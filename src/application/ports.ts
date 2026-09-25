import type { Account } from '../domain/account.js';
import type { FxRate } from '../domain/fx.js';
import type { Id } from '../domain/ids.js';
import type { JournalEntry } from '../domain/journal.js';
import type { RecurrenceRule } from '../domain/recurring.js';

/** A period that has been closed, recorded so a close cannot silently repeat. */
export interface ClosedPeriod {
  readonly id: Id;
  readonly from: string | null;
  readonly to: string;
  readonly functionalCurrency: string;
  /** Ids of the entries that performed the close. */
  readonly entryIds: readonly Id[];
  readonly closedAt: string;
  readonly closedBy: string;
}

/**
 * The whole book, as plain data.
 *
 * Snapshots are the only thing that crosses the application/infrastructure
 * boundary. The domain hands out frozen objects, a store round-trips them, and
 * nothing else about the storage engine leaks upwards.
 */
export interface BooksSnapshot {
  readonly accounts: readonly Account[];
  readonly entries: readonly JournalEntry[];
  readonly rates: readonly FxRate[];
  readonly rules: readonly RecurrenceRule[];
  readonly closedPeriods: readonly ClosedPeriod[];
}

export function emptySnapshot(): BooksSnapshot {
  return { accounts: [], entries: [], rates: [], rules: [], closedPeriods: [] };
}

export interface BooksLoad {
  readonly snapshot: BooksSnapshot;
  /** Opaque store revision, handed back to `save` to detect concurrent writes. */
  readonly version: number;
}

/**
 * Persistence port.
 *
 * `load` and `save` are the whole contract: the application keeps the working
 * copy in memory (where reports are fast) and writes the snapshot back on every
 * mutation. `expectedVersion` is the version from the last successful `load`, so a
 * concurrent writer is detected instead of silently overwriting someone else's
 * work.
 */
export interface LedgerStore {
  load(): Promise<BooksLoad>;
  save(snapshot: BooksSnapshot, expectedVersion: number): Promise<number>;
  close(): Promise<void>;
}

export class VersionConflictError extends Error {
  constructor(expected: number, actual: number) {
    super(`Books were modified by someone else (expected version ${expected}, found ${actual}).`);
    this.name = 'VersionConflictError';
  }
}
