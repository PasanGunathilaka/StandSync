import { z } from 'zod';
import type { Skill } from '../agents/types.js';
import type { MessageKind } from '../types.js';

/**
 * Skill: decide whether an ambient Teams message belongs in the StandSync
 * pipeline at all.
 *
 * This is the gate that makes ambient listening tolerable. StandSync sees every
 * message in an observed channel, and the overwhelming majority are none of its
 * business. Receiving a message and reacting to one are different things, and
 * this skill is where that distinction is decided.
 *
 * It classifies only. It never interprets work, never names a Jira action and
 * never produces anything a human has to dismiss.
 */

export const MESSAGE_KINDS = [
  'standup_update',
  'work_update',
  'blocker',
  'jira_reference',
  'clarification_reply',
  'unrelated',
] as const satisfies readonly MessageKind[];

export interface ClassifyInput {
  /** Cleaned message text — mentions and HTML already stripped. */
  text: string;
  authorName: string;
  /** Channel or conversation label, for context only. */
  conversation: string;
  /** Jira keys StandSync detected deterministically, if any. */
  detectedKeys: string[];
  /** Today's date, so "yesterday"/"tomorrow" are interpretable. */
  today: string;
  /** Bounded recent thread context, oldest first. May be empty. */
  context: { authorName: string; text: string }[];
}

export interface ClassifyOutput {
  relevant: boolean;
  type: MessageKind;
  confidence: number;
  reason: string;
}

export const ClassifyOutputSchema: z.ZodType<ClassifyOutput> = z.object({
  relevant: z.boolean(),
  type: z.enum(MESSAGE_KINDS),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(400),
});

const SYSTEM_PROMPT = `You are the relevance gate for StandSync, a bot that keeps Jira in step with a software team's standup conversation in Microsoft Teams.

You see every message in the channel. Your only job is to decide whether a message is about the team's work in a way StandSync should act on. You never decide what to change in Jira.

Classify the message as exactly one type:
- standup_update: a report of what the author did, is doing, or will do. Usually covers one or more tickets.
- work_update: a statement about progress on a specific piece of work, outside a formal standup.
- blocker: the author cannot proceed, is waiting on something, or reports a dependency.
- jira_reference: mentions a ticket but reports no progress (a question about it, a link, an FYI).
- clarification_reply: answers or refines an earlier statement about work, e.g. "code is done, just needs review".
- unrelated: everything else.

Set relevant: true only for standup_update, work_update, blocker, and clarification_reply. jira_reference and unrelated are relevant: false — mentioning a ticket is not the same as reporting progress on it.

Not relevant (be strict, these are the common case):
- greetings and pleasantries: "good morning", "morning all", "hi team"
- acknowledgements: "thanks", "ok", "sounds good", "👍", "noted"
- social conversation: lunch, weather, weekend plans, jokes
- emoji-only or reaction-only messages
- meeting logistics: "standup in 5", "joining late", "can you unmute"
- questions that ask for information rather than report work: "did anyone look at TES-31?"
- general technical discussion with no statement of personal progress

Relevant:
- "Finished TES-31." — standup_update
- "TES-42 is blocked waiting for API credentials." — blocker
- "Started working on the payment ticket." — work_update, even with no ticket key
- "Code is done, it just needs review." — clarification_reply
- "Yesterday I closed TES-12 and TES-14, today I'm on TES-20." — standup_update

confidence is how sure you are of the classification, 0 to 1. Use a value below 0.6 when the message could reasonably be read either way — for example work described so vaguely you cannot tell whether it is progress or chat.

reason must be one short sentence explaining the decision, referring to what the message actually says.

Respond only with the structured output object. Do not use any tools.`;

export const detectStandupSkill: Skill<ClassifyInput, ClassifyOutput> = {
  name: 'detect-standup',
  purpose: 'Decide whether an ambient channel message should enter the StandSync pipeline.',
  systemPrompt: SYSTEM_PROMPT,
  outputSchema: ClassifyOutputSchema,
  jsonSchema: {
    type: 'object',
    properties: {
      relevant: {
        type: 'boolean',
        description: 'True only if StandSync should process this message.',
      },
      type: { type: 'string', enum: [...MESSAGE_KINDS] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reason: { type: 'string', description: 'One short sentence justifying the decision.' },
    },
    required: ['relevant', 'type', 'confidence', 'reason'],
    additionalProperties: false,
  },
  buildUserMessage: (input) => {
    const lines = [
      `Today is ${input.today}.`,
      `Channel: ${input.conversation}`,
      `Author: ${input.authorName}`,
      '',
      'Message to classify:',
      '"""',
      input.text,
      '"""',
    ];

    if (input.detectedKeys.length) {
      lines.push('', `Jira keys present in the text: ${input.detectedKeys.join(', ')}`);
    } else {
      lines.push('', 'No Jira ticket keys were found in the text.');
    }

    if (input.context.length) {
      lines.push(
        '',
        'Recent messages in this thread, for context only (do not classify these):',
        ...input.context.map((m) => `- ${m.authorName}: ${m.text}`),
      );
    }

    return lines.join('\n');
  },
};
