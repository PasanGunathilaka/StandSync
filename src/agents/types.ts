import type { z } from 'zod';
import type { LLMClient } from '../llm/types.js';
import type { ApprovalStore } from '../approval/store.js';
import type { StageLogger } from '../observe/stages.js';

/**
 * Shared vocabulary for StandSync's bounded reasoning components.
 *
 * "Agent" here means a narrow, schema-constrained reasoning step managed by
 * application code — not an autonomous process with tools. Every agent receives
 * a structured input, returns a structured output, and has no capability beyond
 * the LLMClient it was handed. None of them can reach Jira, the filesystem, the
 * network or a shell.
 */

/** Why an agent produced no usable answer. Drives fail-closed handling. */
export type AgentFailureKind = 'schema_invalid' | 'provider_error' | 'timeout';

/**
 * An agent either answered within its schema or it did not. There is no partial
 * state: callers must handle `ok: false` explicitly, which is what makes the
 * degradation strategy checkable rather than accidental.
 */
export type AgentResult<T> =
  | { ok: true; value: T; meta: AgentRunMeta }
  | { ok: false; kind: AgentFailureKind; reason: string; meta: AgentRunMeta };

export interface AgentRunMeta {
  agentName: string;
  provider: string;
  model: string;
  durationMs: number;
  attempts: number;
}

/**
 * One reasoning module: the prompt, the schema the provider is constrained to,
 * and the zod schema the output is re-validated against.
 *
 * Skills in src/skills/ are values of this type. Keeping prompt and schema in
 * one object is what stops the two drifting apart.
 */
export interface Skill<TInput, TOutput> {
  /** Stable name used in logs, metrics and the agent_runs table. */
  name: string;
  /** One line on what this skill decides. Documentation, not prompt text. */
  purpose: string;
  /** Trusted, StandSync-authored instructions. */
  systemPrompt: string;
  /** JSON Schema handed to the provider. */
  jsonSchema: Record<string, unknown>;
  /** Re-validation of whatever comes back. */
  outputSchema: z.ZodType<TOutput>;
  /** Renders the untrusted user turn from typed input. */
  buildUserMessage: (input: TInput) => string;
}

/** Everything a bounded agent is allowed to depend on. */
export interface AgentDeps {
  llm: LLMClient;
  timeoutMs: number;
  /** Optional: agent runs are recorded for audit when a store is available. */
  store?: ApprovalStore;
  log: StageLogger;
  traceId: string;
  messageId?: string;
}
