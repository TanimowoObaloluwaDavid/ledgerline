import { describe, expect, it } from 'vitest';
import { usd } from '../../test/support/factories.js';
import { InvalidRecurrenceError } from './errors.js';
import { createEntry } from './journal.js';
import {
  createRule,
  describeRule,
  occurrenceId,
  occurrences,
  occurrenceToEntry,
} from './recurring.js';

const rent = () => [
  { accountCode: '5200', side: 'debit' as const, amount: usd('850.00') },
  { accountCode: '1100', side: 'credit' as const, amount: usd('850.00') },
];

describe('recurrence rules', () => {
  it('expands monthly occurrences with end-of-month clamping', () => {
    const rule = createRule({
      frequency: 'monthly',
      startDate: '2025-01-31',
      maxOccurrences: 4,
      postings: rent(),
    });
    expect(occurrences(rule, '2025-12-31').map((item) => item.date)).toEqual([
      '2025-01-31',
      '2025-02-28',
      '2025-03-31',
      '2025-04-30',
    ]);
  });

  it('supports every frequency and interval', () => {
    const weekly = createRule({
      frequency: 'weekly',
      interval: 2,
      startDate: '2025-01-06',
      maxOccurrences: 3,
      postings: rent(),
    });
    expect(occurrences(weekly, '2025-02-01').map((item) => item.date)).toEqual(
      ['2025-01-06', '2025-01-20', '2025-02-03'].filter((date) => date <= '2025-02-01'),
    );

    const quarterly = createRule({
      frequency: 'quarterly',
      startDate: '2025-01-01',
      maxOccurrences: 3,
      postings: rent(),
    });
    expect(occurrences(quarterly, '2026-01-01').map((item) => item.date)).toEqual([
      '2025-01-01',
      '2025-04-01',
      '2025-07-01',
    ]);

    const yearly = createRule({
      frequency: 'yearly',
      startDate: '2024-02-29',
      maxOccurrences: 2,
      postings: rent(),
    });
    expect(occurrences(yearly, '2030-01-01').map((item) => item.date)).toEqual([
      '2024-02-29',
      '2025-02-28',
    ]);
  });

  it('stops at the end date', () => {
    const rule = createRule({
      frequency: 'daily',
      startDate: '2025-01-01',
      endDate: '2025-01-05',
      postings: rent(),
    });
    expect(occurrences(rule, '2025-03-01')).toHaveLength(5);
  });

  it('pushes weekend occurrences to the next business day', () => {
    const rule = createRule({
      frequency: 'weekly',
      startDate: '2025-01-04',
      maxOccurrences: 2,
      adjustWeekend: 'next-business-day',
      postings: rent(),
    });
    const dates = occurrences(rule, '2025-02-01');
    expect(dates[0]).toMatchObject({
      scheduledDate: '2025-01-04',
      date: '2025-01-06',
      adjusted: true,
    });
    expect(dates[1]).toMatchObject({
      scheduledDate: '2025-01-11',
      date: '2025-01-13',
      adjusted: true,
    });
  });

  it('produces the same entry id for the same rule and date', () => {
    const rule = createRule({
      frequency: 'monthly',
      startDate: '2025-01-01',
      maxOccurrences: 2,
      postings: rent(),
    });
    const [first] = occurrences(rule, '2025-02-01');
    const again = occurrences(rule, '2025-02-01')[0];
    expect(first?.entryId).toBe(again?.entryId);
    expect(first?.entryId).toBe(occurrenceId(rule.id, '2025-01-01'));
  });

  it('materialises an occurrence into a balanced entry', () => {
    const rule = createRule({
      frequency: 'monthly',
      startDate: '2025-01-01',
      maxOccurrences: 1,
      memo: 'Monthly rent',
      postings: rent(),
    });
    const occurrence = occurrences(rule, '2025-01-31')[0];
    expect(occurrence).toBeDefined();
    const entry = createEntry(
      occurrenceToEntry(rule, occurrence as NonNullable<typeof occurrence>, { sequence: 1 }),
    );
    expect(entry.memo).toBe('Monthly rent');
    expect(entry.tags).toContain('recurring');
    expect(entry.source).toEqual({ kind: 'recurring', ruleId: rule.id });
    expect(entry.postings).toHaveLength(2);
  });

  it('rejects rules that cannot produce valid entries', () => {
    expect(() =>
      createRule({
        frequency: 'monthly',
        startDate: '2025-13-01',
        postings: rent(),
      }),
    ).toThrow(InvalidRecurrenceError);

    expect(() =>
      createRule({
        frequency: 'monthly',
        startDate: '2025-01-01',
        endDate: '2024-12-31',
        postings: rent(),
      }),
    ).toThrow(InvalidRecurrenceError);

    expect(() =>
      createRule({
        frequency: 'monthly',
        interval: 0,
        startDate: '2025-01-01',
        postings: rent(),
      }),
    ).toThrow(InvalidRecurrenceError);

    expect(() =>
      createRule({
        frequency: 'monthly',
        startDate: '2025-01-01',
        postings: [
          { accountCode: '5200', side: 'debit', amount: usd('850.00') },
          { accountCode: '1100', side: 'credit', amount: usd('800.00') },
        ],
      }),
    ).toThrow(InvalidRecurrenceError);

    expect(() =>
      createRule({
        frequency: 'monthly',
        startDate: '2025-01-01',
        postings: [{ accountCode: '5200', side: 'debit', amount: usd('850.00') }],
      }),
    ).toThrow(InvalidRecurrenceError);
  });

  it('describes itself in one line', () => {
    const rule = createRule({
      frequency: 'monthly',
      interval: 3,
      startDate: '2025-01-01',
      endDate: '2026-01-01',
      postings: rent(),
    });
    expect(describeRule(rule)).toBe('3x monthly from 2025-01-01 (until 2026-01-01)');
  });
});
