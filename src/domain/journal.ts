import { type AccountType, normalSide, type Side } from './account.js';
import { type IsoDate, isIsoDate } from './date.js';
import {
  DuplicateAccountInEntryError,
  EmptyEntryError,
  EntryAlreadyReversedError,
  UnbalancedEntryError,
  ValidationError,
} from './errors.js';
import type { Id } from './ids.js';
import { Money } from './money.js';

export interface Posting {
  readonly accountCode: string;
  readonly side: Side;
  /** Always a positive magnitude; direction lives in `side`. */
  readonly amount: Money;
  readonly memo: string;
}

export type EntrySource = 'manual' | 'recurring' | 'opening' | 'import' | 'reversal' | 'adjustment';

export interface EntryProvenance {
  readonly kind: EntrySource;
  readonly ruleId?: Id;
  readonly idempotencyKey?: string;
}

export interface JournalEntry {
  readonly id: Id;
  /** Monotonic per-ledger ordering, independent of the entry date. */
  readonly sequence: number;
  readonly date: IsoDate;
  readonly memo: string;
  readonly reference: string;
  readonly postings: readonly Posting[];
  readonly tags: readonly string[];
  readonly recordedAt: string;
  readonly reversesId: Id | null;
  readonly source: EntryProvenance;
}

export interface PostingInput {
  readonly accountCode: string;
  readonly side: Side;
  readonly amount: Money | string;
  readonly memo?: string;
}

export interface EntryInput {
  readonly id: Id;
  readonly sequence: number;
  readonly date: IsoDate;
  readonly memo?: string;
  readonly reference?: string;
  readonly postings: readonly PostingInput[];
  readonly tags?: readonly string[];
  readonly recordedAt?: string;
  readonly reversesId?: Id | null;
  readonly source?: EntryProvenance;
}

export interface EntryTotals {
  readonly currency: string;
  readonly debits: Money;
  readonly credits: Money;
  readonly difference: bigint;
}

const ACCOUNT_CODE_PATTERN = /^[A-Z0-9][A-Z0-9:._-]{0,31}$/;

export function createPosting(input: PostingInput): Posting {
  const accountCode = input.accountCode.trim().toUpperCase();
  if (!ACCOUNT_CODE_PATTERN.test(accountCode)) {
    throw new ValidationError(`Posting references malformed account '${input.accountCode}'.`, {
      accountCode: input.accountCode,
    });
  }
  if (input.side !== 'debit' && input.side !== 'credit') {
    throw new ValidationError(`Posting side must be 'debit' or 'credit'.`, {
      accountCode,
      side: input.side,
    });
  }
  const amount = typeof input.amount === 'string' ? Money.parse(input.amount) : input.amount;
  amount.isStrictlyPositive();
  return Object.freeze({
    accountCode,
    side: input.side,
    amount,
    memo: (input.memo ?? '').trim(),
  });
}

/**
 * Builds a journal entry and enforces every invariant a ledger depends on.
 *
 * A journal entry is immutable once created. Nothing can be edited in place;
 * corrections are expressed as reversals, so history stays auditable.
 */
export function createEntry(input: EntryInput): JournalEntry {
  if (!isIsoDate(input.date)) {
    throw new ValidationError(`Entry date '${input.date}' must be YYYY-MM-DD.`, {
      date: input.date,
    });
  }
  if (!Number.isInteger(input.sequence) || input.sequence < 1) {
    throw new ValidationError('Entry sequence must be a positive integer.', {
      sequence: input.sequence,
    });
  }
  const memo = (input.memo ?? '').trim();
  if (memo.length > 280) {
    throw new ValidationError('Entry memo is limited to 280 characters.', { memo });
  }
  const reference = (input.reference ?? '').trim();
  if (reference.length > 64) {
    throw new ValidationError('Entry reference is limited to 64 characters.', { reference });
  }
  const tags = [
    ...new Set(
      (input.tags ?? []).map((tag) => tag.trim().toLowerCase()).filter((tag) => tag !== ''),
    ),
  ];
  if (tags.length > 12) {
    throw new ValidationError('An entry may carry at most 12 tags.', { tags });
  }
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(recordedAt))) {
    throw new ValidationError('recordedAt must be an ISO-8601 timestamp.', { recordedAt });
  }

  const postings = input.postings.map(createPosting);
  assertEntryIsWellFormed(postings);

  return Object.freeze({
    id: input.id,
    sequence: input.sequence,
    date: input.date,
    memo,
    reference,
    postings: Object.freeze(postings),
    tags: Object.freeze(tags),
    recordedAt,
    reversesId: input.reversesId ?? null,
    source: input.source ?? { kind: 'manual' as EntrySource },
  });
}

/**
 * Structural invariants, independent of the account tree:
 * two or more distinct accounts, one currency, no duplicate line, balanced.
 */
export function assertEntryIsWellFormed(postings: readonly Posting[]): void {
  if (postings.length < 2) {
    throw new EmptyEntryError('a journal entry needs at least two postings');
  }
  const currency = postings[0]?.amount.currency;
  const accounts = new Set<string>();
  const seenLines = new Set<string>();
  for (const posting of postings) {
    if (posting.amount.currency !== currency) {
      throw new ValidationError('A journal entry may only use a single currency.', {
        expected: currency,
        found: posting.amount.currency,
        accountCode: posting.accountCode,
      });
    }
    accounts.add(posting.accountCode);
    const lineKey = `${posting.accountCode}:${posting.side}`;
    if (seenLines.has(lineKey)) {
      throw new DuplicateAccountInEntryError(posting.accountCode);
    }
    seenLines.add(lineKey);
  }
  if (accounts.size < 2) {
    throw new EmptyEntryError('a journal entry must touch at least two distinct accounts');
  }

  const totals = totalsOf(postings);
  if (totals.difference !== 0n) {
    throw new UnbalancedEntryError(
      totals.debits.minor,
      totals.credits.minor,
      String(totals.currency),
    );
  }
}

export function totalsOf(postings: readonly Posting[]): EntryTotals {
  const first = postings[0];
  if (first === undefined) {
    throw new EmptyEntryError('no postings');
  }
  let debits = 0n;
  let credits = 0n;
  for (const posting of postings) {
    if (posting.side === 'debit') {
      debits += posting.amount.minor;
    } else {
      credits += posting.amount.minor;
    }
  }
  return {
    currency: first.amount.currency,
    debits: Money.fromMinor(first.amount.currency, debits),
    credits: Money.fromMinor(first.amount.currency, credits),
    difference: debits - credits,
  };
}

export function entryTotals(entry: JournalEntry): EntryTotals {
  return totalsOf(entry.postings);
}

/** The mirrored postings that cancel an entry out. */
export function reversalPostings(entry: JournalEntry): readonly Posting[] {
  return entry.postings.map((posting) =>
    Object.freeze({
      accountCode: posting.accountCode,
      side: posting.side === 'debit' ? 'credit' : 'debit',
      amount: posting.amount,
      memo: posting.memo,
    }),
  );
}

export function buildReversal(
  original: JournalEntry,
  options: {
    readonly id: Id;
    readonly sequence: number;
    readonly date: IsoDate;
    readonly recordedAt?: string;
    readonly idempotencyKey?: string;
  },
): JournalEntry {
  return createEntry({
    id: options.id,
    sequence: options.sequence,
    date: options.date,
    memo: `Reversal of ${original.id}`,
    reference: original.reference,
    postings: reversalPostings(original),
    tags: original.tags,
    reversesId: original.id,
    ...(options.recordedAt === undefined ? {} : { recordedAt: options.recordedAt }),
    source: {
      kind: 'reversal' as EntrySource,
      ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    },
  });
}

export function assertNotAlreadyReversed(
  entry: JournalEntry,
  reversalOf: (id: Id) => JournalEntry | undefined,
): void {
  const existing = reversalOf(entry.id);
  if (existing !== undefined) {
    throw new EntryAlreadyReversedError(entry.id, existing.id);
  }
}

/**
 * Debit-positive amount for an account, given its normal side.
 *
 * Income, liability and equity accounts are credit-normal, so their balances
 * are negated. Every report in the engine works in this convention and only
 * converts back to "debit/credit columns" for presentation.
 */
export function signedMinor(posting: Posting, accountType: AccountType): bigint {
  const raw = posting.side === 'debit' ? posting.amount.minor : -posting.amount.minor;
  return normalSide(accountType) === 'credit' ? -raw : raw;
}
