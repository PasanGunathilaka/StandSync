import { runAgent } from './runAgent.js';
import {
  interpretWorkSkill,
  type InterpretWorkInput,
  type TicketIntent,
} from '../skills/interpret-work.js';
import type { AgentDeps } from './types.js';

/**
 * Agent 2 — standup interpreter.
 *
 * The V2 evolution of src/standup/interpret.ts. It keeps that file's reliability
 * contract, which existed for good reasons and still does:
 *
 * - the result always covers exactly the keys StandSync detected
 * - keys the model invented are dropped
 * - keys the model skipped become `unclear`, never a guess
 * - a duplicated key is de-duplicated, first mention winning
 * - a provider or schema failure yields `unclear` for everything, so a broken
 *   model produces no proposals rather than wrong ones
 *
 * What is new: the interpreter now receives bounded thread context and richer
 * Jira context, and surfaces the `uncertain` and `unblocked` signals that the
 * ambiguity and blocker stages act on.
 */

export interface InterpretationV2 {
  tickets: TicketIntent[];
  unresolvedMentions: string[];
  /** True when the model could not be used and everything fell back to unclear. */
  degraded: boolean;
}

export async function interpretWork(
  input: InterpretWorkInput,
  deps: AgentDeps,
): Promise<InterpretationV2> {
  if (input.keys.length === 0) {
    return { tickets: [], unresolvedMentions: [], degraded: false };
  }

  const result = await runAgent(interpretWorkSkill, input, deps);

  if (!result.ok) {
    deps.log.warn('interpretation_complete', {
      agent: interpretWorkSkill.name,
      outcome: result.kind,
      durationMs: result.meta.durationMs,
    });
    return {
      tickets: allUnclear(input.keys, reasonFor(result.kind)),
      unresolvedMentions: [],
      degraded: true,
    };
  }

  const tickets = reconcile(result.value.tickets, input.keys);

  deps.log.stage('interpretation_complete', {
    agent: interpretWorkSkill.name,
    ticketCount: tickets.length,
    intents: tickets.map((t) => `${t.key}:${t.intent}${t.uncertain ? '?' : ''}`),
    durationMs: result.meta.durationMs,
  });

  return { tickets, unresolvedMentions: result.value.unresolvedMentions, degraded: false };
}

/**
 * Forces the result to cover exactly the detected keys, in mention order.
 *
 * Mention order matters for the card: the author reads their own update back in
 * the order they wrote it.
 */
export function reconcile(tickets: TicketIntent[], keys: string[]): TicketIntent[] {
  const allowed = new Set(keys);
  const byKey = new Map<string, TicketIntent>();

  for (const ticket of tickets) {
    if (!allowed.has(ticket.key)) continue; // never trust an invented key
    if (!byKey.has(ticket.key)) byKey.set(ticket.key, ticket);
  }

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
export function allUnclear(keys: string[], reason: string): TicketIntent[] {
  return keys.map((key) => ({
    key,
    intent: 'unclear' as const,
    confidence: 0,
    evidence: reason,
  }));
}

function reasonFor(kind: 'schema_invalid' | 'provider_error' | 'timeout'): string {
  switch (kind) {
    case 'timeout':
      return 'Interpretation timed out.';
    case 'provider_error':
      return 'The interpretation service could not be reached.';
    case 'schema_invalid':
      return 'Claude did not return a valid interpretation.';
  }
}
