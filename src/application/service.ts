import {
  type Account,
  type AccountInput,
  type AccountType,
  createAccount,
  SYSTEM_ACCOUNTS,
} from '../domain/account.js';
import { AccountTree } from '../domain/account-tree.js';
import { buildClosingEntries } from '../domain/closing.js';
import type { CurrencyCode } from '../domain/currency.js';
import type { IsoDate } from '../domain/date.js';
import { ConflictError, ValidationError } from '../domain/errors.js';
import { createRate, type FxRate, type FxRateInput, FxTable } from '../domain/fx.js';
import { deterministicId, type Id, newId } from '../domain/ids.js';
import {
  assertNotAlreadyReversed,
  buildReversal,
  createEntry,
  createPosting,
  type EntryProvenance,
  type EntrySource,
  type JournalEntry,
  type PostingInput,
} from '../domain/journal.js';
import { Ledger } from '../domain/ledger.js';
import { Money } from '../domain/money.js';
import { assertPostingsAllowed } from '../domain/postings.js';
import {
  createRule,
  type Occurrence,
  occurrences,
  occurrenceToEntry,
  type RecurrenceInput,
  type RecurrenceRule,
} from '../domain/recurring.js';
import {
  type AccountStatement,
  accountStatement,
  assertPeriod,
  type BalanceSheet,
  balanceSheet,
  type IncomeStatement,
  incomeStatement,
  type Period,
  type StatementOptions,
  type TrialBalance,
  trialBalance,
} from '../domain/statements.js';
import type { BooksSnapshot, ClosedPeriod, LedgerStore } from './ports.js';

export interface RecurringRuleRequest {
  readonly frequency: NonNullable<RecurrenceInput['frequency']>;
  readonly interval?: number | undefined;
  readonly startDate: IsoDate;
  readonly endDate?: IsoDate | null | undefined;
  readonly maxOccurrences?: number | null | undefined;
  readonly adjustWeekend?: NonNullable<RecurrenceInput['adjustWeekend']> | undefined;
  readonly memo?: string | undefined;
  readonly reference?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  /** Same shape as a manual posting: `{ account, side, amount }`. */
  readonly postings: readonly PostingRequest[];
}

/** The chart of accounts a fresh book starts from. */
export function seedAccounts(): Account[] {
  return SYSTEM_ACCOUNTS.map((input: AccountInput) => createAccount(input));
}

export interface ServiceOptions {
  /** Currency every report is presented in. */
  readonly functionalCurrency: CurrencyCode;
  /** Equity account that receives closed results. */
  readonly retainedEarningsCode: string;
  /** Equity account used to translate foreign results. */
  readonly fxClearingCode: string;
  /** Load the stock chart of accounts when the store is empty. */
  readonly seedSystemAccounts?: boolean;
  readonly clock?: () => Date;
  readonly recordedBy?: string;
}

/**
 * Command payloads as they arrive from a boundary (JSON body, CLI argument).
 *
 * Optional members are typed `?: T | undefined` on purpose: at the edge, an
 * absent key and an explicit `undefined` mean the same thing, and pretending
 * otherwise just moves the problem one layer down.
 */
export interface PostingRequest {
  readonly account: string;
  readonly side: 'debit' | 'credit';
  /** `"1234.56 USD"` or `"USD 1234.56"`. */
  readonly amount: string;
  readonly memo?: string | undefined;
}

export interface PostEntryRequest {
  readonly date: IsoDate;
  readonly memo?: string | undefined;
  readonly reference?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly postings: readonly PostingRequest[];
  readonly source?: EntrySource | undefined;
}

export interface CommandContext {
  /**
   * Replaying a command with the same key resolves to the original result
   * instead of posting twice.
   */
  readonly idempotencyKey?: string;
}

export interface PostResult {
  readonly entry: JournalEntry;
  readonly created: boolean;
}

export interface ClosePeriodRequest {
  readonly from?: IsoDate;
  readonly to: IsoDate;
  readonly date?: IsoDate;
  readonly memo?: string;
  readonly closedBy?: string;
}

export interface ClosePeriodResult {
  readonly entries: readonly JournalEntry[];
  readonly period: ClosedPeriod;
}

export interface RecurringRunResult {
  readonly created: readonly JournalEntry[];
  readonly skipped: number;
  readonly occurrences: readonly Occurrence[];
}

export interface ReportOptions {
  readonly rateMode?: 'closing' | 'average';
}

export interface IntegrityReport {
  readonly balanced: boolean;
  readonly entries: number;
  readonly accounts: number;
  readonly imbalances: readonly { readonly currency: string; readonly difference: string }[];
  readonly unknownAccounts: readonly string[];
  readonly problems: readonly string[];
}

/**
 * The application's single entry point.
 *
 * It owns three things the domain deliberately does not: where state is kept, who
 * may write to it, and how commands map to domain operations. Every mutation runs
 * through {@link serialize}, so a caller never observes a half-applied write, and
 * every write reaches the store before the call returns.
 */
export class LedgerService {
  private readonly options: Required<ServiceOptions>;
  private snapshot: BooksSnapshot | null = null;
  private version = 0;
  private tree: AccountTree | null = null;
  private ledger: Ledger | null = null;
  private fx: FxTable | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: LedgerStore,
    options: ServiceOptions,
  ) {
    this.options = {
      functionalCurrency: options.functionalCurrency,
      retainedEarningsCode: options.retainedEarningsCode,
      fxClearingCode: options.fxClearingCode,
      seedSystemAccounts: options.seedSystemAccounts ?? true,
      clock: options.clock ?? (() => new Date()),
      recordedBy: options.recordedBy ?? 'ledgerline',
    };
  }

  /**
   * The currency this book is reported in. Exposed because callers legitimately
   * need it: a CLI defaulting a bare amount, or a client labelling a total.
   */
  get functionalCurrency(): CurrencyCode {
    return this.options.functionalCurrency;
  }

  // ------------------------------------------------------------------ reading

  async accounts(filter: { readonly type?: AccountType } = {}): Promise<readonly Account[]> {
    await this.ready();
    const tree = this.requireTree();
    return filter.type === undefined
      ? tree.ordered()
      : tree.codesOfType(filter.type).map((code) => tree.get(code));
  }

  async account(code: string): Promise<Account> {
    await this.ready();
    return this.requireTree().get(code);
  }

  async entry(id: Id): Promise<JournalEntry> {
    await this.ready();
    return this.requireLedger().get(id);
  }

  async entries(query: Parameters<Ledger['query']>[0] = {}): Promise<readonly JournalEntry[]> {
    await this.ready();
    return this.requireLedger().query(query);
  }

  async rates(): Promise<readonly FxRate[]> {
    await this.ready();
    return this.requireFx().list();
  }

  async rules(): Promise<readonly RecurrenceRule[]> {
    await this.ready();
    return this.requireSnapshot().rules;
  }

  async rule(id: Id): Promise<RecurrenceRule> {
    await this.ready();
    const found = this.requireSnapshot().rules.find((candidate) => candidate.id === id);
    if (found === undefined) {
      throw new ConflictError(`No recurring rule with id '${id}'.`, { id });
    }
    return found;
  }

  async closedPeriods(): Promise<readonly ClosedPeriod[]> {
    await this.ready();
    return this.requireSnapshot().closedPeriods;
  }

  /** Which entries a rule *would* create, without creating any of them. */
  async previewOccurrences(
    ruleId: Id,
    request: { readonly until: IsoDate; readonly limit?: number },
  ): Promise<readonly Occurrence[]> {
    await this.ready();
    const rule = this.requireSnapshot().rules.find((candidate) => candidate.id === ruleId);
    if (rule === undefined) {
      throw new ConflictError(`No recurring rule with id '${ruleId}'.`, { id: ruleId });
    }
    return occurrences(rule, request.until, request.limit ?? 100);
  }

  // ------------------------------------------------------------------ writing

  async createAccount(input: AccountInput): Promise<Account> {
    return this.serialize(async () => {
      const snapshot = this.requireSnapshot();
      const account = createAccount({ ...input, createdAt: this.nowIso() });
      if (snapshot.accounts.some((existing) => existing.code === account.code)) {
        throw new ConflictError(`Account '${account.code}' already exists.`, {
          code: account.code,
        });
      }
      // Constructing the tree is what validates the new account against the rest.
      const accounts = [...snapshot.accounts, account];
      new AccountTree(accounts);
      await this.persist({ ...snapshot, accounts });
      return account;
    });
  }

  async updateAccount(
    code: string,
    patch: {
      readonly name?: string;
      readonly description?: string;
      readonly tags?: readonly string[];
      readonly parentCode?: string | null;
    },
  ): Promise<Account> {
    return this.serialize(async () => {
      const snapshot = this.requireSnapshot();
      const existing = this.requireTree().get(code);
      const parentCode = patch.parentCode === undefined ? existing.parentCode : patch.parentCode;
      if (existing.system && parentCode !== existing.parentCode) {
        throw new ConflictError(`System account '${code}' cannot be re-parented.`, { code });
      }
      const next = createAccount({
        code: existing.code,
        name: patch.name ?? existing.name,
        type: existing.type,
        parentCode,
        currency: existing.currency,
        description: patch.description ?? existing.description,
        tags: patch.tags ?? existing.tags,
        computed: existing.computed,
        system: existing.system,
        createdAt: existing.createdAt,
      });
      const accounts = snapshot.accounts.map((account) =>
        account.code === existing.code ? next : account,
      );
      new AccountTree(accounts);
      await this.persist({ ...snapshot, accounts });
      return next;
    });
  }

  async postEntry(request: PostEntryRequest, context: CommandContext = {}): Promise<PostResult> {
    return this.serialize(async () => {
      const ledger = this.requireLedger();
      const id =
        context.idempotencyKey === undefined
          ? newId('entry')
          : deterministicId('entry', context.idempotencyKey);
      const existing = ledger.find(id);
      if (existing !== undefined) {
        return { entry: existing, created: false };
      }
      this.assertPeriodOpen(request.date);
      const entry = createEntry({
        id,
        sequence: ledger.nextSequence(),
        date: request.date,
        ...(request.memo === undefined ? {} : { memo: request.memo }),
        ...(request.reference === undefined ? {} : { reference: request.reference }),
        ...(request.tags === undefined ? {} : { tags: request.tags }),
        recordedAt: this.nowIso(),
        postings: request.postings.map(toPostingInput),
        source: provenanceOf(request.source, context),
      });
      assertPostingsAllowed(this.requireTree(), entry.postings);
      await this.appendAll([entry]);
      return { entry, created: true };
    });
  }

  async reverseEntry(
    id: Id,
    options: { readonly date: IsoDate },
    context: CommandContext = {},
  ): Promise<JournalEntry> {
    return this.serialize(async () => {
      const ledger = this.requireLedger();
      const original = ledger.get(id);
      assertNotAlreadyReversed(original, (target) => ledger.reversalOf(target));
      this.assertPeriodOpen(options.date);
      const reversal = buildReversal(original, {
        id:
          context.idempotencyKey === undefined
            ? newId('entry')
            : deterministicId('reversal', context.idempotencyKey),
        sequence: ledger.nextSequence(),
        date: options.date,
        recordedAt: this.nowIso(),
        ...(context.idempotencyKey === undefined ? {} : { idempotencyKey: context.idempotencyKey }),
      });
      await this.appendAll([reversal]);
      return reversal;
    });
  }

  async recordRate(input: FxRateInput): Promise<FxRate> {
    return this.serialize(async () => {
      const snapshot = this.requireSnapshot();
      const rate = createRate({
        ...input,
        id: input.id ?? newId('rate'),
        recordedAt: this.nowIso(),
      });
      const rates = [...snapshot.rates, rate];
      // Rebuilding the table rejects a second rate for the same pair and day.
      new FxTable(rates);
      await this.persist({ ...snapshot, rates });
      return rate;
    });
  }

  async createRecurringRule(input: RecurringRuleRequest): Promise<RecurrenceRule> {
    return this.serialize(async () => {
      const snapshot = this.requireSnapshot();
      const rule = createRule({
        frequency: input.frequency,
        startDate: input.startDate,
        postings: input.postings.map(toPostingInput),
        id: newId('rule'),
        createdAt: this.nowIso(),
        ...(input.interval === undefined ? {} : { interval: input.interval }),
        ...(input.endDate === undefined ? {} : { endDate: input.endDate }),
        ...(input.maxOccurrences === undefined ? {} : { maxOccurrences: input.maxOccurrences }),
        ...(input.adjustWeekend === undefined ? {} : { adjustWeekend: input.adjustWeekend }),
        ...(input.memo === undefined ? {} : { memo: input.memo }),
        ...(input.reference === undefined ? {} : { reference: input.reference }),
        ...(input.tags === undefined ? {} : { tags: input.tags }),
      });
      assertPostingsAllowed(this.requireTree(), rule.postings);
      await this.persist({ ...snapshot, rules: [...snapshot.rules, rule] });
      return rule;
    });
  }

  /**
   * Materialises every occurrence due up to `until`.
   *
   * Occurrence ids are derived from the rule and the date, so running the same
   * rule twice is a no-op: occurrences that already exist are counted as skipped
   * rather than duplicated, which is what makes this safe to run on a schedule.
   */
  async runRecurring(request: {
    readonly until: IsoDate;
    readonly limit?: number;
  }): Promise<RecurringRunResult> {
    return this.serialize(async () => {
      const ledger = this.requireLedger();
      const snapshot = this.requireSnapshot();
      const due: Occurrence[] = [];
      const created: JournalEntry[] = [];
      let skipped = 0;
      let sequence = ledger.nextSequence();

      for (const rule of snapshot.rules) {
        if (!rule.active) {
          continue;
        }
        for (const occurrence of occurrences(rule, request.until, request.limit ?? 500)) {
          if (ledger.has(occurrence.entryId)) {
            skipped += 1;
            continue;
          }
          due.push(occurrence);
          // Checked before anything is written: a run that would post into a
          // sealed period is refused whole, not half-applied.
          this.assertPeriodOpen(occurrence.date);
          created.push(
            createEntry(
              occurrenceToEntry(rule, occurrence, { sequence, recordedAt: this.nowIso() }),
            ),
          );
          sequence += 1;
        }
      }
      await this.appendAll(created);
      return { created, skipped, occurrences: due };
    });
  }

  /**
   * Closes a period into retained earnings.
   *
   * Re-closing the same period is refused rather than performed: a second close
   * would post a fresh set of entries for a result that is now zero, which is
   * trivially easy to do by accident and ruinous to unpick afterwards.
   */
  async closePeriod(request: ClosePeriodRequest): Promise<ClosePeriodResult> {
    return this.serialize(async () => {
      const snapshot = this.requireSnapshot();
      const duplicate = snapshot.closedPeriods.find(
        (period) => period.to === request.to && (period.from ?? null) === (request.from ?? null),
      );
      if (duplicate !== undefined) {
        throw new ConflictError(`The period ending ${request.to} was already closed.`, {
          to: request.to,
          from: request.from ?? null,
          closedAt: duplicate.closedAt,
        });
      }

      const ledger = this.requireLedger();
      let sequence = ledger.nextSequence();
      const entries = buildClosingEntries(ledger, this.requireTree(), {
        ...(request.from === undefined ? {} : { from: request.from }),
        to: request.to,
        date: request.date ?? request.to,
        retainedEarningsCode: this.options.retainedEarningsCode,
        retainedEarningsCurrency: this.options.functionalCurrency,
        fxClearingCode: this.options.fxClearingCode,
        nextId: () => newId('entry'),
        nextSequence: () => {
          const value = sequence;
          sequence += 1;
          return value;
        },
        recordedAt: this.nowIso(),
        ...(request.memo === undefined ? {} : { memo: request.memo }),
        fx: this.requireFx(),
      });
      if (entries.length === 0) {
        throw new ConflictError('Nothing to close: the temporary accounts are already at zero.', {
          to: request.to,
        });
      }

      await this.appendAll(entries);
      const period: ClosedPeriod = {
        id: newId('batch'),
        from: request.from ?? null,
        to: request.to,
        functionalCurrency: this.options.functionalCurrency,
        entryIds: entries.map((entry) => entry.id),
        closedAt: this.nowIso(),
        closedBy: request.closedBy ?? this.options.recordedBy,
      };
      const current = this.requireSnapshot();
      await this.persist({
        ...current,
        closedPeriods: [...current.closedPeriods, period],
      });
      return { entries, period };
    });
  }

  // ------------------------------------------------------------------ reports

  async trialBalance(period: Period = {}, options: ReportOptions = {}): Promise<TrialBalance> {
    await this.ready();
    return trialBalance(
      this.requireLedger(),
      this.requireTree(),
      assertPeriod(period),
      this.statementOptions(options, period),
    );
  }

  async balanceSheet(period: Period = {}, options: ReportOptions = {}): Promise<BalanceSheet> {
    await this.ready();
    return balanceSheet(
      this.requireLedger(),
      this.requireTree(),
      assertPeriod(period),
      this.statementOptions(options, period),
    );
  }

  async incomeStatement(
    period: Period = {},
    options: ReportOptions = {},
  ): Promise<IncomeStatement> {
    await this.ready();
    return incomeStatement(
      this.requireLedger(),
      this.requireTree(),
      assertPeriod(period),
      this.statementOptions(options, period),
    );
  }

  async accountStatement(
    code: string,
    period: Period = {},
    options: ReportOptions = {},
  ): Promise<AccountStatement> {
    await this.ready();
    return accountStatement(
      this.requireLedger(),
      this.requireTree(),
      code,
      assertPeriod(period),
      this.statementOptions(options, period),
    );
  }

  /**
   * Cross-checks the whole book.
   *
   * Per-entry invariants are already guaranteed by the domain, so this looks for
   * the things only a whole-book view can catch: a ledger that fails to balance in
   * some currency, postings to accounts that no longer exist, and closes whose
   * entries have gone missing.
   */
  async verify(): Promise<IntegrityReport> {
    await this.ready();
    const ledger = this.requireLedger();
    const tree = this.requireTree();
    const snapshot = this.requireSnapshot();
    const problems: string[] = [];

    const unknown = new Set<string>();
    for (const entry of ledger.all()) {
      for (const posting of entry.postings) {
        if (!tree.has(posting.accountCode)) {
          unknown.add(posting.accountCode);
        }
      }
    }
    for (const code of [...unknown].sort()) {
      problems.push(`Postings reference unknown account '${code}'.`);
    }

    for (const period of snapshot.closedPeriods) {
      for (const id of period.entryIds) {
        if (!ledger.has(id)) {
          problems.push(`Closing entry ${id} of period ${period.to} is missing.`);
        }
      }
    }

    const imbalances = [...ledger.imbalanceByCurrency()]
      .filter(([, difference]) => difference !== 0n)
      .map(([currency, difference]) => ({ currency, difference: difference.toString() }));

    return {
      balanced: imbalances.length === 0 && problems.length === 0,
      entries: ledger.size,
      accounts: tree.size,
      imbalances,
      unknownAccounts: [...unknown].sort(),
      problems,
    };
  }

  // ------------------------------------------------------------------ storage

  /** Writes the current snapshot back, for hosts that mutate the store directly. */
  async flush(): Promise<void> {
    await this.serialize(async () => {
      await this.persist(this.requireSnapshot());
    });
  }

  async close(): Promise<void> {
    await this.store.close();
  }

  // --------------------------------------------------------------- internals

  private async ready(): Promise<void> {
    if (this.snapshot !== null) {
      return;
    }
    const loaded = await this.store.load();
    this.version = loaded.version;
    this.install(loaded.snapshot);
    if (this.options.seedSystemAccounts && this.requireSnapshot().accounts.length === 0) {
      const seeded: BooksSnapshot = { ...this.requireSnapshot(), accounts: seedAccounts() };
      this.version = await this.store.save(seeded, this.version);
      this.install(seeded);
    }
  }

  private install(snapshot: BooksSnapshot): void {
    this.snapshot = snapshot;
    this.tree = new AccountTree(snapshot.accounts);
    this.ledger = new Ledger(snapshot.entries);
    this.fx = new FxTable(snapshot.rates);
  }

  /** Applies entries in memory, then writes the snapshot back once. */
  private async appendAll(entries: readonly JournalEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    const ledger = this.requireLedger();
    for (const entry of entries) {
      ledger.append(entry);
    }
    const snapshot = this.requireSnapshot();
    await this.persist({ ...snapshot, entries: [...snapshot.entries, ...entries] });
  }

  private async persist(snapshot: BooksSnapshot): Promise<void> {
    this.version = await this.store.save(snapshot, this.version);
    this.install(snapshot);
  }

  private requireSnapshot(): BooksSnapshot {
    if (this.snapshot === null) {
      throw new ConflictError('The books have not been loaded yet.');
    }
    return this.snapshot;
  }

  /**
   * A closed period is sealed. Allowing a backdated entry into one would
   * silently invalidate the closing entry that was generated from those very
   * balances, so the write is refused instead. Reopening is deliberately not
   * automated: it means reversing the closing entry by hand, with a reason.
   */
  private assertPeriodOpen(date: IsoDate): void {
    for (const period of this.requireSnapshot().closedPeriods) {
      // `from` is `null` for "since inception"; a snapshot that came back from
      // storage always uses `null`, while a fresh close may carry `undefined`.
      const from = period.from ?? null;
      const startsBefore = from === null || date >= from;
      if (startsBefore && date <= period.to) {
        throw new ConflictError(
          `The period ${period.from ?? 'inception'}..${period.to} is closed; ` +
            `${date} can no longer be posted to.`,
          {
            code: 'CLOSED_PERIOD',
            period: { from: period.from ?? null, to: period.to },
            closedAt: period.closedAt,
            closedBy: period.closedBy,
          },
        );
      }
    }
  }

  private requireTree(): AccountTree {
    if (this.tree === null) {
      throw new ConflictError('The books have not been loaded yet.');
    }
    return this.tree;
  }

  private requireLedger(): Ledger {
    if (this.ledger === null) {
      throw new ConflictError('The books have not been loaded yet.');
    }
    return this.ledger;
  }

  private requireFx(): FxTable {
    if (this.fx === null) {
      throw new ConflictError('The books have not been loaded yet.');
    }
    return this.fx;
  }

  private statementOptions(options: ReportOptions, period: Period): StatementOptions {
    if (options.rateMode === 'average' && period.from === undefined) {
      throw new ValidationError('Average-rate reports need an explicit period start.', {
        rateMode: 'average',
      });
    }
    return {
      functionalCurrency: this.options.functionalCurrency,
      fx: this.requireFx(),
      rateMode: options.rateMode ?? 'closing',
    };
  }

  private nowIso(): string {
    return this.options.clock().toISOString();
  }

  /**
   * Runs `task` after every previously queued task, so two concurrent posts
   * cannot claim the same sequence number or interleave their writes.
   */
  private async serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      await this.ready();
      return task();
    });
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function toPostingInput(request: PostingRequest): PostingInput {
  return createPosting({
    accountCode: request.account,
    side: request.side,
    amount: Money.parse(request.amount),
    ...(request.memo === undefined ? {} : { memo: request.memo }),
  });
}

function provenanceOf(source: EntrySource | undefined, context: CommandContext): EntryProvenance {
  return {
    kind: source ?? 'manual',
    ...(context.idempotencyKey === undefined ? {} : { idempotencyKey: context.idempotencyKey }),
  };
}
