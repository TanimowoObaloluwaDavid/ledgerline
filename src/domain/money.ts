import { assertCurrency, type CurrencyCode, exponentOf, minorUnitsPerMajor } from './currency.js';
import { CurrencyMismatchError, NonPositiveAmountError, ValidationError } from './errors.js';
import { divRoundHalfEven, Ratio } from './ratio.js';

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

export interface MoneyJson {
  readonly currency: CurrencyCode;
  /** Amount in minor units, as a string so it survives JSON round-trips. */
  readonly minor: string;
  /** Human-facing decimal form, e.g. `-1234.56`. */
  readonly decimal: string;
  /**
   * Minor units per major unit, as a power of ten: 2 for USD, 0 for JPY, 3 for
   * BHD. A client that wants to add two amounts together needs this to scale
   * `minor` back into a decimal, and should not have to ship its own table of
   * currency exponents to do it.
   */
  readonly exponent: number;
}

/**
 * An exact monetary amount.
 *
 * Money is stored as an integer number of *minor units* (cents, pence, fils)
 * in a single currency. Binary floating point is never involved: every sum,
 * split and conversion is exact integer arithmetic, so the ledger balances to
 * the last minor unit or it does not balance at all.
 */
export class Money {
  private constructor(
    readonly currency: CurrencyCode,
    readonly minor: bigint,
  ) {}

  // ---------------------------------------------------------------- factories

  /** Builds from an exact minor-unit integer, e.g. `fromMinor('USD', 1234n)`. */
  static fromMinor(currency: CurrencyCode, minor: bigint | number): Money {
    return new Money(assertCurrency(currency), BigInt(minor));
  }

  /**
   * Builds from a major-unit decimal string, e.g. `fromMajor('USD', '19.99')`.
   *
   * Input with more precision than the currency can represent is rejected rather
   * than rounded: `Money.fromMajor('JPY', '1500.5')` throws instead of quietly
   * turning 0.5 yen into a whole yen. Use {@link Money.multiply} or
   * {@link FxTable.convert} when you *want* rounding.
   */
  static fromMajor(currency: CurrencyCode, major: string | Ratio | number): Money {
    const code = assertCurrency(currency);
    if (typeof major === 'number') {
      if (!Number.isFinite(major)) {
        throw new ValidationError('Amount must be a finite number', { amount: major });
      }
      return Money.fromRatio(code, Ratio.parse(String(major)));
    }
    const ratio = typeof major === 'string' ? parseDecimalAmount(major) : major;
    assertFitsCurrency(code, ratio);
    return Money.fromRatio(code, ratio);
  }

  static fromRatio(currency: CurrencyCode, ratio: Ratio): Money {
    const code = assertCurrency(currency);
    const scaled = ratio.multiply(Ratio.of(minorUnitsPerMajor(code)));
    return new Money(code, divRoundHalfEven(scaled.numerator, scaled.denominator));
  }

  static zero(currency: CurrencyCode): Money {
    return new Money(assertCurrency(currency), 0n);
  }

  /**
   * Parses `"1234.56 USD"`, `"USD 1234.56"` or `"1234.56"` (currency required).
   */
  static parse(text: string): Money {
    const trimmed = text.trim();
    const prefixed = /^([A-Za-z]{3})\s*(-?[\d.,]+)$/.exec(trimmed);
    if (prefixed !== null) {
      return Money.fromMajor(
        (prefixed[1] as string).toUpperCase(),
        stripGrouping(prefixed[2] as string),
      );
    }
    const suffixed = /^(-?[\d.,]+)\s*([A-Za-z]{3})$/.exec(trimmed);
    if (suffixed === null) {
      throw new ValidationError(
        `'${text}' is not a monetary amount; expected e.g. '1234.56 USD' or 'USD 1234.56'.`,
        { text },
      );
    }
    return Money.fromMajor(
      (suffixed[2] as string).toUpperCase(),
      stripGrouping(suffixed[1] as string),
    );
  }

  /** Rejects JSON payloads that do not describe an exact amount. */
  static fromJson(json: MoneyJson): Money {
    if (typeof json.minor !== 'string' || !/^-?\d+$/.test(json.minor)) {
      throw new ValidationError('Money.minor must be a stringified integer', { minor: json.minor });
    }
    return Money.fromMinor(json.currency, BigInt(json.minor));
  }

  // ------------------------------------------------------------- arithmetic

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.currency, this.minor + other.minor);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.currency, this.minor - other.minor);
  }

  negate(): Money {
    return new Money(this.currency, -this.minor);
  }

  abs(): Money {
    return new Money(this.currency, this.minor < 0n ? -this.minor : this.minor);
  }

  /** Scales by an exact ratio, rounding halves to even at minor-unit precision. */
  multiply(ratio: Ratio): Money {
    return new Money(
      this.currency,
      divRoundHalfEven(this.minor * ratio.numerator, ratio.denominator),
    );
  }

  /** `multiply` by a basis-point count: `money.percentOf(250)` is 2.5%. */
  percentOf(bps: number | bigint): Money {
    return this.multiply(Ratio.of(bps, 10_000n));
  }

  /** Division by an exact ratio, rounded halves to even. */
  divide(ratio: Ratio): Money {
    if (ratio.isZero()) {
      throw new ValidationError('Cannot divide money by zero.');
    }
    return new Money(
      this.currency,
      divRoundHalfEven(this.minor * ratio.denominator, ratio.numerator),
    );
  }

  /**
   * Splits an amount across weights without losing or inventing a single minor
   * unit: the parts always re-sum to the original amount.
   *
   * Remainders go to the largest fractional claims, ties broken by position, so
   * the result is deterministic and order-stable.
   */
  allocate(weights: readonly Ratio[]): Money[] {
    if (weights.length === 0) {
      throw new ValidationError('allocate requires at least one weight.');
    }
    if (weights.some((weight) => weight.isNegative())) {
      throw new ValidationError('Allocation weights must not be negative.', {
        weights: weights.map(String),
      });
    }
    const total = weights.reduce((sum, weight) => sum.add(weight), Ratio.ZERO);
    if (total.isZero()) {
      throw new ValidationError('Allocation weights must not sum to zero.');
    }

    const sign = this.minor < 0n ? -1n : 1n;
    const magnitude = this.minor < 0n ? -this.minor : this.minor;
    const base: bigint[] = [];
    const remainder: Ratio[] = [];
    for (const weight of weights) {
      const exact = Ratio.of(magnitude).multiply(weight).divide(total);
      base.push(exact.numerator / exact.denominator);
      remainder.push(exact.subtract(Ratio.of(exact.numerator / exact.denominator)));
    }

    let leftover = magnitude - base.reduce((sum, part) => sum + part, 0n);
    const order = weights
      .map((_, index) => index)
      .sort((left, right) => {
        const diff = remainder[right]?.compare(remainder[left] ?? Ratio.ZERO) ?? 0;
        return diff !== 0 ? diff : left - right;
      });

    for (let position = 0; position < order.length && leftover > 0n; position += 1) {
      const index = order[position] as number;
      base[index] = (base[index] ?? 0n) + 1n;
      leftover -= 1n;
    }

    return base.map((part) => new Money(this.currency, part * sign));
  }

  /** Splits by plain integer weights, e.g. `allocateByCount(3)`. */
  allocateByCount(parts: number): Money[] {
    if (!Number.isInteger(parts) || parts < 1) {
      throw new ValidationError('Split count must be a positive integer.', { parts });
    }
    return this.allocate(Array.from({ length: parts }, () => Ratio.ONE));
  }

  // -------------------------------------------------------------- comparison

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    if (this.minor < other.minor) {
      return -1;
    }
    return this.minor > other.minor ? 1 : 0;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isStrictlyPositive(): Money {
    if (this.minor <= 0n) {
      throw new NonPositiveAmountError(this.toDecimalString(), this.currency);
    }
    return this;
  }

  // ---------------------------------------------------------------- printing

  /** Exact decimal form, always with the currency's full minor precision. */
  toDecimalString(): string {
    const exponent = exponentOf(this.currency);
    const negative = this.minor < 0n;
    const digits = (negative ? -this.minor : this.minor).toString().padStart(exponent + 1, '0');
    if (exponent === 0) {
      return `${negative ? '-' : ''}${digits}`;
    }
    return `${negative ? '-' : ''}${digits.slice(0, digits.length - exponent)}.${digits.slice(digits.length - exponent)}`;
  }

  /** Lossy, for charting and exports. Never use this for arithmetic. */
  toNumber(): number {
    return Number(this.minor) / Number(minorUnitsPerMajor(this.currency));
  }

  format(locale?: string): string {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: this.currency,
      currencyDisplay: 'narrowSymbol',
    }).format(this.toNumber());
  }

  toJSON(): MoneyJson {
    return {
      currency: this.currency,
      minor: this.minor.toString(),
      decimal: this.toDecimalString(),
      exponent: exponentOf(this.currency),
    };
  }

  toString(): string {
    return `${this.toDecimalString()} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}

/** Same as {@link Ratio.parseDecimal} but rejects non-canonical input. */
function parseDecimalAmount(text: string): Ratio {
  const trimmed = text.trim();
  if (!DECIMAL_PATTERN.test(trimmed)) {
    throw new ValidationError(`'${text}' is not a decimal amount.`, { text });
  }
  return Ratio.parseDecimal(trimmed);
}

function assertFitsCurrency(currency: CurrencyCode, ratio: Ratio): void {
  const scaled = ratio.multiply(Ratio.of(minorUnitsPerMajor(currency)));
  if (scaled.denominator !== 1n) {
    throw new ValidationError(
      `${ratio.toDecimalString(6)} ${currency} has more precision than the currency supports ` +
        `(${exponentOf(currency)} decimal place${exponentOf(currency) === 1 ? '' : 's'}).`,
      { currency, value: ratio.toDecimalString(6) },
    );
  }
}

function stripGrouping(text: string): string {
  return text.replaceAll(',', '');
}
