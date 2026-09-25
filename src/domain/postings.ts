import type { AccountTree } from './account-tree.js';
import { AccountNotPostableError, CurrencyMismatchError, ValidationError } from './errors.js';
import type { Posting } from './journal.js';
import { Money } from './money.js';

/**
 * The rules that connect a journal entry to the chart of accounts.
 *
 * `assertEntryIsWellFormed` checks an entry against itself — it balances, it uses
 * one currency, it is not a no-op. These checks look *outward*, at the accounts it
 * touches, and they are the reason a report can never mention an account that was
 * never posted to.
 */

/**
 * Rejects postings to accounts that cannot legally receive them:
 *
 * - roll-up parents, because their balance is the sum of their children;
 * - computed accounts, because the engine derives them and hand-written
 *   postings would silently disagree with the report;
 * - amounts in a currency the account is not denominated in.
 */
export function assertPostingsAllowed(tree: AccountTree, postings: readonly Posting[]): void {
  for (const posting of postings) {
    const account = tree.get(posting.accountCode);
    if (tree.childrenOf(account.code).length > 0) {
      throw new AccountNotPostableError(account.code);
    }
    if (account.computed) {
      throw new ValidationError(
        `Account '${account.code}' is computed and rejects direct postings.`,
        { code: account.code, account: account.name },
      );
    }
    if (account.currency !== null && account.currency !== posting.amount.currency) {
      throw new CurrencyMismatchError(account.currency, posting.amount.currency);
    }
  }
}

/** Total of `codes`' balances in one currency, debit-positive. */
export function balanceOf(
  tree: AccountTree,
  postings: readonly Posting[],
  codes: ReadonlySet<string>,
  currency: string,
): Money {
  let total = 0n;
  for (const posting of postings) {
    if (!codes.has(posting.accountCode) || posting.amount.currency !== currency) {
      continue;
    }
    const account = tree.get(posting.accountCode);
    const raw = posting.side === 'debit' ? posting.amount.minor : -posting.amount.minor;
    const normal = account.type === 'asset' || account.type === 'expense' ? 1n : -1n;
    total += normal * raw;
  }
  return Money.fromMinor(currency, total);
}
