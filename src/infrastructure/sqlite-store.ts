import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { BooksLoad, BooksSnapshot, ClosedPeriod, LedgerStore } from '../application/ports.js';
import { VersionConflictError } from '../application/ports.js';
import { type Account, createAccount } from '../domain/account.js';
import type { CurrencyCode } from '../domain/currency.js';
import type { IsoDate } from '../domain/date.js';
import { createRate, type FxRate } from '../domain/fx.js';
import { createEntry, type JournalEntry, type Posting } from '../domain/journal.js';
import { Money } from '../domain/money.js';
import { Ratio } from '../domain/ratio.js';
import type { RecurrenceInput, RecurrenceRule } from '../domain/recurring.js';
import { createRule } from '../domain/recurring.js';

export interface SqliteStoreOptions {
  /** File path, or `:memory:` for a throwaway database. */
  readonly path: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,
  parent_code TEXT,
  currency    TEXT,
  description TEXT NOT NULL,
  tags        TEXT NOT NULL,
  computed    INTEGER NOT NULL,
  system      INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entries (
  id           TEXT PRIMARY KEY,
  sequence     INTEGER NOT NULL UNIQUE,
  date         TEXT NOT NULL,
  memo         TEXT NOT NULL,
  reference    TEXT NOT NULL,
  tags         TEXT NOT NULL,
  recorded_at  TEXT NOT NULL,
  reverses_id  TEXT,
  source_kind  TEXT NOT NULL,
  source_rule  TEXT,
  source_idem  TEXT
);

CREATE TABLE IF NOT EXISTS postings (
  entry_id     TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  account_code TEXT NOT NULL REFERENCES accounts(code),
  side         TEXT NOT NULL,
  currency     TEXT NOT NULL,
  minor        TEXT NOT NULL,
  memo         TEXT NOT NULL,
  PRIMARY KEY (entry_id, position)
);

CREATE TABLE IF NOT EXISTS fx_rates (
  id             TEXT PRIMARY KEY,
  base           TEXT NOT NULL,
  quote          TEXT NOT NULL,
  rate_numerator  TEXT NOT NULL,
  rate_denominator TEXT NOT NULL,
  effective_date TEXT NOT NULL,
  source         TEXT NOT NULL,
  recorded_at    TEXT NOT NULL,
  UNIQUE (base, quote, effective_date)
);

CREATE TABLE IF NOT EXISTS rules (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL,
  document    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS closed_periods (
  id                   TEXT PRIMARY KEY,
  from_date            TEXT,
  to_date              TEXT NOT NULL,
  functional_currency  TEXT NOT NULL,
  entry_ids            TEXT NOT NULL,
  closed_at            TEXT NOT NULL,
  closed_by            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS postings_account_idx ON postings(account_code);
CREATE INDEX IF NOT EXISTS entries_date_idx ON entries(date);
`;

/**
 * SQLite-backed persistence, using Node's built-in `node:sqlite`.
 *
 * Two design decisions worth stating:
 *
 * 1. **Postings are a table of their own.** Reporting is a join, not a JSON blob
 *    scan, so `SELECT ... WHERE account_code = ?` stays fast as the ledger grows.
 * 2. **Loading rebuilds the domain through `createEntry`.** Every invariant is
 *    re-checked on the way out of the database, so a hand-edited or truncated file
 *    fails loudly at startup instead of quietly producing wrong reports.
 */
export class SqliteStore implements LedgerStore {
  private readonly database: DatabaseSync;
  private closed = false;
  private readonly statements: {
    readonly readVersion: StatementSync;
    readonly writeVersion: StatementSync;
    readonly selectAccounts: StatementSync;
    readonly upsertAccount: StatementSync;
    readonly deleteAccount: StatementSync;
    readonly selectEntries: StatementSync;
    readonly selectPostings: StatementSync;
    readonly upsertEntry: StatementSync;
    readonly deleteEntry: StatementSync;
    readonly upsertPosting: StatementSync;
    readonly selectRates: StatementSync;
    readonly upsertRate: StatementSync;
    readonly deleteRate: StatementSync;
    readonly selectRules: StatementSync;
    readonly upsertRule: StatementSync;
    readonly deleteRule: StatementSync;
    readonly selectPeriods: StatementSync;
    readonly upsertPeriod: StatementSync;
    readonly deletePeriod: StatementSync;
  };

  constructor(options: SqliteStoreOptions) {
    this.database = new DatabaseSync(options.path);
    this.database.exec('PRAGMA journal_mode = WAL');
    this.database.exec('PRAGMA foreign_keys = ON');
    this.database.exec(SCHEMA);
    this.statements = {
      readVersion: this.database.prepare('SELECT value FROM meta WHERE key = ?'),
      writeVersion: this.database.prepare(
        'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ),
      selectAccounts: this.database.prepare('SELECT * FROM accounts'),
      upsertAccount: this.database.prepare(`
        INSERT INTO accounts(code, name, type, parent_code, currency, description, tags, computed, system, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET
          name = excluded.name, type = excluded.type, parent_code = excluded.parent_code,
          currency = excluded.currency, description = excluded.description, tags = excluded.tags,
          computed = excluded.computed, system = excluded.system, created_at = excluded.created_at`),
      deleteAccount: this.database.prepare('DELETE FROM accounts WHERE code = ?'),
      selectEntries: this.database.prepare('SELECT * FROM entries ORDER BY sequence'),
      selectPostings: this.database.prepare(
        'SELECT * FROM postings WHERE entry_id = ? ORDER BY position',
      ),
      upsertEntry: this.database.prepare(`
        INSERT INTO entries(id, sequence, date, memo, reference, tags, recorded_at, reverses_id, source_kind, source_rule, source_idem)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          sequence = excluded.sequence, date = excluded.date, memo = excluded.memo,
          reference = excluded.reference, tags = excluded.tags, recorded_at = excluded.recorded_at,
          reverses_id = excluded.reverses_id, source_kind = excluded.source_kind,
          source_rule = excluded.source_rule, source_idem = excluded.source_idem`),
      deleteEntry: this.database.prepare('DELETE FROM entries WHERE id = ?'),
      upsertPosting: this.database.prepare(`
        INSERT INTO postings(entry_id, position, account_code, side, currency, minor, memo)
        VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entry_id, position) DO UPDATE SET
          account_code = excluded.account_code, side = excluded.side,
          currency = excluded.currency, minor = excluded.minor, memo = excluded.memo`),
      selectRates: this.database.prepare('SELECT * FROM fx_rates'),
      upsertRate: this.database.prepare(`
        INSERT INTO fx_rates(id, base, quote, rate_numerator, rate_denominator, effective_date, source, recorded_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          base = excluded.base, quote = excluded.quote, rate_numerator = excluded.rate_numerator,
          rate_denominator = excluded.rate_denominator, effective_date = excluded.effective_date,
          source = excluded.source, recorded_at = excluded.recorded_at`),
      deleteRate: this.database.prepare('DELETE FROM fx_rates WHERE id = ?'),
      selectRules: this.database.prepare('SELECT id, document FROM rules'),
      upsertRule: this.database.prepare(`
        INSERT INTO rules(id, created_at, document) VALUES(?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at, document = excluded.document`),
      deleteRule: this.database.prepare('DELETE FROM rules WHERE id = ?'),
      selectPeriods: this.database.prepare('SELECT * FROM closed_periods ORDER BY closed_at'),
      upsertPeriod: this.database.prepare(`
        INSERT INTO closed_periods(id, from_date, to_date, functional_currency, entry_ids, closed_at, closed_by)
        VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          from_date = excluded.from_date, to_date = excluded.to_date,
          functional_currency = excluded.functional_currency, entry_ids = excluded.entry_ids,
          closed_at = excluded.closed_at, closed_by = excluded.closed_by`),
      deletePeriod: this.database.prepare('DELETE FROM closed_periods WHERE id = ?'),
    };
  }

  load(): Promise<BooksLoad> {
    const snapshot: BooksSnapshot = {
      accounts: this.readAccounts(),
      entries: this.readEntries(),
      rates: this.readRates(),
      rules: this.readRules(),
      closedPeriods: this.readPeriods(),
    };
    return Promise.resolve({ snapshot, version: this.readVersion() });
  }

  save(snapshot: BooksSnapshot, expectedVersion: number): Promise<number> {
    const current = this.readVersion();
    if (current !== expectedVersion) {
      return Promise.reject(new VersionConflictError(expectedVersion, current));
    }
    const next = current + 1;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.syncAccounts(snapshot.accounts);
      this.syncEntries(snapshot.entries);
      this.syncRates(snapshot.rates);
      this.syncRules(snapshot.rules);
      this.syncPeriods(snapshot.closedPeriods);
      this.statements.writeVersion.run('version', String(next));
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return Promise.resolve(next);
  }

  close(): Promise<void> {
    // Idempotent: hosts close on shutdown paths that can run more than once.
    if (!this.closed) {
      this.closed = true;
      this.database.close();
    }
    return Promise.resolve();
  }

  // ------------------------------------------------------------------- reads

  private readVersion(): number {
    const row = this.statements.readVersion.get('version') as { value?: string } | undefined;
    return row === undefined ? 0 : Number(row.value);
  }

  private readAccounts(): Account[] {
    const rows = this.statements.selectAccounts.all() as Record<string, unknown>[];
    return rows.map((row) =>
      createAccount({
        code: String(row.code),
        name: String(row.name),
        type: String(row.type) as Account['type'],
        parentCode: row.parent_code === null ? null : String(row.parent_code),
        currency: row.currency === null ? null : (String(row.currency) as CurrencyCode),
        description: String(row.description),
        tags: parseTags(row.tags),
        computed: Number(row.computed) === 1,
        system: Number(row.system) === 1,
        createdAt: String(row.created_at),
      }),
    );
  }

  private readEntries(): JournalEntry[] {
    const rows = this.statements.selectEntries.all() as Record<string, unknown>[];
    return rows.map((row) => {
      const id = String(row.id);
      const postings = this.readPostings(id);
      return createEntry({
        id,
        sequence: Number(row.sequence),
        date: String(row.date) as IsoDate,
        memo: String(row.memo),
        reference: String(row.reference),
        tags: parseTags(row.tags),
        recordedAt: String(row.recorded_at),
        reversesId: row.reverses_id === null ? null : String(row.reverses_id),
        postings: postings.map((posting) => ({
          accountCode: posting.accountCode,
          side: posting.side,
          amount: posting.amount,
          memo: posting.memo,
        })),
        source: {
          kind: String(row.source_kind) as JournalEntry['source']['kind'],
          ...(row.source_rule === null ? {} : { ruleId: String(row.source_rule) }),
          ...(row.source_idem === null ? {} : { idempotencyKey: String(row.source_idem) }),
        },
      });
    });
  }

  private readPostings(entryId: string): Posting[] {
    const rows = this.statements.selectPostings.all(entryId) as Record<string, unknown>[];
    return rows.map((row) => ({
      accountCode: String(row.account_code),
      side: String(row.side) as 'debit' | 'credit',
      amount: Money.fromMinor(String(row.currency) as CurrencyCode, BigInt(String(row.minor))),
      memo: String(row.memo),
    }));
  }

  private readRates(): FxRate[] {
    const rows = this.statements.selectRates.all() as Record<string, unknown>[];
    return rows.map((row) =>
      createRate({
        id: String(row.id),
        base: String(row.base) as CurrencyCode,
        quote: String(row.quote) as CurrencyCode,
        rate: Ratio.of(BigInt(String(row.rate_numerator)), BigInt(String(row.rate_denominator))),
        effectiveDate: String(row.effective_date) as IsoDate,
        source: String(row.source),
        recordedAt: String(row.recorded_at),
      }),
    );
  }

  private readRules(): RecurrenceRule[] {
    const rows = this.statements.selectRules.all() as { id: string; document: string }[];
    return rows.map((row) => deserializeRule(row.document));
  }

  private readPeriods(): ClosedPeriod[] {
    const rows = this.statements.selectPeriods.all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      from: row.from_date === null ? null : String(row.from_date),
      to: String(row.to_date),
      functionalCurrency: String(row.functional_currency),
      entryIds: (JSON.parse(String(row.entry_ids)) as string[]).slice(),
      closedAt: String(row.closed_at),
      closedBy: String(row.closed_by),
    }));
  }

  // ------------------------------------------------------------------ syncing

  private syncAccounts(accounts: readonly Account[]): void {
    const keep = new Set(accounts.map((account) => account.code));
    for (const row of this.statements.selectAccounts.all() as { code: string }[]) {
      if (!keep.has(row.code)) {
        this.statements.deleteAccount.run(row.code);
      }
    }
    for (const account of accounts) {
      this.statements.upsertAccount.run(
        account.code,
        account.name,
        account.type,
        account.parentCode,
        account.currency,
        account.description,
        JSON.stringify(account.tags),
        account.computed ? 1 : 0,
        account.system ? 1 : 0,
        account.createdAt,
      );
    }
  }

  private syncEntries(entries: readonly JournalEntry[]): void {
    const keep = new Set(entries.map((entry) => entry.id));
    for (const row of this.statements.selectEntries.all() as { id: string }[]) {
      if (!keep.has(row.id)) {
        this.statements.deleteEntry.run(row.id);
      }
    }
    for (const entry of entries) {
      this.statements.upsertEntry.run(
        entry.id,
        entry.sequence,
        entry.date,
        entry.memo,
        entry.reference,
        JSON.stringify(entry.tags),
        entry.recordedAt,
        entry.reversesId,
        entry.source.kind,
        entry.source.ruleId ?? null,
        entry.source.idempotencyKey ?? null,
      );
      entry.postings.forEach((posting, position) => {
        this.statements.upsertPosting.run(
          entry.id,
          position,
          posting.accountCode,
          posting.side,
          posting.amount.currency,
          posting.amount.minor.toString(),
          posting.memo,
        );
      });
    }
  }

  private syncRates(rates: readonly FxRate[]): void {
    const keep = new Set(rates.map((rate) => rate.id));
    for (const row of this.statements.selectRates.all() as { id: string }[]) {
      if (!keep.has(row.id)) {
        this.statements.deleteRate.run(row.id);
      }
    }
    for (const rate of rates) {
      this.statements.upsertRate.run(
        rate.id,
        rate.base,
        rate.quote,
        rate.rate.numerator.toString(),
        rate.rate.denominator.toString(),
        rate.effectiveDate,
        rate.source,
        rate.recordedAt,
      );
    }
  }

  private syncRules(rules: readonly RecurrenceRule[]): void {
    const keep = new Set(rules.map((rule) => rule.id));
    for (const row of this.statements.selectRules.all() as { id: string }[]) {
      if (!keep.has(row.id)) {
        this.statements.deleteRule.run(row.id);
      }
    }
    for (const rule of rules) {
      this.statements.upsertRule.run(rule.id, rule.createdAt, serializeRule(rule));
    }
  }

  private syncPeriods(periods: readonly ClosedPeriod[]): void {
    const keep = new Set(periods.map((period) => period.id));
    for (const row of this.statements.selectPeriods.all() as { id: string }[]) {
      if (!keep.has(row.id)) {
        this.statements.deletePeriod.run(row.id);
      }
    }
    for (const period of periods) {
      this.statements.upsertPeriod.run(
        period.id,
        period.from,
        period.to,
        period.functionalCurrency,
        JSON.stringify(period.entryIds),
        period.closedAt,
        period.closedBy,
      );
    }
  }
}

/**
 * Rules are stored as a plain input document rather than a dump of the domain
 * object, and rebuilt with `createRule` on the way out. The same trick keeps
 * `Money` exact — a `Money` is reconstructed from its decimal string, not from a
 * JSON blob with a stringified `bigint` inside it.
 */
interface RuleDocument {
  readonly id: string;
  readonly frequency: string;
  readonly interval: number;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly maxOccurrences: number | null;
  readonly adjustWeekend: string;
  readonly memo: string;
  readonly reference: string;
  readonly tags: string[];
  readonly active: boolean;
  readonly createdAt: string;
  readonly postings: readonly {
    readonly accountCode: string;
    readonly side: 'debit' | 'credit';
    readonly amount: string;
    readonly memo: string;
  }[];
}

function serializeRule(rule: RecurrenceRule): string {
  const document: RuleDocument = {
    id: rule.id,
    frequency: rule.frequency,
    interval: rule.interval,
    startDate: rule.startDate,
    endDate: rule.endDate,
    maxOccurrences: rule.maxOccurrences,
    adjustWeekend: rule.adjustWeekend,
    memo: rule.memo,
    reference: rule.reference,
    tags: [...rule.tags],
    active: rule.active,
    createdAt: rule.createdAt,
    postings: rule.postings.map((posting) => ({
      accountCode: posting.accountCode,
      side: posting.side,
      amount: posting.amount.toString(),
      memo: posting.memo,
    })),
  };
  return JSON.stringify(document);
}

function deserializeRule(raw: string): RecurrenceRule {
  const document = JSON.parse(raw) as RuleDocument;
  return createRule({
    id: document.id,
    frequency: document.frequency as RecurrenceInput['frequency'],
    interval: document.interval,
    startDate: document.startDate as IsoDate,
    ...(document.endDate === null ? {} : { endDate: document.endDate as IsoDate }),
    ...(document.maxOccurrences === null ? {} : { maxOccurrences: document.maxOccurrences }),
    adjustWeekend: document.adjustWeekend as NonNullable<RecurrenceInput['adjustWeekend']>,
    memo: document.memo,
    reference: document.reference,
    tags: document.tags,
    active: document.active,
    createdAt: document.createdAt,
    postings: document.postings.map((posting) => ({
      accountCode: posting.accountCode,
      side: posting.side,
      amount: posting.amount,
      ...(posting.memo === undefined ? {} : { memo: posting.memo }),
    })),
  });
}

function parseTags(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
