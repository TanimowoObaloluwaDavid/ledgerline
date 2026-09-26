# HTTP API

Base path `/v1`. Requests and responses are JSON. Start the server with
`npm run serve`.

## Conventions

**Money is a string.** Amounts cross the wire as `"12500.00 USD"` on the way in
and as an object on the way out, so no value ever touches a JavaScript float:

```json
{ "currency": "USD", "minor": "1250000", "decimal": "12500.00" }
```

`minor` is the exact integer in the currency's smallest unit, as a string
because JSON numbers are doubles and `9007199254740993` is not exactly
representable. `decimal` is the same value formatted for humans.

**Dates are `YYYY-MM-DD`** strings, validated by the same `isIsoDate` the engine
uses, so the API and the domain can never disagree about a calendar.

**Errors carry a code.** The HTTP status is derived from the domain error code in
one place (`statusForError`), never from a message:

```json
{
  "error": {
    "code": "UNBALANCED_ENTRY",
    "message": "The entry does not balance.",
    "details": { "debits": "1000", "credits": "900" }
  }
}
```

| Status | Codes |
| --- | --- |
| 400 | `VALIDATION_FAILED`, `CURRENCY_UNSUPPORTED` |
| 404 | `ACCOUNT_NOT_FOUND`, `ENTRY_NOT_FOUND` |
| 409 | `CONFLICT`, `ACCOUNT_ALREADY_EXISTS`, `ENTRY_ALREADY_REVERSED` |
| 422 | `UNBALANCED_ENTRY`, `EMPTY_ENTRY`, `NON_POSITIVE_AMOUNT`, `DUPLICATE_ACCOUNT_IN_ENTRY`, `ACCOUNT_NOT_POSTABLE`, `ACCOUNT_TYPE_CONFLICT`, `ACCOUNT_CYCLE`, `CURRENCY_MISMATCH`, `RATE_NOT_FOUND`, `INVALID_RATE`, `INVALID_RECURRENCE` |
| 500 | `INTERNAL`, reported as `500` with a generic message |

A `CLOSED_PERIOD` failure is a `ConflictError` with `details.code =
"CLOSED_PERIOD"`, so it arrives as `409 CONFLICT` with the specific code in the
details. A store version mismatch arrives as `409 CONFLICT` too.

**Writes are idempotent.** Send `Idempotency-Key: <string>` on any `POST` that
creates something. The first call returns `201` with `created: true`; a repeat of
the same key returns `200` with `created: false` and the original object. Keys
are scoped per command, and a key derived deterministically means a retry after a
timeout cannot double-post.

## Health

### `GET /health`

```json
{ "status": "ok" }
```

## Accounts

### `GET /v1/accounts`

Query: `type` — one of `asset`, `liability`, `equity`, `income`, `expense`.

```json
{ "accounts": [ { "code": "1100", "name": "Cash", "type": "asset", "parentCode": "1000", "currency": null, "computed": false, "system": true, "createdAt": "2026-01-01T00:00:00.000Z" } ] }
```

### `GET /v1/accounts/:code`

One account, or `404 ACCOUNT_NOT_FOUND`.

### `POST /v1/accounts`

```json
{ "code": "1600", "name": "Prepaid Rent", "type": "asset", "parentCode": "1000", "description": "Rent paid in advance", "tags": ["rent"] }
```

`201` with `{ "account": { … } }`. `parentCode` must exist and cannot create a
cycle; `currency` constrains what may later be posted to the account.

### `PATCH /v1/accounts/:code`

Any of `name`, `description`, `tags`, `parentCode`. Accounts referenced by entries
cannot be re-parented into a different type or given a different currency.

## Entries

### `GET /v1/entries`

Query: `from`, `to`, `account` (all optional, ISO dates).

```json
{ "entries": [ { "id": "ent_…", "sequence": 1, "date": "2025-01-05", "memo": "Invoice 1", "reference": "INV-1", "tags": [], "source": "manual", "postings": [ { "account": "1200", "side": "debit", "amount": { "currency": "USD", "minor": "1250000", "decimal": "12500.00" } } ] } ] }
```

### `GET /v1/entries/:id`

### `POST /v1/entries`

```json
{
  "date": "2025-01-05",
  "memo": "Invoice 1",
  "reference": "INV-1",
  "tags": ["q1"],
  "postings": [
    { "account": "1200", "side": "debit",  "amount": "12500.00 USD" },
    { "account": "4100", "side": "credit", "amount": "12500.00 USD" }
  ]
}
```

At least two postings, and they must balance in every currency they touch. A
posting to an account with a fixed currency must use that currency.

`201` on create, `200` when an `Idempotency-Key` is replayed.

### `POST /v1/entries/:id/reversal`

```json
{ "date": "2025-02-01", "memo": "Wrong account" }
```

Posts the mirror-image entry. A second reversal of the same entry is
`409 ENTRY_ALREADY_REVERSED`; an entry is never modified or deleted.

## Exchange rates

### `GET /v1/fx/rates`

```json
{ "rates": [ { "base": "EUR", "quote": "USD", "rate": "1.1000000000", "rateExact": { "numerator": "11", "denominator": "10" }, "effectiveDate": "2025-01-01", "source": null } ] }
```

### `POST /v1/fx/rates`

```json
{ "base": "EUR", "quote": "USD", "rate": "1.10", "effectiveDate": "2025-01-01", "source": "ECB" }
```

Rates are exact rationals, stored as a fraction, so a rate never accumulates
error. One rate per pair per day: a second one is `422 INVALID_RATE`.

## Recurring entries

### `GET /v1/recurring`

### `GET /v1/recurring/:id/occurrences?until=2025-12-31`

```json
{ "occurrences": [ { "date": "2025-01-31", "scheduledDate": "2025-01-31", "sequence": 1, "adjusted": false } ] }
```

Preview only; nothing is written. `scheduledDate` differs from `date` when a
weekend adjustment moved the occurrence.

### `POST /v1/recurring`

```json
{
  "frequency": "monthly",
  "interval": 1,
  "startDate": "2025-01-31",
  "endDate": null,
  "maxOccurrences": 12,
  "adjustWeekend": "next-business-day",
  "memo": "Rent",
  "postings": [
    { "account": "5200", "side": "debit",  "amount": "1200.00 USD" },
    { "account": "1100", "side": "credit", "amount": "1200.00 USD" }
  ]
}
```

### `POST /v1/recurring/run`

```json
{ "until": "2025-12-31" }
```

```json
{ "created": [ { "id": "ent_…" } ], "skipped": 0 }
```

Occurrence IDs are derived from the rule and the date, so running twice posts
nothing the second time. An occurrence dated inside a closed period is refused
with `409 CONFLICT`, and the whole run is rejected before anything is written.

## Reports

All four take `from` and `to`; `to` is required whenever a rate is needed, and
`from` is required for `rateMode=average`. `rateMode` is `closing` (default),
`last` or `average`.

Amounts are presented in the functional currency unless the report says
otherwise; the trial balance keeps every currency separately.

### `GET /v1/reports/trial-balance?to=2025-01-31`

```json
{ "report": { "asOf": "2025-01-31", "rows": [ { "code": "1100", "name": "Cash", "debit": { … }, "credit": { … } } ], "totals": { "debit": { … }, "credit": { … }, "difference": { … }, "balanced": true } } }
```

Rows include roll-up accounts next to their children, marked with
`"isSubtotal": true` and a `depth`. `totals` counts the leaf accounts only, so
summing the `debit` column of every row gives a larger number — filter on
`isSubtotal === false` before totalling.

### `GET /v1/reports/balance-sheet?to=2025-01-31`

Sections `assets`, `liabilities`, `equity`, plus `currentEarnings`,
`totalAssets`, `balanced` and `difference`.

### `GET /v1/reports/income-statement?from=2025-01-01&to=2025-01-31`

Sections `revenue` and `expenses`, plus `netIncome`.

### `GET /v1/reports/accounts/1100?from=2025-01-01&to=2025-01-31`

`openingBalance`, per-entry `lines`, and `closingBalance`. Entries dated exactly
`from` are counted in the activity, not folded into the opening balance.

## Closing

### `GET /v1/periods`

```json
{ "periods": [ { "id": "per_…", "from": "2025-01-01", "to": "2025-01-31", "functionalCurrency": "USD", "entryIds": [ "ent_…" ], "closedAt": "2026-01-01T00:00:00.000Z", "closedBy": "alice" } ] }
```

### `POST /v1/periods/close`

```json
{ "from": "2025-01-01", "to": "2025-01-31", "date": "2025-01-31", "memo": "January close", "closedBy": "alice" }
```

`201` with `{ "period": { … }, "entries": [ … ] }`. Closing moves revenue and
expense balances to retained earnings in a single generated entry, translating
foreign-currency results through the FX clearing account. A period with nothing
to close is `409 CONFLICT`, a second close is `409 CONFLICT`, and afterwards any
entry dated inside the period is refused with `409 CLOSED_PERIOD`.

## Integrity

### `GET /v1/verify`

```json
{ "report": { "balanced": true, "entries": 6, "accounts": 25, "imbalances": [], "unknownAccounts": [], "problems": [] } }
```

`200` when the books balance, `409` when they do not. Checks every currency for
imbalance, postings against accounts that no longer exist, and missing closing
entries.
