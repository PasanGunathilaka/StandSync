import { logger, type Logger } from '../logger.js';

/**
 * Thin Jira REST API v3 wrapper: Basic auth, retry/backoff, and errors that carry
 * enough detail for a result card to explain what went wrong to a human.
 */

export class JiraError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issueKey?: string,
  ) {
    super(message);
    this.name = 'JiraError';
  }
}

/** 404 — the key does not exist (or this account cannot see it). */
export class JiraNotFoundError extends JiraError {
  constructor(issueKey?: string) {
    super(
      issueKey ? `Issue ${issueKey} not found in Jira` : 'Jira resource not found',
      404,
      issueKey,
    );
    this.name = 'JiraNotFoundError';
  }
}

/** 401/403 — credentials are wrong or lack permission. */
export class JiraAuthError extends JiraError {
  constructor(status: number, detail?: string) {
    super(
      status === 401
        ? 'Jira rejected the credentials (401). Check JIRA_EMAIL and JIRA_API_TOKEN.'
        : `Jira denied this action (403).${detail ? ` ${detail}` : ''}`,
      status,
    );
    this.name = 'JiraAuthError';
  }
}

export interface JiraClientOptions {
  baseUrl: string;
  email: string;
  apiToken: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  /** Injectable for tests so backoff does not actually sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
  log?: Logger;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT';
  body?: unknown;
  issueKey?: string;
}

export class JiraClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: Logger;

  constructor(opts: JiraClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    // Basic base64(email:token). Built once; never logged.
    this.authHeader = `Basic ${Buffer.from(`${opts.email}:${opts.apiToken}`).toString('base64')}`;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.sleep = opts.sleepImpl ?? defaultSleep;
    this.log = opts.log ?? logger;
  }

  /**
   * Performs a Jira request, retrying 429 and 5xx up to maxRetries with backoff.
   * 4xx other than 429 fail immediately — retrying a 400 just repeats the mistake.
   */
  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const method = opts.method ?? 'GET';

    let lastError: JiraError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: this.authHeader,
          Accept: 'application/json',
          ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      });

      if (res.ok) {
        // 204 No Content is the success shape for transitions.
        if (res.status === 204) return undefined as T;
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }

      // Retryable: rate limit and server errors.
      if (res.status === 429 || res.status >= 500) {
        lastError = new JiraError(
          `Jira returned ${res.status} for ${method} ${path}`,
          res.status,
          opts.issueKey,
        );
        if (attempt < this.maxRetries) {
          const delay = this.retryDelayMs(res, attempt);
          this.log.warn(
            { status: res.status, path, attempt: attempt + 1, delayMs: delay },
            'Jira request failed, retrying',
          );
          await this.sleep(delay);
          continue;
        }
        throw lastError;
      }

      throw await this.toError(res, opts.issueKey);
    }

    throw lastError ?? new JiraError(`Jira request failed: ${method} ${path}`, 500, opts.issueKey);
  }

  /** Honours Retry-After when Jira sends it, else exponential backoff. */
  private retryDelayMs(res: Response, attempt: number): number {
    const retryAfter = res.headers.get('retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
    }
    return Math.min(2 ** attempt * 500, 8_000);
  }

  /** Turns a Jira error response into a typed error, surfacing Jira's own messages. */
  private async toError(res: Response, issueKey?: string): Promise<JiraError> {
    if (res.status === 404) return new JiraNotFoundError(issueKey);

    let detail = '';
    try {
      const body = (await res.json()) as { errorMessages?: unknown; errors?: unknown };
      const messages = Array.isArray(body.errorMessages)
        ? body.errorMessages.filter((m): m is string => typeof m === 'string')
        : [];
      const fieldErrors =
        body.errors && typeof body.errors === 'object'
          ? Object.entries(body.errors as Record<string, unknown>).map(
              ([field, msg]) => `${field}: ${String(msg)}`,
            )
          : [];
      detail = [...messages, ...fieldErrors].join('; ');
    } catch {
      // Jira occasionally returns HTML for auth failures; there is nothing to parse.
    }

    if (res.status === 401 || res.status === 403) return new JiraAuthError(res.status, detail);

    return new JiraError(detail || `Jira returned ${res.status}`, res.status, issueKey);
  }
}
