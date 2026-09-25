import {
  addDays,
  dayOfWeek,
  daysInMonth,
  type IsoDate,
  isAfter,
  isIsoDate,
  makeIsoDate,
  parseIsoDate,
} from './date.js';
import { InvalidRecurrenceError, ValidationError } from './errors.js';
import { deterministicId, type Id, newId } from './ids.js';
import {
  createPosting,
  type EntryInput,
  type EntryProvenance,
  type Posting,
  type PostingInput,
  totalsOf,
} from './journal.js';

export const FREQUENCIES = [
  'daily',
  'weekly',
  'fortnightly',
  'monthly',
  'quarterly',
  'yearly',
] as const;

export type Frequency = (typeof FREQUENCIES)[number];

const MAX_OCCURRENCES = 10_000;

export interface RecurrenceRule {
  readonly id: Id;
  readonly frequency: Frequency;
  /** Every `interval` periods: `['monthly', 3]` is quarterly. */
  readonly interval: number;
  readonly startDate: IsoDate;
  readonly endDate: IsoDate | null;
  readonly maxOccurrences: number | null;
  /** Nudge weekend occurrences to the next Monday. */
  readonly adjustWeekend: 'none' | 'next-business-day';
  readonly memo: string;
  readonly reference: string;
  readonly postings: readonly Posting[];
  readonly tags: readonly string[];
  readonly active: boolean;
  readonly createdAt: string;
}

export interface RecurrenceInput {
  readonly id?: Id;
  readonly frequency: Frequency;
  readonly interval?: number;
  readonly startDate: IsoDate;
  readonly endDate?: IsoDate | null;
  readonly maxOccurrences?: number | null;
  readonly adjustWeekend?: 'none' | 'next-business-day';
  readonly memo?: string;
  readonly reference?: string;
  readonly postings: readonly PostingInput[];
  readonly tags?: readonly string[];
  readonly active?: boolean;
  readonly createdAt?: string;
}

export interface Occurrence {
  /** Zero-based index of the occurrence within the rule. */
  readonly index: number;
  /** The scheduled date, before weekend adjustment. */
  readonly scheduledDate: IsoDate;
  /** The date the entry will be dated, after weekend adjustment. */
  readonly date: IsoDate;
  readonly adjusted: boolean;
  /** Deterministic: the same rule and date always produce the same id. */
  readonly entryId: Id;
}

export function isFrequency(value: string): value is Frequency {
  return (FREQUENCIES as readonly string[]).includes(value);
}

export function createRule(input: RecurrenceInput): RecurrenceRule {
  const frequency = parseFrequency(input.frequency);
  const interval = input.interval ?? 1;
  assertInterval(interval);
  if (!isIsoDate(input.startDate)) {
    throw new InvalidRecurrenceError(`startDate '${input.startDate}' must be YYYY-MM-DD`);
  }
  const endDate = input.endDate ?? null;
  assertEndDate(endDate, input.startDate);
  const maxOccurrences = input.maxOccurrences ?? null;
  if (maxOccurrences !== null && (!Number.isInteger(maxOccurrences) || maxOccurrences < 1)) {
    throw new InvalidRecurrenceError('maxOccurrences must be a positive integer');
  }
  const postings = input.postings.map(createPosting);
  assertBalancedTemplate(postings);
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(createdAt))) {
    throw new InvalidRecurrenceError('createdAt must be an ISO-8601 timestamp');
  }

  return Object.freeze({
    id: input.id ?? newId('rule'),
    frequency,
    interval,
    startDate: input.startDate,
    endDate,
    maxOccurrences,
    adjustWeekend: input.adjustWeekend ?? 'none',
    memo: (input.memo ?? '').trim(),
    reference: (input.reference ?? '').trim(),
    postings: Object.freeze(postings),
    tags: Object.freeze([...new Set((input.tags ?? []).map((tag) => tag.trim().toLowerCase()))]),
    active: input.active ?? true,
    createdAt,
  });
}

function assertBalancedTemplate(postings: readonly Posting[]): void {
  if (postings.length < 2) {
    throw new InvalidRecurrenceError('a recurring rule needs at least two postings');
  }
  const totals = totalsOf(postings);
  if (totals.difference !== 0n) {
    throw new InvalidRecurrenceError(
      `postings do not balance (${totals.debits.minor} vs ${totals.credits.minor})`,
    );
  }
}

function assertInterval(interval: number): void {
  if (!Number.isInteger(interval) || interval < 1 || interval > 365) {
    throw new InvalidRecurrenceError('interval must be an integer between 1 and 365');
  }
}

function assertEndDate(endDate: IsoDate | null, startDate: IsoDate): void {
  if (endDate === null) {
    return;
  }
  if (!isIsoDate(endDate)) {
    throw new InvalidRecurrenceError(`endDate '${endDate}' must be YYYY-MM-DD`);
  }
  if (isAfter(startDate, endDate)) {
    throw new InvalidRecurrenceError('endDate cannot be before startDate');
  }
}

function parseFrequency(value: string): Frequency {
  const normalized = value.trim().toLowerCase();
  if (!isFrequency(normalized)) {
    throw new InvalidRecurrenceError(
      `unknown frequency '${value}'; expected one of ${FREQUENCIES.join(', ')}`,
    );
  }
  return normalized;
}

/**
 * A schedule that never drifts.
 *
 * Month-based frequencies keep an *anchor day* from the rule's start date and
 * recompute the day for every month, clamping only when the month is too short.
 * A rule anchored on the 31st therefore runs 31 Jan, 28 Feb, 31 Mar, 30 Apr —
 * the naive "add a month to the previous date" approach would slide to the 28th
 * and stay there for the rest of the year.
 */
class Schedule {
  private cursor: IsoDate;
  private monthIndex: number;
  private readonly anchorDay: number;

  constructor(private readonly rule: RecurrenceRule) {
    this.cursor = rule.startDate;
    const { year, month, day } = parseIsoDate(rule.startDate);
    this.monthIndex = year * 12 + (month - 1);
    this.anchorDay = day;
  }

  current(): IsoDate {
    return this.cursor;
  }

  next(): void {
    this.cursor = isMonthBased(this.rule.frequency)
      ? this.monthAt(this.monthIndex + monthStep(this.rule))
      : addDays(this.cursor, dayStep(this.rule));
    if (isMonthBased(this.rule.frequency)) {
      this.monthIndex += monthStep(this.rule);
    }
  }

  private monthAt(index: number): IsoDate {
    const year = Math.floor(index / 12);
    const month = (index % 12) + 1;
    return makeIsoDate(year, month, Math.min(this.anchorDay, daysInMonth(year, month)));
  }
}

function isMonthBased(frequency: Frequency): boolean {
  return frequency === 'monthly' || frequency === 'quarterly' || frequency === 'yearly';
}

function monthStep(rule: RecurrenceRule): number {
  const unit = rule.frequency === 'yearly' ? 12 : rule.frequency === 'quarterly' ? 3 : 1;
  return unit * rule.interval;
}

function dayStep(rule: RecurrenceRule): number {
  const unit = rule.frequency === 'daily' ? 1 : rule.frequency === 'weekly' ? 7 : 14;
  return unit * rule.interval;
}

function toBusinessDay(date: IsoDate): IsoDate {
  const day = dayOfWeek(date);
  if (day === 6) {
    return addDays(date, 2);
  }
  return day === 0 ? addDays(date, 1) : date;
}

/**
 * Expands a rule into concrete dates.
 *
 * `until` is exclusive-of-nothing: every occurrence on or before it is
 * returned. The expansion is a pure function of the rule, so it can be called
 * as often as you like without side effects — which is what makes scheduled
 * posting idempotent.
 */
export function occurrences(
  rule: RecurrenceRule,
  until: IsoDate,
  limit = MAX_OCCURRENCES,
): Occurrence[] {
  if (!isIsoDate(until)) {
    throw new InvalidRecurrenceError(`until '${until}' must be YYYY-MM-DD`);
  }
  if (limit < 1) {
    throw new InvalidRecurrenceError('limit must be a positive integer');
  }
  const result: Occurrence[] = [];
  const schedule = new Schedule(rule);
  let index = 0;
  let guard = 0;

  while (guard < MAX_OCCURRENCES) {
    guard += 1;
    const scheduled = schedule.current();
    if (rule.endDate !== null && isAfter(scheduled, rule.endDate)) {
      break;
    }
    if (rule.maxOccurrences !== null && index >= rule.maxOccurrences) {
      break;
    }
    if (isAfter(scheduled, until)) {
      break;
    }
    const date = rule.adjustWeekend === 'next-business-day' ? toBusinessDay(scheduled) : scheduled;
    result.push({
      index,
      scheduledDate: scheduled,
      date,
      adjusted: date !== scheduled,
      entryId: occurrenceId(rule.id, scheduled),
    });
    index += 1;
    if (result.length >= limit) {
      break;
    }
    schedule.next();
  }

  return result;
}

export function occurrenceId(ruleId: Id, date: IsoDate): Id {
  return deterministicId('entry', ruleId, date);
}

/** Materialises an occurrence into the input for a balanced journal entry. */
export function occurrenceToEntry(
  rule: RecurrenceRule,
  occurrence: Occurrence,
  options: {
    readonly sequence: number;
    readonly recordedAt?: string;
    readonly source?: EntryProvenance;
  },
): EntryInput {
  if (!rule.active) {
    throw new ValidationError(`Recurring rule '${rule.id}' is inactive.`, { ruleId: rule.id });
  }
  return {
    id: occurrence.entryId,
    date: occurrence.date,
    sequence: options.sequence,
    memo: rule.memo === '' ? `Recurring ${rule.frequency} entry` : rule.memo,
    reference: rule.reference === '' ? `rule:${rule.id}` : rule.reference,
    postings: rule.postings,
    tags: [...rule.tags, 'recurring'],
    source: options.source ?? { kind: 'recurring' as const, ruleId: rule.id },
    ...(options.recordedAt === undefined ? {} : { recordedAt: options.recordedAt }),
  };
}

export function describeRule(rule: RecurrenceRule): string {
  const every = rule.interval === 1 ? rule.frequency : `${rule.interval}x ${rule.frequency}`;
  const end =
    rule.endDate === null
      ? rule.maxOccurrences === null
        ? 'no end'
        : `${rule.maxOccurrences} occurrences`
      : `until ${rule.endDate}`;
  return `${every} from ${rule.startDate} (${end})`;
}
