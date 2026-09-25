import { describe, expect, it } from 'vitest';
import { usd } from '../../test/support/factories.js';
import { createAccount } from './account.js';
import { AccountTree } from './account-tree.js';
import {
  AccountNotFoundError,
  AccountNotPostableError,
  CurrencyMismatchError,
  ValidationError,
} from './errors.js';
import { createPosting } from './journal.js';
import { assertPostingsAllowed, balanceOf } from './postings.js';

describe('posting rules', () => {
  const tree = new AccountTree([
    createAccount({ code: '1000', name: 'Assets', type: 'asset' }),
    createAccount({
      code: '1100',
      name: 'Cash',
      type: 'asset',
      parentCode: '1000',
      currency: 'USD',
    }),
    createAccount({ code: '3200', name: 'Retained Earnings', type: 'equity', computed: true }),
    createAccount({ code: '4000', name: 'Revenue', type: 'income' }),
  ]);

  it('accepts a well-formed posting to a postable account', () => {
    expect(() =>
      assertPostingsAllowed(tree, [
        createPosting({ accountCode: '1100', side: 'debit', amount: usd('10') }),
      ]),
    ).not.toThrow();
  });

  it('rejects roll-up parents', () => {
    expect(() =>
      assertPostingsAllowed(tree, [
        createPosting({ accountCode: '1000', side: 'debit', amount: usd('10') }),
      ]),
    ).toThrow(AccountNotPostableError);
  });

  it('rejects computed accounts', () => {
    expect(() =>
      assertPostingsAllowed(tree, [
        createPosting({ accountCode: '3200', side: 'credit', amount: usd('10') }),
      ]),
    ).toThrow(ValidationError);
  });

  it('rejects a currency the account is not denominated in', () => {
    expect(() =>
      assertPostingsAllowed(tree, [
        createPosting({ accountCode: '1100', side: 'debit', amount: '10.00 EUR' }),
      ]),
    ).toThrow(CurrencyMismatchError);
  });

  it('rejects unknown accounts', () => {
    expect(() =>
      assertPostingsAllowed(tree, [
        createPosting({ accountCode: 'NOPE', side: 'debit', amount: usd('10') }),
      ]),
    ).toThrow(AccountNotFoundError);
  });

  it('sums debit-positive balances per account type', () => {
    const postings = [
      createPosting({ accountCode: '1100', side: 'debit', amount: usd('500') }),
      createPosting({ accountCode: '1100', side: 'credit', amount: usd('200') }),
      createPosting({ accountCode: '4000', side: 'credit', amount: usd('300') }),
    ];
    // Cash is debit-normal: 500 - 200 = 300.
    expect(balanceOf(tree, postings, new Set(['1100']), 'USD').minor).toBe(30_000n);
    // Revenue is credit-normal: a credit of 300 is +300.
    expect(balanceOf(tree, postings, new Set(['4000']), 'USD').minor).toBe(30_000n);
  });
});
