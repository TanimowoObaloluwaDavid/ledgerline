import { pathToFileURL } from 'node:url';
import { LedgerService } from '../../application/service.js';
import type { AccountType } from '../../domain/account.js';
import { assertAccountType, isAccountType } from '../../domain/account.js';
import { assertCurrency, type CurrencyCode } from '../../domain/currency.js';
import type { IsoDate } from '../../domain/date.js';
import { isIsoDate } from '../../domain/date.js';
import type { Frequency } from '../../domain/recurring.js';
import { isFrequency } from '../../domain/recurring.js';
import { InMemoryStore } from '../../infrastructure/memory-store.js';
import { SqliteStore } from '../../infrastructure/sqlite-store.js';
import { formatError, renderMoneyWithCode, renderSection } from './format.js';

/**
 * `ledgerline <command> [options]`
 *
 * Commands are dispatched from a table, every one of them is a pure function of
 * the service plus its parsed arguments, and unknown flags are an error rather
 * than being ignored — a typo in a bookkeeping command is not something to shrug
 * off.
 */

interface Context {
  readonly service: LedgerService;
  readonly args: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
}

type Command = { readonly usage: string; readonly run: (context: Context) => Promise<string> };

const commands: Record<string, Command> = {
  help: {
    usage: 'ledgerline help',
    run: async () => usage(),
  },

  'account:list': {
    usage: 'ledgerline account:list [--type=asset]',
    run: async ({ service, flags }) => {
      const type = optionalAccountTypeFlag(flags, 'type');
      const accounts = await service.accounts(type === undefined ? {} : { type });
      return accounts
        .map((account) => `${account.code.padEnd(6)} ${account.type.padEnd(10)} ${account.name}`)
        .join('\n');
    },
  },

  'account:create': {
    usage: 'ledgerline account:create --code=1600 --name="Prepaid Rent" --type=asset --parent=1000',
    run: async ({ service, flags }) => {
      const currency = optionalCurrencyFlag(flags, 'currency');
      const account = await service.createAccount({
        code: requireFlag(flags, 'code').toUpperCase(),
        name: requireFlag(flags, 'name'),
        type: accountTypeFlag(flags, 'type'),
        ...(typeof flags.parent === 'string' ? { parentCode: flags.parent.toUpperCase() } : {}),
        ...(currency === undefined ? {} : { currency }),
        ...(typeof flags.description === 'string' ? { description: flags.description } : {}),
      });
      return `created ${account.code} (${account.type})`;
    },
  },

  'entry:post': {
    usage:
      'ledgerline entry:post --date=2025-01-05 --memo="Invoice 1" ' +
      '--posting=1100:debit:5000.00 --posting=4100:credit:5000.00 [--ref=INV-1] [--key=abc]',
    run: async ({ service, flags }) => {
      const postings = listFlag(flags, 'posting', false).map((raw) =>
        parsePosting(raw, service.functionalCurrency),
      );
      const result = await service.postEntry(
        {
          date: dateFlag(flags, 'date'),
          postings,
          ...(typeof flags.memo === 'string' ? { memo: flags.memo } : {}),
          ...(typeof flags.ref === 'string' ? { reference: flags.ref } : {}),
          ...(listFlag(flags, 'tag').length === 0 ? {} : { tags: listFlag(flags, 'tag') }),
        },
        typeof flags.key === 'string' ? { idempotencyKey: flags.key } : {},
      );
      return `${result.created ? 'posted' : 'replayed'} ${result.entry.id} (${
        result.entry.postings.length
      } postings)`;
    },
  },

  'entry:list': {
    usage: 'ledgerline entry:list [--from=2025-01-01] [--to=2025-01-31]',
    run: async ({ service, flags }) => {
      const from = optionalDateFlag(flags, 'from');
      const to = optionalDateFlag(flags, 'to');
      const entries = await service.entries({
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
      });
      return entries
        .map((entry) => {
          const total = entry.postings[0]?.amount;
          const amount = total === undefined ? '' : renderMoneyWithCode(total);
          return `${entry.date} #${String(entry.sequence).padStart(4)} ${entry.id} ${amount} ${
            entry.memo
          }`;
        })
        .join('\n');
    },
  },

  'entry:reverse': {
    usage: 'ledgerline entry:reverse --id=ent_... [--date=2025-02-01]',
    run: async ({ service, flags }) => {
      const reversal = await service.reverseEntry(
        requireFlag(flags, 'id'),
        { date: dateFlag(flags, 'date', today()) },
        typeof flags.key === 'string' ? { idempotencyKey: flags.key } : {},
      );
      return `reversed by ${reversal.id}`;
    },
  },

  'fx:rate': {
    usage: 'ledgerline fx:rate --base=EUR --quote=USD --rate=1.10 --date=2025-01-01',
    run: async ({ service, flags }) => {
      const rate = await service.recordRate({
        base: currencyFlag(flags, 'base'),
        quote: currencyFlag(flags, 'quote'),
        rate: requireFlag(flags, 'rate'),
        effectiveDate: dateFlag(flags, 'date'),
        ...(typeof flags.source === 'string' ? { source: flags.source } : {}),
      });
      return `recorded ${rate.base}/${rate.quote} = ${rate.rate.toDecimalString(6)} from ${rate.effectiveDate}`;
    },
  },

  'recurring:create': {
    usage:
      'ledgerline recurring:create --frequency=monthly --from=2025-01-01 ' +
      '--posting=5200:debit:1200.00 --posting=1100:credit:1200.00 --memo=Rent',
    run: async ({ service, flags }) => {
      const endDate = optionalDateFlag(flags, 'until');
      const rule = await service.createRecurringRule({
        frequency: frequencyFlag(flags, 'frequency'),
        startDate: dateFlag(flags, 'from'),
        postings: listFlag(flags, 'posting', false).map((raw) =>
          parsePosting(raw, service.functionalCurrency),
        ),
        ...(typeof flags.every === 'string' ? { interval: Number(flags.every) } : {}),
        ...(endDate === undefined ? {} : { endDate }),
        ...(typeof flags.occurrences === 'string'
          ? { maxOccurrences: Number(flags.occurrences) }
          : {}),
        ...(typeof flags.memo === 'string' ? { memo: flags.memo } : {}),
      });
      return `created rule ${rule.id}`;
    },
  },

  'recurring:preview': {
    usage: 'ledgerline recurring:preview --id=rul_... --until=2025-12-31',
    run: async ({ service, flags }) => {
      const due = await service.previewOccurrences(requireFlag(flags, 'id'), {
        until: dateFlag(flags, 'until'),
      });
      return due
        .map((occurrence) =>
          `${occurrence.date} ${occurrence.adjusted ? `(moved from ${occurrence.scheduledDate})` : ''}`.trim(),
        )
        .join('\n');
    },
  },

  'recurring:run': {
    usage: 'ledgerline recurring:run --until=2025-12-31',
    run: async ({ service, flags }) => {
      const result = await service.runRecurring({ until: dateFlag(flags, 'until') });
      return `created ${result.created.length}, skipped ${result.skipped}`;
    },
  },

  'report:trial': {
    usage: 'ledgerline report:trial [--to=2025-01-31]',
    run: async ({ service, flags }) => {
      const report = await service.trialBalance(period(flags));
      const rows = report.rows.map(
        (row) =>
          `${row.code.padEnd(6)} ${row.name.padEnd(30)} ${renderMoneyWithCode(row.debit, 14)} ${renderMoneyWithCode(
            row.credit,
            14,
          )}`,
      );
      return [
        `Trial balance as of ${report.asOf}`,
        ...rows,
        `Totals: ${renderMoneyWithCode(report.totals.debit, 14)} ${renderMoneyWithCode(
          report.totals.credit,
          14,
        )} ${report.totals.balanced ? 'balanced' : 'OUT OF BALANCE'}`,
      ].join('\n');
    },
  },

  'report:income': {
    usage: 'ledgerline report:income --from=2025-01-01 --to=2025-12-31',
    run: async ({ service, flags }) => {
      const report = await service.incomeStatement(period(flags));
      return [
        `Income statement ${report.from ?? 'inception'}..${report.to}`,
        renderSection(report.revenue),
        renderSection(report.expenses),
        `Net income: ${renderMoneyWithCode(report.netIncome)}`,
      ].join('\n');
    },
  },

  'report:balance': {
    usage: 'ledgerline report:balance [--to=2025-12-31]',
    run: async ({ service, flags }) => {
      const report = await service.balanceSheet(period(flags));
      return [
        `Balance sheet as of ${report.asOf}`,
        renderSection(report.assets),
        renderSection(report.liabilities),
        renderSection(report.equity),
        `Current earnings: ${renderMoneyWithCode(report.currentEarnings)}`,
        `Total assets: ${renderMoneyWithCode(report.totalAssets)}`,
        report.balanced ? 'Balanced.' : `OUT OF BALANCE by ${report.difference.toString()}`,
      ].join('\n');
    },
  },

  'report:account': {
    usage: 'ledgerline report:account --code=1100 [--from=2025-01-01] [--to=2025-01-31]',
    run: async ({ service, flags }) => {
      const report = await service.accountStatement(requireFlag(flags, 'code'), period(flags));
      return [
        `Statement for ${report.account.code} ${report.account.name}`,
        `Opening ${renderMoneyWithCode(report.openingBalance)}`,
        ...report.lines.map(
          (line) =>
            `  ${line.date} ${line.side.padEnd(6)} ${renderMoneyWithCode(line.amount, 14)} ${line.memo}`,
        ),
        `Closing ${renderMoneyWithCode(report.closingBalance)}`,
      ].join('\n');
    },
  },

  'period:close': {
    usage: 'ledgerline period:close --to=2025-01-31 [--from=2025-01-01] [--by=alice]',
    run: async ({ service, flags }) => {
      const from = optionalDateFlag(flags, 'from');
      const result = await service.closePeriod({
        to: dateFlag(flags, 'to'),
        ...(from === undefined ? {} : { from }),
        ...(typeof flags.by === 'string' ? { closedBy: flags.by } : {}),
        ...(typeof flags.memo === 'string' ? { memo: flags.memo } : {}),
      });
      return `closed ${result.period.to} with ${result.entries.length} entries (${result.entries
        .map((entry) => entry.id)
        .join(', ')})`;
    },
  },

  verify: {
    usage: 'ledgerline verify',
    run: async ({ service }) => {
      const report = await service.verify();
      return [
        report.balanced ? 'Books are balanced.' : 'BOOKS ARE NOT BALANCED.',
        `entries: ${report.entries}`,
        `accounts: ${report.accounts}`,
        ...report.problems.map((problem) => `  ! ${problem}`),
      ].join('\n');
    },
  },

  demo: {
    usage: 'ledgerline demo',
    run: async ({ service }) => runDemo(service),
  },
};

function usage(): string {
  const rows = Object.entries(commands)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([name, command]) => `  ${name.padEnd(20)} ${command.usage.split(' ').slice(1).join(' ')}`,
    );
  return ['Ledgerline — a double-entry accounting engine', '', 'Commands:', ...rows].join('\n');
}

function requireFlag(flags: Readonly<Record<string, string | boolean>>, name: string): string {
  const value = flags[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Missing required flag --${name}. Run 'ledgerline help' for usage.`);
  }
  return value;
}

/** `2025-01-31` in UTC, which is the calendar the books are kept in. */
function today(): IsoDate {
  return new Date().toISOString().slice(0, 10) as IsoDate;
}

/**
 * Flags are user input, so each one is validated at the edge with a message that
 * says what was expected. `as never` would only move the complaint further in,
 * to a stack trace instead of a sentence.
 */
function dateFlag(
  flags: Readonly<Record<string, string | boolean>>,
  name: string,
  fallback?: string,
): IsoDate {
  const raw = fallback === undefined ? requireFlag(flags, name) : (flags[name] ?? fallback);
  if (typeof raw !== 'string' || !isIsoDate(raw)) {
    throw new Error(`Bad --${name} '${String(raw)}'. Expected an ISO date such as 2025-01-31.`);
  }
  return raw;
}

function optionalDateFlag(
  flags: Readonly<Record<string, string | boolean>>,
  name: string,
): IsoDate | undefined {
  const raw = flags[name];
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'string' || !isIsoDate(raw)) {
    throw new Error(`Bad --${name} '${String(raw)}'. Expected an ISO date such as 2025-01-31.`);
  }
  return raw;
}

function accountTypeFlag(
  flags: Readonly<Record<string, string | boolean>>,
  name: string,
): AccountType {
  const raw = requireFlag(flags, name);
  if (!isAccountType(raw)) {
    throw new Error(
      `Bad --${name} '${raw}'. Expected one of asset, liability, equity, income, expense.`,
    );
  }
  return assertAccountType(raw);
}

function optionalAccountTypeFlag(
  flags: Readonly<Record<string, string | boolean>>,
  name: string,
): AccountType | undefined {
  const raw = flags[name];
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'string' || !isAccountType(raw)) {
    throw new Error(
      `Bad --${name} '${String(raw)}'. Expected one of asset, liability, equity, income, expense.`,
    );
  }
  return assertAccountType(raw);
}

function currencyFlag(
  flags: Readonly<Record<string, string | boolean>>,
  name: string,
): CurrencyCode {
  return assertCurrency(requireFlag(flags, name).toUpperCase());
}

function optionalCurrencyFlag(
  flags: Readonly<Record<string, string | boolean>>,
  name: string,
): CurrencyCode | undefined {
  const raw = flags[name];
  return typeof raw === 'string' ? assertCurrency(raw.toUpperCase()) : undefined;
}

function frequencyFlag(flags: Readonly<Record<string, string | boolean>>, name: string): Frequency {
  const raw = requireFlag(flags, name);
  if (!isFrequency(raw)) {
    throw new Error(
      `Bad --${name} '${raw}'. Expected one of daily, weekly, monthly, quarterly, yearly.`,
    );
  }
  return raw;
}

/**
 * Reads a repeatable flag. `splitOnComma` is opt-out because some values contain
 * a comma that means something (`--posting=1100:debit:100.00,EUR`).
 */
function listFlag(
  flags: Readonly<Record<string, string | boolean>>,
  name: string,
  splitOnComma = true,
): string[] {
  const value = flags[name];
  if (value === undefined) {
    return [];
  }
  return (Array.isArray(value) ? value : [String(value)])
    .flatMap((item) => (splitOnComma ? item.split(',') : [item]))
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function period(flags: Readonly<Record<string, string | boolean>>): {
  from?: IsoDate;
  to?: IsoDate;
} {
  const from = optionalDateFlag(flags, 'from');
  const to = optionalDateFlag(flags, 'to');
  return {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };
}

/**
 * `--posting=1100:debit:5000.00` → `{ account, side, amount }`.
 *
 * A bare amount is a shorthand for the book's functional currency, because
 * typing the same three-letter code on every line of a command would be noise.
 * Pass a currency explicitly as `--posting=1100:debit:5000.00,EUR`.
 */
function parsePosting(
  raw: string,
  functionalCurrency: string,
): { account: string; side: 'debit' | 'credit'; amount: string } {
  const [head, side, rest] = raw.split(':');
  if (head === undefined || (side !== 'debit' && side !== 'credit') || rest === undefined) {
    throw new Error(`Bad --posting '${raw}'. Expected ACCOUNT:debit|credit:AMOUNT[,CURRENCY].`);
  }
  const [value, currency] = rest.split(',');
  const code = (currency ?? '').trim().toUpperCase() || functionalCurrency;
  if (value === undefined || value.trim() === '') {
    throw new Error(`Bad --posting '${raw}'. The amount is missing.`);
  }
  return {
    account: head.trim().toUpperCase(),
    side,
    amount: `${value.trim()} ${code}`,
  };
}

function parseArgs(argv: readonly string[]): {
  command: string;
  flags: Record<string, string | boolean | string[]>;
  args: string[];
} {
  const args: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  for (const argument of argv) {
    if (!argument.startsWith('--')) {
      args.push(argument);
      continue;
    }
    const body = argument.slice(2);
    let name: string;
    let value: string | true;
    if (body.includes('=')) {
      const index = body.indexOf('=');
      name = body.slice(0, index);
      value = body.slice(index + 1);
    } else {
      name = body;
      value = true;
    }
    const key = camel(name);
    const existing = flags[key];
    if (value === true) {
      flags[key] = true;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else if (typeof existing === 'string') {
      flags[key] = [existing, value];
    } else {
      flags[key] = value;
    }
  }
  return { command: args[0] ?? 'help', flags, args: args.slice(1) };
}

function camel(name: string): string {
  return name.replaceAll(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

async function runDemo(service: LedgerService): Promise<string> {
  await service.postEntry({
    date: '2025-01-01',
    memo: 'Owner investment',
    postings: [
      { account: '1100', side: 'debit', amount: '100000.00 USD' },
      { account: '3100', side: 'credit', amount: '100000.00 USD' },
    ],
  });
  await service.postEntry({
    date: '2025-01-05',
    memo: 'Invoice 1',
    reference: 'INV-1',
    postings: [
      { account: '1200', side: 'debit', amount: '12500.00 USD' },
      { account: '4100', side: 'credit', amount: '12500.00 USD' },
    ],
  });
  await service.postEntry({
    date: '2025-01-06',
    memo: 'Cost of goods sold',
    postings: [
      { account: '5100', side: 'debit', amount: '4000.00 USD' },
      { account: '1200', side: 'credit', amount: '4000.00 USD' },
    ],
  });
  await service.createRecurringRule({
    frequency: 'monthly',
    startDate: '2025-02-01',
    memo: 'Office rent',
    postings: [
      { account: '5200', side: 'debit', amount: '2500.00 USD' },
      { account: '1100', side: 'credit', amount: '2500.00 USD' },
    ],
  });
  const run = await service.runRecurring({ until: '2025-04-30' });
  const income = await service.incomeStatement({ from: '2025-01-01', to: '2025-04-30' });
  const integrity = await service.verify();

  return [
    '=== Ledgerline demo ===',
    `Posting rent: created ${run.created.length} entries`,
    '',
    renderSection(income.revenue),
    renderSection(income.expenses),
    `Net income: ${renderMoneyWithCode(income.netIncome)}`,
    '',
    integrity.balanced ? 'Books are balanced.' : 'BOOKS ARE NOT BALANCED.',
  ].join('\n');
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const { command, flags, args } = parseArgs(argv);
  const found = commands[command];
  if (found === undefined) {
    console.error(`Unknown command '${command}'. Run 'ledgerline help'.`);
    return 2;
  }
  const path = process.env.LEDGERLINE_DB ?? ':memory:';
  const service = new LedgerService(
    path === ':memory:' ? new InMemoryStore() : new SqliteStore({ path }),
    {
      functionalCurrency: assertCurrency((process.env.LEDGERLINE_CURRENCY ?? 'USD').toUpperCase()),
      retainedEarningsCode: process.env.LEDGERLINE_RETAINED_EARNINGS ?? '3200',
      fxClearingCode: process.env.LEDGERLINE_FX_CLEARING ?? '3210',
    },
  );
  try {
    const output = await found.run({
      service,
      args,
      flags: flags as Record<string, string | boolean>,
    });
    if (output !== '') {
      console.log(output);
    }
    return 0;
  } catch (error) {
    console.error(formatError(error));
    return 1;
  } finally {
    await service.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
