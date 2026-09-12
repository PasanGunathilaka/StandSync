/**
 * Provider-agnostic contract for structured LLM calls.
 *
 * Everything StandSync asks a model to do is: "given this text, return an object
 * matching this JSON schema". Keeping that the whole interface is what lets the
 * Claude Code CLI, the Anthropic SDK and a deterministic mock be interchangeable.
 */

export interface LLMRequest {
  /** Trusted, StandSync-authored instructions. */
  systemPrompt: string;
  /** Untrusted user content (the standup text). Never interpolated into a shell. */
  userMessage: string;
  /** JSON Schema the provider must constrain output to. */
  jsonSchema: Record<string, unknown>;
  /** Hard ceiling. The provider must abandon the call and throw once exceeded. */
  timeoutMs: number;
}

export interface LLMResponse {
  /**
   * The structured object the provider produced. Still `unknown`: the caller
   * re-validates with zod regardless of any provider-side schema enforcement.
   */
  data: unknown;
  meta: LLMCallMeta;
}

export interface LLMCallMeta {
  provider: string;
  model: string;
  durationMs: number;
  costUsd?: number;
  sessionId?: string;
}

export interface LLMClient {
  /** Stable identifier used in logs: 'claude-code' | 'anthropic' | 'mock'. */
  readonly name: string;
  readonly model: string;
  complete(req: LLMRequest): Promise<LLMResponse>;
}

export class LLMError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'LLMError';
  }
}

/** The call exceeded timeoutMs and the provider abandoned it. */
export class LLMTimeoutError extends LLMError {
  constructor(provider: string, timeoutMs: number) {
    super(`${provider} call exceeded the ${timeoutMs}ms timeout`, provider);
    this.name = 'LLMTimeoutError';
  }
}
