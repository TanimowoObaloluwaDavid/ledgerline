import { InvalidRateError, ValidationError } from './errors.js';

function gcd(a: bigint, b: bigint): bigint {
  let left = a < 0n ? -a : a;
  let right = b < 0n ? -b : b;
  while (right !== 0n) {
    const next = left % right;
    left = right;
    right = next;
  }
  return left;
}

/**
 * Integer division rounding halves to even ("banker's rounding").
 *
 * This is the rounding rule used for currency: `0.005 -> 0.00`, `0.015 -> 0.02`,
 * `2.5 -> 2`, `3.5 -> 4`. Exact halves are not biased upwards, which keeps
 * large batches of conversions from drifting.
 */
export function divRoundHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new InvalidRateError('division by zero');
  }
  const d = denominator < 0n ? -denominator : denominator;
  const n = denominator < 0n ? -numerator : numerator;
  const quotient = n / d;
  const remainder = n % d;
  if (remainder === 0n) {
    return quotient;
  }
  const twiceRemainder = remainder < 0n ? -remainder * 2n : remainder * 2n;
  if (twiceRemainder > d) {
    return quotient + (numerator < 0n ? -1n : 1n);
  }
  if (twiceRemainder < d) {
    return quotient;
  }
  const isEven = quotient % 2n === 0n;
  if (isEven) {
    return quotient;
  }
  return quotient + (numerator < 0n ? -1n : 1n);
}

/**
 * An exact non-negative-capable rational number backed by `bigint`.
 *
 * Exchange rates and split weights are ratios, not floats: `0.1 + 0.2 !== 0.3`
 * in IEEE-754, and a ledger that is off by a cent per thousand entries is a
 * ledger nobody trusts. Ratios are kept in lowest terms with a positive
 * denominator so equality and ordering are exact.
 */
export class Ratio {
  readonly numerator: bigint;
  readonly denominator: bigint;

  private constructor(numerator: bigint, denominator: bigint) {
    if (denominator === 0n) {
      throw new InvalidRateError('zero denominator');
    }
    const d = denominator < 0n ? -denominator : denominator;
    const n = denominator < 0n ? -numerator : numerator;
    const divisor = gcd(n, d) || 1n;
    this.numerator = n / divisor;
    this.denominator = d / divisor;
  }

  static of(numerator: bigint | number, denominator: bigint | number = 1n): Ratio {
    return new Ratio(BigInt(numerator), BigInt(denominator));
  }

  /** Parses `a/b`, `a.b`, or a bare integer. */
  static parse(text: string): Ratio {
    const trimmed = text.trim();
    if (trimmed === '') {
      throw new InvalidRateError('empty value');
    }
    const fraction = /^([+-]?\d+)\s*\/\s*(\d+)$/.exec(trimmed);
    if (fraction) {
      return Ratio.of(BigInt(fraction[1] as string), BigInt(fraction[2] as string));
    }
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(trimmed)) {
      throw new InvalidRateError(`'${text}' is not a number or fraction`);
    }
    return Ratio.parseDecimal(trimmed);
  }

  /** Parses a base-10 decimal string exactly, without going through a float. */
  static parseDecimal(text: string): Ratio {
    const negative = text.startsWith('-');
    const unsigned = negative ? text.slice(1) : text;
    const [whole = '0', fraction = ''] = unsigned.split('.');
    if (fraction === '') {
      const value = BigInt(whole);
      return new Ratio(negative ? -value : value, 1n);
    }
    const digits = BigInt(`${whole}${fraction}`);
    const scale = 10n ** BigInt(fraction.length);
    return new Ratio(negative ? -digits : digits, scale);
  }

  static readonly ZERO = new Ratio(0n, 1n);
  static readonly ONE = new Ratio(1n, 1n);

  add(other: Ratio): Ratio {
    return new Ratio(
      this.numerator * other.denominator + other.numerator * this.denominator,
      this.denominator * other.denominator,
    );
  }

  subtract(other: Ratio): Ratio {
    return new Ratio(
      this.numerator * other.denominator - other.numerator * this.denominator,
      this.denominator * other.denominator,
    );
  }

  multiply(other: Ratio): Ratio {
    return new Ratio(this.numerator * other.numerator, this.denominator * other.denominator);
  }

  divide(other: Ratio): Ratio {
    if (other.numerator === 0n) {
      throw new InvalidRateError('division by zero');
    }
    return new Ratio(this.numerator * other.denominator, this.denominator * other.numerator);
  }

  inverse(): Ratio {
    if (this.numerator === 0n) {
      throw new InvalidRateError('no inverse for zero');
    }
    return new Ratio(this.denominator, this.numerator);
  }

  negate(): Ratio {
    return new Ratio(-this.numerator, this.denominator);
  }

  compare(other: Ratio): -1 | 0 | 1 {
    const left = this.numerator * other.denominator;
    const right = other.numerator * this.denominator;
    if (left < right) {
      return -1;
    }
    return left > right ? 1 : 0;
  }

  isZero(): boolean {
    return this.numerator === 0n;
  }

  isOne(): boolean {
    return this.numerator === this.denominator;
  }

  isNegative(): boolean {
    return this.numerator < 0n;
  }

  isPositive(): boolean {
    return this.numerator > 0n;
  }

  abs(): Ratio {
    return this.isNegative() ? this.negate() : this;
  }

  /** Lossy, for display and for rate APIs that speak floats. */
  toNumber(): number {
    return Number(this.numerator) / Number(this.denominator);
  }

  /** Nearest integer, halves to even. */
  roundHalfEven(): bigint {
    return divRoundHalfEven(this.numerator, this.denominator);
  }

  /** Decimal string with at most `maxDecimals` digits, halves to even. */
  toDecimalString(maxDecimals = 12): string {
    if (maxDecimals < 0 || !Number.isInteger(maxDecimals)) {
      throw new ValidationError('maxDecimals must be a non-negative integer', { maxDecimals });
    }
    const negative = this.numerator < 0n;
    const scale = 10n ** BigInt(maxDecimals);
    const scaled = divRoundHalfEven(this.numerator * scale, this.denominator);
    const digits = (scaled < 0n ? -scaled : scaled).toString().padStart(maxDecimals + 1, '0');
    const whole = digits.slice(0, digits.length - maxDecimals) || '0';
    const fraction = maxDecimals === 0 ? '' : `.${digits.slice(digits.length - maxDecimals)}`;
    return `${negative && scaled !== 0n ? '-' : ''}${whole}${fraction}`;
  }

  equals(other: Ratio): boolean {
    return this.compare(other) === 0;
  }

  toString(): string {
    return this.denominator === 1n
      ? this.numerator.toString()
      : `${this.numerator}/${this.denominator}`;
  }

  toJSON(): { value: string; decimal: string } {
    return { value: this.toString(), decimal: this.toDecimalString() };
  }
}

/** Converts a basis-point count (1/100 of a percent) to a ratio. */
export function ratioFromBps(bps: number): Ratio {
  if (!Number.isInteger(bps)) {
    throw new ValidationError('Basis points must be an integer', { bps });
  }
  return Ratio.of(bps, 10_000n);
}
