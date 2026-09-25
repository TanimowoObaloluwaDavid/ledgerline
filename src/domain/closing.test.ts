import { describe, expect, it } from 'vitest';
import { ledgerOf, tree, usd } from '../../test/support/factories.js';
import { createAccount, normalSide, signMultiplier } from './account.js';
import { AccountTree, systemChartOfAccounts } from './account-tree.js';
import { buildClosingEntries } from './closing.js';
import {
  AccountAlreadyExistsError,
  AccountCycleError,
  AccountNotFoundError,
  AccountTypeConflictError,
  ValidationError,
} from './errors.js';
import { FxTable } from './fx.js';
import { type Id, newId } from './ids.js';
import type { Ledger } from './ledger.js';
import { Money } from './money.js';
import { balanceSheet, computeMovements } from './statements.js';

describe('account tree', () => {
  it('indexes parents, children and paths', () => {
    const accounts = tree();
    expect(accounts.childrenOf('1000').map((account) => account.code)).toEqual([
      '1100',
      '1110',
      '1200',
      '1300',
      '1500',
    ]);
    expect(accounts.pathOf('1100')).toEqual(['1000']);
    expect(accounts.depthOf('1000')).toBe(0);
    expect(accounts.depthOf('1100')).toBe(1);
    expect(accounts.ancestorsOf('1100')[0]?.code).toBe('1000');
  });

  it('orders parents before children, siblings by code', () => {
    const ordered = tree()
      .ordered()
      .map((account) => account.code);
    expect(ordered.indexOf('1000')).toBeLessThan(ordered.indexOf('1100'));
    expect(ordered.indexOf('1100')).toBeLessThan(ordered.indexOf('1110'));
  });

  it('knows which accounts can receive postings', () => {
    const accounts = tree();
    expect(accounts.isPostable('1100')).toBe(true);
    expect(accounts.isPostable('1000')).toBe(false);
    expect(accounts.isPostable('3200')).toBe(false);
  });

  it('rejects duplicate codes, unknown parents and type mismatches', () => {
    const base = systemChartOfAccounts();
    expect(() => new AccountTree([...base, base[0] as never])).toThrow(AccountAlreadyExistsError);
    expect(
      () =>
        new AccountTree([
          createAccount({ code: '9000', name: 'X', type: 'asset', parentCode: 'NOPE' }),
        ]),
    ).toThrow(AccountNotFoundError);
    expect(
      () =>
        new AccountTree([
          createAccount({ code: '7000', name: 'Root', type: 'asset' }),
          createAccount({ code: '7001', name: 'Child', type: 'expense', parentCode: '7000' }),
        ]),
    ).toThrow(AccountTypeConflictError);
  });

  it('rejects a cycle', () => {
    expect(
      () =>
        new AccountTree([
          createAccount({ code: '7000', name: 'A', type: 'asset', parentCode: '7001' }),
          createAccount({ code: '7001', name: 'B', type: 'asset', parentCode: '7000' }),
        ]),
    ).toThrow(AccountCycleError);
  });

  it('normalises sides and signs per account type', () => {
    expect(normalSide('asset')).toBe('debit');
    expect(normalSide('liability')).toBe('credit');
    expect(signMultiplier('expense')).toBe(1);
    expect(signMultiplier('income')).toBe(-1);
  });
});

describe('period closing', () => {
  const accounts = tree();
  const fx = FxTable.empty();

  /** Builds a small trading period: revenue 5,000, rent 1,200, utilities 300. */
  function januaryLedger(): Ledger {
    return ledgerOf([
      {
        date: '2025-01-05',
        postings: [
          ['1100', 'debit', usd('5000')],
          ['4100', 'credit', usd('5000')],
        ],
      },
      {
        date: '2025-01-10',
        postings: [
          ['5200', 'debit', usd('1200')],
          ['1100', 'credit', usd('1200')],
        ],
      },
      {
        date: '2025-01-15',
        postings: [
          ['5300', 'debit', usd('300')],
          ['1100', 'credit', usd('300')],
        ],
      },
    ]);
  }

  const close = (ledger: Ledger, rates: FxTable = fx, from?: string) => {
    let counter = 0;
    let sequence = ledger.nextSequence();
    return buildClosingEntries(ledger, accounts, {
      ...(from === undefined ? {} : { from }),
      to: '2025-01-31',
      date: '2025-01-31',
      retainedEarningsCode: '3200',
      retainedEarningsCurrency: 'USD',
      fxClearingCode: '3210',
      nextId: (): Id => {
        counter += 1;
        return `ent_close_${counter}`;
      },
      nextSequence: () => {
        const value = sequence;
        sequence += 1;
        return value;
      },
      fx: rates,
    });
  };

  it('moves the period result into retained earnings', () => {
    const entries = close(januaryLedger(), fx, '2025-01-01');
    expect(entries).toHaveLength(1);
    const [closing] = entries;
    expect(closing?.memo).toContain('2025-01-01');
    // Two income/expense lines that moved, plus retained earnings.
    expect(closing?.postings.map((posting) => posting.accountCode)).toEqual([
      '4100',
      '5200',
      '5300',
      '3200',
    ]);

    const retained = closing?.postings.find((posting) => posting.accountCode === '3200');
    expect(retained?.side).toBe('credit');
    expect(retained?.amount.minor).toBe(350_000n);
  });

  it('zeroes the temporary accounts and keeps the balance sheet balanced', () => {
    const ledger = januaryLedger();
    for (const item of close(ledger, fx, '2025-01-01')) {
      ledger.append(item);
    }
    const movements = computeMovements(ledger, accounts, {});
    for (const code of ['4100', '5200', '5300']) {
      const net = movements.direct(code, false)[0]?.net ?? 0n;
      expect(net).toBe(0n);
    }

    const sheet = balanceSheet(
      ledger,
      accounts,
      { to: '2025-01-31' },
      {
        functionalCurrency: 'USD',
        fx,
      },
    );
    expect(sheet.balanced).toBe(true);
    expect(sheet.equity.total.minor).toBe(350_000n);
    expect(sheet.currentEarnings.isZero()).toBe(true);
  });

  it('is safe to run twice: the second run has nothing left to close', () => {
    const ledger = januaryLedger();
    for (const item of close(ledger, fx, '2025-01-01')) {
      ledger.append(item);
    }
    expect(close(ledger, fx, '2025-01-01')).toEqual([]);
  });

  it('refuses to close into a non-equity account', () => {
    expect(() =>
      buildClosingEntries(januaryLedger(), accounts, {
        to: '2025-01-31',
        date: '2025-01-31',
        retainedEarningsCode: '1000',
        retainedEarningsCurrency: 'USD',
        fxClearingCode: '3210',
        nextId: () => newId('entry'),
        nextSequence: () => 99,
        fx,
      }),
    ).toThrow(ValidationError);
  });

  it('refuses a closing entry dated before the period it closes', () => {
    expect(() =>
      buildClosingEntries(januaryLedger(), accounts, {
        to: '2025-01-31',
        date: '2025-01-01',
        retainedEarningsCode: '3200',
        retainedEarningsCurrency: 'USD',
        fxClearingCode: '3210',
        nextId: () => newId('entry'),
        nextSequence: () => 99,
        fx,
      }),
    ).toThrow(ValidationError);
  });

  it('closes a foreign-currency period as a balanced pair', () => {
    const rates = FxTable.empty().add({
      base: 'EUR',
      quote: 'USD',
      rate: '1.10',
      effectiveDate: '2025-01-01',
    });
    const ledger = ledgerOf([
      {
        date: '2025-01-05',
        postings: [
          ['1100', 'debit', '1000.00 EUR'],
          ['4100', 'credit', '1000.00 EUR'],
        ],
      },
    ]);

    const entries = close(ledger, rates, '2025-01-01');
    expect(entries).toHaveLength(2);

    const [foreign, translated] = entries;
    expect(foreign?.postings.every((posting) => posting.amount.currency === 'EUR')).toBe(true);
    expect(foreign?.postings.at(-1)?.accountCode).toBe('3210');
    expect(foreign?.postings.at(-1)?.amount.minor).toBe(100_000n);

    expect(translated?.postings.every((posting) => posting.amount.currency === 'USD')).toBe(true);
    expect(translated?.postings.at(-1)?.accountCode).toBe('3200');
    expect(translated?.postings.at(-1)?.amount.minor).toBe(110_000n);

    for (const item of entries) {
      ledger.append(item);
    }
    expect(ledger.isBalanced()).toBe(true);

    const sheet = balanceSheet(
      ledger,
      accounts,
      { to: '2025-01-31' },
      {
        functionalCurrency: 'USD',
        fx: rates,
      },
    );
    expect(sheet.balanced).toBe(true);
    // Assets 1,000 EUR translated at 1.10, matched by retained earnings.
    expect(sheet.totalAssets.minor).toBe(110_000n);
    expect(sheet.equity.total.minor).toBe(110_000n);
  });

  it('keeps the ledger balanced after closing', () => {
    const ledger = januaryLedger();
    for (const item of close(ledger, fx, '2025-01-01')) {
      ledger.append(item);
    }
    expect(ledger.isBalanced()).toBe(true);
  });
});

describe('Money in reports', () => {
  it('exposes exact decimals', () => {
    expect(Money.fromMajor('USD', '1234.50').toDecimalString()).toBe('1234.50');
  });
});
