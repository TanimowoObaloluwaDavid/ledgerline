import { type AccountInput, createAccount } from '../../src/domain/account.js';
import { AccountTree, systemChartOfAccounts } from '../../src/domain/account-tree.js';
import { FxTable } from '../../src/domain/fx.js';
import { type Id, newId } from '../../src/domain/ids.js';
import {
  createEntry,
  type EntryInput,
  type JournalEntry,
  type PostingInput,
} from '../../src/domain/journal.js';
import { Ledger } from '../../src/domain/ledger.js';
import { Money } from '../../src/domain/money.js';

export function usd(amount: string | number): Money {
  return Money.fromMajor('USD', String(amount));
}

export function gbp(amount: string | number): Money {
  return Money.fromMajor('GBP', String(amount));
}

export function jpy(amount: string | number): Money {
  return Money.fromMajor('JPY', String(amount));
}

/** A chart of accounts with the system template plus optional extras. */
export function tree(extra: readonly AccountInput[] = []): AccountTree {
  return new AccountTree([...systemChartOfAccounts(), ...extra.map(createAccount)]);
}

export interface EntrySpec {
  readonly date: string;
  readonly memo?: string;
  readonly reference?: string;
  readonly postings: readonly (readonly [string, 'debit' | 'credit', Money | string])[];
  readonly tags?: readonly string[];
  readonly id?: Id;
  readonly sequence?: number;
}

/** Builds a valid entry: the first two postings are mirrored if unbalanced. */
export function entry(spec: EntrySpec, sequence = 1): JournalEntry {
  const postings: PostingInput[] = spec.postings.map(([code, side, amount]) => ({
    accountCode: code,
    side,
    amount,
  }));
  return createEntry({
    id: spec.id ?? newId('entry'),
    sequence,
    date: spec.date,
    ...(spec.memo === undefined ? {} : { memo: spec.memo }),
    ...(spec.reference === undefined ? {} : { reference: spec.reference }),
    ...(spec.tags === undefined ? {} : { tags: spec.tags }),
    postings,
  } satisfies EntryInput);
}

export function ledgerOf(specs: readonly EntrySpec[]): Ledger {
  const ledger = new Ledger();
  specs.forEach((spec, index) => {
    ledger.append(entry(spec, index + 1));
  });
  return ledger;
}

export function fx(entries: readonly [string, string, string, string][] = []): FxTable {
  return entries.reduce<Rx>(
    (table, [base, quote, rate, date]) => table.add({ base, quote, rate, effectiveDate: date }),
    new FxTable(),
  );
}

type Rx = FxTable;
