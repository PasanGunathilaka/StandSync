import type { z } from 'zod';
import { LLMTimeoutError } from '../llm/types.js';
import type { AgentDeps, AgentResult, AgentRunMeta, Skill } from './types.js';

/**
 * The single place a bounded agent calls a model.
 *
 * Every V2 reasoning stage goes through here, which is what keeps the promise
 * that there is one LLM integration rather than six. It provides:
 *
 * - One retry on schema failure, with the validation error fed back, matching
 *   the reliability contract V1 established in src/standup/interpret.ts.
 * - Mandatory zod re-validation. A provider-side schema is a hint, not a
 *   guarantee, so nothing leaves this function unvalidated.
 * - A typed failure instead of an exception. Callers must decide what a failed
 *   stage means, and "fail closed" is only auditable if the failure is a value.
 * - An agent_runs row per call: timings and outcome, never reasoning traces.
 *
 * It grants no capability. A skill gets a system prompt, a schema and a string;
 * it cannot reach Jira, the filesystem or the network.
 */

export const MAX_ATTEMPTS = 2;

export async function runAgent<TInput, TOutput>(
  skill: Skill<TInput, TOutput>,
  input: TInput,
  deps: AgentDeps,
): Promise<AgentResult<TOutput>> {
  const { llm, timeoutMs } = deps;
  const baseUserMessage = skill.buildUserMessage(input);
  const startedAt = Date.now();

  let validationError = '';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const userMessage =
      attempt === 1 ? baseUserMessage : `${baseUserMessage}${retrySuffix(validationError)}`;

    let data: unknown;
    try {
      const response = await llm.complete({
        systemPrompt: skill.systemPrompt,
        userMessage,
        jsonSchema: skill.jsonSchema,
        timeoutMs,
      });
      data = response.data;
    } catch (err) {
      // Provider failures and timeouts are terminal: there is nothing to correct
      // by asking again with the same input.
      // The stage name belongs to the caller, which knows which stage it is
      // running; the runner only records the agent-level outcome.
      const kind = err instanceof LLMTimeoutError ? 'timeout' : 'provider_error';
      const reason = err instanceof Error ? err.message : String(err);
      const meta = metaFor(skill.name, deps, startedAt, attempt);
      record(deps, meta, kind, false, reason);
      return { ok: false, kind, reason, meta };
    }

    const parsed = skill.outputSchema.safeParse(data);
    if (parsed.success) {
      const meta = metaFor(skill.name, deps, startedAt, attempt);
      record(deps, meta, 'ok', true);
      return { ok: true, value: parsed.data, meta };
    }

    validationError = summarizeZodError(parsed.error);
  }

  const meta = metaFor(skill.name, deps, startedAt, MAX_ATTEMPTS);
  record(deps, meta, 'schema_invalid', false, validationError);
  return {
    ok: false,
    kind: 'schema_invalid',
    reason: `${skill.name} did not return a valid result: ${validationError}`,
    meta,
  };
}

function metaFor(
  agentName: string,
  deps: AgentDeps,
  startedAt: number,
  attempts: number,
): AgentRunMeta {
  return {
    agentName,
    provider: deps.llm.name,
    model: deps.llm.model,
    durationMs: Date.now() - startedAt,
    attempts,
  };
}

function record(
  deps: AgentDeps,
  meta: AgentRunMeta,
  resultType: 'ok' | 'schema_invalid' | 'provider_error' | 'timeout',
  ok: boolean,
  detail?: string,
): void {
  if (!deps.store) return;
  try {
    deps.store.recordAgentRun({
      traceId: deps.traceId,
      ...(deps.messageId ? { messageId: deps.messageId } : {}),
      agentName: meta.agentName,
      provider: meta.provider,
      model: meta.model,
      durationMs: meta.durationMs,
      resultType,
      ok,
      ...(detail ? { detail } : {}),
    });
  } catch {
    // Audit bookkeeping must never fail a reasoning stage. The stage log still
    // carries the outcome, so the run is not invisible.
  }
}

/** Appended on the single retry, so the model sees exactly what was wrong. */
export function retrySuffix(validationError: string): string {
  return [
    '',
    '',
    'Your previous response did not match the required schema.',
    `Validation error: ${validationError}`,
    'Return a corrected object matching the schema exactly.',
  ].join('\n');
}

export function summarizeZodError(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

/** Records a stage that was deliberately not run, so the trace has no gaps. */
export function recordSkipped(deps: AgentDeps, agentName: string, reason: string): void {
  if (!deps.store) return;
  try {
    deps.store.recordAgentRun({
      traceId: deps.traceId,
      ...(deps.messageId ? { messageId: deps.messageId } : {}),
      agentName,
      provider: deps.llm.name,
      model: deps.llm.model,
      durationMs: 0,
      resultType: 'skipped',
      ok: true,
      detail: reason,
    });
  } catch {
    /* see record() */
  }
}
