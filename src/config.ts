import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv({ quiet: true });

const required = (label: string) => z.string().trim().min(1, `${label} must not be empty`);

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3978),

  // Optional: only the 'anthropic' LLM provider needs it. The default
  // 'claude-code' provider authenticates through the Claude Code CLI instead.
  ANTHROPIC_API_KEY: z.string().trim().default(''),
  // Always an explicit model id. CLI aliases like 'sonnet' resolve to whatever the
  // installed Claude Code build points at (observed: 'sonnet' -> claude-sonnet-4-6),
  // which would silently change interpretation behaviour between machines.
  ANTHROPIC_MODEL: z.string().trim().min(1).default('claude-sonnet-5'),

  // claude-code: shell out to the Claude Code CLI (uses your subscription login or
  //              CLAUDE_CODE_OAUTH_TOKEN; no ANTHROPIC_API_KEY needed).
  // anthropic:   direct Anthropic SDK, requires ANTHROPIC_API_KEY.
  // mock:        deterministic heuristics — unit tests and offline demo fallback.
  LLM_PROVIDER: z.enum(['claude-code', 'anthropic', 'mock']).default('claude-code'),
  CLAUDE_CODE_PATH: z.string().trim().min(1).default('claude'),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),

  JIRA_BASE_URL: z.url('JIRA_BASE_URL must be a full URL, e.g. https://yourorg.atlassian.net'),
  JIRA_EMAIL: required('JIRA_EMAIL'),
  JIRA_API_TOKEN: required('JIRA_API_TOKEN'),
  JIRA_PROJECT_KEY: z.string().trim().min(1).default('PAY'),

  STATUS_DONE: z.string().trim().min(1).default('Done'),
  STATUS_IN_PROGRESS: z.string().trim().min(1).default('In Progress'),
  STATUS_TODO: z.string().trim().min(1).default('To Do'),

  MICROSOFT_APP_ID: z.string().trim().default(''),
  MICROSOFT_APP_PASSWORD: z.string().trim().default(''),
  MICROSOFT_APP_TENANT_ID: z.string().trim().default(''),
  TEAMS_ALLOWED_CONVERSATION_ID: z.string().trim().default(''),

  APPROVAL_POLICY: z.enum(['author_only', 'anyone']).default('anyone'),
  STALE_DAYS: z.coerce.number().int().positive().default(5),

  DATABASE_PATH: z.string().trim().min(1).default('./data/standsync.db'),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Keys whose values must never appear in logs or error messages. */
export const SECRET_KEYS = [
  'ANTHROPIC_API_KEY',
  'JIRA_API_TOKEN',
  'MICROSOFT_APP_PASSWORD',
] as const satisfies readonly (keyof Config)[];

class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * Parses process.env. Throws a ConfigError listing every problem at once so a
 * misconfigured deploy is fixed in one pass rather than one variable per restart.
 * Never includes the offending value — only the variable name and the reason.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (parsed.success) return parsed.data;

  const problems = parsed.error.issues.map((issue) => {
    const name = issue.path.join('.') || '(root)';
    const reason = issue.code === 'invalid_type' ? 'is missing' : issue.message;
    return `  - ${name}: ${reason}`;
  });

  throw new ConfigError(
    `StandSync cannot start — ${problems.length} configuration problem(s):\n${problems.join('\n')}\n\n` +
      `Copy .env.example to .env and fill in the blanks.`,
  );
}

let cached: Config | undefined;

/** Memoized config. Call sites should use this rather than reading process.env. */
export function getConfig(): Config {
  cached ??= loadConfig();
  return cached;
}

/** Test seam: drop the memoized config so a later getConfig() re-reads the env. */
export function resetConfigForTests(): void {
  cached = undefined;
}

export function isDevelopment(cfg: Config = getConfig()): boolean {
  return cfg.NODE_ENV === 'development';
}
