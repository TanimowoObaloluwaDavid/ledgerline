import { ValidationError } from './errors.js';

/** A calendar date with no time and no timezone: `YYYY-MM-DD`. */
export type IsoDate = string;

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value: string): value is IsoDate {
  if (!ISO_DATE_PATTERN.test(value)) {
    return false;
  }
  const { year, month, day } = partsOf(value);
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  return day <= daysInMonth(year, month);
}

/** Parses a validated `YYYY-MM-DD` date. */
export function parseIsoDate(value: string): { year: number; month: number; day: number } {
  if (!isIsoDate(value)) {
    throw new ValidationError(`'${value}' is not a valid YYYY-MM-DD date.`, { date: value });
  }
  return partsOf(value);
}

function partsOf(value: string): { year: number; month: number; day: number } {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) {
    throw new ValidationError(`'${value}' is not a valid YYYY-MM-DD date.`, { date: value });
  }
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function pad(value: number, width = 2): string {
  return value.toString().padStart(width, '0');
}

/** Builds a date string, rejecting impossible days (e.g. `2025-02-30`). */
export function makeIsoDate(year: number, month: number, day: number): IsoDate {
  const value = `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
  if (!isIsoDate(value)) {
    throw new ValidationError(`'${value}' is not a valid date.`, { date: value });
  }
  return value;
}

/** Lexicographic order on `YYYY-MM-DD` is chronological order. */
export function compareIsoDates(left: IsoDate, right: IsoDate): -1 | 0 | 1 {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

export function isBefore(left: IsoDate, right: IsoDate): boolean {
  return compareIsoDates(left, right) < 0;
}

export function isAfter(left: IsoDate, right: IsoDate): boolean {
  return compareIsoDates(left, right) > 0;
}

export function minDate(left: IsoDate, right: IsoDate): IsoDate {
  return compareIsoDates(left, right) <= 0 ? left : right;
}

export function maxDate(left: IsoDate, right: IsoDate): IsoDate {
  return compareIsoDates(left, right) >= 0 ? left : right;
}

function toUtcMillis(date: IsoDate): number {
  const { year, month, day } = parseIsoDate(date);
  return Date.UTC(year, month - 1, day);
}

function fromUtcMillis(millis: number): IsoDate {
  const date = new Date(millis);
  return makeIsoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

export function addDays(date: IsoDate, days: number): IsoDate {
  if (!Number.isInteger(days)) {
    throw new ValidationError('Day offset must be an integer.', { days });
  }
  return fromUtcMillis(toUtcMillis(date) + days * 86_400_000);
}

/**
 * Adds calendar months, clamping to the end of the target month.
 *
 * A rent rule that fires on the 31st goes 31 Jan, 28/29 Feb, 31 Mar — it does
 * not skip February, and it does not drift into the first of the month.
 */
export function addMonths(date: IsoDate, months: number): IsoDate {
  if (!Number.isInteger(months)) {
    throw new ValidationError('Month offset must be an integer.', { months });
  }
  const { year, month, day } = parseIsoDate(date);
  const zeroBased = year * 12 + (month - 1) + months;
  const nextYear = Math.floor(zeroBased / 12);
  const nextMonth = (zeroBased % 12) + 1;
  const clampedDay = Math.min(day, daysInMonth(nextYear, nextMonth));
  return makeIsoDate(nextYear, nextMonth, clampedDay);
}

export function addYears(date: IsoDate, years: number): IsoDate {
  return addMonths(date, years * 12);
}

/** Whole days from `from` to `to`; negative when `to` precedes `from`. */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((toUtcMillis(to) - toUtcMillis(from)) / 86_400_000);
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(date: IsoDate): number {
  return new Date(toUtcMillis(date)).getUTCDay();
}

export function isWeekend(date: IsoDate): boolean {
  const day = dayOfWeek(date);
  return day === 0 || day === 6;
}

export function startOfMonth(date: IsoDate): IsoDate {
  const { year, month } = parseIsoDate(date);
  return makeIsoDate(year, month, 1);
}

export function endOfMonth(date: IsoDate): IsoDate {
  const { year, month } = parseIsoDate(date);
  return makeIsoDate(year, month, daysInMonth(year, month));
}

export function startOfYear(date: IsoDate): IsoDate {
  return `${parseIsoDate(date).year.toString().padStart(4, '0')}-01-01`;
}

export function endOfYear(date: IsoDate): IsoDate {
  return `${parseIsoDate(date).year.toString().padStart(4, '0')}-12-31`;
}

export function clampDate(date: IsoDate, lower: IsoDate, upper: IsoDate): IsoDate {
  return minDate(maxDate(date, lower), upper);
}

export function dateRange(from: IsoDate, to: IsoDate): IsoDate[] {
  if (isAfter(from, to)) {
    return [];
  }
  const total = daysBetween(from, to);
  return Array.from({ length: total + 1 }, (_, index) => addDays(from, index));
}
