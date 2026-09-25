import { compareIsoDates, type IsoDate } from './date.js';
import { EntryNotFoundError, ValidationError } from './errors.js';
import type { Id } from './ids.js';
import { entryTotals, type JournalEntry, type Posting } from './journal.js';

export interface EntryQuery {
  readonly from?: IsoDate;
  readonly to?: IsoDate;
  readonly sinceSequence?: number;
  readonly tags?: readonly string[];
  readonly reference?: string;
}

/**
 * The append-only book of record.
 *
 * Entries are never mutated or deleted. Corrections are made by posting a
 * reversing entry, so `Ledger` can always answer "what did the books say on
 * this date?" without any soft-delete bookkeeping. Backdated entries are
 * inserted in `(date, sequence)` order, which is the order every report reads.
 */
export class Ledger {
  private readonly ordered: JournalEntry[] = [];
  private readonly byId = new Map<Id, JournalEntry>();
  private readonly reversalByTarget = new Map<Id, Id>();
  private highestSequence = 0;

  constructor(entries: readonly JournalEntry[] = []) {
    for (const entry of entries) {
      this.append(entry);
    }
  }

  get size(): number {
    return this.ordered.length;
  }

  isEmpty(): boolean {
    return this.ordered.length === 0;
  }

  nextSequence(): number {
    return this.highestSequence + 1;
  }

  latestDate(): IsoDate | null {
    return this.ordered.at(-1)?.date ?? null;
  }

  earliestDate(): IsoDate | null {
    return this.ordered.at(0)?.date ?? null;
  }

  append(entry: JournalEntry): JournalEntry {
    if (this.byId.has(entry.id)) {
      throw new ValidationError(`Entry '${entry.id}' is already in the ledger.`, {
        id: entry.id,
      });
    }
    const previous = this.ordered.at(-1);
    if (previous !== undefined && entry.sequence <= this.highestSequence) {
      throw new ValidationError(
        `Entry sequence must increase: got ${entry.sequence} after ${this.highestSequence}.`,
        { id: entry.id, sequence: entry.sequence, highest: this.highestSequence },
      );
    }
    this.insertInOrder(entry);
    this.byId.set(entry.id, entry);
    if (entry.reversesId !== null) {
      this.reversalByTarget.set(entry.reversesId, entry.id);
    }
    this.highestSequence = Math.max(this.highestSequence, entry.sequence);
    return entry;
  }

  private insertInOrder(entry: JournalEntry): void {
    let low = 0;
    let high = this.ordered.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const candidate = this.ordered[mid] as JournalEntry;
      const after =
        compareIsoDates(candidate.date, entry.date) < 0 ||
        (candidate.date === entry.date && candidate.sequence < entry.sequence);
      if (after) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    this.ordered.splice(low, 0, entry);
  }

  has(id: Id): boolean {
    return this.byId.has(id);
  }

  find(id: Id): JournalEntry | undefined {
    return this.byId.get(id);
  }

  get(id: Id): JournalEntry {
    const entry = this.byId.get(id);
    if (entry === undefined) {
      throw new EntryNotFoundError(id);
    }
    return entry;
  }

  all(): readonly JournalEntry[] {
    return this.ordered;
  }

  query(filter: EntryQuery = {}): readonly JournalEntry[] {
    return this.ordered.filter((entry) => matchesQuery(entry, filter));
  }

  /** Every posting that touches one of `codes`, in ledger order. */
  postingsFor(codes: ReadonlySet<string>): readonly Posting[] {
    const wanted = new Set([...codes].map((code) => code.toUpperCase()));
    return this.ordered.flatMap((entry) => entry.postings.filter((p) => wanted.has(p.accountCode)));
  }

  entriesTouching(code: string): readonly JournalEntry[] {
    const wanted = code.toUpperCase();
    return this.ordered.filter((entry) => entry.postings.some((p) => p.accountCode === wanted));
  }

  reversalOf(id: Id): JournalEntry | undefined {
    const reversalId = this.reversalByTarget.get(id);
    return reversalId === undefined ? undefined : this.byId.get(reversalId);
  }

  isReversed(id: Id): boolean {
    return this.reversalByTarget.has(id);
  }

  reversedIds(): ReadonlySet<Id> {
    return new Set(this.reversalByTarget.keys());
  }

  /**
   * Sum of every entry's debit/credit difference, keyed by currency.
   *
   * A healthy ledger reports `0n` for every currency. This is the invariant the
   * `verify` command and the test-suite assert against: it catches storage
   * corruption, bad migrations and partial writes that per-entry checks cannot.
   */
  imbalanceByCurrency(): ReadonlyMap<string, bigint> {
    const totals = new Map<string, bigint>();
    for (const entry of this.ordered) {
      const totals0 = entryTotals(entry);
      totals.set(totals0.currency, (totals.get(totals0.currency) ?? 0n) + totals0.difference);
    }
    return totals;
  }

  isBalanced(): boolean {
    for (const difference of this.imbalanceByCurrency().values()) {
      if (difference !== 0n) {
        return false;
      }
    }
    return true;
  }
}

function matchesQuery(entry: JournalEntry, filter: EntryQuery): boolean {
  if (filter.from !== undefined && compareIsoDates(entry.date, filter.from) < 0) {
    return false;
  }
  if (filter.to !== undefined && compareIsoDates(entry.date, filter.to) > 0) {
    return false;
  }
  if (filter.sinceSequence !== undefined && entry.sequence <= filter.sinceSequence) {
    return false;
  }
  if (filter.reference !== undefined && entry.reference !== filter.reference) {
    return false;
  }
  const tags = filter.tags;
  if (tags !== undefined && tags.length > 0) {
    const entryTags = new Set(entry.tags);
    return tags.every((tag) => entryTags.has(tag.toLowerCase()));
  }
  return true;
}
