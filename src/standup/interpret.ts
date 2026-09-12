import type { z } from 'zod';
import { logger, type Logger } from '../logger.js';
import type { LLMClient } from '../llm/types.js';
import type { IssueLookup } from '../jira/issues.js';
import type { InterpretationResult, TicketInterpretation } from '../types.js';
import {
  INTERPRETATION_JSON_SCHEMA,
  InterpretationResultSchema,
  SYSTEM_PROMPT,
  buildRetrySuffix,
  buildUserMessage,
} from './prompts.js';

/**
 * Turns a standup message into per-ticket intent.
 *
 * Claude's only job here is interpretation. It never sees transition ids, never
 * chooses a Jira action and never writes anything — src/standup/propose.ts merges
 * this output with live Jira state to decide what to actually propose.
 *
 * Reliability contract:
 * - The provider is schema-constrained, and we still re-validate with zod.
 * - One retry on validation failure, with the error fed back.
 * - After that, affected tickets become `unclear` rather than a guess.
 * - Keys the model invented are dropped; keys it omitted are filled in as `unclear`,
 *   so the result always covers exactly the keys we detected.
 */

export interface InterpretParams {
  rawMessage: string;
  keys: string[];
  lookups?: IssueLookup[];
  llm: LLMClient;
  timeoutMs: number;
  log?: Logger;
  /** Correlates every pipeline stage for one standup. */
  batchId?: string;
}

export async function interpretStandup(params: InterpretParams): Promise<InterpretationResult> {
  const { rawMessage, keys, lookups = [], llm, timeoutMs } = params;
  const log = (params.log ?? logger).child({
    batchId: params.batchId,
    provider: llm.name,
    model: llm.model,
    stage: 'interpret',
  });

  if (keys.length === 0) return { tickets: [], unresolvedMentions: [] };

  const baseUserMessage = buildUserMessage(rawMessage, keys, lookups);
  let validationError: string | undefined;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const userMessage =
      attempt === 1 ? baseUserMessage : baseUserMessage + buildRetrySuffix(validationError ?? '');

    let data: unknown;
    try {
      const response = await llm.complete({
        systemPrompt: SYSTEM_PROMPT,
        userMessage,
        jsonSchema: INTERPRETATION_JSON_SCHEMA,
        timeoutMs,
      });
      data = response.data;
      log.info(
        {
          attempt,
          durationMs: response.meta.durationMs,
          costUsd: response.meta.costUsd,
          status: 'received',
        },
        'interpretation response received',
      );
    } catch (err) {
      // Timeouts and provider failures are terminal: there is nothing to correct.
      log.warn(
        {
          attempt,
          status: 'provider_error',
          err: err instanceof Error ? err.message : String(err),
        },
        'interpretation provider failed — falling back to unclear',
      );
      return allUnclear(keys, 'The interpretation service could not be reached.');
    }

    const parsed = InterpretationResultSchema.safeParse(data);
    if (parsed.success) {
      const reconciled = reconcile(parsed.data.tickets, keys);
      log.info(
        {
          attempt,
          status: 'ok',
          ticketCount: reconciled.length,
          intents: reconciled.map((t) => `${t.key}:${t.intent}`),
        },
        'interpretation complete',
      );
      return { tickets: reconciled, unresolvedMentions: parsed.data.unresolvedMentions };
    }

    validationError = summarizeZodError(parsed.error);
    log.warn(
      { attempt, status: 'schema_invalid', validationError },
      attempt === 1
        ? 'interpretation failed schema validation — retrying once'
        : 'interpretation failed schema validation twice — falling back to unclear',
    );
  }

  return allUnclear(keys, 'Claude did not return a valid interpretation.');
}

/**
 * Forces the result to cover exactly the detected keys: drops anything invented,
 * de-duplicates, and marks anything the model skipped as unclear.
 */
function reconcile(tickets: TicketInterpretation[], keys: string[]): TicketInterpretation[] {
  const allowed = new Set(keys);
  const byKey = new Map<string, TicketInterpretation>();

  for (const ticket of tickets) {
    if (!allowed.has(ticket.key)) continue; // never trust an invented key
    if (!byKey.has(ticket.key)) byKey.set(ticket.key, ticket);
  }

  // Preserve mention order so the card reads back the way the author spoke.
  return keys.map(
    (key) =>
      byKey.get(key) ?? {
        key,
        intent: 'unclear' as const,
        confidence: 0,
        evidence: '',
      },
  );
}

/** Safe fallback: recommend nothing rather than guess. */
function allUnclear(keys: string[], reason: string): InterpretationResult {
  return {
    tickets: keys.map((key) => ({
      key,
      intent: 'unclear' as const,
      confidence: 0,
      evidence: reason,
    })),
    unresolvedMentions: [],
  };
}

function summarizeZodError(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}
