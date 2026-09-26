# Architecture

Ledgerline is four layers deep and the arrow only points inward. The domain
knows nothing about HTTP, SQLite, or the wall clock; the application layer owns
use cases and persistence orchestration; the two outer layers are replaceable
adapters.

```
src/interfaces/http     Fastify routes, Zod schemas, JSON presenters
src/interfaces/cli      argument parsing, table rendering, exit codes
        ↓
src/application         LedgerService, LedgerStore port, versions, idempotency
        ↓
src/infrastructure      InMemoryStore, SqliteStore
        ↓
src/domain              accounts, journal, money, rates, reports, closing
```

`src/index.ts` re-exports the public surface for library consumers.

## The domain

Pure functions and value objects. Every constructor validates, so an `Account`
or a `JournalEntry` that exists is one that is already correct, and there is no
such thing as a half-built entry that a caller has to remember to check.

| Module | Responsibility |
| --- | --- |
| `money.ts` | `Money` as an integer of minor units plus a currency exponent |
| `ratio.ts` | Exact rational arithmetic for rates, reduced and comparable |
| `currency.ts` | Supported currencies and their exponents |
| `date.ts` | ISO calendar arithmetic, no time zones, no `Date` objects |
| `ids.ts` | Prefixed random ids, plus deterministic ids for idempotency |
| `account.ts` | The account record and the stock chart of accounts |
| `account-tree.ts` | Hierarchy, ordering, cycles, roll-up detection |
| `postings.ts` | Cross-account rules that no single account can know |
| `journal.ts` | The entry itself: balance, per-currency, provenance |
| `ledger.ts` | The append-only collection: sequences, reversals, indexes |
| `fx.ts` | Dated rates and the three valuation modes |
| `recurring.ts` | Schedule arithmetic and deterministic occurrence ids |
| `statements.ts` | Movements, trial balance, balance sheet, income, statements |
| `closing.ts` | Turning temporary balances into retained earnings |
| `errors.ts` | The error taxonomy every layer speaks |

### Money is never a number

`Money` is `{ minor: bigint, currency }`. Parsing `"12500.00 USD"` is exact and
rejects anything with more precision than the currency allows (`0.001 USD` is an
error; `0.001 BHD` is not). Totals are `bigint` additions. Rounding happens in
exactly one place — `Money.divide()` — and uses banker's rounding, because
rounding 0.005 up every time drifts.

### Rates are fractions

`Ratio` is a reduced `bigint` fraction. `"1.10"` becomes `11/10`, not
`1.100000000000000088817841970012523233890533447265625`. A rate that has been
through storage and back compares equal to the one that went in, which matters
when a balance sheet has to reconcile across a restart.

### Dates are strings

`IsoDate` is a branded `YYYY-MM-DD` string. There is no time zone anywhere in
the domain, because a bookkeeping period is a calendar range, not an instant. The
one place a timestamp appears is `recordedAt`, which is provenance, never
arithmetic.

### Invariants enforced at construction

- An entry has at least two postings and balances **per currency**. A
  multi-currency entry is two balanced groups, not one global total.
- An account's currency, once set, constrains what may be posted to it.
- A parent may not be its own descendant, and a parent's type governs its
  children.
- System accounts cannot be renamed or re-parented, and `3200` / `3210` cannot
  be posted to directly.
- Roll-up and computed accounts reject postings: a subtotal is derived, not
  accumulated.

`assertPostingsAllowed()` in `postings.ts` exists because a couple of these rules
need more than one account to evaluate — that is also why posting to a
non-leaf account is refused at the application boundary rather than silently
allowed by `Money`.

## Recurrence arithmetic

Month arithmetic is anchored, not cumulative. A monthly rule that starts on
January 31st lands on February 28th, then March 31st again — not March 3rd. The
implementation keeps the original day and clamps to the length of each target
month, and the property-based tests check that the day-of-month never drifts
across a long run.

Occurrence ids are `hash(ruleId, date)`. That is what makes `runRecurring`
idempotent: a second run finds the ids already in the ledger and counts them as
skipped, with no bookkeeping of "what did we already run" on the side.

## Closing

`buildClosingEntries` reads *balances*, not postings, so a month with nine
hundred entries still produces one closing entry. For each currency with a
non-zero temporary balance it emits a single entry that zeroes revenue and
expense accounts and credits retained earnings. For a currency that is not the
functional one, the result is translated at the closing rate and the difference
is routed through the FX clearing account, so the closing entry balances in
every currency it touches.

Closing is refused for a period with nothing to close (a second close of an
already-closed period would post a fresh set of entries for a result that is now
zero) and for an already-closed period. Afterwards, `assertPeriodOpen` refuses
any entry, reversal or recurring occurrence dated inside the seal. Reopening is
deliberately not automated: it means reversing the closing entry by hand, with a
reason, and that is a decision a human should make.

## The application layer

`LedgerService` is the only thing the outer layers talk to. It holds the loaded
`BooksSnapshot`, the derived `AccountTree` / `Ledger` / `FxTable`, and a version
number.

**Serialised writes.** Every mutating method runs inside `serialize()`, which
chains onto an internal promise queue. Two concurrent `postEntry` calls cannot
interleave, so the version check and the append are atomic with respect to each
other. The HTTP server relies on this instead of adding its own lock.

**Optimistic versions.** The store is handed `(snapshot, expectedVersion)` and
returns the new version. A mismatch raises `VersionConflictError` rather than
overwriting someone else's work.

**Idempotency.** `postEntry`, `reverseEntry` and `closePeriod` accept an
`idempotencyKey`. When present, the entry id becomes
`deterministicId('entry', key)` instead of a random one, so a retry finds the
existing entry and reports `created: false`. The client never has to know
whether its first request arrived.

**A clock you can inject.** `options.clock` makes `recordedAt` deterministic in
tests, which is the difference between a test that asserts on an id and a test
that asserts on behaviour.

## Storage

`LedgerStore` is a three-method port — `load`, `save`, `close`. Two
implementations satisfy it.

`InMemoryStore` keeps one snapshot and a version. `SqliteStore` normalises the
snapshot into seven tables (`meta`, `accounts`, `entries`, `postings`, `fx_rates`,
`rules`, `closed_periods`) inside a transaction, with foreign keys from postings
to entries and accounts.

Load is not a deserialisation, it is a re-derivation: the store reads rows and
hands them to the same domain constructors the service uses. A row that was
hand-edited into an invalid state fails to load rather than quietly entering the
books. Recurrence rules round-trip as their input document and are rebuilt
through `createRule()`, so a schema change in the schedule arithmetic cannot
corrupt a stored rule.

## The outer layers

All three front ends are thin and share the same use cases.

**HTTP.** One rule: domain error codes decide the status, in one map
(`statusForError`). No handler inspects an error message. Zod validates at the
edge and produces `IsoDate` and `CurrencyCode` directly, so the API cannot drift
from the domain's own notion of those types. `present.ts` is the only place that
turns a `Money` into JSON, and it emits `minor` as a string.

**CLI.** Flags are validated with the domain's own `is*` helpers, so
`--frequency=monthly` and `--currency=EUR` are checked by the same code that
checks the API's equivalents. Errors print as `CODE: message`, exit 0 for
success, 1 for a domain error, 2 for a usage error.

**Browser.** `public/` is served by the same Fastify process: plain ES modules,
one stylesheet, no build step and no framework. Two decisions follow from that.

The first is that assets are served from an allowlist (`web.ts`) rather than from
a path. Adding a file to the app means adding it to the list, and in exchange
there is no traversal to get wrong — a request for `..%2f..%2f.env` matches
nothing and is a 404. The same files are read through `isInside`, so a bug in the
table still cannot escape the web root.

The second is that the app can serve a strict `Content-Security-Policy`. It has
no inline script and no inline style, so the chart is SVG attributes and the
report indentation is a class name rather than a computed width. `default-src
'none'` is the policy's floor, and nothing in the app needs to be excepted.

The client does its own arithmetic in `BigInt`, on the same `minor` strings the
server sends, because a browser form that balances a 19-digit amount in floats is
worse than one that refuses to submit. It is the same reasoning as the domain's,
arrived at twice.

## Decisions worth arguing about

- **`node:sqlite` instead of `better-sqlite3`.** No native build step, no
  prebuilt binaries to go stale. The cost is an experimental warning on stderr
  and a Node version floor. The port means swapping it later is one file.
- **Integers everywhere, including rates.** Slower than floats and completely
  predictable. For a ledger, predictable wins.
- **Snapshots, not an event log.** The whole book is one value, saved in a
  transaction. That is simple and trivially consistent; the cost is rewriting
  rows on every write, which is fine at the scale a single book implies and
  wrong for a million-entry ledger. The port is the seam if that changes.
- **String dates.** Loses nothing here, and removes an entire class of
  off-by-one-day bugs.
- **No dependency injection framework.** Constructor parameters. The graph is
  small enough that a container would be more code than it removes.
- **A no-build front end in a strict-TypeScript project.** The client is plain
  JavaScript with JSDoc types, which is the one place the type checking stops.
  The alternative — compiling the client and serving `dist/` — means two
  different code paths in development and production, and a build step in a
  project whose selling point is that there isn't one. The client's own
  arithmetic is covered by tests instead.
- **Reopening is manual.** Automating it invites a machine to quietly unbalance
  a period that people have already reported on.
