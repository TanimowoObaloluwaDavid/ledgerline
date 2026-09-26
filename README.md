# Ledgerline

A double-entry accounting engine with a REST API and a CLI, written in strict
TypeScript with no runtime dependencies beyond Fastify and Zod.

Ledgerline keeps books the way an accountant would want them kept: money is
exact (integer minor units, never a float), the ledger is append-only, every
entry balances per currency, exchange rates are dated rather than assumed, and a
closed period stays closed.

```
npm install
npm run demo
```

```
=== Ledgerline demo ===
Posting rent: created 3 entries

Revenue
    Sales                                  12500.00
  Total                                    12500.00

Expenses
    Cost of Goods Sold                      4000.00
    Rent                                    7500.00
  Total                                    11500.00

Net income: 1000.00 USD

Books are balanced.
```

## What it does

- **Chart of accounts** with a hierarchy, five account types, per-account
  currency constraints, and system accounts that seed a new book.
- **Journal** that is append-only, balanced per currency, rejects postings to
  roll-up parents, and reverses rather than edits.
- **Exact money** in integer minor units with correct exponents (`JPY` has 0,
  `USD` 2, `BHD` 3) and banker's rounding for conversions.
- **Dated exchange rates** with three valuation modes (last rate, average rate,
  closing rate) and half-even rounding; a missing rate is an error, never a
  guess.
- **Recurring entries** on daily, weekly, monthly, quarterly and yearly
  schedules, with anchored month arithmetic (a rule that starts on the 31st
  stays on the 31st whenever the month is long enough) and weekend adjustment.
- **Period closing** that moves temporary-account balances into retained
  earnings in one generated entry, translating foreign-currency results through
  an FX clearing account.
- **Reports**: trial balance, balance sheet, income statement, and per-account
  statements with a correct opening balance.
- **Two front ends**: a Fastify REST API and a CLI over the same use cases.
- **Two stores**: in-memory for tests, SQLite (`node:sqlite`) for everything
  else, both behind optimistic version checks.
- **Idempotent writes** keyed by `Idempotency-Key`, so a retried request cannot
  double-post.

## Quick start

### As a library

```ts
import { InMemoryStore, LedgerService } from 'ledgerline';

const books = new LedgerService(new InMemoryStore(), { functionalCurrency: 'USD' });

await books.postEntry({
  date: '2025-01-05',
  memo: 'Invoice 1',
  postings: [
    { account: '1200', side: 'debit', amount: '12500.00 USD' },
    { account: '4100', side: 'credit', amount: '12500.00 USD' },
  ],
});

const sheet = await books.balanceSheet({ to: '2025-01-31' });
console.log(sheet.totalAssets.toDecimalString(), sheet.balanced); // 12500.00 true
```

### CLI

The CLI keeps its ledger in a SQLite file. Set `LEDGERLINE_DB`; without it the
book is in memory and disappears when the command ends.

```bash
export LEDGERLINE_DB=./data/ledger.db

npm run cli -- account:list
npm run cli -- entry:post --date=2025-01-05 --memo="Invoice 1" \
  --posting=1200:debit:12500.00 --posting=4100:credit:12500.00 --key=inv-1
npm run cli -- report:income --from=2025-01-01 --to=2025-01-31
npm run cli -- period:close --to=2025-01-31 --by=alice
npm run cli -- verify
```

A bare amount means the book's functional currency, so `--posting=1100:debit:5000.00`
is `5000.00 USD`. Pass one explicitly with a comma: `--posting=1100:debit:5000.00,EUR`.

`npm run cli -- help` lists every command.

### Browser

```bash
npm run serve
```

Then open **<http://127.0.0.1:3000/app>**.

That is a working book: post entries on a form that refuses to submit until the
debits equal the credits, read the journal, browse the chart of accounts, and
look at the trial balance, balance sheet, income statement and any account's
statement. It also closes a period into retained earnings and records exchange
rates.

The app is plain ES modules and one stylesheet in [`public/`](public), served by
the same process as the API. There is no build step, no bundler and no client
framework — the directory is the whole thing, and you can read it in one sitting.
Set `LEDGERLINE_WEB_DIR` to point somewhere else, or to `none` to serve the API
on its own.

### HTTP

```bash
npm run serve
```

```
POST /v1/entries
Idempotency-Key: 7f3c...

{
  "date": "2025-01-05",
  "memo": "Invoice 1",
  "postings": [
    { "account": "1200", "side": "debit",  "amount": "12500.00 USD" },
    { "account": "4100", "side": "credit", "amount": "12500.00 USD" }
  ]
}
```

```
201 Created
{ "created": true, "entry": { "id": "ent_…", "sequence": 1, … } }
```

Send the same `Idempotency-Key` again and you get `200 OK` with the original
entry instead of a second one. The full route reference is in
[docs/API.md](docs/API.md).

## How it is put together

```
src/domain          pure accounting. No I/O, no clock, no framework.
src/application     use cases, the store port, optimistic versions, idempotency
src/infrastructure  in-memory and SQLite stores
src/interfaces      Fastify routes and the CLI
public              the browser app: plain ES modules, served as-is
```

The dependency arrow only points inward: the domain knows nothing about HTTP,
SQL or `Date.now()`, which is why the interesting parts of the accounting can be
tested as plain functions. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for
the invariants and the trade-offs behind them.

The rules the engine will not bend:

| Rule | Why |
| --- | --- |
| Every entry balances, per currency | Debits equal credits or the entry is rejected |
| Amounts are integers of minor units | `0.1 + 0.2` is not a bug you can report |
| Money posted to a currency-constrained account must match it | No silent FX on a cash account |
| Postings cannot target roll-up parents or computed accounts | A subtotal is derived, not posted to |
| A dated rate is required to translate | An invented rate is a fabricated balance sheet |
| Entries are never edited or deleted | Corrections are reversals, so history survives |
| A closed period refuses new entries | Otherwise the closing entry is invalidated silently |
| Reports present in the functional currency | One currency on the face of the statements |

## Scripts

| Script | What it does |
| --- | --- |
| `npm run demo` | Seeds a small book and prints an income statement |
| `npm run cli -- <command>` | Runs the CLI against `$LEDGERLINE_DB` |
| `npm run serve` | Starts the HTTP API and the browser app |
| `npm test` | Runs the test suite |
| `npm run test:coverage` | Runs it with coverage |
| `npm run typecheck` | `tsc --noEmit` under the strictest settings |
| `npm run lint` / `npm run lint:fix` | Biome lint and format |
| `npm run build` | Compiles to `dist/` |
| `npm run verify` | Typecheck, lint and test in one go |

The dev scripts run the TypeScript sources directly through Node's type
stripping, with a one-line resolve hook in `tools/ts-resolve.mjs` so `./foo.js`
specifiers find `./foo.ts`. There is no build step to remember and no bundler.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `LEDGERLINE_DB` | `:memory:` | SQLite file, or `:memory:` |
| `LEDGERLINE_HOST` | `127.0.0.1` | HTTP bind address |
| `LEDGERLINE_PORT` | `3000` | HTTP port |
| `LEDGERLINE_LOG` | `false` | Fastify request logging |
| `LEDGERLINE_CURRENCY` | `USD` | Functional currency for all reports |
| `LEDGERLINE_WEB_DIR` | `public/` | Where the browser app lives, or `none` |
| `LEDGERLINE_RETAINED_EARNINGS` | `3200` | Account that receives closed results |
| `LEDGERLINE_FX_CLEARING` | `3210` | Account that absorbs translation differences |

## Requirements

Node 22.15 or newer. The default store uses `node:sqlite`, which is still
flagged experimental by Node, so the CLI and server run with
`--disable-warning=ExperimentalWarning` in the npm scripts. Nothing else about
the engine depends on it: `InMemoryStore` has the same contract, and tests run
against both.

## Testing

188 tests over 15 files: the domain with property-based checks (fast-check) for
the money and rate arithmetic, the application layer against the in-memory
store, the SQLite store against a real temporary database, both front ends
through their public interfaces, and the browser app's own arithmetic and HTTP
client. `npm run test:coverage` enforces a coverage floor so a suite cannot
quietly stop running.

```bash
npm run verify
```

## License

MIT © 2026 Tanimowo Obaloluwa
