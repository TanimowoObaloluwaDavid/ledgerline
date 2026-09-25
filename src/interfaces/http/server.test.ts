import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LedgerService } from '../../application/service.js';
import { InMemoryStore } from '../../infrastructure/memory-store.js';
import { buildServer, statusForError } from './server.js';

describe('HTTP API', () => {
  let app: FastifyInstance;
  let service: LedgerService;

  beforeEach(async () => {
    service = new LedgerService(new InMemoryStore(), {
      functionalCurrency: 'USD',
      retainedEarningsCode: '3200',
      fxClearingCode: '3210',
    });
    app = buildServer({ service });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, payload: payload as object, headers });

  it('answers the health check', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('lists the stock chart of accounts', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/accounts' });
    expect(response.statusCode).toBe(200);
    const accounts = response.json().accounts as { code: string }[];
    expect(accounts.length).toBeGreaterThan(20);
    expect(accounts.map((account) => account.code)).toContain('1100');
  });

  it('filters accounts by type', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/accounts?type=income' });
    const accounts = response.json().accounts as { type: string }[];
    expect(accounts.every((account) => account.type === 'income')).toBe(true);
  });

  it('creates an account and returns 201', async () => {
    const response = await post('/v1/accounts', {
      code: '1600',
      name: 'Prepaid Rent',
      type: 'asset',
      parentCode: '1000',
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().account.name).toBe('Prepaid Rent');
  });

  it('rejects a malformed body with 400 and a machine-readable code', async () => {
    const response = await post('/v1/accounts', { code: '', name: 'Nope', type: 'wallet' });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(Array.isArray(body.error.details.issues)).toBe(true);
  });

  it('returns 404 for an unknown account and an unknown route', async () => {
    const missing = await app.inject({ method: 'GET', url: '/v1/accounts/ZZZZ' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('ACCOUNT_NOT_FOUND');

    const noRoute = await app.inject({ method: 'GET', url: '/v1/nope' });
    expect(noRoute.statusCode).toBe(404);
  });

  it('posts an entry and serialises amounts exactly', async () => {
    const response = await post('/v1/entries', {
      date: '2025-01-05',
      memo: 'Invoice 1',
      postings: [
        { account: '1100', side: 'debit', amount: '1234.56 USD' },
        { account: '4100', side: 'credit', amount: '1234.56 USD' },
      ],
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.created).toBe(true);
    expect(body.entry.postings[0].amount).toEqual({
      currency: 'USD',
      minor: '123456',
      decimal: '1234.56',
    });
  });

  it('is idempotent on a replayed Idempotency-Key', async () => {
    const payload = {
      date: '2025-01-05',
      postings: [
        { account: '1100', side: 'debit', amount: '10.00 USD' },
        { account: '4100', side: 'credit', amount: '10.00 USD' },
      ],
    };
    const first = await post('/v1/entries', payload, { 'idempotency-key': 'abc' });
    const second = await post('/v1/entries', payload, { 'idempotency-key': 'abc' });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().created).toBe(false);
    expect(second.json().entry.id).toBe(first.json().entry.id);
  });

  it('maps an unbalanced entry to 422', async () => {
    const response = await post('/v1/entries', {
      date: '2025-01-05',
      postings: [
        { account: '1100', side: 'debit', amount: '10.00 USD' },
        { account: '4100', side: 'credit', amount: '9.00 USD' },
      ],
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('UNBALANCED_ENTRY');
    expect(response.json().error.details.debits).toBe('1000');
  });

  it('reverses an entry', async () => {
    const created = await post('/v1/entries', {
      date: '2025-01-05',
      postings: [
        { account: '1100', side: 'debit', amount: '75.00 USD' },
        { account: '4100', side: 'credit', amount: '75.00 USD' },
      ],
    });
    const id = created.json().entry.id as string;
    const reversed = await post(`/v1/entries/${id}/reversal`, { date: '2025-01-06' });
    expect(reversed.statusCode).toBe(201);
    expect(reversed.json().entry.postings[0].side).toBe('credit');

    const again = await post(`/v1/entries/${id}/reversal`, { date: '2025-01-07' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('ENTRY_ALREADY_REVERSED');
  });

  it('records and lists exchange rates', async () => {
    const created = await post('/v1/fx/rates', {
      base: 'EUR',
      quote: 'USD',
      rate: '1.1',
      effectiveDate: '2025-01-01',
    });
    expect(created.statusCode).toBe(201);
    // Rates travel as an exact decimal plus the raw fraction behind them.
    expect(created.json().rate.rate).toBe('1.1000000000');
    expect(created.json().rate.rateExact).toEqual({ numerator: '11', denominator: '10' });
    const listed = await app.inject({ method: 'GET', url: '/v1/fx/rates' });
    expect(listed.json().rates).toHaveLength(1);
  });

  it('creates a recurring rule, previews it, and runs it once', async () => {
    const created = await post('/v1/recurring', {
      frequency: 'monthly',
      startDate: '2025-01-01',
      memo: 'Rent',
      postings: [
        { account: '5200', side: 'debit', amount: '1200.00 USD' },
        { account: '1100', side: 'credit', amount: '1200.00 USD' },
      ],
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().rule.id as string;

    const preview = await app.inject({
      method: 'GET',
      url: `/v1/recurring/${id}/occurrences?until=2025-03-31`,
    });
    expect(preview.json().occurrences).toHaveLength(3);

    const run = await post('/v1/recurring/run', { until: '2025-03-31' });
    expect(run.json().created).toHaveLength(3);
    const rerun = await post('/v1/recurring/run', { until: '2025-03-31' });
    expect(rerun.json().created).toHaveLength(0);
    expect(rerun.json().skipped).toBe(3);
  });

  it('serves reports with exact totals', async () => {
    await post('/v1/entries', {
      date: '2025-01-05',
      postings: [
        { account: '1100', side: 'debit', amount: '5000.00 USD' },
        { account: '4100', side: 'credit', amount: '5000.00 USD' },
      ],
    });
    await post('/v1/entries', {
      date: '2025-01-10',
      postings: [
        { account: '5200', side: 'debit', amount: '1200.00 USD' },
        { account: '1100', side: 'credit', amount: '1200.00 USD' },
      ],
    });

    const trial = await app.inject({
      method: 'GET',
      url: '/v1/reports/trial-balance?to=2025-01-31',
    });
    expect(trial.json().report.totals.balanced).toBe(true);

    const income = await app.inject({
      method: 'GET',
      url: '/v1/reports/income-statement?from=2025-01-01&to=2025-01-31',
    });
    expect(income.json().report.netIncome.minor).toBe('380000');

    const sheet = await app.inject({
      method: 'GET',
      url: '/v1/reports/balance-sheet?to=2025-01-31',
    });
    expect(sheet.json().report.balanced).toBe(true);

    const statement = await app.inject({
      method: 'GET',
      url: '/v1/reports/accounts/1100?from=2025-01-01&to=2025-01-31',
    });
    expect(statement.json().report.closingBalance.minor).toBe('380000');
  });

  it('closes a period and refuses a second close', async () => {
    await post('/v1/entries', {
      date: '2025-01-05',
      postings: [
        { account: '1100', side: 'debit', amount: '5000.00 USD' },
        { account: '4100', side: 'credit', amount: '5000.00 USD' },
      ],
    });
    const closed = await post('/v1/periods/close', { from: '2025-01-01', to: '2025-01-31' });
    expect(closed.statusCode).toBe(201);
    expect(closed.json().entries).toHaveLength(1);

    const again = await post('/v1/periods/close', { from: '2025-01-01', to: '2025-01-31' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('CONFLICT');
  });

  it('reports integrity and passes when the books balance', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/verify' });
    expect(response.statusCode).toBe(200);
    expect(response.json().report.balanced).toBe(true);
  });

  it('maps a missing exchange rate to 422 rather than guessing', async () => {
    await post('/v1/entries', {
      date: '2025-01-05',
      postings: [
        { account: '1100', side: 'debit', amount: '100.00 EUR' },
        { account: '4100', side: 'credit', amount: '100.00 EUR' },
      ],
    });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/reports/balance-sheet?to=2025-01-31',
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('RATE_NOT_FOUND');
  });
});

describe('statusForError', () => {
  it('falls back to 500 for anything unrecognised', () => {
    expect(statusForError(new Error('boom'))).toBe(500);
  });
});
