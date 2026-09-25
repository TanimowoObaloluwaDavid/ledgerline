import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { InvalidRateError, RateNotFoundError } from './errors.js';
import { createRate, FxTable } from './fx.js';
import { Money } from './money.js';
import { Ratio } from './ratio.js';

const table = FxTable.empty()
  .add({ base: 'EUR', quote: 'USD', rate: '1.10', effectiveDate: '2025-01-01' })
  .add({ base: 'EUR', quote: 'USD', rate: '1.20', effectiveDate: '2025-06-01' })
  .add({ base: 'JPY', quote: 'USD', rate: '0.0067', effectiveDate: '2025-01-01' });

describe('FxTable', () => {
  it('uses the most recent rate at or before the date', () => {
    expect(table.rateOn('EUR', 'USD', '2025-01-01').toDecimalString(2)).toBe('1.10');
    expect(table.rateOn('EUR', 'USD', '2025-05-31').toDecimalString(2)).toBe('1.10');
    expect(table.rateOn('EUR', 'USD', '2025-06-01').toDecimalString(2)).toBe('1.20');
    expect(table.rateOn('EUR', 'USD', '2030-01-01').toDecimalString(2)).toBe('1.20');
  });

  it('inverts a pair that is only recorded the other way round', () => {
    const inverse = table.rateOn('USD', 'EUR', '2025-01-15');
    expect(inverse.multiply(table.rateOn('EUR', 'USD', '2025-01-15')).equals(Ratio.ONE)).toBe(true);
  });

  it('fails loudly instead of guessing a rate', () => {
    expect(() => table.rateOn('GBP', 'USD', '2025-01-01')).toThrow(RateNotFoundError);
    expect(() => table.rateOn('EUR', 'USD', '2024-12-31')).toThrow(RateNotFoundError);
  });

  it('rejects rates it cannot use', () => {
    expect(() =>
      createRate({ base: 'USD', quote: 'USD', rate: '1', effectiveDate: '2025-01-01' }),
    ).toThrow(InvalidRateError);
    expect(() =>
      createRate({ base: 'USD', quote: 'EUR', rate: '0', effectiveDate: '2025-01-01' }),
    ).toThrow(InvalidRateError);
    expect(() =>
      createRate({ base: 'USD', quote: 'EUR', rate: '1.2', effectiveDate: 'nope' }),
    ).toThrow(InvalidRateError);
  });

  it('rejects two rates for the same pair and date', () => {
    expect(() =>
      table.add({ base: 'EUR', quote: 'USD', rate: '1.3', effectiveDate: '2025-06-01' }),
    ).toThrow(InvalidRateError);
  });

  it('converts across different decimal exponents', () => {
    const yen = Money.fromMinor('JPY', 150_000);
    expect(table.convert(yen, 'USD', '2025-01-02').minor).toBe(100_500n);

    // 1,000.00 USD at 149 yen per dollar is 149,000 yen: no decimal point.
    const dollars = Money.fromMajor('USD', '1000.00');
    const back = table.convert(dollars, 'JPY', '2025-01-02', Ratio.of(149));
    expect(back.currency).toBe('JPY');
    expect(back.minor).toBe(149_000n);
    expect(back.toDecimalString()).toBe('149000');
  });

  it('is a no-op when source and target match', () => {
    const money = Money.fromMajor('EUR', '10.00');
    expect(table.convert(money, 'EUR', '2025-01-01').equals(money)).toBe(true);
  });

  it('day-weights average rates across the period', () => {
    // 151 days at 1.10 and one day at 1.20, across 152 days:
    // (151 * 1.10 + 1 * 1.20) / 152 = 1.100657...
    const straddling = table.averageRateOn('EUR', 'USD', '2025-01-01', '2025-06-01');
    expect(straddling.toDecimalString(6)).toBe('1.100658');

    const beforeStep = table.averageRateOn('EUR', 'USD', '2025-01-01', '2025-05-31');
    expect(beforeStep.toDecimalString(6)).toBe('1.100000');
  });

  it('resolves every currency a report needs', () => {
    const rates = table.ratesFor(['USD', 'EUR', 'JPY'], 'USD', '2025-02-01');
    expect(rates.get('USD')?.equals(Ratio.ONE)).toBe(true);
    expect(rates.get('EUR')?.toDecimalString(2)).toBe('1.10');
    expect(rates.get('JPY')?.isPositive()).toBe(true);
  });
});

describe('FxTable properties', () => {
  const rateArb = fc
    .tuple(fc.bigInt({ min: 1n, max: 10_000n }), fc.bigInt({ min: 1n, max: 10_000n }))
    .map(([numerator, denominator]) => Ratio.of(numerator, denominator));
  const minorArb = fc.bigInt({ min: 1n, max: 10n ** 9n });

  it('is deterministic: the same input always converts to the same amount', () => {
    fc.assert(
      fc.property(rateArb, minorArb, (rate, minor) => {
        const fx = FxTable.empty().add({
          base: 'EUR',
          quote: 'USD',
          rate,
          effectiveDate: '2025-01-01',
        });
        const money = Money.fromMinor('EUR', minor);
        expect(fx.convert(money, 'USD', '2025-06-01').minor).toBe(
          fx.convert(money, 'USD', '2025-06-01').minor,
        );
      }),
      { numRuns: 200 },
    );
  });

  it('is monotonic: a bigger amount never converts to a smaller one', () => {
    fc.assert(
      fc.property(rateArb, minorArb, (rate, minor) => {
        const fx = FxTable.empty().add({
          base: 'EUR',
          quote: 'USD',
          rate,
          effectiveDate: '2025-01-01',
        });
        const small = fx.convert(Money.fromMinor('EUR', minor), 'USD', '2025-01-01');
        const large = fx.convert(Money.fromMinor('EUR', minor + 1_000_000n), 'USD', '2025-01-01');
        expect(large.minor >= small.minor).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('never converts more than half a minor unit away from the exact value', () => {
    fc.assert(
      fc.property(rateArb, minorArb, (rate, minor) => {
        const fx = FxTable.empty().add({
          base: 'EUR',
          quote: 'USD',
          rate,
          effectiveDate: '2025-01-01',
        });
        const converted = fx.convert(Money.fromMinor('EUR', minor), 'USD', '2025-01-01');
        // Both currencies have two decimals, so the exact minor-unit result is
        // simply minor * rate.
        const exact = Ratio.of(minor).multiply(rate);
        const error = Ratio.of(converted.minor).subtract(exact).abs();
        expect(error.compare(Ratio.of(1, 2)) <= 0).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});
