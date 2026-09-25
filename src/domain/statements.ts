import type { Account, AccountType } from './account.js';
import type { AccountTree } from './account-tree.js';
import { assertCurrency, type CurrencyCode } from './currency.js';
import { addDays, type IsoDate, isIsoDate } from './date.js';
import { ValidationError } from './errors.js';
import type { FxTable } from './fx.js';
import type { Ledger } from './ledger.js';
import { Money } from './money.js';
import { Ratio } from './ratio.js';

export interface Movement {
  readonly currency: CurrencyCode;
  readonly debit: bigint;
  readonly credit: bigint;
  /** Debit-positive for asset/expense, credit-positive otherwise. */
  readonly net: bigint;
}

/** Accumulates debit/credit totals per currency. */
export class MovementGrid {
  private readonly byCurrency = new Map<CurrencyCode, { debit: bigint; credit: bigint }>();

  add(currency: CurrencyCode, side: 'debit' | 'credit', minor: bigint): void {
    const bucket = this.byCurrency.get(currency) ?? { debit: 0n, credit: 0n };
    if (side === 'debit') {
      bucket.debit += minor;
    } else {
      bucket.credit += minor;
    }
    this.byCurrency.set(currency, bucket);
  }

  addMovement(currency: CurrencyCode, debit: bigint, credit: bigint): void {
    const bucket = this.byCurrency.get(currency) ?? { debit: 0n, credit: 0n };
    bucket.debit += debit;
    bucket.credit += credit;
    this.byCurrency.set(currency, bucket);
  }

  merge(other: MovementGrid): void {
    for (const [currency, bucket] of other.byCurrency) {
      this.addMovement(currency, bucket.debit, bucket.credit);
    }
  }

  get(currency: CurrencyCode): { debit: bigint; credit: bigint } {
    return this.byCurrency.get(currency) ?? { debit: 0n, credit: 0n };
  }

  currencies(): CurrencyCode[] {
    return [...this.byCurrency.keys()].sort();
  }

  isEmpty(): boolean {
    return this.byCurrency.size === 0;
  }

  toArray(debitNormal: boolean): Movement[] {
    return this.currencies().map((currency) => {
      const { debit, credit } = this.get(currency);
      return { currency, debit, credit, net: debitNormal ? debit - credit : credit - debit };
    });
  }
}

export interface MovementOptions {
  readonly from?: IsoDate;
  readonly to?: IsoDate;
}

/**
 * Per-account movements for a period, with roll-ups.
 *
 * `direct` holds what was posted to the account itself; `subtotal` adds up the
 * whole subtree. Roll-ups are what make a report readable: the balance sheet
 * shows "Cash", "Current assets" and "Assets" from the same postings.
 */
export class AccountMovements {
  private readonly directGrids = new Map<string, MovementGrid>();
  private readonly subtotalGrids = new Map<string, MovementGrid>();

  constructor(private readonly tree: AccountTree) {
    for (const account of tree.ordered()) {
      this.directGrids.set(account.code, new MovementGrid());
      this.subtotalGrids.set(account.code, new MovementGrid());
    }
  }

  private gridFor(code: string): {
    account: Account;
    direct: MovementGrid;
    subtotal: MovementGrid;
  } {
    const account = this.tree.get(code);
    const direct = this.directGrids.get(code);
    const subtotal = this.subtotalGrids.get(code);
    if (direct === undefined || subtotal === undefined) {
      throw new ValidationError(`Account '${code}' is not part of the tree.`, { code });
    }
    return { account, direct, subtotal };
  }

  addPosting(code: string, currency: CurrencyCode, side: 'debit' | 'credit', minor: bigint): void {
    const { direct } = this.gridFor(code);
    direct.add(currency, side, minor);
  }

  /**
   * Seeds each account's subtotal with its own postings, then pushes subtotals
   * up the tree. Children must be rolled up before their parents, which reverse
   * pre-order guarantees.
   */
  seal(): void {
    for (const account of this.tree.ordered()) {
      const { direct, subtotal } = this.gridFor(account.code);
      subtotal.merge(direct);
    }
    for (const account of [...this.tree.ordered()].reverse()) {
      if (account.parentCode === null) {
        continue;
      }
      const { subtotal } = this.gridFor(account.code);
      this.gridFor(account.parentCode).subtotal.merge(subtotal);
    }
  }

  direct(code: string, debitNormal: boolean): Movement[] {
    return (this.directGrids.get(this.tree.get(code).code) ?? new MovementGrid()).toArray(
      debitNormal,
    );
  }

  subtotal(code: string, debitNormal: boolean): Movement[] {
    return (this.subtotalGrids.get(this.tree.get(code).code) ?? new MovementGrid()).toArray(
      debitNormal,
    );
  }

  /** Union of every currency seen anywhere in the tree. */
  currencies(): CurrencyCode[] {
    const all = new Set<CurrencyCode>();
    for (const account of this.tree.ordered()) {
      for (const currency of (
        this.subtotalGrids.get(account.code) ?? new MovementGrid()
      ).currencies()) {
        all.add(currency);
      }
    }
    return [...all].sort();
  }
}

export function isDebitNormal(type: AccountType): boolean {
  return type === 'asset' || type === 'expense';
}

export interface Period {
  readonly from?: IsoDate;
  readonly to?: IsoDate;
}

/** Narrows a {@link Period} into a ledger query, honouring exact optional props. */
export function entryQueryOf(period: Period): { from?: IsoDate; to?: IsoDate } {
  return {
    ...(period.from === undefined ? {} : { from: period.from }),
    ...(period.to === undefined ? {} : { to: period.to }),
  };
}

export function assertPeriod(period: Period): Period {
  if (period.from !== undefined && !isIsoDate(period.from)) {
    throw new ValidationError(`'${period.from}' is not a valid YYYY-MM-DD date.`, {
      date: period.from,
    });
  }
  if (period.to !== undefined && !isIsoDate(period.to)) {
    throw new ValidationError(`'${period.to}' is not a valid YYYY-MM-DD date.`, {
      date: period.to,
    });
  }
  if (period.from !== undefined && period.to !== undefined && period.from > period.to) {
    throw new ValidationError('Period start must not be after period end.', {
      from: period.from,
      to: period.to,
    });
  }
  return period;
}

export interface StatementOptions {
  readonly functionalCurrency: CurrencyCode;
  readonly fx: FxTable;
  /** `closing` uses the report date's rate; `average` day-weights the period. */
  readonly rateMode?: 'closing' | 'average';
}

/** Resolves and caches the rates needed to present one report. */
export class Translator {
  private readonly rates: ReadonlyMap<string, Ratio>;

  constructor(
    readonly functionalCurrency: CurrencyCode,
    private readonly fx: FxTable,
    rates: ReadonlyMap<string, Ratio>,
  ) {
    this.functionalCurrency = assertCurrency(functionalCurrency);
    this.rates = rates;
  }

  static create(
    options: StatementOptions,
    currencies: Iterable<CurrencyCode>,
    period: Period,
  ): Translator {
    const rateDate = period.to;
    if (rateDate === undefined) {
      throw new ValidationError('A report needs an end date to resolve exchange rates.');
    }
    const rates = options.fx.ratesFor(
      currencies,
      options.functionalCurrency,
      rateDate,
      options.rateMode ?? 'closing',
      period.from,
    );
    return new Translator(options.functionalCurrency, options.fx, rates);
  }

  rate(currency: CurrencyCode): Ratio {
    return this.rates.get(currency) ?? Ratio.ONE;
  }

  /** Converts a signed minor amount into the functional currency. */
  to(currency: CurrencyCode, minor: bigint): Money {
    if (currency === this.functionalCurrency) {
      return Money.fromMinor(this.functionalCurrency, minor);
    }
    return Money.fromMinor(
      this.functionalCurrency,
      this.fx.convertMinor(currency, minor, this.functionalCurrency, this.rate(currency)),
    );
  }

  /** Sums a movement list into one functional-currency amount. */
  total(movements: readonly Movement[]): Money {
    let sum = 0n;
    for (const movement of movements) {
      sum += this.to(movement.currency, movement.net).minor;
    }
    return Money.fromMinor(this.functionalCurrency, sum);
  }

  /** Debit and credit columns, each translated separately. */
  columns(movements: readonly Movement[]): { debit: Money; credit: Money } {
    let debits = 0n;
    let credits = 0n;
    for (const movement of movements) {
      debits += this.to(movement.currency, movement.debit).minor;
      credits += this.to(movement.currency, movement.credit).minor;
    }
    return {
      debit: Money.fromMinor(this.functionalCurrency, debits),
      credit: Money.fromMinor(this.functionalCurrency, credits),
    };
  }
}

/** Folds the ledger into per-account movements for a period. */
export function computeMovements(
  ledger: Ledger,
  tree: AccountTree,
  period: Period = {},
): AccountMovements {
  assertPeriod(period);
  const movements = new AccountMovements(tree);
  for (const entry of ledger.query(entryQueryOf(period))) {
    for (const posting of entry.postings) {
      movements.addPosting(
        posting.accountCode,
        posting.amount.currency,
        posting.side,
        posting.amount.minor,
      );
    }
  }
  movements.seal();
  return movements;
}

export interface ReportLine {
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly depth: number;
  readonly isSubtotal: boolean;
  readonly amount: Money;
  readonly byCurrency: readonly Movement[];
}

export interface StatementSection {
  readonly title: string;
  readonly lines: readonly ReportLine[];
  readonly total: Money;
}

function buildSection(
  tree: AccountTree,
  movements: AccountMovements,
  codes: readonly string[],
  translator: Translator,
  options: { readonly subtotalsFromDepth: number },
): StatementSection {
  const lines: ReportLine[] = [];
  for (const code of codes) {
    const account = tree.get(code);
    const depth = tree.depthOf(code);
    const hasChildren = tree.childrenOf(code).length > 0;
    const byCurrency = hasChildren
      ? movements.subtotal(code, isDebitNormal(account.type))
      : movements.direct(code, isDebitNormal(account.type));
    const amount = translator.total(byCurrency);
    const isSubtotal = hasChildren && depth >= options.subtotalsFromDepth;
    if (amount.isZero() && !hasChildren) {
      continue;
    }
    lines.push({
      code: account.code,
      name: account.name,
      type: account.type,
      depth,
      isSubtotal,
      amount,
      byCurrency,
    });
  }
  const total = lines
    .filter((line) => !line.isSubtotal)
    .reduce((sum, line) => sum.add(line.amount), Money.zero(translator.functionalCurrency));
  return { title: '', lines, total };
}

export interface TrialBalanceRow extends ReportLine {
  readonly debit: Money;
  readonly credit: Money;
}

export interface TrialBalance {
  readonly asOf: IsoDate;
  readonly from?: IsoDate;
  readonly functionalCurrency: CurrencyCode;
  readonly rateMode: 'closing' | 'average';
  readonly rows: readonly TrialBalanceRow[];
  readonly totals: {
    readonly debit: Money;
    readonly credit: Money;
    readonly difference: Money;
    readonly balanced: boolean;
  };
}

export function trialBalance(
  ledger: Ledger,
  tree: AccountTree,
  period: Period,
  options: StatementOptions,
): TrialBalance {
  assertPeriod(period);
  const movements = computeMovements(ledger, tree, period);
  const translator = Translator.create(options, movements.currencies(), period);

  const rows: TrialBalanceRow[] = [];
  let totalDebit = 0n;
  let totalCredit = 0n;
  for (const account of tree.ordered()) {
    const hasChildren = tree.childrenOf(account.code).length > 0;
    const byCurrency = hasChildren
      ? movements.subtotal(account.code, isDebitNormal(account.type))
      : movements.direct(account.code, isDebitNormal(account.type));
    if (byCurrency.length === 0) {
      continue;
    }
    const columns = translator.columns(byCurrency);
    if (!hasChildren) {
      // Totals count leaf activity once: parent rows are roll-ups of their
      // children, and adding both would count every posting twice.
      totalDebit += columns.debit.minor;
      totalCredit += columns.credit.minor;
    }
    rows.push({
      code: account.code,
      name: account.name,
      type: account.type,
      depth: tree.depthOf(account.code),
      isSubtotal: hasChildren,
      amount: translator.total(byCurrency),
      byCurrency,
      debit: columns.debit,
      credit: columns.credit,
    });
  }

  const debit = Money.fromMinor(options.functionalCurrency, totalDebit);
  const credit = Money.fromMinor(options.functionalCurrency, totalCredit);
  const difference = debit.subtract(credit);
  return {
    asOf: period.to ?? ledger.latestDate() ?? '',
    ...(period.from === undefined ? {} : { from: period.from }),
    functionalCurrency: options.functionalCurrency,
    rateMode: options.rateMode ?? 'closing',
    rows,
    totals: { debit, credit, difference, balanced: difference.isZero() },
  };
}

export interface BalanceSheet {
  readonly asOf: IsoDate;
  readonly functionalCurrency: CurrencyCode;
  readonly assets: StatementSection;
  readonly liabilities: StatementSection;
  readonly equity: StatementSection;
  /** Net income not yet closed into retained earnings. */
  readonly currentEarnings: Money;
  readonly totalAssets: Money;
  readonly totalLiabilitiesAndEquity: Money;
  readonly difference: Money;
  readonly balanced: boolean;
}

export function balanceSheet(
  ledger: Ledger,
  tree: AccountTree,
  period: Period,
  options: StatementOptions,
): BalanceSheet {
  assertPeriod(period);
  const asOf: IsoDate = period.to ?? ledger.latestDate() ?? '';
  assertReportDate(asOf, 'balance sheet');
  const resolved: Period = period.to === undefined ? { ...period, to: asOf } : period;
  const movements = computeMovements(ledger, tree, resolved);
  const translator = Translator.create(options, movements.currencies(), resolved);

  const section = (title: string, codes: readonly string[]): StatementSection => ({
    ...buildSection(tree, movements, codes, translator, { subtotalsFromDepth: 0 }),
    title,
  });

  const assets = section('Assets', tree.codesOfType('asset'));
  const liabilities = section('Liabilities', tree.codesOfType('liability'));
  const equity = section('Equity', tree.codesOfType('equity'));

  // Only leaves, so parent roll-ups are not counted twice.
  const incomeCodes = tree
    .codesOfType('income')
    .filter((code) => tree.childrenOf(code).length === 0);
  const expenseCodes = tree
    .codesOfType('expense')
    .filter((code) => tree.childrenOf(code).length === 0);
  const revenue = translator.total(incomeCodes.flatMap((code) => movements.subtotal(code, false)));
  const expenses = translator.total(expenseCodes.flatMap((code) => movements.subtotal(code, true)));
  const currentEarnings = revenue.subtract(expenses);

  const totalAssets = assets.total;
  const totalLiabilitiesAndEquity = liabilities.total.add(equity.total).add(currentEarnings);
  const difference = totalAssets.subtract(totalLiabilitiesAndEquity);

  return {
    asOf,
    functionalCurrency: options.functionalCurrency,
    assets,
    liabilities,
    equity,
    currentEarnings,
    totalAssets,
    totalLiabilitiesAndEquity,
    difference,
    balanced: difference.isZero(),
  };
}

export interface IncomeStatement {
  readonly from?: IsoDate;
  readonly to: IsoDate;
  readonly functionalCurrency: CurrencyCode;
  readonly rateMode: 'closing' | 'average';
  readonly revenue: StatementSection;
  readonly expenses: StatementSection;
  readonly netIncome: Money;
  readonly totalRevenue: Money;
  readonly totalExpenses: Money;
}

export function incomeStatement(
  ledger: Ledger,
  tree: AccountTree,
  period: Period,
  options: StatementOptions,
): IncomeStatement {
  assertPeriod(period);
  const to: IsoDate = period.to ?? ledger.latestDate() ?? '';
  assertReportDate(to, 'income statement');
  const resolved: Period = period.to === undefined ? { ...period, to } : period;
  const movements = computeMovements(ledger, tree, resolved);
  const translator = Translator.create(options, movements.currencies(), resolved);

  const section = (title: string, codes: readonly string[]): StatementSection => ({
    ...buildSection(tree, movements, codes, translator, { subtotalsFromDepth: 0 }),
    title,
  });

  const revenue = section('Revenue', tree.codesOfType('income'));
  const expenses = section('Expenses', tree.codesOfType('expense'));
  const netIncome = revenue.total.subtract(expenses.total);

  return {
    ...(resolved.from === undefined ? {} : { from: resolved.from }),
    to,
    functionalCurrency: options.functionalCurrency,
    rateMode: options.rateMode ?? 'closing',
    revenue,
    expenses,
    netIncome,
    totalRevenue: revenue.total,
    totalExpenses: expenses.total,
  };
}

export interface StatementLine {
  readonly date: IsoDate;
  readonly sequence: number;
  readonly entryId: string;
  readonly memo: string;
  readonly reference: string;
  readonly side: 'debit' | 'credit';
  readonly amount: Money;
  readonly runningBalance: Money;
}

export interface AccountStatement {
  readonly account: Account;
  readonly from?: IsoDate;
  readonly to?: IsoDate;
  readonly openingBalance: Money;
  readonly closingBalance: Money;
  readonly totalDebits: Money;
  readonly totalCredits: Money;
  readonly lines: readonly StatementLine[];
  readonly functionalCurrency: CurrencyCode;
}

export function accountStatement(
  ledger: Ledger,
  tree: AccountTree,
  code: string,
  period: Period,
  options: StatementOptions,
): AccountStatement {
  assertPeriod(period);
  const account = tree.get(code);
  const reportDate = period.to ?? ledger.latestDate() ?? '';
  assertReportDate(reportDate, 'account statement');
  const target = assertCurrency(options.functionalCurrency);
  const debitNormal = isDebitNormal(account.type);
  const subtree = new Set(tree.subtreeOf(account.code).map((node) => node.code));

  const opening =
    period.from === undefined
      ? new MovementGrid()
      : // Strictly before the period: the day `from` belongs to the period itself,
        // and counting it in both places would inflate every statement total.
        collectOpening(ledger, subtree, { to: addDays(period.from, -1) });
  const currencies = [...new Set([...opening.currencies(), ...collectCurrencies(ledger, subtree)])];
  const translator = new Translator(
    target,
    options.fx,
    options.fx.ratesFor(currencies, target, reportDate),
  );

  const openingBalance = sumNet(opening.toArray(debitNormal), translator);
  const movement = walkEntries(ledger, subtree, period, translator, debitNormal, openingBalance);

  return {
    account,
    ...(period.from === undefined ? {} : { from: period.from }),
    ...(period.to === undefined ? {} : { to: period.to }),
    openingBalance: Money.fromMinor(target, openingBalance),
    closingBalance: Money.fromMinor(target, movement.running),
    totalDebits: Money.fromMinor(target, movement.debits),
    totalCredits: Money.fromMinor(target, movement.credits),
    lines: movement.lines,
    functionalCurrency: target,
  };
}

function collectOpening(
  ledger: Ledger,
  subtree: ReadonlySet<string>,
  period: Period,
): MovementGrid {
  const grid = new MovementGrid();
  for (const entry of ledger.query(entryQueryOf(period))) {
    for (const posting of entry.postings) {
      if (subtree.has(posting.accountCode)) {
        grid.add(posting.amount.currency, posting.side, posting.amount.minor);
      }
    }
  }
  return grid;
}

function sumNet(movements: readonly Movement[], translator: Translator): bigint {
  return movements.reduce(
    (sum, movement) => sum + translator.to(movement.currency, movement.net).minor,
    0n,
  );
}

interface WalkResult {
  readonly lines: StatementLine[];
  readonly running: bigint;
  readonly debits: bigint;
  readonly credits: bigint;
}

function walkEntries(
  ledger: Ledger,
  subtree: ReadonlySet<string>,
  period: Period,
  translator: Translator,
  debitNormal: boolean,
  openingBalance: bigint,
): WalkResult {
  const lines: StatementLine[] = [];
  let running = openingBalance;
  const totals: Record<'debit' | 'credit', bigint> = { debit: 0n, credit: 0n };

  for (const entry of ledger.query(entryQueryOf(period))) {
    for (const posting of entry.postings) {
      if (!subtree.has(posting.accountCode)) {
        continue;
      }
      const amount = translator.to(posting.amount.currency, posting.amount.minor).minor;
      const signed = (posting.side === 'debit' ? amount : -amount) * (debitNormal ? 1n : -1n);
      running += signed;
      totals[posting.side] += amount;
      lines.push(statementLine(entry, posting.side, amount, running, translator));
    }
  }

  return { lines, running, debits: totals.debit, credits: totals.credit };
}

function statementLine(
  entry: {
    readonly date: IsoDate;
    readonly sequence: number;
    readonly id: string;
    readonly memo: string;
    readonly reference: string;
  },
  side: 'debit' | 'credit',
  amount: bigint,
  running: bigint,
  translator: Translator,
): StatementLine {
  return {
    date: entry.date,
    sequence: entry.sequence,
    entryId: entry.id,
    memo: entry.memo,
    reference: entry.reference,
    side,
    amount: Money.fromMinor(translator.functionalCurrency, amount),
    runningBalance: Money.fromMinor(translator.functionalCurrency, running),
  };
}

/** Reports need a rate date; an empty ledger has none, so say so plainly. */
function assertReportDate(date: IsoDate, report: string): void {
  if (date === '') {
    throw new ValidationError(
      `Cannot build a ${report}: the ledger is empty, so pass an explicit end date.`,
      { report },
    );
  }
}

function collectCurrencies(ledger: Ledger, codes: ReadonlySet<string>): CurrencyCode[] {
  const found = new Set<CurrencyCode>();
  for (const entry of ledger.all()) {
    for (const posting of entry.postings) {
      if (codes.has(posting.accountCode)) {
        found.add(posting.amount.currency);
      }
    }
  }
  return [...found];
}
