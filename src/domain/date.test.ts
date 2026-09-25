import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  addYears,
  dateRange,
  daysBetween,
  endOfMonth,
  isAfter,
  isIsoDate,
  isLeapYear,
  isWeekend,
  startOfMonth,
} from './date.js';
import { ValidationError } from './errors.js';

describe('dates', () => {
  it('validates real calendar dates only', () => {
    expect(isIsoDate('2024-02-29')).toBe(true);
    expect(isIsoDate('2025-02-29')).toBe(false);
    expect(isIsoDate('2025-13-01')).toBe(false);
    expect(isIsoDate('2025-1-01')).toBe(false);
    expect(isIsoDate('not-a-date')).toBe(false);
  });

  it('knows leap years', () => {
    expect(isLeapYear(2000)).toBe(true);
    expect(isLeapYear(1900)).toBe(false);
    expect(isLeapYear(2024)).toBe(true);
  });

  it('adds months with end-of-month clamping', () => {
    expect(addMonths('2025-01-31', 1)).toBe('2025-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2025-01-31', 3)).toBe('2025-04-30');
    expect(addMonths('2025-12-15', 2)).toBe('2026-02-15');
    expect(addYears('2024-02-29', 1)).toBe('2025-02-28');
  });

  it('crosses year boundaries when adding days', () => {
    expect(addDays('2025-12-31', 1)).toBe('2026-01-01');
    expect(addDays('2025-01-01', -1)).toBe('2024-12-31');
    expect(daysBetween('2025-01-01', '2025-12-31')).toBe(364);
  });

  it('finds month boundaries and weekends', () => {
    expect(startOfMonth('2025-02-14')).toBe('2025-02-01');
    expect(endOfMonth('2024-02-14')).toBe('2024-02-29');
    expect(isWeekend('2025-01-04')).toBe(true);
    expect(isWeekend('2025-01-06')).toBe(false);
  });

  it('builds inclusive ranges', () => {
    expect(dateRange('2025-01-01', '2025-01-04')).toEqual([
      '2025-01-01',
      '2025-01-02',
      '2025-01-03',
      '2025-01-04',
    ]);
    expect(dateRange('2025-01-04', '2025-01-01')).toEqual([]);
  });

  it('rejects impossible dates on construction', () => {
    expect(() => addMonths('2025-01-01', 1.5)).toThrow(ValidationError);
  });
});

describe('date properties', () => {
  it('adding then subtracting days is the identity', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2000-01-01'), max: new Date('2099-12-31'), noInvalidDate: true }),
        fc.integer({ min: 1, max: 5000 }),
        (date, days) => {
          const iso = date.toISOString().slice(0, 10);
          expect(addDays(addDays(iso, days), -days)).toBe(iso);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('date comparison matches UTC ordering', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2000-01-01'), max: new Date('2099-12-31'), noInvalidDate: true }),
        fc.date({ min: new Date('2000-01-01'), max: new Date('2099-12-31'), noInvalidDate: true }),
        (left, right) => {
          const a = left.toISOString().slice(0, 10);
          const b = right.toISOString().slice(0, 10);
          expect(isAfter(a, b)).toBe(a > b);
        },
      ),
      { numRuns: 300 },
    );
  });
});
