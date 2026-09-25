import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CurrencyMismatchError, ValidationError } from './errors.js';
import { Money } from './money.js';
import { divRoundHalfEven, Ratio } from './ratio.js';

describe('Ratio', () => {
  it('normalises to lowest terms with a positive denominator', () => {
    expect(Ratio.of(6, -8).toString()).toBe('-3/4');
    expect(Ratio.of(0, 5).toString()).toBe('0');
    expect(Ratio.of(2, 4).equals(Ratio.of(1, 2))).toBe(true);
  });

  it('parses decimals exactly, without float error', () => {
    expect(Ratio.parse('0.1').add(Ratio.parse('0.2')).equals(Ratio.of(3, 10))).toBe(true);
    expect(Ratio.parse('1/3').multiply(Ratio.of(3)).equals(Ratio.ONE)).toBe(true);
  });

  it('orders exactly, including for values a float cannot separate', () => {
    const big = Ratio.of(9_007_199_254_740_993n); // 2^53 + 1
    const bigger = big.add(Ratio.of(1, 3n));
    expect(big.compare(bigger)).toBe(-1);
    expect(bigger.compare(big)).toBe(1);
  });

  it('rounds halves to even', () => {
    expect(divRoundHalfEven(5n, 2n)).toBe(2n);
    expect(divRoundHalfEven(7n, 2n)).toBe(4n);
    expect(divRoundHalfEven(-5n, 2n)).toBe(-2n);
    expect(divRoundHalfEven(1n, 3n)).toBe(0n);
    expect(divRoundHalfEven(2n, 3n)).toBe(1n);
    expect(divRoundHalfEven(-2n, 3n)).toBe(-1n);
  });
});

describe('Money', () => {
  it('stores exact minor units per currency exponent', () => {
    expect(Money.fromMajor('USD', '19.99').minor).toBe(1999n);
    expect(Money.fromMajor('JPY', '1500').minor).toBe(1500n);
    expect(Money.fromMajor('KWD', '1.234').minor).toBe(1234n);
    expect(Money.fromMajor('JPY', '1500').toDecimalString()).toBe('1500');
    expect(Money.fromMajor('KWD', '1.234').toDecimalString()).toBe('1.234');
  });

  it('rejects sub-minor precision for zero-decimal currencies', () => {
    expect(() => Money.fromMajor('JPY', '1500.5')).toThrow(ValidationError);
  });

  it('refuses to mix currencies', () => {
    expect(() => Money.fromMajor('USD', '1').add(Money.fromMajor('EUR', '1'))).toThrow(
      CurrencyMismatchError,
    );
  });

  it('round-trips through JSON without losing the minor unit', () => {
    const money = Money.fromMajor('USD', '-1234.56');
    expect(Money.fromJson(money.toJSON()).equals(money)).toBe(true);
  });

  it('splits without losing or inventing a single minor unit', () => {
    const parts = Money.fromMajor('USD', '100.00').allocateByCount(3);
    expect(parts.map((part) => part.minor)).toEqual([3334n, 3333n, 3333n]);
    expect(parts.reduce((sum, part) => sum.add(part), Money.zero('USD')).minor).toBe(10000n);
  });

  it('allocates by weighted shares, largest remainder first', () => {
    const parts = Money.fromMajor('USD', '10.00').allocate([Ratio.of(1), Ratio.of(1), Ratio.of(1)]);
    expect(parts.map((part) => part.minor)).toEqual([334n, 333n, 333n]);

    const weighted = Money.fromMajor('USD', '10.00').allocate([
      Ratio.of(7, 10),
      Ratio.of(2, 10),
      Ratio.of(1, 10),
    ]);
    expect(weighted.map((part) => part.minor)).toEqual([700n, 200n, 100n]);
  });

  it('keeps negative allocations symmetric', () => {
    const parts = Money.fromMajor('USD', '-100.00').allocateByCount(3);
    expect(parts.map((part) => part.minor)).toEqual([-3334n, -3333n, -3333n]);
  });

  it('multiplies by a ratio with banker rounding', () => {
    expect(Money.fromMajor('USD', '10.00').multiply(Ratio.parse('0.125')).minor).toBe(125n);
    expect(Money.fromMajor('USD', '0.05').percentOf(5000).minor).toBe(2n);
    expect(Money.fromMinor('JPY', 5).multiply(Ratio.parse('0.5')).minor).toBe(2n);
  });

  it('parses human input', () => {
    expect(Money.parse('1,234.56 USD').minor).toBe(123456n);
    expect(Money.parse('USD -0.99').minor).toBe(-99n);
  });
});

describe('Money properties', () => {
  const minorArb = fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n });

  it('addition is associative and commutative', () => {
    fc.assert(
      fc.property(minorArb, minorArb, minorArb, (a, b, c) => {
        const x = Money.fromMinor('USD', a);
        const y = Money.fromMinor('USD', b);
        const z = Money.fromMinor('USD', c);
        expect(x.add(y).add(z).minor).toBe(z.add(x).add(y).minor);
      }),
      { numRuns: 200 },
    );
  });

  it('subtracting a value from itself is exactly zero', () => {
    fc.assert(
      fc.property(minorArb, (a) => {
        const x = Money.fromMinor('USD', a);
        expect(x.subtract(x).isZero()).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('never loses a minor unit when splitting', () => {
    fc.assert(
      fc.property(minorArb, fc.integer({ min: 1, max: 12 }), (amount, parts) => {
        const pieces = Money.fromMinor('USD', amount).allocateByCount(parts);
        const total = pieces.reduce((sum, piece) => sum.add(piece), Money.zero('USD'));
        expect(total.minor).toBe(amount);
        expect(pieces).toHaveLength(parts);
      }),
      { numRuns: 200 },
    );
  });

  it('decimal rendering round-trips through fromMajor', () => {
    fc.assert(
      fc.property(fc.integer({ min: -(10 ** 9), max: 10 ** 9 }), (units) => {
        const money = Money.fromMajor('USD', `${units}.07`);
        expect(Money.fromMajor('USD', money.toDecimalString()).minor).toBe(money.minor);
      }),
      { numRuns: 200 },
    );
  });
});
