import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { VersionConflictError } from '../../application/ports.js';
import type { LedgerService } from '../../application/service.js';
import { type CurrencyCode, isCurrencyCode } from '../../domain/currency.js';
import { type IsoDate, isIsoDate } from '../../domain/date.js';
import { type ErrorCode, LedgerError, ValidationError } from '../../domain/errors.js';
import {
  presentAccount,
  presentAccountStatement,
  presentBalanceSheet,
  presentClosedPeriod,
  presentEntry,
  presentIncomeStatement,
  presentIntegrity,
  presentOccurrence,
  presentRate,
  presentRule,
  presentTrialBalance,
} from './present.js';

/**
 * REST surface.
 *
 * Three rules hold everywhere:
 *
 * 1. **Domain error codes decide the status.** A handler never inspects a message
 *    to decide whether the caller made a mistake; it maps `ErrorCode` to a status
 *    once, in {@link statusForError}.
 * 2. **Amounts are strings.** See `present.ts`.
 * 3. **Writes are idempotent** when the caller sends `Idempotency-Key`, so a
 *    retried request after a timeout cannot double-post.
 */

/**
 * `z.custom` rather than a plain string schema: the service wants an `IsoDate`,
 * and a schema that produces one removes every `as never` cast downstream. The
 * domain's own `isIsoDate` does the validating, so the API and the engine can
 * never disagree about what a date is.
 */
const isoDate = z.custom<IsoDate>((value) => typeof value === 'string' && isIsoDate(value), {
  message: 'expected an ISO date such as 2025-01-31',
});
const currency = z
  .custom<CurrencyCode>((value) => typeof value === 'string' && isCurrencyCode(value), {
    message: 'expected a 3-letter currency code',
  })
  .transform((value) => value.toUpperCase());
const accountCode = z
  .string()
  .min(1)
  .max(32)
  .transform((value) => value.trim().toUpperCase());

const postingSchema = z.object({
  account: accountCode,
  side: z.enum(['debit', 'credit']),
  amount: z.string().min(1),
  memo: z.string().max(280).optional(),
});

const entrySchema = z.object({
  date: isoDate,
  memo: z.string().max(280).optional(),
  reference: z.string().max(64).optional(),
  tags: z.array(z.string().max(32)).max(12).optional(),
  postings: z.array(postingSchema).min(2),
});

const accountSchema = z.object({
  code: accountCode,
  name: z.string().min(1).max(120),
  type: z.enum(['asset', 'liability', 'equity', 'income', 'expense']),
  parentCode: accountCode.nullish(),
  currency: currency.nullish(),
  description: z.string().max(500).optional(),
  tags: z.array(z.string().max(32)).max(16).optional(),
});

const rateSchema = z.object({
  base: currency,
  quote: currency,
  rate: z.string().min(1),
  effectiveDate: isoDate,
  source: z.string().max(64).optional(),
});

const ruleSchema = z.object({
  frequency: z.enum(['daily', 'weekly', 'fortnightly', 'monthly', 'quarterly', 'yearly']),
  interval: z.number().int().min(1).max(365).optional(),
  startDate: isoDate,
  endDate: isoDate.nullish(),
  maxOccurrences: z.number().int().min(1).nullish(),
  adjustWeekend: z.enum(['none', 'next-business-day']).optional(),
  memo: z.string().max(280).optional(),
  reference: z.string().max(64).optional(),
  tags: z.array(z.string().max(32)).max(12).optional(),
  postings: z.array(postingSchema).min(2),
});

const periodSchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  rateMode: z.enum(['closing', 'average']).optional(),
});

const closeSchema = z.object({
  from: isoDate.optional(),
  to: isoDate,
  date: isoDate.optional(),
  memo: z.string().max(280).optional(),
  closedBy: z.string().max(64).optional(),
});

const reverseSchema = z.object({ date: isoDate });

/** Status codes per domain error code, in one place. */
const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  ACCOUNT_NOT_FOUND: 404,
  ACCOUNT_ALREADY_EXISTS: 409,
  ACCOUNT_NOT_POSTABLE: 422,
  ACCOUNT_TYPE_CONFLICT: 422,
  ACCOUNT_CYCLE: 422,
  CURRENCY_MISMATCH: 422,
  CURRENCY_UNSUPPORTED: 400,
  UNBALANCED_ENTRY: 422,
  EMPTY_ENTRY: 422,
  NON_POSITIVE_AMOUNT: 422,
  DUPLICATE_ACCOUNT_IN_ENTRY: 422,
  ENTRY_NOT_FOUND: 404,
  ENTRY_ALREADY_REVERSED: 409,
  RATE_NOT_FOUND: 422,
  INVALID_RATE: 422,
  INVALID_RECURRENCE: 422,
  CONFLICT: 409,
  INTERNAL: 500,
};

export function statusForError(error: unknown): number {
  if (error instanceof LedgerError) {
    return STATUS_BY_CODE[error.code];
  }
  if (error instanceof VersionConflictError) {
    return 409;
  }
  return 500;
}

function errorBody(error: unknown): Record<string, unknown> {
  if (error instanceof LedgerError) {
    return { error: error.toJSON() };
  }
  if (error instanceof VersionConflictError) {
    return { error: { code: 'CONFLICT', message: error.message, details: {} } };
  }
  return {
    error: {
      code: 'INTERNAL',
      message: 'The books could not be updated.',
      details: {},
    },
  };
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError('The request is not valid.', {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return result.data;
}

function query(request: FastifyRequest): Record<string, string> {
  return (request.query ?? {}) as Record<string, string>;
}

function idempotencyKey(request: FastifyRequest): { idempotencyKey?: string } {
  const header = request.headers['idempotency-key'];
  const key = Array.isArray(header) ? header[0] : header;
  return key === undefined ? {} : { idempotencyKey: key };
}

export interface ServerOptions {
  readonly service: LedgerService;
  readonly logger?: boolean;
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const { service } = options;
  const app = Fastify({ logger: options.logger ?? false });

  app.setErrorHandler((error, request, reply) => {
    const status = statusForError(error);
    if (status >= 500) {
      request.log.error({ err: error }, 'unhandled error');
    }
    void reply.status(status).send(errorBody(error));
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      error: {
        code: 'VALIDATION_FAILED',
        message: `No route for ${request.method} ${request.url}.`,
        details: {},
      },
    });
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/v1/accounts', async (request) => {
    const type = query(request).type;
    const accounts = await service.accounts(type === undefined ? {} : { type: parseType(type) });
    return { accounts: accounts.map(presentAccount) };
  });

  app.get('/v1/accounts/:code', async (request) => {
    const { code } = request.params as { code: string };
    return { account: presentAccount(await service.account(code)) };
  });

  app.post('/v1/accounts', async (request, reply) => {
    const body = parse(accountSchema, request.body);
    const account = await service.createAccount({
      code: body.code,
      name: body.name,
      type: body.type,
      ...(body.parentCode === null || body.parentCode === undefined
        ? {}
        : { parentCode: body.parentCode }),
      ...(body.currency === null || body.currency === undefined ? {} : { currency: body.currency }),
      ...(body.description === undefined ? {} : { description: body.description }),
      ...(body.tags === undefined ? {} : { tags: body.tags }),
    });
    return reply.status(201).send({ account: presentAccount(account) });
  });

  app.patch('/v1/accounts/:code', async (request) => {
    const { code } = request.params as { code: string };
    const body = parse(
      z.object({
        name: z.string().min(1).max(120).optional(),
        description: z.string().max(500).optional(),
        tags: z.array(z.string().max(32)).max(16).optional(),
        parentCode: accountCode.nullish(),
      }),
      request.body,
    );
    const account = await service.updateAccount(code, {
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.description === undefined ? {} : { description: body.description }),
      ...(body.tags === undefined ? {} : { tags: body.tags }),
      ...(body.parentCode === undefined ? {} : { parentCode: body.parentCode }),
    });
    return { account: presentAccount(account) };
  });

  app.get('/v1/entries', async (request) => {
    const params = query(request);
    const entries = await service.entries({
      ...(params.from === undefined ? {} : { from: isoDate.parse(params.from) }),
      ...(params.to === undefined ? {} : { to: isoDate.parse(params.to) }),
      ...(params.reference === undefined ? {} : { reference: params.reference }),
      ...(params.tags === undefined ? {} : { tags: params.tags.split(',') }),
    });
    return { entries: entries.map(presentEntry) };
  });

  app.get('/v1/entries/:id', async (request) => {
    const { id } = request.params as { id: string };
    return { entry: presentEntry(await service.entry(id)) };
  });

  app.post('/v1/entries', async (request, reply) => {
    const body = parse(entrySchema, request.body);
    const result = await service.postEntry(
      {
        date: body.date,
        ...(body.memo === undefined ? {} : { memo: body.memo }),
        ...(body.reference === undefined ? {} : { reference: body.reference }),
        ...(body.tags === undefined ? {} : { tags: body.tags }),
        postings: body.postings,
      },
      idempotencyKey(request),
    );
    return reply.status(result.created ? 201 : 200).send({
      entry: presentEntry(result.entry),
      created: result.created,
    });
  });

  app.post('/v1/entries/:id/reversal', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = parse(reverseSchema, request.body);
    const reversal = await service.reverseEntry(id, { date: body.date }, idempotencyKey(request));
    return reply.status(201).send({ entry: presentEntry(reversal) });
  });

  app.get('/v1/fx/rates', async () => ({ rates: (await service.rates()).map(presentRate) }));

  app.post('/v1/fx/rates', async (request, reply) => {
    const body = parse(rateSchema, request.body);
    const rate = await service.recordRate({
      base: body.base,
      quote: body.quote,
      rate: body.rate,
      effectiveDate: body.effectiveDate,
      ...(body.source === undefined ? {} : { source: body.source }),
    });
    return reply.status(201).send({ rate: presentRate(rate) });
  });

  app.get('/v1/recurring', async () => ({ rules: (await service.rules()).map(presentRule) }));

  app.get('/v1/recurring/:id/occurrences', async (request) => {
    const { id } = request.params as { id: string };
    const params = query(request);
    const until = params.until;
    if (until === undefined) {
      throw new ValidationError("Query parameter 'until' (YYYY-MM-DD) is required.");
    }
    const limit = params.limit;
    const due = await service.previewOccurrences(id, {
      until: until,
      ...(limit === undefined ? {} : { limit: Number(limit) }),
    });
    return { occurrences: due.map(presentOccurrence) };
  });

  app.post('/v1/recurring', async (request, reply) => {
    const body = parse(ruleSchema, request.body);
    const rule = await service.createRecurringRule({
      frequency: body.frequency,
      startDate: body.startDate,
      postings: body.postings,
      ...(body.interval === undefined ? {} : { interval: body.interval }),
      ...(body.endDate === undefined ? {} : { endDate: body.endDate }),
      ...(body.maxOccurrences === undefined ? {} : { maxOccurrences: body.maxOccurrences }),
      ...(body.adjustWeekend === undefined ? {} : { adjustWeekend: body.adjustWeekend }),
      ...(body.memo === undefined ? {} : { memo: body.memo }),
      ...(body.reference === undefined ? {} : { reference: body.reference }),
      ...(body.tags === undefined ? {} : { tags: body.tags }),
    });
    return reply.status(201).send({ rule: presentRule(rule) });
  });

  app.post('/v1/recurring/run', async (request) => {
    const body = parse(
      z.object({ until: isoDate, limit: z.number().int().min(1).optional() }),
      request.body,
    );
    const result = await service.runRecurring({
      until: body.until,
      ...(body.limit === undefined ? {} : { limit: body.limit }),
    });
    return {
      created: result.created.map(presentEntry),
      skipped: result.skipped,
      occurrences: result.occurrences.map(presentOccurrence),
    };
  });

  app.get('/v1/reports/trial-balance', async (request) => {
    const { from, to, rateMode } = parse(periodSchema, query(request));
    return {
      report: presentTrialBalance(
        await service.trialBalance(periodOf(from, to), {
          ...(rateMode === undefined ? {} : { rateMode }),
        }),
      ),
    };
  });

  app.get('/v1/reports/balance-sheet', async (request) => {
    const { from, to, rateMode } = parse(periodSchema, query(request));
    return {
      report: presentBalanceSheet(
        await service.balanceSheet(periodOf(from, to), {
          ...(rateMode === undefined ? {} : { rateMode }),
        }),
      ),
    };
  });

  app.get('/v1/reports/income-statement', async (request) => {
    const { from, to, rateMode } = parse(periodSchema, query(request));
    return {
      report: presentIncomeStatement(
        await service.incomeStatement(periodOf(from, to), {
          ...(rateMode === undefined ? {} : { rateMode }),
        }),
      ),
    };
  });

  app.get('/v1/reports/accounts/:code', async (request) => {
    const { code } = request.params as { code: string };
    const { from, to, rateMode } = parse(periodSchema, query(request));
    return {
      report: presentAccountStatement(
        await service.accountStatement(code, periodOf(from, to), {
          ...(rateMode === undefined ? {} : { rateMode }),
        }),
      ),
    };
  });

  app.post('/v1/periods/close', async (request, reply) => {
    const body = parse(closeSchema, request.body);
    const result = await service.closePeriod({
      to: body.to,
      ...(body.from === undefined ? {} : { from: body.from }),
      ...(body.date === undefined ? {} : { date: body.date }),
      ...(body.memo === undefined ? {} : { memo: body.memo }),
      ...(body.closedBy === undefined ? {} : { closedBy: body.closedBy }),
    });
    return reply.status(201).send({
      period: presentClosedPeriod(result.period),
      entries: result.entries.map(presentEntry),
    });
  });

  app.get('/v1/periods', async () => ({
    periods: (await service.closedPeriods()).map(presentClosedPeriod),
  }));

  app.get('/v1/verify', async (_request, reply: FastifyReply) => {
    const report = await service.verify();
    return reply.status(report.balanced ? 200 : 409).send({ report: presentIntegrity(report) });
  });

  return app;
}

function parseType(value: string): 'asset' | 'liability' | 'equity' | 'income' | 'expense' {
  const result = z.enum(['asset', 'liability', 'equity', 'income', 'expense']).safeParse(value);
  if (!result.success) {
    throw new ValidationError(`Unknown account type '${value}'.`, { type: value });
  }
  return result.data;
}

function periodOf(
  from: IsoDate | undefined,
  to: IsoDate | undefined,
): { from?: IsoDate; to?: IsoDate } {
  return {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };
}
