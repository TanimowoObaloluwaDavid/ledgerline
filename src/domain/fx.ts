import { assertCurrency, type CurrencyCode, exponentOf, minorUnitsPerMajor } from './currency.js';
import { compareIsoDates, dateRange, type IsoDate, isIsoDate } from './date.js';
import { InvalidRateError, RateNotFoundError, ValidationError } from './errors.js';
import { type Id, newId } from './ids.js';
import { Money } from './money.js';
import { divRoundHalfEven, Ratio } from './ratio.js';

/** `1 base = rate quote`, effective from `effectiveDate`. */
export interface FxRate {
  readonly id: Id;
  readonly base: CurrencyCode;
  readonly quote: CurrencyCode;
  readonly rate: Ratio;
  readonly effectiveDate: IsoDate;
  readonly source: string;
  readonly recordedAt: string;
}

export interface FxRateInput {
  readonly base: CurrencyCode;
  readonly quote: CurrencyCode;
  readonly rate: Ratio | string;
  readonly effectiveDate: IsoDate;
  readonly source?: string;
  readonly id?: Id;
  readonly recordedAt?: string;
}

export function createRate(input: FxRateInput): FxRate {
  const base = assertCurrency(input.base);
  const quote = assertCurrency(input.quote);
  if (base === quote) {
    throw new InvalidRateError('base and quote must differ');
  }
  const rate = typeof input.rate === 'string' ? Ratio.parse(input.rate) : input.rate;
  if (!rate.isPositive()) {
    throw new InvalidRateError('rate must be greater than zero');
  }
  if (!isIsoDate(input.effectiveDate)) {
    throw new InvalidRateError(`effectiveDate '${input.effectiveDate}' must be YYYY-MM-DD`);
  }
  const source = (input.source ?? 'manual').trim();
  if (source.length > 64) {
    throw new InvalidRateError('source is limited to 64 characters');
  }
  return Object.freeze({
    id: input.id ?? newId('rate'),
    base,
    quote,
    rate,
    effectiveDate: input.effectiveDate,
    source,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
  });
}

function rateKey(base: string, quote: string): string {
  return `${base}/${quote}`;
}

/**
 * A dated set of exchange rates.
 *
 * Rates are point-in-time facts: each one applies from its effective date until
 * the next rate for the same pair. Lookups use the most recent rate at or before
 * the requested date and never silently fall back to "today" — a missing rate is
 * an error, because a report computed against an invented rate is worse than no
 * report at all.
 */
export class FxTable {
  private readonly rates: readonly FxRate[];

  constructor(rates: readonly FxRate[] = []) {
    this.rates = [...rates].sort(compareRates);
    for (let index = 1; index < this.rates.length; index += 1) {
      const previous = this.rates[index - 1] as FxRate;
      const current = this.rates[index] as FxRate;
      if (
        previous.base === current.base &&
        previous.quote === current.quote &&
        previous.effectiveDate === current.effectiveDate
      ) {
        throw new InvalidRateError(
          `duplicate rate for ${rateKey(current.base, current.quote)} on ${current.effectiveDate}`,
        );
      }
    }
  }

  static empty(): FxTable {
    return new FxTable([]);
  }

  add(input: FxRateInput): FxTable {
    return new FxTable([...this.rates, createRate(input)]);
  }

  list(): readonly FxRate[] {
    return this.rates;
  }

  size(): number {
    return this.rates.length;
  }

  pairs(): readonly string[] {
    return [...new Set(this.rates.map((rate) => rateKey(rate.base, rate.quote)))].sort();
  }

  /** Only the rates in force at the end of `date`. */
  asOf(date: IsoDate): FxTable {
    return new FxTable(this.rates.filter((rate) => compareIsoDates(rate.effectiveDate, date) <= 0));
  }

  /**
   * Rate in force on `date`, or the inverse of the opposite pair when only the
   * reciprocal has been recorded.
   */
  rateOn(base: CurrencyCode, quote: CurrencyCode, date: IsoDate): Ratio {
    const from = assertCurrency(base);
    const to = assertCurrency(quote);
    if (from === to) {
      return Ratio.ONE;
    }
    const direct = this.lookup(from, to, date);
    if (direct !== undefined) {
      return direct;
    }
    const inverse = this.lookup(to, from, date);
    if (inverse !== undefined) {
      return inverse.inverse();
    }
    throw new RateNotFoundError(from, to, date);
  }

  hasRate(base: CurrencyCode, quote: CurrencyCode, date: IsoDate): boolean {
    try {
      this.rateOn(base, quote, date);
      return true;
    } catch {
      return false;
    }
  }

  private lookup(base: string, quote: string, date: IsoDate): Ratio | undefined {
    let found: Ratio | undefined;
    for (const rate of this.rates) {
      if (rate.base !== base || rate.quote !== quote) {
        continue;
      }
      if (compareIsoDates(rate.effectiveDate, date) > 0) {
        break;
      }
      found = rate.rate;
    }
    return found;
  }

  /**
   * Day-weighted mean rate across `[from, to]`, the standard basis for
   * translating an income statement. Returns the closing rate for a one-day
   * period, so callers can use it unconditionally.
   */
  averageRateOn(base: CurrencyCode, quote: CurrencyCode, from: IsoDate, to: IsoDate): Ratio {
    const days = dateRange(from, to);
    if (days.length === 0) {
      return this.rateOn(base, quote, from);
    }
    if (days.length === 1) {
      return this.rateOn(base, quote, from);
    }
    let total = Ratio.ZERO;
    for (const day of days) {
      total = total.add(this.rateOn(base, quote, day));
    }
    return total.divide(Ratio.of(days.length));
  }

  /**
   * Converts an amount at the rate in force on `date`.
   *
   * The result is rounded to the target currency's minor unit, halves to even.
   * Cross-exponent pairs (JPY/USD) are handled by rescaling in minor units, so
   * no precision is invented along the way.
   */
  convert(amount: Money, to: CurrencyCode, date: IsoDate, rate?: Ratio): Money {
    const target = assertCurrency(to);
    if (amount.currency === target) {
      return amount;
    }
    const effective = rate ?? this.rateOn(amount.currency, target, date);
    if (!effective.isPositive()) {
      throw new InvalidRateError('rate must be greater than zero');
    }
    const targetScale = minorUnitsPerMajor(target);
    const sourceScale = 10n ** BigInt(exponentOf(amount.currency));
    const numerator = amount.minor * effective.numerator * targetScale;
    const denominator = effective.denominator * sourceScale;
    return Money.fromMinor(target, divRoundHalfEven(numerator, denominator));
  }

  /** Converts a signed minor-unit amount, used by report aggregation. */
  convertMinor(currency: CurrencyCode, minor: bigint, to: CurrencyCode, rate: Ratio): bigint {
    const targetScale = minorUnitsPerMajor(to);
    const sourceScale = 10n ** BigInt(exponentOf(currency));
    return divRoundHalfEven(minor * rate.numerator * targetScale, rate.denominator * sourceScale);
  }

  /**
   * Resolves every rate needed to translate `currencies` into `functional` at
   * the given date, failing loudly if any is missing.
   */
  ratesFor(
    currencies: Iterable<CurrencyCode>,
    functional: CurrencyCode,
    date: IsoDate,
    mode: 'closing' | 'average' = 'closing',
    from?: IsoDate,
  ): ReadonlyMap<string, Ratio> {
    const resolved = new Map<string, Ratio>();
    for (const currency of new Set(currencies)) {
      if (currency === functional) {
        resolved.set(currency, Ratio.ONE);
        continue;
      }
      if (mode === 'average') {
        if (from === undefined) {
          throw new ValidationError('Average-rate translation requires a period start date.', {
            currency,
          });
        }
        resolved.set(currency, this.averageRateOn(currency, functional, from, date));
      } else {
        resolved.set(currency, this.rateOn(currency, functional, date));
      }
    }
    return resolved;
  }
}

function compareRates(left: FxRate, right: FxRate): number {
  if (left.base !== right.base) {
    return left.base.localeCompare(right.base);
  }
  if (left.quote !== right.quote) {
    return left.quote.localeCompare(right.quote);
  }
  return compareIsoDates(left.effectiveDate, right.effectiveDate);
}
