/**
 * Ledgerline: a double-entry accounting engine.
 *
 * The public surface is deliberately small — the domain's value objects, the
 * application service that owns them, and the two stores it can sit on.
 */

export type { BooksLoad, BooksSnapshot, ClosedPeriod, LedgerStore } from './application/ports.js';
export { VersionConflictError } from './application/ports.js';
export type {
  ClosePeriodRequest,
  ClosePeriodResult,
  CommandContext,
  IntegrityReport,
  PostEntryRequest,
  PostingRequest,
  PostResult,
  RecurringRuleRequest,
  RecurringRunResult,
  ReportOptions,
  ServiceOptions,
} from './application/service.js';
export { LedgerService, seedAccounts } from './application/service.js';
export {
  type Account,
  type AccountType,
  createAccount,
  normalSide,
  SYSTEM_ACCOUNTS,
} from './domain/account.js';
export { AccountTree, systemChartOfAccounts } from './domain/account-tree.js';
export { buildClosingEntries } from './domain/closing.js';
export { type CurrencyCode, exponentOf, SUPPORTED_CURRENCIES } from './domain/currency.js';
export { addDays, type IsoDate, isIsoDate, parseIsoDate } from './domain/date.js';
export {
  type ErrorCode,
  LedgerError,
  ValidationError,
} from './domain/errors.js';
export { createRate, type FxRate, FxTable } from './domain/fx.js';
export { deterministicId, type Id, newId } from './domain/ids.js';
export {
  createEntry,
  createPosting,
  type JournalEntry,
  type Posting,
  type PostingInput,
} from './domain/journal.js';
export { Ledger } from './domain/ledger.js';
export { Money } from './domain/money.js';
export { assertPostingsAllowed } from './domain/postings.js';
export { Ratio } from './domain/ratio.js';
export {
  createRule,
  occurrences,
  type RecurrenceRule,
} from './domain/recurring.js';
export {
  type AccountStatement,
  accountStatement,
  type BalanceSheet,
  balanceSheet,
  type IncomeStatement,
  incomeStatement,
  type TrialBalance,
  trialBalance,
} from './domain/statements.js';
export { InMemoryStore } from './infrastructure/memory-store.js';
export { SqliteStore } from './infrastructure/sqlite-store.js';
export { buildServer, statusForError } from './interfaces/http/server.js';
