# Ledgerline

A double-entry accounting engine with a browser app, a REST API and a CLI.
Strict TypeScript, exact money, no build step.

[![CI](https://github.com/TanimowoObaloluwaDavid/ledgerline/actions/workflows/ci.yml/badge.svg)](https://github.com/TanimowoObaloluwaDavid/ledgerline/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-22.15%20%7C%2024-5FA04E.svg)](https://nodejs.org)
[![License: Proprietary](https://img.shields.io/badge/license-proprietary-red.svg)](LICENSE)

Ledgerline keeps books the way an accountant would want them kept: money is exact
integer minor units and never a float, the journal is append-only, every entry
balances per currency, exchange rates are dated rather than assumed, and a closed
period stays closed.

**Ledgerline is my software, I own it, and it is not open source.** You may read
it, run the tests, and tell me what you want to build with it. You may not copy
it, fork it into something of your own, run it in production, or use it
commercially without my written permission.
[How to ask](#ownership-and-contact).

- [Try it](#try-it)
- [What's in the box](#whats-in-the-box)
- [The rules it will not bend](#the-rules-it-will-not-bend)
- [Why the money is exact](#why-the-money-is-exact)
- [The browser app](#the-browser-app)
- [The CLI](#the-cli)
- [The REST API](#the-rest-api)
- [As a library](#as-a-library)
- [Docker](#docker)
- [Reports](#reports)
- [Project layout](#project-layout)
- [Scripts](#scripts)
- [Configuration](#configuration)
- [Testing](#testing)
- [Requirements](#requirements)
- [Documentation](#documentation)
- [Ownership and contact](#ownership-and-contact)
- [License](#license)

## Try it

Clone it and run the demo. Reading the code and running it locally to evaluate
it is allowed without permission — see [Ownership and contact](#ownership-and-contact)
for what is not.

```bash
git clone https://github.com/TanimowoObaloluwaDavid/ledgerline.git
cd ledgerline
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

That is a real book being opened, posted to and reported on. To drive one
yourself, `npm run serve` and open
**<http://127.0.0.1:3000/app>**.

## What's in the box

| Surface | What it is |
| --- | --- |
| **Browser app** | A no-build front end for the whole book: post entries, read the journal, run the reports, close a period |
| **REST API** | Fastify, Zod-validated at the edge, idempotent writes, error codes that decide the status |
| **CLI** | 17 commands over the same use cases, for scripts and `make`-style pipelines |
| **Library** | The domain and the service as importable TypeScript, with the stores behind a port |
| **Stores** | In-memory for tests, SQLite (`node:sqlite`) for everything else, both behind optimistic version checks |

The engine underneath them:

- **Chart of accounts** with a hierarchy, five account types, per-account currency
  constraints, and a system chart that seeds every new book.
- **Journal** that is append-only, balanced per currency, refuses postings to
  roll-up parents, and reverses rather than edits.
- **Exact money** in integer minor units with real currency exponents (`JPY` has
  0, `USD` 2, `KWD` 3) and half-even rounding on conversion.
- **Dated exchange rates** with closing-rate and average-rate valuation, and a
  missing rate is an error rather than a guess.
- **Recurring entries** on daily, weekly, monthly, quarterly and yearly
  schedules, with anchored month arithmetic — a rule anchored on the 31st runs
  31 Jan, 28 Feb, 31 Mar, 30 Apr — and weekend adjustment.
- **Period closing** that moves temporary-account balances into retained
  earnings in one generated entry, translating foreign-currency results through
  an FX clearing account.
- **Idempotent writes** keyed by `Idempotency-Key`, so a request retried after a
  timeout cannot double-post.

## The rules it will not bend

These are enforced in the domain, not in the interface, so the API, the CLI, the
browser app and your own code all get the same answer.

| Rule | Why |
| --- | --- |
| Every entry balances, per currency | Debits equal credits or the entry is rejected |
| Amounts are integers of minor units | `0.1 + 0.2` is not a bug you can report |
| A posting to a currency-constrained account must match it | No silent FX on a cash account |
| Postings cannot target roll-up parents or computed accounts | A subtotal is derived, not posted to |
| A dated rate is required to translate | An invented rate is a fabricated balance sheet |
| Entries are never edited or deleted | Corrections are reversals, so history survives |
| A closed period refuses new entries | Otherwise the closing entry is invalidated silently |
| Reports present in the functional currency | One currency on the face of the statements |

## Why the money is exact

`0.1 + 0.2 !== 0.3` is not an accounting problem, it is a representation problem,
and no amount of care at the call site fixes it. Every amount is an integer count
of minor units, carried in a `bigint`, with the currency's exponent deciding how
those integers print:

| Amount | Minor units | Exponent |
| --- | --- | --- |
| `12500.00 USD` | `1250000` | 2 |
| `1500 JPY` | `1500` | 0 |
| `12.345 KWD` | `12345` | 3 |

JSON numbers are doubles, so `9007199254740993` cannot survive one, and every
amount crosses the wire as a string:

```json
{
  "currency": "USD",
  "minor": "1250000",
  "decimal": "12500.00",
  "exponent": 2
}
```

Rates are exact ratios rather than floats, so translating `100.00 EUR` at `1.1`
is `100000 × 11 ÷ 10 = 110000` minor units — `110.00 USD`, exactly, every time —
instead of a float that happens to print as `110.00`. Where a result genuinely
cannot be exact, the division rounds halves to even rather than to whatever the
nearest binary approximation suggests.

## The browser app

```bash
npm run serve
```

Open <http://127.0.0.1:3000/app>. That is a working book, not a screenshot of
one:

| View | What you can do |
| --- | --- |
| **Dashboard** | Debits, credits and net for the period, a trial-balance check, revenue against expenses, recent entries |
| **New entry** | Add postings by account; it will not submit until the debits equal the credits, and it tells you which side is missing |
| **Journal** | Filter by date range, account or memo; reverse an entry instead of editing it |
| **Accounts** | Browse the chart with balances, create accounts |
| **Reports** | Trial balance, balance sheet, income statement, and a statement for any account |
| **Currencies** | Record dated exchange rates |
| **Close period** | Close into retained earnings, and see what it did |

It is plain ES modules and one stylesheet in [`public/`](public), served by the
same Fastify process as the API. There is no build step, no bundler and no client
framework — the directory is the whole thing, and you can read it in one sitting.
The client does its own arithmetic in `BigInt` over the same minor-unit strings
the server sends, because a form that balances a 19-digit amount in floats is
worse than one that refuses to submit.

`LEDGERLINE_WEB_DIR` points it at another directory; `LEDGERLINE_WEB_DIR=none`
serves the API on its own. Assets come from a fixed allowlist rather than a
path, and every response carries `default-src 'none'; script-src 'self'`, which
the app can afford because it has no inline script and no inline style.

## The CLI

The CLI keeps its ledger in a SQLite file. Set `LEDGERLINE_DB`; without it the
book is in memory and disappears when the command ends.

```bash
export LEDGERLINE_DB=./data/ledger.db

npm run cli -- account:list
npm run cli -- entry:post --date=2025-01-05 --memo="Invoice 1" \
  --posting=1200:debit:12500.00 --posting=4100:credit:12500.00 --key=inv-1
npm run cli -- entry:list --from=2025-01-01 --to=2025-01-31
npm run cli -- report:income --from=2025-01-01 --to=2025-01-31
npm run cli -- fx:rate --base=EUR --quote=USD --rate=1.10 --date=2025-01-01
npm run cli -- period:close --to=2025-01-31 --by=alice
npm run cli -- verify
```

A bare amount means the book's functional currency, so
`--posting=1100:debit:5000.00` is `5000.00 USD`. Pass one explicitly with a
comma: `--posting=1100:debit:5000.00,EUR`.

`npm run cli -- help` lists all 17 commands, and `demo` seeds a book and prints a
statement. Errors print as `CODE: message` and exit `0` for success, `1` for a
domain error, `2` for a usage error.

## The REST API

`npm run serve`, then:

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
entry instead of a second one. The status code is derived from the domain error
code in one map, so it never depends on the wording of a message.
[`GET /`](http://127.0.0.1:3000/) is a browsable index of every route, and the
full reference is in [docs/API.md](docs/API.md).

## As a library

Depending on Ledgerline is *using* it, so it needs my permission first — see
[Ownership and contact](#ownership-and-contact). Once you have it:

```bash
npm install ledgerline
```

```ts
import { InMemoryStore, LedgerService } from 'ledgerline';

const books = new LedgerService(new InMemoryStore(), { functionalCurrency: 'USD' });

const posted = await books.postEntry({
  date: '2025-01-05',
  memo: 'Invoice 1',
  postings: [
    { account: '1200', side: 'debit', amount: '12500.00 USD' },
    { account: '4100', side: 'credit', amount: '12500.00 USD' },
  ],
});

posted.created; // true
posted.entry.sequence; // 1

const sheet = await books.balanceSheet({ to: '2025-01-31' });
sheet.totalAssets.toDecimalString(); // '12500.00'
sheet.balanced; // true

const report = await books.verify();
report.balanced; // true
report.entries; // 1
```

Swap `InMemoryStore` for `SqliteStore` to keep the book on disk. The domain is
exported too — `Money`, `Ledger`, `trialBalance`, `occurrences` and friends — so
you can use the accounting without the service.

## Docker

```bash
docker build -t ledgerline .
docker run --rm -p 3000:3000 -v ledgerline-data:/data ledgerline
```

Then open <http://127.0.0.1:3000/app>. The image runs as a non-root user, keeps
its book in the `/data` volume, and serves the app and the API from one process.

## Reports

All four present in the book's functional currency, translated at dated rates.

| Report | What it answers |
| --- | --- |
| Trial balance | Does every account agree, and does the whole book balance? |
| Balance sheet | What do we own, owe, and hold at a date? |
| Income statement | What did we make and spend over a period? |
| Account statement | What happened in one account, with a correct opening balance? |

Sections roll up the account tree, so a parent like `1000 Assets` is a subtotal
of its children. Postings to a subtotal are rejected, because a subtotal is
derived rather than stored.

## Project layout

```
src/domain          pure accounting. No I/O, no clock, no framework.
src/application     use cases, the store port, optimistic versions, idempotency
src/infrastructure  in-memory and SQLite stores
src/interfaces      Fastify routes, the static web server and the CLI
public              the browser app: plain ES modules, served as-is
```

The dependency arrow only points inward: the domain knows nothing about HTTP, SQL
or `Date.now()`, which is why the interesting parts of the accounting can be
tested as plain functions.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run demo` | Seeds a small book and prints an income statement |
| `npm run serve` | Starts the HTTP API and the browser app |
| `npm run cli -- <command>` | Runs the CLI against `$LEDGERLINE_DB` |
| `npm test` | Runs the test suite |
| `npm run test:coverage` | Runs it with a coverage floor |
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

## Testing

188 tests over 15 files: the domain with property-based checks (`fast-check`) for
the money, rate and date arithmetic, the application layer against the in-memory
store, the SQLite store against a real temporary file, the HTTP and CLI front
ends through their public interfaces, and the browser app's own arithmetic and
API client.

```bash
npm run verify
```

`npm run test:coverage` enforces a floor so a suite cannot quietly stop running.
CI runs the whole thing on Node 22.15 and 24, and smoke-tests the built CLI from
`dist/` so a broken build cannot pass.

## Requirements

Node 22.15 or newer. The SQLite store uses `node:sqlite`, which Node still flags
experimental, so the CLI and server run with
`--disable-warning=ExperimentalWarning` in the npm scripts. Nothing else about
the engine depends on it: `InMemoryStore` has the same contract, and the tests
run against both.

## Documentation

- [docs/API.md](docs/API.md) — every route, every error code, the wire format.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the invariants, the layering, and
  the trade-offs worth arguing about.

## Ownership and contact

Ledgerline is my software. I designed it, I wrote it, I maintain it, and I hold the
copyright. There is no company behind it and no team: one maintainer, which is
also why it moves when I have an evening free.

**It is proprietary, and there is no open-source licence here.** The
[LICENSE](LICENSE) file is the whole of the permission you have, and it is short:
no copying, no forking, no modification, no redistribution, no commercial use, no
running it in production, without my written permission. "Open source" is not
what this is, and I would rather you knew that on line one than after you had
built something on top of it.

**What you can do right now, with no paperwork:**

- Read the code to decide whether you want it.
- Run the tests, and run it locally to look around.
- Quote short excerpts, with attribution, in an article or a talk.
- Report bugs, request features, and send me a pull request.

**What needs my written permission:** everything else. Using it in a product,
running it for a business, hosting it as a service, or building on top of it.
Most requests I say yes to, and I would rather hear the idea than have you
reimplement it badly.

| What you want | Where |
| --- | --- |
| Permission to use it, or a paid licence | Email me: [codex5358@gmail.com](mailto:codex5358@gmail.com) |
| A bug report or a feature request | [Open an issue](https://github.com/TanimowoObaloluwaDavid/ledgerline/issues/new) |
| To just read the code | No permission needed |

I answer email, and I read every issue. A bug with a reproduction gets fixed
first; a reply can take a few days, because this is one person with one inbox.

**One honest note:** the versions published before this change went out under the
MIT licence. That grant is perpetual and I cannot withdraw it, so it still covers
those releases. Everything released after today is under the terms above.

— **Tanimowo Obaloluwa**, author and maintainer

## License

**Proprietary. All rights reserved.** Copyright (c) 2026 Tanimowo Obaloluwa. Use,
copying, modification and redistribution require written permission. The full
terms are in [LICENSE](LICENSE).
