import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../../domain/errors.js';
import { Money } from '../../domain/money.js';
import type { StatementSection } from '../../domain/statements.js';
import { bodyLines, formatError, renderMoney, renderMoneyWithCode } from './format.js';
import { main } from './main.js';

/**
 * The CLI is exercised through `main()` with a real SQLite file behind it,
 * because the argument parsing, the exit codes and the persistence are the parts
 * most likely to rot. Console output is captured rather than swallowed so the
 * assertions can be about what a user actually sees.
 */

const usd = (minor: bigint): Money => Money.fromMinor('USD', minor);

describe('cli formatting', () => {
  it('pads exact decimal strings, never floats', () => {
    expect(renderMoney(usd(123_456n), 12)).toBe('     1234.56');
    expect(renderMoneyWithCode(usd(5n))).toBe('0.05 USD');
  });

  it('drops a line that only repeats the section title', () => {
    const section = {
      title: 'Revenue',
      lines: [
        {
          code: '4100',
          name: 'Revenue',
          type: 'income',
          depth: 0,
          isSubtotal: true,
          amount: usd(100n),
          byCurrency: [{ currency: 'USD', debit: 100n, credit: 0n, net: 100n }],
        },
        {
          code: '4110',
          name: 'Sales',
          type: 'income',
          depth: 1,
          isSubtotal: false,
          amount: usd(100n),
          byCurrency: [{ currency: 'USD', debit: 100n, credit: 0n, net: 100n }],
        },
      ],
      total: usd(100n),
    } satisfies StatementSection;
    expect(bodyLines(section).map((line) => line.name)).toEqual(['Sales']);
  });

  it('leads with the error code for ledger errors', () => {
    const error = formatError(new ValidationError('Nope.', { field: 'amount' }));
    expect(error).toBe('VALIDATION_FAILED: Nope. {"field":"amount"}');
    expect(formatError(new Error('plain'))).toBe('plain');
    expect(formatError('weird')).toBe('weird');
  });
});

describe('cli', () => {
  let workspace: string;
  let previousDb: string | undefined;
  let out: string[];
  let err: string[];

  const run = async (...argv: string[]): Promise<number> => {
    out = [];
    err = [];
    return main(argv);
  };

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'ledgerline-cli-'));
    previousDb = process.env.LEDGERLINE_DB;
    process.env.LEDGERLINE_DB = join(workspace, 'books.db');
    out = [];
    err = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      out.push(String(line));
    });
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      err.push(String(line));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousDb === undefined) {
      delete process.env.LEDGERLINE_DB;
    } else {
      process.env.LEDGERLINE_DB = previousDb;
    }
    rmSync(workspace, { recursive: true, force: true });
  });

  it('prints help and defaults to it with no arguments', async () => {
    await expect(run('help')).resolves.toBe(0);
    expect(out.join('\n')).toContain('Commands:');
    await expect(run('help')).resolves.toBe(0);
    expect(out.join('\n')).toContain('period:close');
  });

  it('exits 2 on an unknown command', async () => {
    await expect(run('nope')).resolves.toBe(2);
    expect(err.join('\n')).toContain("Unknown command 'nope'");
  });

  it('reports a missing required flag instead of guessing', async () => {
    await expect(run('account:create', '--code=1600')).resolves.toBe(1);
    expect(err.join('\n')).toContain('Missing required flag --name');
  });

  it('rejects a malformed --posting', async () => {
    await expect(
      run('entry:post', '--date=2025-01-05', '--posting=1100:sideways:1.00'),
    ).resolves.toBe(1);
    expect(err.join('\n')).toContain('Bad --posting');
  });

  it('defaults a bare amount to the functional currency', async () => {
    await expect(
      run(
        'entry:post',
        '--date=2025-01-05',
        '--posting=1100:debit:5000.00',
        '--posting=4100:credit:5000.00',
      ),
    ).resolves.toBe(0);
    expect(out.join('\n')).toMatch(/^posted ent_\w+ \(2 postings\)$/m);

    await expect(run('report:account', '--code=1100', '--to=2025-01-31')).resolves.toBe(0);
    expect(out.join('\n')).toContain('Closing 5000.00 USD');
  });

  it('accepts an explicit currency on a posting', async () => {
    // A foreign amount needs a foreign account: the engine refuses to post EUR
    // to a USD-denominated account rather than converting behind your back.
    await expect(
      run('account:create', '--code=1150', '--name=Cash EUR', '--type=asset', '--currency=EUR'),
    ).resolves.toBe(0);
    await expect(
      run(
        'entry:post',
        '--date=2025-01-05',
        '--posting=1150:debit:100.00,EUR',
        '--posting=4100:credit:100.00,EUR',
      ),
    ).resolves.toBe(0);
    // The statement is presented in the functional currency, so 100.00 EUR shows
    // up translated at the dated rate. Without a rate the engine refuses instead
    // of guessing.
    await expect(
      run('fx:rate', '--base=EUR', '--quote=USD', '--rate=1.10', '--date=2025-01-01'),
    ).resolves.toBe(0);
    await expect(run('report:account', '--code=1150', '--to=2025-01-31')).resolves.toBe(0);
    expect(out.join('\n')).toContain('Opening 0.00 USD');
    expect(out.join('\n')).toContain('110.00 USD');
    expect(out.join('\n')).toContain('Closing 110.00 USD');
  });

  it('refuses a statement in a foreign currency with no rate', async () => {
    await expect(
      run('account:create', '--code=1150', '--name=Cash EUR', '--type=asset', '--currency=EUR'),
    ).resolves.toBe(0);
    await expect(
      run(
        'entry:post',
        '--date=2025-01-05',
        '--posting=1150:debit:100.00,EUR',
        '--posting=4100:credit:100.00,EUR',
      ),
    ).resolves.toBe(0);
    await expect(run('report:account', '--code=1150', '--to=2025-01-31')).resolves.toBe(1);
    expect(err.join('\n')).toContain('RATE_NOT_FOUND');
  });

  it('persists across invocations and replays an idempotency key', async () => {
    const args = [
      'entry:post',
      '--date=2025-01-05',
      '--memo=Invoice 1',
      '--posting=1100:debit:5000.00',
      '--posting=4100:credit:5000.00',
      '--key=inv-1',
    ];
    await expect(run(...args)).resolves.toBe(0);
    expect(out.join('\n')).toContain('posted');
    await expect(run(...args)).resolves.toBe(0);
    expect(out.join('\n')).toContain('replayed');

    await expect(run('entry:list', '--from=2025-01-01', '--to=2025-01-31')).resolves.toBe(0);
    expect(out.join('\n')).toMatch(/2025-01-05 #\s+1 ent_\w+ 5000\.00 USD Invoice 1/);
  });

  it('lists and creates accounts', async () => {
    await expect(run('account:list')).resolves.toBe(0);
    expect(out.join('\n')).toContain('1100');
    expect(out.join('\n')).not.toContain('1600');

    await expect(
      run('account:create', '--code=1600', '--name=Prepaid Rent', '--type=asset', '--parent=1000'),
    ).resolves.toBe(0);
    expect(out.join('\n')).toBe('created 1600 (asset)');

    await expect(run('account:list', '--type=asset')).resolves.toBe(0);
    const lines = out.join('\n').split('\n');
    expect(lines.some((line) => line.startsWith('1600'))).toBe(true);
    expect(lines.every((line) => line.includes('asset'))).toBe(true);
  });

  it('records a rate and reports a trial balance that balances', async () => {
    await expect(
      run('fx:rate', '--base=EUR', '--quote=USD', '--rate=1.10', '--date=2025-01-01'),
    ).resolves.toBe(0);
    expect(out.join('\n')).toContain('recorded EUR/USD = 1.100000');

    await expect(
      run(
        'entry:post',
        '--date=2025-01-05',
        '--posting=1100:debit:5000.00',
        '--posting=4100:credit:5000.00',
      ),
    ).resolves.toBe(0);
    await expect(run('report:trial', '--to=2025-01-31')).resolves.toBe(0);
    expect(out.join('\n')).toContain('balanced');
  });

  it('creates, previews and runs a recurring rule', async () => {
    await expect(
      run(
        'recurring:create',
        '--frequency=monthly',
        '--from=2025-01-31',
        '--posting=5200:debit:1200.00',
        '--posting=1100:credit:1200.00',
        '--memo=Rent',
      ),
    ).resolves.toBe(0);
    const id = /created rule (rul_\w+)/.exec(out.join('\n'))?.[1] ?? '';
    expect(id).not.toBe('');

    await expect(run('recurring:preview', `--id=${id}`, '--until=2025-03-31')).resolves.toBe(0);
    expect(out.join('\n').split('\n')).toHaveLength(3);

    await expect(run('recurring:run', '--until=2025-03-31')).resolves.toBe(0);
    expect(out.join('\n')).toBe('created 3, skipped 0');
    await expect(run('recurring:run', '--until=2025-03-31')).resolves.toBe(0);
    expect(out.join('\n')).toBe('created 0, skipped 3');
  });

  it('closes a period, then refuses a backdated entry', async () => {
    await expect(
      run(
        'entry:post',
        '--date=2025-01-05',
        '--posting=1100:debit:5000.00',
        '--posting=4100:credit:5000.00',
      ),
    ).resolves.toBe(0);
    await expect(run('period:close', '--to=2025-01-31', '--by=alice')).resolves.toBe(0);
    expect(out.join('\n')).toContain('closed 2025-01-31');

    await expect(
      run(
        'entry:post',
        '--date=2025-01-06',
        '--posting=1100:debit:1.00',
        '--posting=4100:credit:1.00',
      ),
    ).resolves.toBe(1);
    expect(err.join('\n')).toContain('CONFLICT');
  });

  it('reports integrity', async () => {
    await expect(run('verify')).resolves.toBe(0);
    expect(out.join('\n')).toContain('Books are balanced.');
  });

  it('runs the demo end to end', async () => {
    await expect(run('demo')).resolves.toBe(0);
    const text = out.join('\n');
    expect(text).toContain('Posting rent: created 3 entries');
    expect(text).toContain('Net income: 1000.00 USD');
    expect(text).toContain('Books are balanced.');
  });

  it('surfaces an unbalanced entry as a domain error code', async () => {
    await expect(
      run(
        'entry:post',
        '--date=2025-01-05',
        '--posting=1100:debit:5000.00',
        '--posting=4100:credit:4999.00',
      ),
    ).resolves.toBe(1);
    expect(err.join('\n')).toContain('UNBALANCED_ENTRY');
  });

  it('handles boolean flags and comma-joined repeated flags', async () => {
    await expect(
      run(
        'entry:post',
        '--date=2025-01-05',
        '--posting=1100:debit:1.00',
        '--posting=4100:credit:1.00',
        '--tag=audit,2025',
        '--dry-run',
      ),
    ).resolves.toBe(0);
    expect(out.join('\n')).toContain('posted');
  });
});
