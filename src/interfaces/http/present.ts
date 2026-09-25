import type { ClosedPeriod } from '../../application/ports.js';
import type { IntegrityReport } from '../../application/service.js';
import type { Account } from '../../domain/account.js';
import type { FxRate } from '../../domain/fx.js';
import type { JournalEntry } from '../../domain/journal.js';
import type { Money } from '../../domain/money.js';
import type { Occurrence, RecurrenceRule } from '../../domain/recurring.js';
import type {
  AccountStatement,
  BalanceSheet,
  IncomeStatement,
  Movement,
  ReportLine,
  StatementSection,
  TrialBalance,
} from '../../domain/statements.js';

/**
 * JSON presenters.
 *
 * `bigint` has no JSON representation, and turning a 19-digit minor-unit amount
 * into a JavaScript number would quietly corrupt it the moment it crossed the
 * wire. Every amount is therefore serialised as `{ currency, minor, decimal }`,
 * where `minor` is a string: exact on the way out, exact on the way back in.
 */

export interface MoneyJson {
  readonly currency: string;
  readonly minor: string;
  readonly decimal: string;
}

export function presentMoney(money: Money): MoneyJson {
  return money.toJSON();
}

export function presentMovements(movements: readonly Movement[]): Record<string, unknown>[] {
  return movements.map((movement) => ({
    currency: movement.currency,
    debit: movement.debit.toString(),
    credit: movement.credit.toString(),
    net: movement.net.toString(),
  }));
}

export function presentAccount(account: Account): Record<string, unknown> {
  return {
    code: account.code,
    name: account.name,
    type: account.type,
    parentCode: account.parentCode,
    currency: account.currency,
    description: account.description,
    tags: account.tags,
    computed: account.computed,
    system: account.system,
    createdAt: account.createdAt,
  };
}

export function presentEntry(entry: JournalEntry): Record<string, unknown> {
  return {
    id: entry.id,
    sequence: entry.sequence,
    date: entry.date,
    memo: entry.memo,
    reference: entry.reference,
    tags: entry.tags,
    recordedAt: entry.recordedAt,
    reversesId: entry.reversesId,
    source: entry.source,
    postings: entry.postings.map((posting) => ({
      accountCode: posting.accountCode,
      side: posting.side,
      amount: presentMoney(posting.amount),
      memo: posting.memo,
    })),
  };
}

export function presentRate(rate: FxRate): Record<string, unknown> {
  return {
    id: rate.id,
    base: rate.base,
    quote: rate.quote,
    rate: rate.rate.toDecimalString(10),
    rateExact: {
      numerator: rate.rate.numerator.toString(),
      denominator: rate.rate.denominator.toString(),
    },
    effectiveDate: rate.effectiveDate,
    source: rate.source,
    recordedAt: rate.recordedAt,
  };
}

export function presentRule(rule: RecurrenceRule): Record<string, unknown> {
  return {
    id: rule.id,
    frequency: rule.frequency,
    interval: rule.interval,
    startDate: rule.startDate,
    endDate: rule.endDate,
    maxOccurrences: rule.maxOccurrences,
    adjustWeekend: rule.adjustWeekend,
    memo: rule.memo,
    reference: rule.reference,
    active: rule.active,
    createdAt: rule.createdAt,
    tags: rule.tags,
    postings: rule.postings.map((posting) => ({
      accountCode: posting.accountCode,
      side: posting.side,
      amount: presentMoney(posting.amount),
      memo: posting.memo,
    })),
  };
}

export function presentOccurrence(occurrence: Occurrence): Record<string, unknown> {
  return {
    index: occurrence.index,
    scheduledDate: occurrence.scheduledDate,
    date: occurrence.date,
    adjusted: occurrence.adjusted,
    entryId: occurrence.entryId,
  };
}

export function presentClosedPeriod(period: ClosedPeriod): Record<string, unknown> {
  return {
    id: period.id,
    from: period.from,
    to: period.to,
    functionalCurrency: period.functionalCurrency,
    entryIds: period.entryIds,
    closedAt: period.closedAt,
    closedBy: period.closedBy,
  };
}

function presentLine(line: ReportLine): Record<string, unknown> {
  return {
    code: line.code,
    name: line.name,
    type: line.type,
    depth: line.depth,
    isSubtotal: line.isSubtotal,
    amount: presentMoney(line.amount),
    byCurrency: presentMovements(line.byCurrency),
  };
}

function presentSection(section: StatementSection): Record<string, unknown> {
  return {
    title: section.title,
    total: presentMoney(section.total),
    lines: section.lines.map(presentLine),
  };
}

export function presentTrialBalance(report: TrialBalance): Record<string, unknown> {
  return {
    asOf: report.asOf,
    from: report.from ?? null,
    functionalCurrency: report.functionalCurrency,
    rateMode: report.rateMode,
    rows: report.rows.map((row) => ({
      ...presentLine(row),
      debit: presentMoney(row.debit),
      credit: presentMoney(row.credit),
    })),
    totals: {
      debit: presentMoney(report.totals.debit),
      credit: presentMoney(report.totals.credit),
      difference: presentMoney(report.totals.difference),
      balanced: report.totals.balanced,
    },
  };
}

export function presentBalanceSheet(report: BalanceSheet): Record<string, unknown> {
  return {
    asOf: report.asOf,
    functionalCurrency: report.functionalCurrency,
    assets: presentSection(report.assets),
    liabilities: presentSection(report.liabilities),
    equity: presentSection(report.equity),
    currentEarnings: presentMoney(report.currentEarnings),
    totalAssets: presentMoney(report.totalAssets),
    totalLiabilitiesAndEquity: presentMoney(report.totalLiabilitiesAndEquity),
    difference: presentMoney(report.difference),
    balanced: report.balanced,
  };
}

export function presentIncomeStatement(report: IncomeStatement): Record<string, unknown> {
  return {
    from: report.from ?? null,
    to: report.to,
    functionalCurrency: report.functionalCurrency,
    rateMode: report.rateMode,
    revenue: presentSection(report.revenue),
    expenses: presentSection(report.expenses),
    totalRevenue: presentMoney(report.totalRevenue),
    totalExpenses: presentMoney(report.totalExpenses),
    netIncome: presentMoney(report.netIncome),
  };
}

export function presentAccountStatement(report: AccountStatement): Record<string, unknown> {
  return {
    account: presentAccount(report.account),
    from: report.from ?? null,
    to: report.to ?? null,
    functionalCurrency: report.functionalCurrency,
    openingBalance: presentMoney(report.openingBalance),
    closingBalance: presentMoney(report.closingBalance),
    totalDebits: presentMoney(report.totalDebits),
    totalCredits: presentMoney(report.totalCredits),
    lines: report.lines.map((line) => ({
      date: line.date,
      sequence: line.sequence,
      entryId: line.entryId,
      memo: line.memo,
      reference: line.reference,
      side: line.side,
      amount: presentMoney(line.amount),
      runningBalance: presentMoney(line.runningBalance),
    })),
  };
}

export function presentIntegrity(report: IntegrityReport): Record<string, unknown> {
  return {
    balanced: report.balanced,
    entries: report.entries,
    accounts: report.accounts,
    imbalances: report.imbalances,
    unknownAccounts: report.unknownAccounts,
    problems: report.problems,
  };
}
