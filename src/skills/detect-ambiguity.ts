import { z } from 'zod';
import type { Skill } from '../agents/types.js';
import type { Intent } from '../types.js';
import type { IssueContextResult } from '../jira/context.js';
import { describeContextForPrompt } from '../jira/context.js';
import { INTENTS } from './interpret-work.js';

/**
 * Skill: decide whether to ask the developer instead of guessing.
 *
 * "TES-31 is basically finished" has at least three reasonable readings: move it
 * to Code Review, move it to Done, or leave it alone. Picking one and presenting
 * it as a confident proposal is worse than asking, because the approver has no
 * way to know a choice was made on their behalf.
 *
 * This skill produces the question and the options. It never produces an
 * executable action, and an answer re-enters the normal pipeline rather than
 * short-circuiting to Jira.
 */

export interface AmbiguityCandidate {
  key: string;
  intent: Intent;
  evidence: string;
  confidence: number;
  /** Set by the interpreter when the author hedged. */
  uncertain: boolean;
  /** What StandSync would propose if it did not ask. */
  proposed: string;
}

export interface DetectAmbiguityInput {
  text: string;
  authorName: string;
  candidates: AmbiguityCandidate[];
  contexts: IssueContextResult[];
}

/** One offered answer. `intent` is what the answer resolves to. */
export interface ClarificationChoice {
  label: string;
  intent: Intent;
}

export interface AmbiguousTicket {
  key: string;
  ambiguous: boolean;
  /** The question to put to the author. One sentence, specific to the ticket. */
  question: string;
  /** Two to four options. Always includes a "leave it alone" style choice. */
  options: ClarificationChoice[];
  reason: string;
}

export interface DetectAmbiguityOutput {
  tickets: AmbiguousTicket[];
}

export const ClarificationChoiceSchema: z.ZodType<ClarificationChoice> = z.object({
  label: z.string().min(1).max(60),
  intent: z.enum(INTENTS),
});

export const AmbiguousTicketSchema: z.ZodType<AmbiguousTicket> = z.object({
  key: z.string().min(1),
  ambiguous: z.boolean(),
  question: z.string().max(300).default(''),
  options: z.array(ClarificationChoiceSchema).max(4).default([]),
  reason: z.string().max(400).default(''),
});

export const DetectAmbiguityOutputSchema: z.ZodType<DetectAmbiguityOutput> = z.object({
  tickets: z.array(AmbiguousTicketSchema),
});

const SYSTEM_PROMPT = `You decide whether a team member's statement about a Jira ticket is clear enough to act on, or whether StandSync should ask them a short question first.

Mark a ticket ambiguous when the statement has more than one reasonable Jira outcome. Typical cases:
- Hedged completion: "basically finished", "almost done", "pretty much there", "should be done", "I think it's complete".
- Completion of part of the work: "code is done", "implementation finished", "just needs review" — finished coding is not the same as finished.
- Work named without a ticket key where several tickets could match: "the payment work is complete", "the API ticket is sorted".
- A statement that could be either a status change or just a progress note.
- The author's words and the ticket's current Jira status point in different directions.

Do NOT mark a ticket ambiguous when the statement is plain: "Finished TES-31", "Started TES-50", "TES-42 is blocked waiting for credentials". Asking a needless question is its own failure — it puts work back on the developer for nothing.

When ambiguous:
- question: one short sentence, addressed to the author, naming what is unclear. Quote their own words. Do not explain your reasoning.
- options: two to four choices. Each label is what the developer would click, phrased as an outcome ("Move to Code Review", "Move to Done", "Keep In Progress"). Derive the status names from the ticket's available transitions — never offer a status the workflow cannot reach. Always include an option that changes nothing, so declining is one click.
- Map each option to the intent it represents:
  - completed: the work is finished and the ticket should close.
  - in_progress: work is active; move or keep it in progress.
  - blocked: the author cannot proceed.
  - not_done_yet: explicitly not finished; do not close it.
  - no_change: leave the ticket as it is.
  - unclear: only if no other intent fits.
- reason: one short sentence on what made this ambiguous.

When not ambiguous, set ambiguous: false and leave question, options and reason empty.

Report every ticket you were given exactly once.

Respond only with the structured output object. Do not use any tools.`;

export const detectAmbiguitySkill: Skill<DetectAmbiguityInput, DetectAmbiguityOutput> = {
  name: 'detect-ambiguity',
  purpose: 'Decide whether to ask the developer a clarifying question instead of guessing.',
  systemPrompt: SYSTEM_PROMPT,
  outputSchema: DetectAmbiguityOutputSchema,
  jsonSchema: {
    type: 'object',
    properties: {
      tickets: {
        type: 'array',
        description: 'One entry per ticket supplied, in the order given.',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            ambiguous: { type: 'boolean' },
            question: {
              type: 'string',
              description: 'One sentence for the author. Empty when not ambiguous.',
            },
            options: {
              type: 'array',
              description: 'Two to four choices. Empty when not ambiguous.',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'Outcome-phrased button label.' },
                  intent: { type: 'string', enum: [...INTENTS] },
                },
                required: ['label', 'intent'],
                additionalProperties: false,
              },
            },
            reason: { type: 'string', description: 'Why this was ambiguous. Empty when not.' },
          },
          required: ['key', 'ambiguous', 'question', 'options', 'reason'],
          additionalProperties: false,
        },
      },
    },
    required: ['tickets'],
    additionalProperties: false,
  },
  buildUserMessage: (input) => {
    const lines = [
      `Author: ${input.authorName}`,
      '',
      'What the author wrote:',
      '"""',
      input.text,
      '"""',
      '',
      'Tickets to judge, with what StandSync would otherwise propose:',
      ...input.candidates.map(
        (c) =>
          `- ${c.key}: read as ${c.intent}${c.uncertain ? ' (author hedged)' : ''}, ` +
          `confidence ${c.confidence.toFixed(2)}, would propose "${c.proposed}", ` +
          `based on: "${c.evidence}"`,
      ),
      '',
      'Live Jira state, including which statuses each ticket can actually reach:',
      ...input.candidates.map((c) =>
        describeContextForPrompt(
          c.key,
          input.contexts.find((ctx) => ctx.key === c.key),
        ),
      ),
    ];

    return lines.join('\n');
  },
};
