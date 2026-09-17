import { z } from 'zod';
import type { Skill } from '../agents/types.js';

/**
 * Skill: extract structured blocker information from a work update.
 *
 * Blocker detection is an *observational* path. Knowing that TES-42 is waiting
 * on API credentials is what makes a team summary worth reading, and it is
 * useful even when no Jira change is warranted. So this skill feeds persistence
 * and summaries; it never causes a Jira write on its own. If a blocker also
 * justifies a Jira action, that action comes from the normal interpret →
 * validate → approve path like any other.
 */

export const BLOCKER_CATEGORIES = [
  'access_or_credentials',
  'external_dependency',
  'another_team',
  'environment_or_infrastructure',
  'code_review_or_approval',
  'requirements_unclear',
  'other',
] as const;

export type BlockerCategory = (typeof BLOCKER_CATEGORIES)[number];

export const BLOCKER_SEVERITIES = ['low', 'medium', 'high'] as const;
export type BlockerSeverity = (typeof BLOCKER_SEVERITIES)[number];

export interface DetectBlockersInput {
  text: string;
  authorName: string;
  keys: string[];
  today: string;
}

export interface DetectedBlocker {
  /** The ticket this blocker is about. Must be one of the supplied keys. */
  key: string;
  blocked: boolean;
  category: BlockerCategory | null;
  /** What is blocking the work, in the author's own terms. */
  description: string | null;
  /** What or who the work is waiting on, when named. */
  dependency: string | null;
  severity: BlockerSeverity | null;
  /**
   * True when someone should act on this beyond recording it — a hard stop, a
   * cross-team dependency, or something that has clearly been waiting a while.
   */
  needsAttention: boolean;
}

export interface DetectBlockersOutput {
  blockers: DetectedBlocker[];
}

export const DetectedBlockerSchema: z.ZodType<DetectedBlocker> = z.object({
  key: z.string().min(1),
  blocked: z.boolean(),
  category: z.enum(BLOCKER_CATEGORIES).nullable().default(null),
  description: z.string().max(400).nullable().default(null),
  dependency: z.string().max(200).nullable().default(null),
  severity: z.enum(BLOCKER_SEVERITIES).nullable().default(null),
  needsAttention: z.boolean().default(false),
});

export const DetectBlockersOutputSchema: z.ZodType<DetectBlockersOutput> = z.object({
  blockers: z.array(DetectedBlockerSchema),
});

const SYSTEM_PROMPT = `You extract blocker information from a software team member's work update.

A ticket is blocked when the author cannot make progress without something outside their control. Signals include: "blocked", "waiting for", "waiting on", "depends on", "dependency", "cannot continue", "can't proceed", "stuck", "need access", "need credentials", "environment is down", "waiting for another team", "waiting for review".

Not a blocker:
- Work that is simply unfinished or not started. "Haven't got to TES-50 yet" is no progress, not a blocker.
- A choice the author is still making. "Deciding between two approaches" is work, not a blocker.
- Something already resolved. "Was blocked, got the credentials this morning" is not currently blocked.

Categories:
- access_or_credentials: needs an account, token, key, permission or environment access.
- external_dependency: waiting on a third party, vendor, or external service.
- another_team: waiting on a different team inside the company.
- environment_or_infrastructure: build, CI, test environment, deployment or tooling is broken or unavailable.
- code_review_or_approval: waiting on a review, sign-off or approval.
- requirements_unclear: cannot proceed until a product or design question is answered.
- other: genuinely blocked but none of the above.

severity:
- high: the author cannot do anything on this ticket at all, or it is holding up other work.
- medium: progress is stalled but there is a workaround or partial work available.
- low: a minor wait that will likely clear itself.

Set needsAttention: true only when someone other than the author has to do something — a cross-team dependency, missing access nobody has granted, or a hard stop. A blocker the author is already resolving themselves does not need attention.

description should be the blocking reason, phrased from the author's own words, without your commentary. dependency is the specific thing or person being waited on, when the author named one; otherwise null.

Report every ticket key you were given exactly once, with blocked: false and null fields where the ticket is not blocked. Never report a key you were not given.

Respond only with the structured output object. Do not use any tools.`;

export const detectBlockersSkill: Skill<DetectBlockersInput, DetectBlockersOutput> = {
  name: 'detect-blockers',
  purpose: 'Extract structured blocker information for persistence and team summaries.',
  systemPrompt: SYSTEM_PROMPT,
  outputSchema: DetectBlockersOutputSchema,
  jsonSchema: {
    type: 'object',
    properties: {
      blockers: {
        type: 'array',
        description: 'One entry per supplied key, in the order given.',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            blocked: { type: 'boolean' },
            category: { type: ['string', 'null'], enum: [...BLOCKER_CATEGORIES, null] },
            description: { type: ['string', 'null'] },
            dependency: { type: ['string', 'null'] },
            severity: { type: ['string', 'null'], enum: [...BLOCKER_SEVERITIES, null] },
            needsAttention: { type: 'boolean' },
          },
          required: [
            'key',
            'blocked',
            'category',
            'description',
            'dependency',
            'severity',
            'needsAttention',
          ],
          additionalProperties: false,
        },
      },
    },
    required: ['blockers'],
    additionalProperties: false,
  },
  buildUserMessage: (input) =>
    [
      `Today is ${input.today}.`,
      `Author: ${input.authorName}`,
      '',
      'Work update:',
      '"""',
      input.text,
      '"""',
      '',
      `Report on exactly these ${input.keys.length} ticket(s): ${input.keys.join(', ')}`,
    ].join('\n'),
};
