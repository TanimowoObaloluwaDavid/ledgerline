import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { VersionConflictError } from '../application/ports.js';
import { LedgerService } from '../application/service.js';
import { SqliteStore } from './sqlite-store.js';

/**
 * Keeps a temp directory per test and closes every store it opened, so cleanup
 * never races a live SQLite handle on Windows.
 */
async function withBooks(body: (books: (path: string) => LedgerService) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'ledgerline-'));
  const open: LedgerService[] = [];
  const books = (path: string): LedgerService => {
    const service = new LedgerService(new SqliteStore({ path }), {
      functionalCurrency: 'USD',
      retainedEarningsCode: '3200',
      fxClearingCode: '3210',
      clock: () => new Date('2025-02-01T09:00:00.000Z'),
    });
    open.push(service);
    return service;
  };
  try {
    await body(books);
  } finally {
    for (const service of open) {
      await service.close();
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const invoice = {
  date: '2025-01-05',
  memo: 'Invoice 1',
  reference: 'INV-1',
  tags: ['sales'],
  postings: [
    { account: '1100', side: 'debit' as const, amount: '5000.00 USD' },
    { account: '4100', side: 'credit' as const, amount: '5000.00 USD' },
  ],
};

describe('SqliteStore', () => {
  it('round-trips a whole book through a file on disk', async () => {
    await withBooks(async (books) => {
      const path = join(mkdtempSync(join(tmpdir(), 'ledgerline-db-')), 'books.db');
      const first = books(path);
      await first.postEntry(invoice);
      await first.recordRate({
        base: 'EUR',
        quote: 'USD',
        rate: '1.1',
        effectiveDate: '2025-01-01',
        source: 'ecb',
      });
      await first.createRecurringRule({
        frequency: 'monthly',
        startDate: '2025-02-01',
        memo: 'Rent',
        postings: [
          { account: '5200', side: 'debit', amount: '1200.00 USD' },
          { account: '1100', side: 'credit', amount: '1200.00 USD' },
        ],
      });
      await first.closePeriod({ from: '2025-01-01', to: '2025-01-31' });

      // A brand-new service reading the same file sees the same books.
      const second = books(path);
      const entries = await second.entries();
      expect(entries).toHaveLength(2); // the invoice, plus one closing entry
      expect(entries[0]?.memo).toBe('Invoice 1');
      expect(entries[0]?.tags).toEqual(['sales']);
      expect(entries[0]?.postings[0]?.amount.minor).toBe(500_000n);
      expect(entries[1]?.tags).toContain('closing');

      expect(await second.rates()).toHaveLength(1);
      expect(await second.closedPeriods()).toHaveLength(1);
      expect(await second.rules()).toHaveLength(1);

      const [rule] = await second.rules();
      expect(rule?.postings[0]?.amount.minor).toBe(120_000n);
      expect(rule?.postings[0]?.amount.currency).toBe('USD');

      const sheet = await second.balanceSheet({ to: '2025-01-31' });
      expect(sheet.balanced).toBe(true);
      expect((await second.verify()).balanced).toBe(true);
    });
  });

  it('keeps the chart of accounts across restarts', async () => {
    await withBooks(async (books) => {
      const path = join(mkdtempSync(join(tmpdir(), 'ledgerline-db-')), 'books.db');
      const first = books(path);
      const before = await first.accounts();
      await first.createAccount({
        code: '1600',
        name: 'Prepaid Rent',
        type: 'asset',
        parentCode: '1000',
      });

      const second = books(path);
      expect((await second.accounts()).length).toBe(before.length + 1);
      expect((await second.account('1600')).name).toBe('Prepaid Rent');
    });
  });

  it('rejects a write based on a stale version', async () => {
    const store = new SqliteStore({ path: ':memory:' });
    const loaded = await store.load();
    await store.save(loaded.snapshot, loaded.version);
    await expect(store.save(loaded.snapshot, loaded.version)).rejects.toThrow(VersionConflictError);
    await store.close();
  });

  it('works entirely in memory', async () => {
    const store = new SqliteStore({ path: ':memory:' });
    const books = new LedgerService(store, {
      functionalCurrency: 'USD',
      retainedEarningsCode: '3200',
      fxClearingCode: '3210',
    });
    await books.postEntry(invoice);
    expect((await books.entries()).length).toBe(1);
    await books.close();
  });

  it('fails loudly when the stored data violates a domain invariant', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ledgerline-db-')), 'books.db');
    await withBooks(async (books) => {
      const first = books(path);
      await first.postEntry(invoice);
      await first.close();
    });

    // Tamper with a stored amount behind the store's back: the entry no longer
    // balances, so loading it must say so rather than quietly report it.
    const database = new DatabaseSync(path);
    database.exec("UPDATE postings SET minor = '999' WHERE account_code = '1100'");
    database.close();

    await withBooks(async (books) => {
      const reloaded = books(path);
      await expect(reloaded.entries()).rejects.toThrow();
    });
  });
});
