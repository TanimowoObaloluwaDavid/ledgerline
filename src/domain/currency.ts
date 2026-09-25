import { CurrencyUnsupportedError, ValidationError } from './errors.js';

export type CurrencyCode = string;

/** Currencies the engine understands, with their decimal exponents. */
const EXPONENTS: Readonly<Record<string, number>> = {
  BHD: 3,
  CLP: 0,
  IQD: 3,
  ISK: 0,
  JOD: 3,
  JPY: 0,
  KRW: 0,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  PYG: 0,
  RWF: 0,
  TND: 3,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
};

export const SUPPORTED_CURRENCIES: readonly CurrencyCode[] = Object.freeze([
  'AED',
  'ARS',
  'AUD',
  'BDT',
  'BGN',
  'BRL',
  'BWP',
  'CAD',
  'CHF',
  'CLP',
  'CNY',
  'COP',
  'CZK',
  'DKK',
  'EGP',
  'EUR',
  'GBP',
  'GEL',
  'GHS',
  'HKD',
  'HUF',
  'IDR',
  'ILS',
  'INR',
  'ISK',
  'JMD',
  'JPY',
  'KES',
  'KRW',
  'KWD',
  'KZT',
  'LKR',
  'MAD',
  'MXN',
  'MYR',
  'NGN',
  'NOK',
  'NPR',
  'NZD',
  'OMR',
  'PEN',
  'PHP',
  'PKR',
  'PLN',
  'RON',
  'RUB',
  'SAR',
  'SEK',
  'SGD',
  'THB',
  'TND',
  'TRY',
  'TWD',
  'UAH',
  'UGX',
  'USD',
  'UYU',
  'VND',
  'XAF',
  'XOF',
  'ZAR',
]);

const SUPPORTED = new Set<string>(SUPPORTED_CURRENCIES);

/** A three-letter uppercase currency code. */
export function isCurrencyCode(value: string): boolean {
  return /^[A-Z]{3}$/.test(value);
}

/** Validates and normalises a currency code. */
export function assertCurrency(currency: string): CurrencyCode {
  if (!isCurrencyCode(currency)) {
    throw new ValidationError(`'${currency}' is not a three-letter ISO-4217 code.`, { currency });
  }
  if (!SUPPORTED.has(currency)) {
    throw new CurrencyUnsupportedError(currency);
  }
  return currency;
}

export function isSupportedCurrency(currency: string): boolean {
  return isCurrencyCode(currency) && SUPPORTED.has(currency);
}

/** Decimal exponent: how many minor units make one major unit. */
export function exponentOf(currency: CurrencyCode): number {
  assertCurrency(currency);
  return EXPONENTS[currency] ?? 2;
}

/** Number of minor units in one major unit, e.g. 100 for USD, 1 for JPY. */
export function minorUnitsPerMajor(currency: CurrencyCode): bigint {
  return 10n ** BigInt(exponentOf(currency));
}
