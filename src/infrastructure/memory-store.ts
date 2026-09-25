import type { BooksLoad, BooksSnapshot, LedgerStore } from '../application/ports.js';
import { VersionConflictError } from '../application/ports.js';

/**
 * A store that keeps everything in process memory.
 *
 * Used by the test suite, by `ledgerline demo`, and by the HTTP server's
 * `--memory` mode. It implements the same optimistic-concurrency contract as the
 * SQLite store so behaviour does not diverge between them.
 */
export class InMemoryStore implements LedgerStore {
  private snapshot: BooksSnapshot;
  private version = 0;
  private closed = false;

  constructor(
    initial: BooksSnapshot = { accounts: [], entries: [], rates: [], rules: [], closedPeriods: [] },
  ) {
    this.snapshot = structuredClone(initial);
  }

  /** Current contents, for assertions. */
  peek(): BooksSnapshot {
    return structuredClone(this.snapshot);
  }

  get currentVersion(): number {
    return this.version;
  }

  load(): Promise<BooksLoad> {
    this.assertOpen();
    return Promise.resolve({ snapshot: structuredClone(this.snapshot), version: this.version });
  }

  save(snapshot: BooksSnapshot, expectedVersion: number): Promise<number> {
    this.assertOpen();
    if (expectedVersion !== this.version) {
      return Promise.reject(new VersionConflictError(expectedVersion, this.version));
    }
    this.snapshot = structuredClone(snapshot);
    this.version += 1;
    return Promise.resolve(this.version);
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('This store has been closed.');
    }
  }
}
