import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import { getConfig, isDevelopment, type Config } from './config.js';
import { logger } from './logger.js';
import { ApprovalStore } from './approval/store.js';
import { JiraClient } from './jira/client.js';
import { JiraIssues } from './jira/issues.js';
import { JiraActions } from './jira/actions.js';
import { createLLMClient } from './llm/index.js';
import { registerDevRoutes } from './dev/routes.js';
import { createTeamsApp, isTeamsConfigured } from './teams/app.js';
import type { App } from '@microsoft/teams.apps';
import type { LLMClient } from './llm/types.js';

export type StandSyncServer = ReturnType<typeof buildServer>;

export interface AppContext {
  config: Config;
  store: ApprovalStore;
  issues: JiraIssues;
  actions: JiraActions;
  llm: LLMClient;
}

/** Wires every dependency from config. Used by boot and by integration tests. */
export function buildContext(config: Config): AppContext {
  const client = new JiraClient({
    baseUrl: config.JIRA_BASE_URL,
    email: config.JIRA_EMAIL,
    apiToken: config.JIRA_API_TOKEN,
  });

  return {
    config,
    store: ApprovalStore.open(config.DATABASE_PATH),
    issues: new JiraIssues(client),
    actions: new JiraActions(client),
    llm: createLLMClient(config),
  };
}

export function buildServer(ctx: AppContext) {
  const app = Fastify({ loggerInstance: logger });

  app.get('/health', () => ({
    ok: true,
    service: 'standsync',
    tagline: 'Your team talks. Jira stays current.',
    env: ctx.config.NODE_ENV,
    provider: ctx.config.LLM_PROVIDER,
    model: ctx.config.ANTHROPIC_MODEL,
  }));

  // Dev endpoints drive the same pipeline as Teams, so the product stays
  // demonstrable if tenant policy blocks sideloading the app.
  if (isDevelopment(ctx.config)) {
    registerDevRoutes(app, {
      config: ctx.config,
      store: ctx.store,
      issues: ctx.issues,
      actions: ctx.actions,
      llm: ctx.llm,
    });
  }

  return app;
}

/**
 * Mounts the Teams messaging endpoint on the same Fastify instance.
 *
 * Must be awaited before Fastify listens: App.initialize() is what registers the
 * route through our adapter. App.start() is deliberately never called — Fastify
 * owns the server lifecycle, so the adapter implements no start()/stop().
 */
export async function attachTeams(app: StandSyncServer, ctx: AppContext): Promise<App | undefined> {
  if (!isTeamsConfigured(ctx.config)) {
    logger.warn(
      'MICROSOFT_APP_ID/PASSWORD not set — Teams is disabled. The /dev/* endpoints still work.',
    );
    return undefined;
  }

  const teams = createTeamsApp(app, {
    config: ctx.config,
    store: ctx.store,
    issues: ctx.issues,
    actions: ctx.actions,
    llm: ctx.llm,
  });

  await teams.initialize();
  logger.info(
    { endpoint: ctx.config.TEAMS_MESSAGING_ENDPOINT },
    'Teams endpoint mounted on Fastify',
  );
  return teams;
}

async function main(): Promise<void> {
  const config = getConfig();
  const ctx = buildContext(config);
  const app = buildServer(ctx);

  // Mount Teams before listening so the endpoint exists for the first activity.
  await attachTeams(app, ctx);

  const close = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    await app.close();
    ctx.store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void close('SIGINT'));
  process.on('SIGTERM', () => void close('SIGTERM'));

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info(
    { port: config.PORT, provider: config.LLM_PROVIDER, jira: config.JIRA_BASE_URL },
    'StandSync listening',
  );
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
