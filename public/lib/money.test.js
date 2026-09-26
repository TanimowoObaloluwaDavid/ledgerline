import { describe, expect, it } from 'vitest';
import {
  balanceOf,
  formatMinor,
  formatMoney,
  isNegative,
  isZero,
  magnitude,
  parseAmount,
  sumMoney,
} from './money.js';

/**
 * The browser does arithmetic on the same exact money the server sends. These
 * tests exist because the tempting shortcut — `Number(money.minor) / 100` — is
 * wrong, and wrong quietly.
 */
/** Builds the shape the API actually sends: `minor` keeps its sign. */
const usd = (decimal) => {
  const [whole, rest = ''] = decimal.split('.');
  const minor = BigInt(`${whole}${rest.padEnd(2, '0')}`);
  return { currency: 'USD', decimal, minor: minor.toString(), exponent: 2 };
};

describe('sumMoney', () => {
  it('adds exact minor units, including ones a float would round', () => {
    const total = sumMoney([
      {
        currency: 'USD',
        minor: '10000000000000000001',
        decimal: '100000000000000000.01',
        exponent: 2,
      },
      { currency: 'USD', minor: '1', decimal: '0.01', exponent: 2 },
    ]);
    expect(total.minor).toBe('10000000000000000002');
    expect(total.decimal).toBe('100000000000000000.02');
  });

  it('carries a negative balance through', () => {
    const total = sumMoney([
      { currency: 'USD', minor: '-5000', decimal: '-50.00', exponent: 2 },
      { currency: 'USD', minor: '1250', decimal: '12.50', exponent: 2 },
    ]);
    expect(total.minor).toBe('-3750');
    expect(total.decimal).toBe('-37.50');
    expect(isNegative(total)).toBe(true);
  });

  it('returns zero for an empty list', () => {
    expect(sumMoney([]).minor).toBe('0');
    expect(isZero(sumMoney([]))).toBe(true);
  });

  it('refuses to total two currencies into one number', () => {
    expect(() =>
      sumMoney([
        { currency: 'USD', minor: '100', decimal: '1.00', exponent: 2 },
        { currency: 'EUR', minor: '100', decimal: '1.00', exponent: 2 },
      ]),
    ).toThrow(/Cannot total USD and EUR/);
  });
});

describe('formatMinor', () => {
  it('respects the currency exponent', () => {
    expect(formatMinor(123456n, 2)).toBe('1234.56');
    expect(formatMinor(1234n, 0)).toBe('1234');
    expect(formatMinor(1234n, 3)).toBe('1.234');
  });

  it('keeps the sign outside the digits and pads a lone zero', () => {
    expect(formatMinor(-5n, 2)).toBe('-0.05');
    expect(formatMinor(0n, 2)).toBe('0.00');
    expect(formatMinor(-1234n, 0)).toBe('-1234');
  });
});

describe('parseAmount', () => {
  it('reads what a person types, in minor units', () => {
    expect(parseAmount('1234.56')).toBe(123456n);
    expect(parseAmount('0.05')).toBe(5n);
    expect(parseAmount('7')).toBe(700n);
    expect(parseAmount('1,234.50')).toBe(123450n);
    expect(parseAmount('.5')).toBe(50n);
  });

  it('refuses anything ambiguous instead of guessing', () => {
    for (const text of ['', '.', '-5', '1.2.3', 'abc', '1e3', '12.345', '  ']) {
      expect(parseAmount(text), text).toBeNull();
    }
  });

  it('honours a three-decimal currency', () => {
    expect(parseAmount('1.234', 3)).toBe(1234n);
    expect(parseAmount('1.23', 0)).toBeNull();
  });
});

describe('balanceOf', () => {
  const line = (side, amount) => ({ side, amount });

  it('is happy when debits equal credits', () => {
    const result = balanceOf([line('debit', '120.00'), line('credit', '120.00')]);
    expect(result.ok).toBe(true);
    expect(result.text).toBe('Balanced');
    expect(result.difference).toBe(0n);
  });

  it('names which side is short', () => {
    expect(balanceOf([line('debit', '100.00'), line('credit', '80.00')]).text).toBe(
      'Debits exceed credits',
    );
    expect(balanceOf([line('debit', '80.00'), line('credit', '100.00')]).text).toBe(
      'Credits exceed debits',
    );
  });

  it('asks for both sides before it complains about a difference', () => {
    expect(balanceOf([line('debit', '100.00')]).text).toBe(
      'Enter at least one debit and one credit',
    );
    expect(balanceOf([line('credit', '100.00')]).text).toBe(
      'Enter at least one debit and one credit',
    );
  });

  it('ignores a half-typed line rather than reading it as zero', () => {
    const result = balanceOf([line('debit', '100.00'), line('credit', ''), line('credit', '99')]);
    expect(result.ok).toBe(false);
    expect(result.credits).toBe(9900n);
  });
});

describe('display helpers', () => {
  it('shows a dash instead of an empty cell', () => {
    expect(formatMoney(undefined)).toBe('—');
    expect(formatMoney(usd('0.00'))).toBe('0.00 USD');
    expect(formatMoney(usd('-12.50'))).toBe('-12.50 USD');
  });

  it('treats a zero amount as zero, not as missing', () => {
    expect(isZero(usd('0.00'))).toBe(true);
    expect(isZero(usd('0.01'))).toBe(false);
    expect(isZero(undefined)).toBe(true);
  });

  it('shows an obligation as a positive figure', () => {
    const payable = magnitude(usd('-12500.00'));
    expect(payable.decimal).toBe('12500.00');
    expect(payable.minor).toBe('1250000');
    expect(payable.currency).toBe('USD');
  });

  it('leaves a debit balance alone when taking the magnitude', () => {
    expect(magnitude(usd('200.00')).decimal).toBe('200.00');
    expect(magnitude(usd('0.00')).decimal).toBe('0.00');
  });

  it('handles a three-decimal currency', () => {
    expect(
      magnitude({ currency: 'BHD', minor: '-1234', decimal: '-1.234', exponent: 3 }).decimal,
    ).toBe('1.234');
  });
});
