import { describe, expect, it } from 'vitest';
import { gbp, ledgerOf, tree, usd } from '../../test/support/factories.js';
import { ValidationError } from './errors.js';
import { FxTable } from './fx.js';
import { Money } from './money.js';
import { accountStatement, balanceSheet, incomeStatement, trialBalance } from './statements.js';

/** A tiny trading year: capital in, sales on credit, costs, cash settled. */
const scenario = [
  {
    date: '2025-01-01',
    memo: 'Owner investment',
    postings: [
      ['1100', 'debit', usd('10000')],
      ['3100', 'credit', usd('10000')],
    ],
  },
  {
    date: '2025-01-05',
    memo: 'Invoice 1001',
    postings: [
      ['1200', 'debit', usd('2000')],
      ['4100', 'credit', usd('2000')],
    ],
  },
  {
    date: '2025-01-10',
    memo: 'January rent',
    postings: [
      ['5200', 'debit', usd('800')],
      ['1100', 'credit', usd('800')],
    ],
  },
  {
    date: '2025-01-12',
    memo: 'Stock on credit',
    postings: [
      ['1300', 'debit', usd('1200')],
      ['2100', 'credit', usd('1200')],
    ],
  },
  {
    date: '2025-01-15',
    memo: 'Invoice 1001 paid',
    postings: [
      ['1100', 'debit', usd('2000')],
      ['1200', 'credit', usd('2000')],
    ],
  },
  {
    date: '2025-01-20',
    memo: 'Supplier paid',
    postings: [
      ['2100', 'debit', usd('1200')],
      ['1100', 'credit', usd('1200')],
    ],
  },
] as const;

const options = { functionalCurrency: 'USD', fx: FxTable.empty() };

describe('trial balance', () => {
  const ledger = ledgerOf(scenario);
  const accounts = tree();

  it('balances to the last minor unit', () => {
    const report = trialBalance(ledger, accounts, { to: '2025-01-31' }, options);
    expect(report.totals.balanced).toBe(true);
    expect(report.totals.debit.minor).toBe(report.totals.credit.minor);
    expect(report.totals.debit.minor).toBe(1_720_000n);
  });

  it('rolls child accounts into their parent subtotals', () => {
    const report = trialBalance(ledger, accounts, { to: '2025-01-31' }, options);
    const row = (code: string) => report.rows.find((item) => item.code === code);

    expect(row('1100')?.amount.minor).toBe(1_000_000n);
    expect(row('1000')?.amount.minor).toBe(1_120_000n);
    expect(row('1000')?.isSubtotal).toBe(true);
    expect(row('1100')?.isSubtotal).toBe(false);
  });

  it('honours the reporting period', () => {
    const january = incomeStatement(
      ledger,
      accounts,
      { from: '2025-01-01', to: '2025-01-31' },
      options,
    );
    const february = incomeStatement(
      ledger,
      accounts,
      { from: '2025-02-01', to: '2025-02-28' },
      options,
    );
    expect(january.netIncome.minor).toBe(120_000n);
    expect(february.netIncome.isZero()).toBe(true);
  });
});

describe('balance sheet', () => {
  const ledger = ledgerOf(scenario);
  const accounts = tree();

  it('satisfies assets = liabilities + equity', () => {
    const sheet = balanceSheet(ledger, accounts, { to: '2025-01-31' }, options);
    expect(sheet.totalAssets.minor).toBe(1_120_000n);
    expect(sheet.currentEarnings.minor).toBe(120_000n);
    expect(sheet.equity.total.minor).toBe(1_000_000n);
    expect(sheet.balanced).toBe(true);
    expect(sheet.difference.isZero()).toBe(true);
  });

  it('groups sections by account type', () => {
    const sheet = balanceSheet(ledger, accounts, { to: '2025-01-31' }, options);
    expect(sheet.assets.title).toBe('Assets');
    expect(sheet.liabilities.total.isZero()).toBe(true);
    expect(sheet.assets.lines.map((line) => line.code)).toContain('1100');
  });

  it('defaults to the latest entry date', () => {
    const sheet = balanceSheet(ledger, accounts, {}, options);
    expect(sheet.asOf).toBe('2025-01-20');
  });

  it('refuses to invent a date for an empty ledger', () => {
    expect(() => balanceSheet(ledgerOf([]), accounts, {}, options)).toThrow(ValidationError);
  });
});

describe('income statement', () => {
  const ledger = ledgerOf(scenario);

  it('reports revenue, expenses and the resulting profit', () => {
    const report = incomeStatement(
      ledger,
      tree(),
      { from: '2025-01-01', to: '2025-01-31' },
      options,
    );
    expect(report.totalRevenue.minor).toBe(200_000n);
    expect(report.totalExpenses.minor).toBe(80_000n);
    expect(report.netIncome.minor).toBe(120_000n);
  });
});

describe('account statement', () => {
  const ledger = ledgerOf(scenario);

  it('carries a running balance and period opening', () => {
    const statement = accountStatement(
      ledger,
      tree(),
      '1100',
      { from: '2025-01-11', to: '2025-01-31' },
      options,
    );
    expect(statement.openingBalance.minor).toBe(920_000n);
    expect(statement.closingBalance.minor).toBe(1_000_000n);
    expect(statement.lines).toHaveLength(2);
    expect(statement.totalDebits.minor).toBe(200_000n);
    expect(statement.totalCredits.minor).toBe(120_000n);
  });

  it('includes descendant accounts when asked for a parent', () => {
    const statement = accountStatement(ledger, tree(), '1000', { to: '2025-01-31' }, options);
    expect(statement.closingBalance.minor).toBe(1_120_000n);
  });

  it('uses credit-positive balances for credit-normal accounts', () => {
    const statement = accountStatement(ledger, tree(), '4100', {}, options);
    expect(statement.closingBalance.minor).toBe(200_000n);
  });

  it('counts an entry on the period start exactly once', () => {
    // 2025-01-01 falls inside this period, so it must appear in the activity and
    // not in the opening balance.
    const statement = accountStatement(
      ledger,
      tree(),
      '1100',
      { from: '2025-01-01', to: '2025-01-31' },
      options,
    );
    expect(statement.lines[0]?.date).toBe('2025-01-01');
    expect(
      statement.openingBalance
        .add(statement.totalDebits)
        .subtract(statement.totalCredits)
        .equals(statement.closingBalance),
    ).toBe(true);
  });
});

describe('multi-currency reporting', () => {
  const fx = FxTable.empty().add({
    base: 'GBP',
    quote: 'USD',
    rate: '1.25',
    effectiveDate: '2025-01-01',
  });

  const ledger = ledgerOf([
    {
      date: '2025-01-02',
      memo: 'London client',
      postings: [
        ['1100', 'debit', gbp('1000')],
        ['4100', 'credit', gbp('1000')],
      ],
    },
    {
      date: '2025-01-03',
      memo: 'US client',
      postings: [
        ['1110', 'debit', usd('500')],
        ['4100', 'credit', usd('500')],
      ],
    },
  ]);

  it('translates every currency into the functional one at the closing rate', () => {
    const sheet = balanceSheet(
      ledger,
      tree(),
      { to: '2025-01-31' },
      { functionalCurrency: 'USD', fx },
    );
    expect(sheet.totalAssets.minor).toBe(175_000n);
    expect(sheet.balanced).toBe(true);
  });

  it('keeps a missing rate an error rather than guessing', () => {
    const bare = FxTable.empty();
    expect(() =>
      balanceSheet(ledger, tree(), { to: '2025-01-31' }, { functionalCurrency: 'USD', fx: bare }),
    ).toThrow();
  });

  it('can use period-average rates for the income statement', () => {
    const stepping = FxTable.empty()
      .add({ base: 'GBP', quote: 'USD', rate: '1.20', effectiveDate: '2025-01-01' })
      .add({ base: 'GBP', quote: 'USD', rate: '1.30', effectiveDate: '2025-01-16' });
    const closing = incomeStatement(
      ledger,
      tree(),
      { from: '2025-01-01', to: '2025-01-31' },
      { functionalCurrency: 'USD', fx: stepping },
    );
    const averaged = incomeStatement(
      ledger,
      tree(),
      { from: '2025-01-01', to: '2025-01-31' },
      { functionalCurrency: 'USD', fx: stepping, rateMode: 'average' },
    );
    expect(closing.netIncome.minor).toBe(180_000n);
    expect(averaged.netIncome.minor).toBe(175_161n);
  });
});

describe('money formatting in reports', () => {
  it('keeps exact decimals through to JSON', () => {
    const ledger = ledgerOf(scenario);
    const report = incomeStatement(
      ledger,
      tree(),
      { from: '2025-01-01', to: '2025-01-31' },
      options,
    );
    const json = JSON.parse(JSON.stringify(report.netIncome)) as MoneyJsonLike;
    expect(json.decimal).toBe('1200.00');
    expect(Money.fromJson(json).minor).toBe(120_000n);
  });
});

interface MoneyJsonLike {
  readonly currency: string;
  readonly minor: string;
  readonly decimal: string;
  readonly exponent: number;
}
