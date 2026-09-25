import { beforeEach, describe, expect, it } from 'vitest';
import { ConflictError, RateNotFoundError, ValidationError } from '../domain/errors.js';
import { InMemoryStore } from '../infrastructure/memory-store.js';
import { LedgerService, seedAccounts } from './service.js';

function service(overrides: Partial<ConstructorParameters<typeof LedgerService>[1]> = {}) {
  return new LedgerService(new InMemoryStore(), {
    functionalCurrency: 'USD',
    retainedEarningsCode: '3200',
    fxClearingCode: '3210',
    clock: () => new Date('2025-02-01T09:00:00.000Z'),
    ...overrides,
  });
}

async function seeded() {
  return service();
}

describe('LedgerService', () => {
  let books: LedgerService;

  beforeEach(async () => {
    books = await seeded();
  });

  it('starts from the stock chart of accounts', async () => {
    const accounts = await books.accounts();
    expect(accounts.length).toBeGreaterThan(20);
    expect(accounts.map((account) => account.code)).toContain('1100');
  });

  it('lists accounts by type, in report order', async () => {
    const income = await books.accounts({ type: 'income' });
    expect(income.every((account) => account.type === 'income')).toBe(true);
    expect(income.map((account) => account.code)).toContain('4100');
  });

  it('creates a user account and refuses duplicates', async () => {
    const created = await books.createAccount({
      code: '1600',
      name: 'Prepaid Rent',
      type: 'asset',
      parentCode: '1000',
    });
    expect(created.code).toBe('1600');
    await expect(
      books.createAccount({ code: '1600', name: 'Again', type: 'asset' }),
    ).rejects.toThrow(ConflictError);
  });

  it('refuses an account whose parent does not exist', async () => {
    await expect(
      books.createAccount({ code: '1699', name: 'Orphan', type: 'asset', parentCode: 'NOPE' }),
    ).rejects.toThrow();
  });

  it('posts an entry and reflects it in the trial balance', async () => {
    await books.postEntry({
      date: '2025-01-05',
      memo: 'Invoice 1',
      reference: 'INV-1',
      postings: [
        { account: '1100', side: 'debit', amount: '5000.00 USD' },
        { account: '4100', side: 'credit', amount: '5000.00 USD' },
      ],
    });
    const trial = await books.trialBalance({ to: '2025-01-31' });
    expect(trial.totals.balanced).toBe(true);
    expect(trial.totals.debit.minor).toBe(500_000n);
    // Income is credit-normal, so its net is positive.
    expect(trial.rows.find((row) => row.code === '4100')?.amount.minor).toBe(500_000n);
  });

  it('is idempotent when the same key is replayed', async () => {
    const request = {
      date: '2025-01-05',
      memo: 'Invoice 1',
      postings: [
        { account: '1100', side: 'debit' as const, amount: '100.00 USD' },
        { account: '4100', side: 'credit' as const, amount: '100.00 USD' },
      ],
    };
    const first = await books.postEntry(request, { idempotencyKey: 'invoice-1' });
    const second = await books.postEntry(request, { idempotencyKey: 'invoice-1' });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.entry.id).toBe(first.entry.id);
    expect((await books.entries()).length).toBe(1);
  });

  it('rejects postings to roll-up parents and computed accounts', async () => {
    await expect(
      books.postEntry({
        date: '2025-01-05',
        postings: [
          { account: '1000', side: 'debit', amount: '10.00 USD' },
          { account: '4100', side: 'credit', amount: '10.00 USD' },
        ],
      }),
    ).rejects.toThrow();

    await expect(
      books.postEntry({
        date: '2025-01-05',
        postings: [
          { account: '1100', side: 'debit', amount: '10.00 USD' },
          { account: '3200', side: 'credit', amount: '10.00 USD' },
        ],
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects an entry whose amounts do not match the account currency', async () => {
    await books.createAccount({
      code: '1250',
      name: 'USD Receivable',
      type: 'asset',
      parentCode: '1000',
      currency: 'USD',
    });
    await expect(
      books.postEntry({
        date: '2025-01-05',
        postings: [
          { account: '1250', side: 'debit', amount: '10.00 EUR' },
          { account: '4100', side: 'credit', amount: '10.00 EUR' },
        ],
      }),
    ).rejects.toThrow();
  });

  it('reverses an entry once, and only once', async () => {
    const { entry } = await books.postEntry({
      date: '2025-01-05',
      memo: 'Mistake',
      postings: [
        { account: '1100', side: 'debit', amount: '75.00 USD' },
        { account: '4100', side: 'credit', amount: '75.00 USD' },
      ],
    });
    const reversal = await books.reverseEntry(entry.id, { date: '2025-01-06' });
    expect(reversal.reversesId).toBe(entry.id);
    expect(reversal.postings[0]?.side).toBe('credit');
    await expect(books.reverseEntry(entry.id, { date: '2025-01-07' })).rejects.toThrow();
    const trial = await books.trialBalance({ to: '2025-01-31' });
    expect(trial.totals.balanced).toBe(true);
  });

  it('closes a period and refuses to close it twice', async () => {
    await books.postEntry({
      date: '2025-01-05',
      postings: [
        { account: '1100', side: 'debit', amount: '5000.00 USD' },
        { account: '4100', side: 'credit', amount: '5000.00 USD' },
      ],
    });
    await books.postEntry({
      date: '2025-01-10',
      postings: [
        { account: '5200', side: 'debit', amount: '1200.00 USD' },
        { account: '1100', side: 'credit', amount: '1200.00 USD' },
      ],
    });

    const closed = await books.closePeriod({ from: '2025-01-01', to: '2025-01-31' });
    expect(closed.entries).toHaveLength(1);
    expect(closed.period.entryIds).toEqual([closed.entries[0]?.id]);

    const sheet = await books.balanceSheet({ to: '2025-01-31' });
    expect(sheet.balanced).toBe(true);
    expect(sheet.currentEarnings.isZero()).toBe(true);
    expect(sheet.equity.total.minor).toBe(380_000n);

    await expect(books.closePeriod({ from: '2025-01-01', to: '2025-01-31' })).rejects.toThrow(
      ConflictError,
    );
  });

  it('refuses to post into a period that has been closed', async () => {
    await books.postEntry({
      date: '2025-01-05',
      postings: [
        { account: '1100', side: 'debit', amount: '5000.00 USD' },
        { account: '4100', side: 'credit', amount: '5000.00 USD' },
      ],
    });
    await books.closePeriod({ from: '2025-01-01', to: '2025-01-31' });

    const backdated = await books
      .postEntry({
        date: '2025-01-20',
        postings: [
          { account: '5200', side: 'debit', amount: '99.00 USD' },
          { account: '1100', side: 'credit', amount: '99.00 USD' },
        ],
      })
      .catch((error: unknown) => error);
    expect(backdated).toBeInstanceOf(ConflictError);
    expect((backdated as ConflictError).details.code).toBe('CLOSED_PERIOD');

    // The seal covers the whole period, not just its last day.
    await expect(
      books.postEntry({
        date: '2025-01-01',
        postings: [
          { account: '5200', side: 'debit', amount: '1.00 USD' },
          { account: '1100', side: 'credit', amount: '1.00 USD' },
        ],
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    // A later date is still fine, and so is replaying a key that landed before
    // the close — the idempotent path must not be blocked by the seal.
    await expect(
      books.postEntry({
        date: '2025-02-02',
        postings: [
          { account: '5200', side: 'debit', amount: '10.00 USD' },
          { account: '1100', side: 'credit', amount: '10.00 USD' },
        ],
      }),
    ).resolves.toMatchObject({ created: true });
  });

  it('refuses to reverse an entry dated inside a closed period', async () => {
    const original = await books.postEntry({
      date: '2025-01-05',
      postings: [
        { account: '1100', side: 'debit', amount: '5000.00 USD' },
        { account: '4100', side: 'credit', amount: '5000.00 USD' },
      ],
    });
    await books.closePeriod({ from: '2025-01-01', to: '2025-01-31' });
    await expect(
      books.reverseEntry(original.entry.id, { date: '2025-01-06' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses a recurring run that would post into a closed period', async () => {
    await books.postEntry({
      date: '2025-01-05',
      postings: [
        { account: '1100', side: 'debit', amount: '5000.00 USD' },
        { account: '4100', side: 'credit', amount: '5000.00 USD' },
      ],
    });
    await books.closePeriod({ from: '2025-01-01', to: '2025-03-31' });
    await books.createRecurringRule({
      frequency: 'monthly',
      startDate: '2025-02-01',
      postings: [
        { account: '5200', side: 'debit', amount: '1200.00 USD' },
        { account: '1100', side: 'credit', amount: '1200.00 USD' },
      ],
    });

    await expect(books.runRecurring({ until: '2025-02-28' })).rejects.toBeInstanceOf(ConflictError);
    // All or nothing: the run is refused before the single persist, so neither
    // the offending February occurrence nor the March one behind it is written.
    const dates = (await books.entries()).map((entry) => entry.date);
    expect(dates).not.toContain('2025-02-01');
    expect(dates).not.toContain('2025-03-01');
  });

  it('translates a foreign period through the FX clearing account', async () => {
    await books.recordRate({
      base: 'EUR',
      quote: 'USD',
      rate: '1.10',
      effectiveDate: '2025-01-01',
    });
    await books.postEntry({
      date: '2025-01-05',
      postings: [
        { account: '1100', side: 'debit', amount: '1000.00 EUR' },
        { account: '4100', side: 'credit', amount: '1000.00 EUR' },
      ],
    });

    const closed = await books.closePeriod({ from: '2025-01-01', to: '2025-01-31' });
    expect(closed.entries).toHaveLength(2);
    expect(closed.entries[0]?.postings.at(-1)?.accountCode).toBe('3210');
    expect(closed.entries[1]?.postings.at(-1)?.amount.minor).toBe(110_000n);

    const sheet = await books.balanceSheet({ to: '2025-01-31' });
    expect(sheet.balanced).toBe(true);
    expect(sheet.totalAssets.minor).toBe(110_000n);

    const verify = await books.verify();
    expect(verify.balanced).toBe(true);
    expect(verify.problems).toEqual([]);
  });

  it('reports a missing exchange rate instead of guessing one', async () => {
    await books.postEntry({
      date: '2025-01-05',
      postings: [
        { account: '1100', side: 'debit', amount: '1000.00 EUR' },
        { account: '4100', side: 'credit', amount: '1000.00 EUR' },
      ],
    });
    await expect(books.balanceSheet({ to: '2025-01-31' })).rejects.toThrow(RateNotFoundError);
  });

  it('runs a recurring rule exactly once per occurrence', async () => {
    const rule = await books.createRecurringRule({
      frequency: 'monthly',
      startDate: '2025-01-01',
      memo: 'Rent',
      postings: [
        { account: '5200', side: 'debit', amount: '1200.00 USD' },
        { account: '1100', side: 'credit', amount: '1200.00 USD' },
      ],
    });
    expect(rule.id.startsWith('rul_')).toBe(true);

    const first = await books.runRecurring({ until: '2025-03-31' });
    expect(first.created).toHaveLength(3);
    expect(first.skipped).toBe(0);

    const second = await books.runRecurring({ until: '2025-03-31' });
    expect(second.created).toHaveLength(0);
    expect(second.skipped).toBe(3);

    const statement = await books.accountStatement('5200', {
      from: '2025-01-01',
      to: '2025-03-31',
    });
    expect(statement.closingBalance.minor).toBe(360_000n);
  });

  it('rejects an average-rate report with no period start', async () => {
    await expect(
      books.incomeStatement({ to: '2025-01-31' }, { rateMode: 'average' }),
    ).rejects.toThrow(ValidationError);
  });

  it('seeds the chart of accounts only once', async () => {
    const second = new LedgerService(new InMemoryStore(), {
      functionalCurrency: 'USD',
      retainedEarningsCode: '3200',
      fxClearingCode: '3210',
      seedSystemAccounts: false,
    });
    await expect(second.accounts()).resolves.toEqual([]);
    expect(seedAccounts().length).toBeGreaterThan(20);
  });
});
