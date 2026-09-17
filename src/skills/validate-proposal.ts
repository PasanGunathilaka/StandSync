import { z } from 'zod';
import type { Skill } from '../agents/types.js';
import type { RiskLevel } from '../types.js';
import type { IssueContextResult } from '../jira/context.js';
import { describeContextForPrompt } from '../jira/context.js';

/**
 * Skill: challenge a proposed Jira change against live Jira state.
 *
 * This is a second reasoning pass whose job is explicitly NOT to agree with the
 * first. The interpreter reads the sentence; this reads the sentence against the
 * workflow, and it is the stage that catches the cases where a plausible reading
 * produces a wrong Jira write:
 *
 * - "finished coding" on a workflow whose next step is Code Review, not Done
 * - a ticket already in the target status
 * - a transition that is not available from the current status
 * - a ticket assigned to somebody else
 * - a statement that justifies a comment but not a status change
 *
 * It grades and warns. It never writes, and its output can only ever *reduce*
 * what StandSync proposes — src/policy/decision-policy.ts will not promote an
 * action on the validator's say-so.
 */

export const RISK_LEVELS = ['low', 'medium', 'high'] as const satisfies readonly RiskLevel[];

/** One proposed change, described without transition ids. */
export interface ProposedChange {
  key: string;
  /** e.g. 'In Progress -> Done', or 'add comment', or 'no change'. */
  proposed: string;
  /** What the interpreter concluded, and why. */
  intent: string;
  evidence: string;
  confidence: number;
}

export interface ValidateProposalInput {
  text: string;
  authorName: string;
  changes: ProposedChange[];
  contexts: IssueContextResult[];
  today: string;
}

export interface ValidatedChange {
  key: string;
  /** False when this specific change is not justified by the message and Jira. */
  valid: boolean;
  risk: RiskLevel;
  /** Short cautions to show the approver. Empty when there is nothing to say. */
  warnings: string[];
  /** One factual sentence: why this is or is not the right change. */
  explanation: string;
}

export interface ValidateProposalOutput {
  /** False when any change in the batch is unjustified. */
  valid: boolean;
  risk: RiskLevel;
  changes: ValidatedChange[];
  explanation: string;
}

export const ValidatedChangeSchema: z.ZodType<ValidatedChange> = z.object({
  key: z.string().min(1),
  valid: z.boolean(),
  risk: z.enum(RISK_LEVELS),
  warnings: z.array(z.string().max(300)).max(5).default([]),
  explanation: z.string().max(500),
});

export const ValidateProposalOutputSchema: z.ZodType<ValidateProposalOutput> = z.object({
  valid: z.boolean(),
  risk: z.enum(RISK_LEVELS),
  changes: z.array(ValidatedChangeSchema),
  explanation: z.string().max(600),
});

const SYSTEM_PROMPT = `You review Jira changes that another model proposed from a team member's message. Your job is to find the cases where the proposal is wrong, not to confirm it. Assume the proposal may be mistaken and look for the reason.

For each proposed change, decide whether the author's own words plus the ticket's current Jira state actually justify it.

Mark a change invalid when:
- The ticket is already in the status the change would move it to.
- The proposed destination status is not in the ticket's list of available transitions.
- The author's words do not support a status change at all — they described progress, asked a question, or reported a plan rather than an outcome.
- The author described finishing *implementation* but the workflow's next step is a review stage (for example the available transitions include "Code Review", "In Review", "QA", "Testing"). Moving straight to Done skips the team's process. Prefer the review stage, and say so.
- The author's statement is about a different ticket than the one being changed.
- The ticket is assigned to someone other than the author and the message does not explain why the author is changing it. This is a warning, not automatically invalid — teams hand work over — but it must be surfaced.
- The ticket already has a resolution and the change would contradict it.

Risk grading, per change and for the batch overall:
- low: the change matches both the author's words and the workflow, with nothing surprising.
- medium: the change is defensible but something should be checked — another person's ticket, a terse message, a status jump that skips a stage, a plausible alternative destination.
- high: the change would very likely be wrong — contradicted by Jira state, unavailable, or unsupported by anything the author said.

warnings are short, factual, and written for the person about to click Approve. State what to check, not how you reasoned. Do not include a warning when there is nothing to warn about.

explanation is one factual sentence per change, and one for the batch. Reference the ticket's real status and the author's actual words. Do not use phrases like "as an AI" or "it appears that" or "I believe". Write like a colleague checking a pull request.

A change with nothing to do ("no change") is valid when the author genuinely reported no progress. Do not invent work for it.

Respond only with the structured output object. Do not use any tools.`;

export const validateProposalSkill: Skill<ValidateProposalInput, ValidateProposalOutput> = {
  name: 'validate-proposal',
  purpose: 'Challenge each proposed Jira change against live Jira state and the author’s words.',
  systemPrompt: SYSTEM_PROMPT,
  outputSchema: ValidateProposalOutputSchema,
  jsonSchema: {
    type: 'object',
    properties: {
      valid: {
        type: 'boolean',
        description: 'False if any proposed change is not justified.',
      },
      risk: { type: 'string', enum: [...RISK_LEVELS] },
      changes: {
        type: 'array',
        description: 'One entry per proposed change, in the order given.',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            valid: { type: 'boolean' },
            risk: { type: 'string', enum: [...RISK_LEVELS] },
            warnings: {
              type: 'array',
              items: { type: 'string' },
              description: 'Short cautions for the approver. Omit or leave empty when none.',
            },
            explanation: {
              type: 'string',
              description: 'One factual sentence on why this change is or is not right.',
            },
          },
          required: ['key', 'valid', 'risk', 'warnings', 'explanation'],
          additionalProperties: false,
        },
      },
      explanation: { type: 'string', description: 'One factual sentence about the batch.' },
    },
    required: ['valid', 'risk', 'changes', 'explanation'],
    additionalProperties: false,
  },
  buildUserMessage: (input) => {
    const lines = [
      `Today is ${input.today}.`,
      `Author of the message: ${input.authorName}`,
      '',
      'What the author wrote:',
      '"""',
      input.text,
      '"""',
      '',
      'Proposed changes to review:',
      ...input.changes.map(
        (c) =>
          `- ${c.key}: propose "${c.proposed}" (read as ${c.intent}, confidence ${c.confidence.toFixed(2)}, based on: "${c.evidence}")`,
      ),
      '',
      'Live Jira state for each ticket:',
      ...input.changes.map((c) =>
        describeContextForPrompt(
          c.key,
          input.contexts.find((ctx) => ctx.key === c.key),
        ),
      ),
    ];

    return lines.join('\n');
  },
};
