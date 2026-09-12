import { pino, type Logger } from 'pino';

/**
 * Pipeline logs are traced by batchId. Use `logger.child({ batchId })` at the
 * point a batch is created and pass that child down the pipeline.
 */
const isDev = (process.env.NODE_ENV ?? 'development') === 'development';

export const logger: Logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  // Belt and braces: config.ts keeps secrets out of logs by construction, this
  // catches anything that gets logged by accident (e.g. a raw axios error).
  redact: {
    paths: [
      'apiKey',
      'token',
      'password',
      'authorization',
      '*.apiKey',
      '*.token',
      '*.password',
      '*.authorization',
      'headers.authorization',
      'req.headers.authorization',
      'config.headers.Authorization',
      'ANTHROPIC_API_KEY',
      'JIRA_API_TOKEN',
      'MICROSOFT_APP_PASSWORD',
    ],
    censor: '[redacted]',
  },
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : {}),
});

export type { Logger };
