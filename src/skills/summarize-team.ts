import { z } from 'zod';
import type { Skill } from '../agents/types.js';

/**
 * Skill: turn StandSync's own recorded observations into a team standup summary.
 *
 * The hard requirement is that a summary must be *grounded*. It is built from
 * what StandSync actually interpreted and what Jira actually says — never from
 * the model's impression of what a project like this probably contains. So the
 * input is a closed list of issues with real statuses, and the prompt forbids
 * introducing any ticket that is not in it.
 *
 * The summary is read-only by construction: there is no path from this skill to
 * a Jira write, and the service that calls it is handed no Jira actions client.
 */

export interface SummaryIssue {
  key: string;
  summary: string;
  /** Live Jira status, or 'unknown' when the issue could not be read. */
  status: string;
  /** What StandSync recorded happening to it, most recent last. */
  observations: string[];
  /** Open blocker on this issue, if any. */
  blocker?: {
    description: string;
    dependency?: string;
    severity?: string;
    timesReported: number;
    firstSeenAt: string;
  };
}

export interface SummarizeTeamInput {
  /** e.g. 'the last 24 hours'. */
  period: string;
  today: string;
  issues: SummaryIssue[];
  /** Names of people whose updates are included. */
  contributors: string[];
}

export interface SummaryLine {
  key: string;
  /** One short phrase: what this ticket is and where it stands. */
  text: string;
}

export interface SummarizeTeamOutput {
  completed: SummaryLine[];
  inProgress: SummaryLine[];
  blocked: SummaryLine[];
  /** Things a lead should look at — repeated blockers, stalled work. */
  attention: string[];
}

const SummaryLineSchema: z.ZodType<SummaryLine> = z.object({
  key: z.string().min(1),
  text: z.string().max(200),
});

export const SummarizeTeamOutputSchema: z.ZodType<SummarizeTeamOutput> = z.object({
  completed: z.array(SummaryLineSchema).default([]),
  inProgress: z.array(SummaryLineSchema).default([]),
  blocked: z.array(SummaryLineSchema).default([]),
  attention: z.array(z.string().max(300)).max(6).default([]),
});

const SYSTEM_PROMPT = `You write a short daily standup summary for a software team, from records a bot kept of what the team said and what Jira says.

You are given a closed list of tickets. Every ticket you mention must come from that list, using the key exactly as given. Never introduce a ticket, person, project, deadline, sprint or fact that is not in the input. If the input is thin, write a thin summary — that is the correct output, not a failure.

Sort each ticket into exactly one group, based on its current Jira status and what was observed:
- completed: the work is finished or the ticket has reached a done status.
- inProgress: work is active and not blocked.
- blocked: there is an open blocker on it, even if work is technically in progress.

A ticket with an open blocker belongs in blocked, not inProgress.

For each ticket, text is one short phrase describing the work — usually a compressed form of the ticket summary, plus its state if that is not obvious from the group. Do not repeat the key in text; it is shown separately. Do not add commentary.

attention is for a team lead. Include an item only when the records support it:
- A blocker reported across several updates and still open — say how many times and since when.
- Work that has been in progress across the whole period with no movement.
- A ticket whose Jira status contradicts what was said about it.
Keep each item to one sentence. If nothing warrants attention, return an empty list — do not manufacture concerns.

Write plainly. No preamble, no "here is your summary", no encouragement, no emoji.

Respond only with the structured output object. Do not use any tools.`;

export const summarizeTeamSkill: Skill<SummarizeTeamInput, SummarizeTeamOutput> = {
  name: 'summarize-team',
  purpose: 'Group recorded standup observations into a grounded team summary.',
  systemPrompt: SYSTEM_PROMPT,
  outputSchema: SummarizeTeamOutputSchema,
  jsonSchema: {
    type: 'object',
    properties: {
      completed: { $ref: '#/$defs/lines' },
      inProgress: { $ref: '#/$defs/lines' },
      blocked: { $ref: '#/$defs/lines' },
      attention: {
        type: 'array',
        description: 'One sentence per item a lead should look at. Empty when none.',
        items: { type: 'string' },
      },
    },
    required: ['completed', 'inProgress', 'blocked', 'attention'],
    additionalProperties: false,
    $defs: {
      lines: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'A key from the supplied list, exactly.' },
            text: { type: 'string', description: 'Short phrase describing the work.' },
          },
          required: ['key', 'text'],
          additionalProperties: false,
        },
      },
    },
  },
  buildUserMessage: (input) => {
    const lines = [
      `Today is ${input.today}.`,
      `Period covered: ${input.period}.`,
      input.contributors.length
        ? `Updates came from: ${input.contributors.join(', ')}.`
        : 'No named contributors in this period.',
      '',
      `Tickets to summarize (${input.issues.length}). Use only these keys:`,
    ];

    for (const issue of input.issues) {
      lines.push(`- ${issue.key} — "${issue.summary}" — Jira status: ${issue.status}`);
      for (const observation of issue.observations) {
        lines.push(`    observed: ${observation}`);
      }
      if (issue.blocker) {
        const parts = [`blocker: ${issue.blocker.description}`];
        if (issue.blocker.dependency) parts.push(`waiting on ${issue.blocker.dependency}`);
        if (issue.blocker.severity) parts.push(`severity ${issue.blocker.severity}`);
        parts.push(
          `reported ${issue.blocker.timesReported} time(s) since ${issue.blocker.firstSeenAt.slice(0, 10)}`,
        );
        lines.push(`    ${parts.join('; ')}`);
      }
    }

    if (input.issues.length === 0) {
      lines.push('(none — return empty groups)');
    }

    return lines.join('\n');
  },
};
