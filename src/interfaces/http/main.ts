import { LedgerService } from '../../application/service.js';
import { assertCurrency } from '../../domain/currency.js';
import { InMemoryStore } from '../../infrastructure/memory-store.js';
import { SqliteStore } from '../../infrastructure/sqlite-store.js';
import { buildServer } from './server.js';

/**
 * `npm run serve`
 *
 * Configuration comes from the environment so the same image runs in every
 * environment: `LEDGERLINE_DB` (`:memory:` by default), `LEDGERLINE_CURRENCY`,
 * `LEDGERLINE_HOST`, `LEDGERLINE_PORT`, `LEDGERLINE_LOG`.
 */
async function main(): Promise<void> {
  const path = process.env.LEDGERLINE_DB ?? ':memory:';
  const functionalCurrency = assertCurrency(
    (process.env.LEDGERLINE_CURRENCY ?? 'USD').toUpperCase(),
  );
  const host = process.env.LEDGERLINE_HOST ?? '127.0.0.1';
  const port = Number(process.env.LEDGERLINE_PORT ?? 3000);
  const logger = process.env.LEDGERLINE_LOG === 'true';

  const store = path === ':memory:' ? new InMemoryStore() : new SqliteStore({ path });
  const service = new LedgerService(store, {
    functionalCurrency,
    retainedEarningsCode: process.env.LEDGERLINE_RETAINED_EARNINGS ?? '3200',
    fxClearingCode: process.env.LEDGERLINE_FX_CLEARING ?? '3210',
  });
  const app = buildServer({ service, logger });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await service.close();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host, port });
  app.log.info({ path, functionalCurrency }, 'ledgerline is listening');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
