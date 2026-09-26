/**
 * Exact money on the client side.
 *
 * The server sends `{ currency, minor, decimal, exponent }`. `decimal` is what a
 * human reads, `minor` is what arithmetic uses. This module never converts a
 * `minor` value into a JavaScript number: a 19-digit amount would lose its last
 * digits, and a bookkeeping screen that shows a wrong cent is worse than one
 * that shows nothing.
 */

/** @typedef {{ currency: string, minor: string, decimal: string, exponent: number }} Money */

/** @param {Money} money */
export function minorOf(money) {
  return BigInt(money.minor);
}

/**
 * Adds amounts. Throws when the currencies differ, because a total across two
 * currencies is not a number anyone should be shown.
 *
 * @param {readonly Money[]} amounts
 * @returns {Money}
 */
export function sumMoney(amounts) {
  if (amounts.length === 0) {
    return { currency: '', minor: '0', decimal: '0', exponent: 2 };
  }
  const [{ currency, exponent }] = amounts;
  let total = 0n;
  for (const amount of amounts) {
    if (amount.currency !== currency) {
      throw new Error(`Cannot total ${currency} and ${amount.currency} together.`);
    }
    total += BigInt(amount.minor);
  }
  return { currency, minor: total.toString(), decimal: formatMinor(total, exponent), exponent };
}

/**
 * Scales minor units into a decimal string, half-up on the magnitude, which is
 * what a person expects to read.
 *
 * @param {bigint} minor
 * @param {number} exponent
 */
export function formatMinor(minor, exponent) {
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const rest = exponent === 0 ? '' : `.${digits.slice(digits.length - exponent)}`;
  return `${negative ? '-' : ''}${whole}${rest}`;
}

/**
 * `1234.56 USD`, or an em dash for nothing at all — an empty cell in a report
 * reads as an oversight, a dash reads as "zero on purpose".
 *
 * @param {Money | null | undefined} money
 */
export function formatMoney(money) {
  if (!money) {
    return '—';
  }
  return `${money.decimal} ${money.currency}`;
}

/** @param {Money | null | undefined} money */
export function isNegative(money) {
  return money !== null && money !== undefined && BigInt(money.minor) < 0n;
}

/** @param {Money | null | undefined} money */
export function isZero(money) {
  return money === null || money === undefined || BigInt(money.minor) === 0n;
}

/**
 * The same amount without its sign.
 *
 * The engine stores a credit balance as a negative number, which is what makes
 * `assets = liabilities + equity` add up. It is the wrong thing to put in front
 * of a bookkeeper, though: no balance sheet in the world shows accounts payable
 * as negative. Use this when displaying an obligation, and keep the signed form
 * for arithmetic.
 *
 * @param {Money} money
 * @returns {Money}
 */
export function magnitude(money) {
  const minor = BigInt(money.minor);
  if (minor >= 0n) {
    return money;
  }
  return {
    ...money,
    minor: (-minor).toString(),
    decimal: formatMinor(-minor, money.exponent),
  };
}

/**
 * The live check on the entry form: does this set of postings balance?
 *
 * @param {readonly { side: 'debit' | 'credit', amount: string }[]} postings
 * @returns {{ ok: boolean, debits: bigint, credits: bigint, difference: bigint, text: string }}
 */
export function balanceOf(postings) {
  let debits = 0n;
  let credits = 0n;
  for (const posting of postings) {
    const minor = parseAmount(posting.amount);
    if (minor === null) {
      continue;
    }
    if (posting.side === 'debit') {
      debits += minor;
    } else {
      credits += minor;
    }
  }
  const difference = debits - credits;
  const ok = debits > 0n && difference === 0n;
  // A missing side gets its own message: telling someone their debits exceed
  // their credits when they have not entered any credits yet is technically
  // true and practically useless.
  const missingSide = debits === 0n || credits === 0n;
  return {
    ok,
    debits,
    credits,
    difference,
    text: ok
      ? 'Balanced'
      : missingSide
        ? 'Enter at least one debit and one credit'
        : difference > 0n
          ? 'Debits exceed credits'
          : 'Credits exceed debits',
  };
}

/**
 * Parses what a person typed into minor units, using the book's currency
 * exponent. Returns `null` rather than guessing, so a half-typed amount is not
 * silently read as zero.
 *
 * @param {string} text
 * @param {number} [exponent]
 * @returns {bigint | null}
 */
export function parseAmount(text, exponent = 2) {
  const cleaned = text.replace(/[\s,]/g, '');
  if (!/^\d*\.?\d*$/.test(cleaned) || cleaned === '' || cleaned === '.') {
    return null;
  }
  const [whole = '0', rest = ''] = cleaned.split('.');
  if (rest.length > exponent) {
    return null;
  }
  const scaled = BigInt(`${whole || '0'}${rest.padEnd(exponent, '0')}`);
  return scaled;
}
