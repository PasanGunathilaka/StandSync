import { z } from 'zod';
import type { IssueLookup } from '../jira/issues.js';

/**
 * The prompt, the JSON schema Claude is constrained to, and the zod schema we
 * re-validate against. Claude reports *intent only* — it never sees transition
 * ids and never decides what to write to Jira.
 */

export const SYSTEM_PROMPT = `You interpret software team standup messages. For each Jira ticket key present, decide what the author is saying happened to it. You never decide what to change in Jira; you only report intent.

Intents:
- completed: work is finished and the author considers it done.
- in_progress: author is actively working on it now or starting it.
- blocked: author cannot proceed; capture the reason verbatim-ish in blockerReason.
- not_done_yet: author explicitly says it is NOT finished or should NOT be closed, even if mostly complete.
- no_change: mentioned but nothing actually changed.
- unclear: you cannot tell.

Rules:
- Only report keys that appear in the message. Never invent keys.
- "Mostly finished / almost done / don't close yet / QA found issues" => not_done_yet, never completed.
- "Waiting on X / need Y / can't proceed" => blocked, and keep the work in progress.
- A ticket can be both in_progress and blocked; report blocked (it implies still in progress) with a blockerReason.
- Quote the supporting phrase in evidence.
- Suggest commentText only when it adds information a teammate would want (blockers, partial progress, dependencies). Do not suggest comments like "Completed" for a completed ticket.
- Report every key you were given exactly once.
- Respond only with the structured output object. Do not use any tools.`;

export const INTENTS = [
  'completed',
  'in_progress',
  'blocked',
  'not_done_yet',
  'no_change',
  'unclear',
] as const;

/**
 * JSON Schema handed to the model (Claude Code `--json-schema`, or the Anthropic
 * SDK tool input_schema). Mirrors InterpretationResult exactly.
 */
export const INTERPRETATION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    tickets: {
      type: 'array',
      description: 'One entry per Jira key supplied in the message.',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The Jira key exactly as given, e.g. TES-41.' },
          intent: { type: 'string', enum: [...INTENTS] },
          blockerReason: {
            type: 'string',
            description: 'Why the author is blocked. Only when intent is blocked.',
          },
          commentText: {
            type: 'string',
            description: 'A comment worth adding for teammates, or omit entirely.',
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          evidence: {
            type: 'string',
            description: 'The phrase from the message supporting this reading.',
          },
        },
        required: ['key', 'intent', 'confidence', 'evidence'],
        additionalProperties: false,
      },
    },
    unresolvedMentions: {
      type: 'array',
      description: 'Work described with no Jira key attached.',
      items: { type: 'string' },
    },
  },
  required: ['tickets', 'unresolvedMentions'],
  additionalProperties: false,
};

/** Re-validation of whatever the provider returns. Belt and braces. */
export const TicketInterpretationSchema = z.object({
  key: z.string().min(1),
  intent: z.enum(INTENTS),
  blockerReason: z.string().optional(),
  commentText: z.string().optional(),
  confidence: z.number().min(0).max(1),
  evidence: z.string(),
});

export const InterpretationResultSchema = z.object({
  tickets: z.array(TicketInterpretationSchema),
  unresolvedMentions: z.array(z.string()).default([]),
});

export const TOOL_NAME = 'report_interpretation';

/**
 * Builds the user turn: the raw standup, the keys we detected, and each ticket's
 * real Jira status/summary so Claude can disambiguate (e.g. "finished" against a
 * ticket that is already Done). Transition ids are deliberately absent.
 */
export function buildUserMessage(
  rawMessage: string,
  keys: string[],
  lookups: IssueLookup[] = [],
): string {
  const byKey = new Map(lookups.map((l) => [l.key, l]));

  const context = keys.map((key) => {
    const lookup = byKey.get(key);
    if (!lookup) return `- ${key}: current Jira state unknown`;
    if (!lookup.found) return `- ${key}: NOT FOUND in Jira (${lookup.reason})`;
    return `- ${key}: currently "${lookup.state.status}" — ${lookup.state.summary}`;
  });

  return [
    'Standup message:',
    '"""',
    rawMessage,
    '"""',
    '',
    `Jira keys detected in this message (report on exactly these ${keys.length}): ${keys.join(', ')}`,
    '',
    'Current Jira state for context:',
    ...context,
  ].join('\n');
}

/** Appended on the one retry after a schema failure, so the model sees its mistake. */
export function buildRetrySuffix(validationError: string): string {
  return [
    '',
    'Your previous response did not match the required schema.',
    `Validation error: ${validationError}`,
    'Return a corrected object matching the schema exactly.',
  ].join('\n');
}
