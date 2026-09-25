import type { AccountTree } from './account-tree.js';
import type { CurrencyCode } from './currency.js';
import type { IsoDate } from './date.js';
import { EmptyEntryError, ValidationError } from './errors.js';
import type { Id } from './ids.js';
import { createEntry, type JournalEntry, type PostingInput } from './journal.js';
import type { Ledger } from './ledger.js';
import { Money } from './money.js';
import { computeMovements, MovementGrid } from './statements.js';

/** The slice of {@link FxTable} the closing routine needs. */
export interface ClosingFx {
  convert: (amount: Money, to: CurrencyCode, date: IsoDate) => Money;
}

export interface ClosingOptions {
  /** Period to close. Omit `from` to close everything up to `to`. */
  readonly from?: IsoDate;
  readonly to: IsoDate;
  /** Date stamped on the closing entries; usually the period end. */
  readonly date: IsoDate;
  readonly retainedEarningsCode: string;
  readonly retainedEarningsCurrency: CurrencyCode;
  /**
   * Equity account used to translate a foreign-currency result into the
   * functional currency. Ignored when the period is already functional.
   */
  readonly fxClearingCode: string;
  readonly nextId: () => Id;
  readonly nextSequence: () => number;
  readonly recordedAt?: string;
  readonly memo?: string;
  readonly fx: ClosingFx;
}

interface LineSet {
  readonly postings: readonly PostingInput[];
  /** Contribution to the period result, in minor units of the closing currency. */
  readonly net: bigint;
}

/**
 * Period closing: moves income and expense balances into retained earnings.
 *
 * Three properties make this safe to re-run and easy to audit:
 *
 * 1. Closing is an ordinary journal entry, so it shows up in the ledger instead
 *    of being a query-time trick that silently rewrites history.
 * 2. It is generated from *balances*, not postings, so a month with 900
 *    transactions still closes with one entry per currency.
 * 3. A single currency per entry, always. Foreign-currency results are
 *    translated through an equity clearing account using a matched pair of
 *    entries, which is the only way both legs can balance on their own.
 */
export function buildClosingEntries(
  ledger: Ledger,
  tree: AccountTree,
  options: ClosingOptions,
): JournalEntry[] {
  assertClosingTarget(tree, options);
  const period =
    options.from === undefined ? { to: options.to } : { from: options.from, to: options.to };
  const movements = computeMovements(ledger, tree, period);
  const incomeCodes = leafCodesOfType(tree, 'income');
  const expenseCodes = leafCodesOfType(tree, 'expense');
  const income = collectByCode(movements, incomeCodes, false);
  const expense = collectByCode(movements, expenseCodes, true);

  const currencies = [
    ...new Set([...income.values(), ...expense.values()].flatMap((grid) => grid.currencies())),
  ]
    .filter((currency) => currency !== options.retainedEarningsCurrency)
    .sort();

  const entries: JournalEntry[] = [];
  for (const currency of currencies) {
    entries.push(...closeForeignCurrency(currency, income, expense, options));
  }
  const functional = closeFunctionalCurrency(income, expense, incomeCodes, expenseCodes, options);
  if (functional !== null) {
    entries.push(functional);
  }
  return entries;
}

function assertClosingTarget(tree: AccountTree, options: ClosingOptions): void {
  for (const code of [options.retainedEarningsCode, options.fxClearingCode]) {
    const account = tree.get(code);
    if (account.type !== 'equity') {
      throw new ValidationError(
        `Closing requires equity accounts, but '${code}' is a ${account.type} account.`,
        { code, type: account.type },
      );
    }
    if (tree.childrenOf(code).length > 0) {
      throw new ValidationError(
        `Closing account '${code}' must be a leaf so closing entries stay postable.`,
        { code },
      );
    }
  }
  if (options.retainedEarningsCode === options.fxClearingCode) {
    throw new ValidationError('Retained earnings and FX clearing must be different accounts.', {
      code: options.retainedEarningsCode,
    });
  }
  if (options.date < options.to) {
    throw new ValidationError('A closing entry cannot be dated before the period it closes.', {
      date: options.date,
      to: options.to,
    });
  }
}

type MovementsByCode = ReadonlyMap<string, MovementGrid>;

/** Per-account movements for a set of accounts, keeping each account separate. */
function collectByCode(
  movements: ReturnType<typeof computeMovements>,
  codes: readonly string[],
  debitNormal: boolean,
): MovementsByCode {
  const byCode = new Map<string, MovementGrid>();
  for (const code of codes) {
    const grid = new MovementGrid();
    for (const movement of movements.direct(code, debitNormal)) {
      if (movement.debit !== 0n || movement.credit !== 0n) {
        grid.addMovement(movement.currency, movement.debit, movement.credit);
      }
    }
    byCode.set(code, grid);
  }
  return byCode;
}

/**
 * Debits a credit-normal account (or credits a debit-normal one) so its balance
 * goes to zero, and reports what that does to the period result.
 */
function zeroingLines(
  currency: CurrencyCode,
  byCode: MovementsByCode,
  codes: readonly string[],
  incomeSign: bigint,
): LineSet {
  const postings: PostingInput[] = [];
  let net = 0n;
  for (const code of codes) {
    const bucket = byCode.get(code)?.get(currency) ?? { debit: 0n, credit: 0n };
    const balance = incomeSign > 0n ? bucket.credit - bucket.debit : bucket.debit - bucket.credit;
    if (balance === 0n) {
      continue;
    }
    net += incomeSign * balance;
    const needsDebit = incomeSign > 0n ? balance > 0n : balance < 0n;
    postings.push({
      accountCode: code,
      side: needsDebit ? 'debit' : 'credit',
      amount: Money.fromMinor(currency, abs(balance)),
    });
  }
  return { postings, net };
}

function closeFunctionalCurrency(
  income: MovementsByCode,
  expense: MovementsByCode,
  incomeCodes: readonly string[],
  expenseCodes: readonly string[],
  options: ClosingOptions,
): JournalEntry | null {
  const currency = options.retainedEarningsCurrency;
  const revenue = zeroingLines(currency, income, incomeCodes, 1n);
  const costs = zeroingLines(currency, expense, expenseCodes, -1n);
  const postings = [...revenue.postings, ...costs.postings];
  if (postings.length === 0) {
    return null;
  }
  const netIncome = revenue.net + costs.net;
  if (netIncome !== 0n) {
    postings.push(retainedEarningsPosting(netIncome, currency, options));
  }
  if (postings.length < 2) {
    throw new EmptyEntryError(`period ended with a zero balance in ${currency}`);
  }
  return createEntry({
    id: options.nextId(),
    sequence: options.nextSequence(),
    date: options.date,
    memo: options.memo ?? closeMemo(options, currency),
    reference: closeReference(options, currency),
    postings,
    tags: ['closing'],
    source: { kind: 'adjustment' },
    ...(options.recordedAt === undefined ? {} : { recordedAt: options.recordedAt }),
  });
}

/**
 * Closes a foreign-currency period as a matched pair: the result leaves the
 * foreign temporary accounts into the equity clearing account, and the
 * translated amount moves from there into retained earnings.
 */
function closeForeignCurrency(
  currency: CurrencyCode,
  income: MovementsByCode,
  expense: MovementsByCode,
  options: ClosingOptions,
): JournalEntry[] {
  const incomeCodes = leafCodesOfTypeCodes(income);
  const expenseCodes = leafCodesOfTypeCodes(expense);
  const revenue = zeroingLines(currency, income, incomeCodes, 1n);
  const costs = zeroingLines(currency, expense, expenseCodes, -1n);
  const postings = [...revenue.postings, ...costs.postings];
  const netIncome = revenue.net + costs.net;
  if (postings.length === 0 || netIncome === 0n) {
    return [];
  }

  postings.push(retainedEarningsPosting(netIncome, currency, options, options.fxClearingCode));

  const translated = options.fx.convert(
    Money.fromMinor(currency, netIncome),
    options.retainedEarningsCurrency,
    options.date,
  );
  if (translated.minor === 0n) {
    throw new ValidationError(
      `Closing ${currency} for ${options.from ?? 'inception'}..${options.to} translated to a ` +
        `zero result in ${options.retainedEarningsCurrency}; the exchange rate rounded the ` +
        'period result away, so the period cannot be closed as a single entry.',
      { currency, netIncome: netIncome.toString(), date: options.date },
    );
  }

  const first = createEntry({
    id: options.nextId(),
    sequence: options.nextSequence(),
    date: options.date,
    memo: options.memo ?? closeMemo(options, currency),
    reference: closeReference(options, currency),
    postings,
    tags: ['closing', 'fx'],
    source: { kind: 'adjustment' },
    ...(options.recordedAt === undefined ? {} : { recordedAt: options.recordedAt }),
  });

  const second = createEntry({
    id: options.nextId(),
    sequence: options.nextSequence(),
    date: options.date,
    memo: `Translate ${currency} result into ${options.retainedEarningsCurrency}`,
    reference: `${closeReference(options, currency)}:translated`,
    postings: [
      {
        accountCode: options.fxClearingCode,
        side: translated.minor > 0n ? 'debit' : 'credit',
        amount: translated.abs(),
      },
      retainedEarningsPosting(translated.minor, options.retainedEarningsCurrency, options),
    ],
    tags: ['closing', 'fx'],
    source: { kind: 'adjustment' },
    ...(options.recordedAt === undefined ? {} : { recordedAt: options.recordedAt }),
  });

  return [first, second];
}

function retainedEarningsPosting(
  amount: bigint,
  currency: CurrencyCode,
  options: ClosingOptions,
  target: string = options.retainedEarningsCode,
): PostingInput {
  return {
    accountCode: target,
    side: amount > 0n ? 'credit' : 'debit',
    amount: Money.fromMinor(currency, abs(amount)),
  };
}

function closeMemo(options: ClosingOptions, currency: CurrencyCode): string {
  return options.memo ?? `Close ${currency} ${options.from ?? 'inception'}..${options.to}`;
}

function closeReference(options: ClosingOptions, currency: CurrencyCode): string {
  return `close:${options.from ?? 'inception'}:${options.to}:${currency}`;
}

function leafCodesOfTypeCodes(byCode: MovementsByCode): string[] {
  return [...byCode.keys()];
}

function leafCodesOfType(tree: AccountTree, type: 'income' | 'expense'): string[] {
  return tree.codesOfType(type).filter((code) => tree.childrenOf(code).length === 0);
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}
