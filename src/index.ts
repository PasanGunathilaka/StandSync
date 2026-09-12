import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import { getConfig, isDevelopment, type Config } from './config.js';
import { logger } from './logger.js';
import { ApprovalStore } from './approval/store.js';

export type StandSyncServer = ReturnType<typeof buildServer>;

export interface AppContext {
  config: Config;
  store: ApprovalStore;
}

export function buildServer(ctx: AppContext) {
  const app = Fastify({ loggerInstance: logger });

  app.get('/health', () => ({
    ok: true,
    service: 'standsync',
    tagline: 'Your team talks. Jira stays current.',
    env: ctx.config.NODE_ENV,
  }));

  // Dev endpoints (/dev/standup, /dev/approve/:batchId) are registered in Phase 5.
  if (isDevelopment(ctx.config)) {
    app.log.info('development mode — /dev/* endpoints will be enabled');
  }

  return app;
}

async function main(): Promise<void> {
  const config = getConfig();
  const store = ApprovalStore.open(config.DATABASE_PATH);
  const app = buildServer({ config, store });

  const close = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    await app.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void close('SIGINT'));
  process.on('SIGTERM', () => void close('SIGTERM'));

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info({ port: config.PORT }, 'StandSync listening');
}

// Only boot when executed directly, so tests can import buildServer freely.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    // Config errors are actionable messages, not crashes — print them plainly.
    if (err instanceof Error && err.name === 'ConfigError') {
      console.error(`\n${err.message}\n`);
      process.exit(1);
    }
    logger.error({ err }, 'fatal startup error');
    process.exit(1);
  });
}
