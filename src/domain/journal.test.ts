import { describe, expect, it } from 'vitest';
import { entry, ledgerOf, usd } from '../../test/support/factories.js';
import {
  DuplicateAccountInEntryError,
  EmptyEntryError,
  NonPositiveAmountError,
  UnbalancedEntryError,
  ValidationError,
} from './errors.js';
import { newId } from './ids.js';
import { buildReversal, createEntry, entryTotals, signedMinor } from './journal.js';
import { Ledger } from './ledger.js';
import { Money } from './money.js';

describe('journal entries', () => {
  it('balances debits against credits', () => {
    const posted = entry({
      date: '2025-01-05',
      postings: [
        ['1100', 'debit', usd('1000.00')],
        ['4100', 'credit', usd('1000.00')],
      ],
    });
    const totals = entryTotals(posted);
    expect(totals.difference).toBe(0n);
    expect(totals.debits.minor).toBe(100_000n);
  });

  it('rejects an unbalanced entry', () => {
    expect(() =>
      entry({
        date: '2025-01-05',
        postings: [
          ['1100', 'debit', usd('1000.00')],
          ['4100', 'credit', usd('999.99')],
        ],
      }),
    ).toThrow(UnbalancedEntryError);
  });

  it('rejects single-sided, self-referential and duplicated postings', () => {
    const oneLine = { date: '2025-01-05', postings: [['1100', 'debit', usd('10')]] } as const;
    expect(() => entry(oneLine)).toThrow(EmptyEntryError);

    expect(() =>
      entry({
        date: '2025-01-05',
        postings: [
          ['1100', 'debit', usd('10')],
          ['1100', 'credit', usd('10')],
        ],
      }),
    ).toThrow(EmptyEntryError);

    expect(() =>
      entry({
        date: '2025-01-05',
        postings: [
          ['1100', 'debit', usd('10')],
          ['1100', 'debit', usd('5')],
          ['4100', 'credit', usd('15')],
        ],
      }),
    ).toThrow(DuplicateAccountInEntryError);
  });

  it('rejects zero and negative amounts', () => {
    const build = (amount: Money) =>
      entry({
        date: '2025-01-05',
        postings: [
          ['1100', 'debit', amount],
          ['4100', 'credit', Money.fromMinor('USD', amount.minor)],
        ],
      });
    expect(() => build(Money.zero('USD'))).toThrow(NonPositiveAmountError);
    expect(() => build(Money.fromMajor('USD', '-5'))).toThrow(NonPositiveAmountError);
  });

  it('refuses to mix currencies inside one entry', () => {
    expect(() =>
      entry({
        date: '2025-01-05',
        postings: [
          ['1100', 'debit', usd('10')],
          ['4100', 'credit', Money.fromMajor('EUR', '10')],
        ],
      }),
    ).toThrow(ValidationError);
  });

  it('signs balances by the account normal side', () => {
    const cash = { side: 'debit', amount: usd('100'), accountCode: '1100', memo: 'Cash' } as const;
    const revenue = {
      side: 'credit',
      amount: usd('100'),
      accountCode: '4100',
      memo: 'Cash',
    } as const;
    expect(signedMinor(cash, 'asset')).toBe(10_000n);
    expect(signedMinor(revenue, 'income')).toBe(10_000n);
    expect(signedMinor({ ...cash, side: 'credit' }, 'asset')).toBe(-10_000n);
  });

  it('reverses by mirroring every posting', () => {
    const original = entry({
      date: '2025-01-05',
      memo: 'Invoice 1',
      postings: [
        ['1200', 'debit', usd('250.00')],
        ['4100', 'credit', usd('250.00')],
      ],
    });
    const reversal = buildReversal(original, {
      id: newId('entry'),
      sequence: 2,
      date: '2025-01-06',
    });
    expect(reversal.postings.map((posting) => posting.side)).toEqual(['credit', 'debit']);
    expect(reversal.reversesId).toBe(original.id);
    expect(entryTotals(reversal).difference).toBe(0n);
  });
});

describe('ledger', () => {
  const specs = [
    {
      date: '2025-01-10',
      postings: [
        ['1100', 'debit', usd('500')],
        ['4100', 'credit', usd('500')],
      ],
    },
    {
      date: '2025-01-20',
      postings: [
        ['5200', 'debit', usd('100')],
        ['1100', 'credit', usd('100')],
      ],
    },
    {
      date: '2025-02-05',
      postings: [
        ['1100', 'debit', usd('300')],
        ['4100', 'credit', usd('300')],
      ],
    },
  ] as const;

  it('keeps entries in date order even when they arrive backdated', () => {
    const ledger = ledgerOf(specs);
    const backdated = entry(
      {
        date: '2025-01-15',
        postings: [
          ['5600', 'debit', usd('5')],
          ['1100', 'credit', usd('5')],
        ],
      },
      4,
    );
    ledger.append(backdated);
    expect(ledger.all().map((item) => item.date)).toEqual([
      '2025-01-10',
      '2025-01-15',
      '2025-01-20',
      '2025-02-05',
    ]);
  });

  it('is balanced by construction', () => {
    expect(ledgerOf(specs).isBalanced()).toBe(true);
    expect([...ledgerOf(specs).imbalanceByCurrency().values()]).toEqual([0n]);
  });

  it('filters by period, tag and reference', () => {
    const ledger = ledgerOf([{ ...specs[0], tags: ['q1'], reference: 'INV-1' }, specs[1]] as never);
    expect(ledger.query({ from: '2025-01-01', to: '2025-01-31' })).toHaveLength(2);
    expect(ledger.query({ tags: ['Q1'] })).toHaveLength(1);
    expect(ledger.query({ reference: 'INV-1' })).toHaveLength(1);
    expect(ledger.query({ sinceSequence: 1 })).toHaveLength(1);
  });

  it('refuses duplicate ids and non-increasing sequences', () => {
    const ledger = ledgerOf(specs);
    const duplicate = createEntry({
      id: ledger.all()[0]?.id ?? 'ent_x',
      sequence: 9,
      date: '2025-03-01',
      postings: [
        { accountCode: '1100', side: 'debit', amount: usd('1') },
        { accountCode: '4100', side: 'credit', amount: usd('1') },
      ],
    });
    expect(() => ledger.append(duplicate)).toThrow(ValidationError);
  });

  it('tracks reversals in both directions', () => {
    const ledger = new Ledger();
    const original = entry({
      date: '2025-01-05',
      postings: [
        ['1100', 'debit', usd('10')],
        ['4100', 'credit', usd('10')],
      ],
    });
    ledger.append(original);
    const reversal = buildReversal(original, {
      id: newId('entry'),
      sequence: 2,
      date: '2025-01-06',
    });
    ledger.append(reversal);
    expect(ledger.isReversed(original.id)).toBe(true);
    expect(ledger.reversalOf(original.id)?.id).toBe(reversal.id);
    expect(ledger.isBalanced()).toBe(true);
  });

  it('reports the entry count and boundaries', () => {
    const ledger = ledgerOf(specs);
    expect(ledger.size).toBe(3);
    expect(ledger.earliestDate()).toBe('2025-01-10');
    expect(ledger.latestDate()).toBe('2025-02-05');
    expect(ledger.nextSequence()).toBe(4);
  });
});
