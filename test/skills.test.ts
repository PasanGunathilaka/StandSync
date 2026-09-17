import { describe, it, expect } from 'vitest';
import { detectStandupSkill, ClassifyOutputSchema } from '../src/skills/detect-standup.js';
import { interpretWorkSkill, InterpretWorkOutputSchema } from '../src/skills/interpret-work.js';
import {
  validateProposalSkill,
  ValidateProposalOutputSchema,
} from '../src/skills/validate-proposal.js';
import {
  detectAmbiguitySkill,
  DetectAmbiguityOutputSchema,
} from '../src/skills/detect-ambiguity.js';
import { detectBlockersSkill, DetectBlockersOutputSchema } from '../src/skills/detect-blockers.js';
import { summarizeTeamSkill, SummarizeTeamOutputSchema } from '../src/skills/summarize-team.js';
import {
  confidenceWord,
  describeChange,
  explainProposal,
  isGeneric,
  summarizeProposal,
} from '../src/skills/explain-proposal.js';
import { INTENTS } from '../src/skills/interpret-work.js';
import type { Skill } from '../src/agents/types.js';
import type { IssueContext } from '../src/jira/context.js';

/**
 * Skills are prompt + schema + typed IO. These tests assert the contract each
 * one publishes — that its schemas agree with each other, that its prompt
 * carries the rules the rest of the system depends on, and that its rendered
 * user turn contains what it claims to.
 */

const ALL_SKILLS: Skill<never, unknown>[] = [
  detectStandupSkill,
  interpretWorkSkill,
  validateProposalSkill,
  detectAmbiguitySkill,
  detectBlockersSkill,
  summarizeTeamSkill,
];

const present = (over: Partial<IssueContext> = {}): IssueContext => ({
  key: 'TES-31',
  exists: true,
  summary: 'Payment validation',
  status: 'In Progress',
  issueType: 'Task',
  assignee: 'Pasan',
  availableTransitions: ['Code Review', 'Done'],
  ...over,
});

describe('every skill publishes a complete contract', () => {
  it('has a unique name matching its file convention', () => {
    const names = ALL_SKILLS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });

  it('has a purpose, a prompt, a JSON schema and a zod schema', () => {
    for (const skill of ALL_SKILLS) {
      expect(skill.purpose.length, skill.name).toBeGreaterThan(20);
      expect(skill.systemPrompt.length, skill.name).toBeGreaterThan(200);
      expect(skill.jsonSchema['type'], skill.name).toBe('object');
      expect(skill.outputSchema, skill.name).toBeDefined();
    }
  });

  it('declares additionalProperties: false, so the model cannot pad the output', () => {
    for (const skill of ALL_SKILLS) {
      expect(skill.jsonSchema['additionalProperties'], skill.name).toBe(false);
    }
  });

  it('declares every top-level property as required', () => {
    for (const skill of ALL_SKILLS) {
      const properties = Object.keys(skill.jsonSchema['properties'] as object);
      const required = skill.jsonSchema['required'] as string[];
      expect(required.sort(), skill.name).toEqual(properties.sort());
    }
  });

  it('forbids tool use', () => {
    for (const skill of ALL_SKILLS) {
      expect(skill.systemPrompt, skill.name).toContain('Do not use any tools');
    }
  });

  it('asks only for the structured output object', () => {
    for (const skill of ALL_SKILLS) {
      expect(skill.systemPrompt, skill.name).toContain('structured output object');
    }
  });
});

describe('detect-standup', () => {
  it('validates a well-formed classification', () => {
    const parsed = ClassifyOutputSchema.safeParse({
      relevant: true,
      type: 'standup_update',
      confidence: 0.9,
      reason: 'Reports finishing a ticket.',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown type', () => {
    expect(
      ClassifyOutputSchema.safeParse({
        relevant: true,
        type: 'gossip',
        confidence: 0.9,
        reason: 'x',
      }).success,
    ).toBe(false);
  });

  it('rejects a confidence outside 0..1', () => {
    for (const confidence of [-0.1, 1.5, 42]) {
      expect(
        ClassifyOutputSchema.safeParse({
          relevant: true,
          type: 'work_update',
          confidence,
          reason: 'x',
        }).success,
      ).toBe(false);
    }
  });

  it('names the irrelevant categories the policy relies on', () => {
    // decideRelevance treats these two as never relevant, so the prompt must
    // agree rather than leave it to the boolean.
    expect(detectStandupSkill.systemPrompt).toContain('jira_reference and unrelated');
  });

  it('instructs strictness on greetings, thanks and emoji', () => {
    for (const phrase of ['good morning', 'thanks', 'emoji-only', 'lunch']) {
      expect(detectStandupSkill.systemPrompt).toContain(phrase);
    }
  });

  it('renders the message, the author and the date', () => {
    const rendered = detectStandupSkill.buildUserMessage({
      text: 'Finished TES-31',
      authorName: 'Pasan',
      conversation: 'Standups',
      detectedKeys: ['TES-31'],
      today: '2026-09-17',
      context: [],
    });

    expect(rendered).toContain('Finished TES-31');
    expect(rendered).toContain('Pasan');
    expect(rendered).toContain('2026-09-17');
    expect(rendered).toContain('TES-31');
  });

  it('says so explicitly when no keys were found', () => {
    const rendered = detectStandupSkill.buildUserMessage({
      text: 'Started the payment work',
      authorName: 'Pasan',
      conversation: 'Standups',
      detectedKeys: [],
      today: '2026-09-17',
      context: [],
    });
    expect(rendered).toContain('No Jira ticket keys were found');
  });

  it('marks thread context as context only', () => {
    const rendered = detectStandupSkill.buildUserMessage({
      text: 'Code is done',
      authorName: 'Pasan',
      conversation: 'Standups',
      detectedKeys: [],
      today: '2026-09-17',
      context: [{ authorName: 'Chandima', text: 'Code finished or fully complete?' }],
    });
    expect(rendered).toContain('context only (do not classify these)');
    expect(rendered).toContain('Chandima: Code finished or fully complete?');
  });
});

describe('interpret-work', () => {
  it('keeps the V1 intent vocabulary unchanged', () => {
    // src/jira/statusMap.ts maps exactly these six onto transitions.
    expect([...INTENTS]).toEqual([
      'completed',
      'in_progress',
      'blocked',
      'not_done_yet',
      'no_change',
      'unclear',
    ]);
  });

  it('validates a multi-ticket interpretation', () => {
    const parsed = InterpretWorkOutputSchema.safeParse({
      tickets: [
        { key: 'TES-31', intent: 'completed', confidence: 0.95, evidence: 'Finished TES-31' },
        {
          key: 'TES-42',
          intent: 'blocked',
          confidence: 0.9,
          evidence: 'blocked on credentials',
          blockerReason: 'waiting for credentials',
        },
      ],
      unresolvedMentions: [],
    });
    expect(parsed.success).toBe(true);
  });

  it('defaults unresolvedMentions when the model omits it', () => {
    const parsed = InterpretWorkOutputSchema.safeParse({
      tickets: [{ key: 'TES-31', intent: 'completed', confidence: 0.9, evidence: 'done' }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.unresolvedMentions).toEqual([]);
  });

  it('rejects a missing evidence field', () => {
    expect(
      InterpretWorkOutputSchema.safeParse({
        tickets: [{ key: 'TES-31', intent: 'completed', confidence: 0.9 }],
        unresolvedMentions: [],
      }).success,
    ).toBe(false);
  });

  it('accepts the optional uncertain and unblocked signals', () => {
    const parsed = InterpretWorkOutputSchema.safeParse({
      tickets: [
        {
          key: 'TES-31',
          intent: 'completed',
          confidence: 0.6,
          evidence: 'basically done',
          uncertain: true,
          unblocked: false,
        },
      ],
      unresolvedMentions: [],
    });
    expect(parsed.success).toBe(true);
  });

  it('carries the V1 rules that keep a hedge out of Done', () => {
    for (const rule of [
      'Mostly finished / almost done',
      'not_done_yet, never completed',
      'Never invent a key',
      'Report every key you were given exactly once',
    ]) {
      expect(interpretWorkSkill.systemPrompt).toContain(rule);
    }
  });

  it('instructs per-clause reading for multi-ticket messages', () => {
    expect(interpretWorkSkill.systemPrompt).toContain('Read each clause separately');
    expect(interpretWorkSkill.systemPrompt).toContain('three different intents');
  });

  it('describes the uncertain and unblocked signals', () => {
    expect(interpretWorkSkill.systemPrompt).toContain('uncertain: true');
    expect(interpretWorkSkill.systemPrompt).toContain('unblocked: true');
  });

  it('renders the live Jira state, including reachable statuses', () => {
    const rendered = interpretWorkSkill.buildUserMessage({
      text: 'Finished TES-31',
      authorName: 'Pasan',
      keys: ['TES-31'],
      contexts: [present()],
      context: [],
      today: '2026-09-17',
    });

    expect(rendered).toContain('currently "In Progress"');
    expect(rendered).toContain('can move to: Code Review, Done');
    expect(rendered).toContain('assigned to Pasan');
    expect(rendered).toContain('report on exactly these 1');
  });

  it('renders a missing ticket as NOT FOUND rather than inventing state', () => {
    const rendered = interpretWorkSkill.buildUserMessage({
      text: 'Finished TES-99',
      authorName: 'Pasan',
      keys: ['TES-99'],
      contexts: [{ key: 'TES-99', exists: false, reason: 'not found' }],
      context: [],
      today: '2026-09-17',
    });
    expect(rendered).toContain('TES-99: NOT FOUND in Jira (not found)');
  });

  it('reports state unknown when no context was gathered at all', () => {
    const rendered = interpretWorkSkill.buildUserMessage({
      text: 'Finished TES-31',
      authorName: 'Pasan',
      keys: ['TES-31'],
      contexts: [],
      context: [],
      today: '2026-09-17',
    });
    expect(rendered).toContain('current Jira state unknown');
  });
});

describe('validate-proposal', () => {
  it('validates a per-change verdict set', () => {
    const parsed = ValidateProposalOutputSchema.safeParse({
      valid: false,
      risk: 'high',
      changes: [
        {
          key: 'TES-31',
          valid: false,
          risk: 'high',
          warnings: ['Workflow has a Code Review stage before Done.'],
          explanation: 'Pasan said the implementation is finished, not that it was reviewed.',
        },
      ],
      explanation: 'Moving straight to Done skips Code Review.',
    });
    expect(parsed.success).toBe(true);
  });

  it('defaults warnings to an empty list', () => {
    const parsed = ValidateProposalOutputSchema.safeParse({
      valid: true,
      risk: 'low',
      changes: [{ key: 'TES-31', valid: true, risk: 'low', explanation: 'fine' }],
      explanation: '',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.changes[0]?.warnings).toEqual([]);
  });

  it('rejects an unknown risk level', () => {
    expect(
      ValidateProposalOutputSchema.safeParse({
        valid: true,
        risk: 'catastrophic',
        changes: [],
        explanation: '',
      }).success,
    ).toBe(false);
  });

  it('tells the model to look for the reason a proposal is wrong', () => {
    expect(validateProposalSkill.systemPrompt).toContain('not to confirm it');
    expect(validateProposalSkill.systemPrompt).toContain('Assume the proposal may be mistaken');
  });

  it('names the Code Review case explicitly', () => {
    expect(validateProposalSkill.systemPrompt).toContain('Code Review');
    expect(validateProposalSkill.systemPrompt).toContain('skips the team');
  });

  it('names the other required checks', () => {
    for (const check of [
      'already in the status',
      'not in the ticket',
      'assigned to someone other than the author',
      'already has a resolution',
    ]) {
      expect(validateProposalSkill.systemPrompt).toContain(check);
    }
  });

  it('bans generic AI phrasing in explanations', () => {
    expect(validateProposalSkill.systemPrompt).toContain('as an AI');
    expect(validateProposalSkill.systemPrompt).toContain('it appears that');
  });

  it('renders the proposed change and the live state, without transition ids', () => {
    const rendered = validateProposalSkill.buildUserMessage({
      text: 'Finished coding TES-31.',
      authorName: 'Pasan',
      today: '2026-09-17',
      contexts: [present()],
      changes: [
        {
          key: 'TES-31',
          proposed: 'In Progress → Done',
          intent: 'completed',
          evidence: 'Finished coding',
          confidence: 0.9,
        },
      ],
    });

    expect(rendered).toContain('propose "In Progress → Done"');
    expect(rendered).toContain('read as completed');
    expect(rendered).toContain('can move to: Code Review, Done');
    expect(rendered).not.toContain('transitionId');
  });
});

describe('detect-ambiguity', () => {
  it('validates a question with options', () => {
    const parsed = DetectAmbiguityOutputSchema.safeParse({
      tickets: [
        {
          key: 'TES-31',
          ambiguous: true,
          question: 'Is it ready for review, or fully done?',
          options: [
            { label: 'Move to Code Review', intent: 'in_progress' },
            { label: 'Move to Done', intent: 'completed' },
          ],
          reason: 'Hedged completion.',
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('caps the option count at four', () => {
    const parsed = DetectAmbiguityOutputSchema.safeParse({
      tickets: [
        {
          key: 'TES-31',
          ambiguous: true,
          question: 'q',
          options: Array.from({ length: 5 }, (_, i) => ({
            label: `Option ${i}`,
            intent: 'completed',
          })),
          reason: 'r',
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an option whose intent is outside the vocabulary', () => {
    expect(
      DetectAmbiguityOutputSchema.safeParse({
        tickets: [
          {
            key: 'TES-31',
            ambiguous: true,
            question: 'q',
            options: [{ label: 'Move to Staging', intent: 'deployed' }],
            reason: 'r',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('warns against asking a needless question', () => {
    expect(detectAmbiguitySkill.systemPrompt).toContain('Asking a needless question');
  });

  it('lists the hedged-completion cases from the brief', () => {
    for (const phrase of ['basically finished', 'almost done', 'just needs review', 'is sorted']) {
      expect(detectAmbiguitySkill.systemPrompt).toContain(phrase);
    }
  });

  it('requires options derived from available transitions plus an escape hatch', () => {
    expect(detectAmbiguitySkill.systemPrompt).toContain('available transitions');
    expect(detectAmbiguitySkill.systemPrompt).toContain('never offer a status');
    expect(detectAmbiguitySkill.systemPrompt).toContain('changes nothing');
  });

  it('renders what would otherwise be proposed, and flags a hedge', () => {
    const rendered = detectAmbiguitySkill.buildUserMessage({
      text: 'TES-31 is basically finished.',
      authorName: 'Pasan',
      candidates: [
        {
          key: 'TES-31',
          intent: 'completed',
          evidence: 'basically finished',
          confidence: 0.6,
          uncertain: true,
          proposed: 'In Progress → Done',
        },
      ],
      contexts: [present()],
    });

    expect(rendered).toContain('(author hedged)');
    expect(rendered).toContain('would propose "In Progress → Done"');
    expect(rendered).toContain('which statuses each ticket can actually reach');
  });
});

describe('detect-blockers', () => {
  it('validates a detected blocker', () => {
    const parsed = DetectBlockersOutputSchema.safeParse({
      blockers: [
        {
          key: 'TES-42',
          blocked: true,
          category: 'access_or_credentials',
          description: 'waiting for API credentials',
          dependency: 'platform team',
          severity: 'high',
          needsAttention: true,
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts nulls for an unblocked ticket', () => {
    const parsed = DetectBlockersOutputSchema.safeParse({
      blockers: [
        {
          key: 'TES-31',
          blocked: false,
          category: null,
          description: null,
          dependency: null,
          severity: null,
          needsAttention: false,
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown category', () => {
    expect(
      DetectBlockersOutputSchema.safeParse({
        blockers: [
          {
            key: 'TES-42',
            blocked: true,
            category: 'vibes',
            description: null,
            dependency: null,
            severity: null,
            needsAttention: false,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('lists the blocker phrases from the brief', () => {
    for (const phrase of [
      'blocked',
      'waiting for',
      'dependency',
      'cannot continue',
      'need credentials',
      'waiting for another team',
    ]) {
      expect(detectBlockersSkill.systemPrompt).toContain(phrase);
    }
  });

  it('excludes work that is merely unstarted, and already-cleared blockers', () => {
    expect(detectBlockersSkill.systemPrompt).toContain('not a blocker');
    expect(detectBlockersSkill.systemPrompt).toContain('not currently blocked');
  });

  it('reserves needsAttention for something only someone else can clear', () => {
    expect(detectBlockersSkill.systemPrompt).toContain('someone other than the author');
  });
});

describe('summarize-team', () => {
  it('validates a grouped summary', () => {
    const parsed = SummarizeTeamOutputSchema.safeParse({
      completed: [{ key: 'TES-31', text: 'Payment validation' }],
      inProgress: [{ key: 'TES-50', text: 'Invoice API' }],
      blocked: [{ key: 'TES-42', text: 'Waiting for API credentials' }],
      attention: ['TES-42 has remained blocked across three updates.'],
    });
    expect(parsed.success).toBe(true);
  });

  it('defaults every group so a thin summary is valid', () => {
    const parsed = SummarizeTeamOutputSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.completed).toEqual([]);
      expect(parsed.data.attention).toEqual([]);
    }
  });

  it('forbids inventing anything outside the supplied list', () => {
    expect(summarizeTeamSkill.systemPrompt).toContain('closed list');
    expect(summarizeTeamSkill.systemPrompt).toContain('Never introduce a ticket');
    expect(summarizeTeamSkill.systemPrompt).toContain('write a thin summary');
  });

  it('requires a blocked ticket to be grouped as blocked', () => {
    expect(summarizeTeamSkill.systemPrompt).toContain('belongs in blocked, not inProgress');
  });

  it('forbids manufacturing concerns', () => {
    expect(summarizeTeamSkill.systemPrompt).toContain('do not manufacture concerns');
  });

  it('renders the closed issue list with statuses, blockers and observations', () => {
    const rendered = summarizeTeamSkill.buildUserMessage({
      period: 'the last 24 hours',
      today: '2026-09-17',
      contributors: ['Pasan', 'Chandima'],
      issues: [
        {
          key: 'TES-42',
          summary: 'Invoice API',
          status: 'In Progress',
          observations: ['Pasan: add comment (applied)'],
          blocker: {
            description: 'waiting for API credentials',
            dependency: 'platform team',
            severity: 'high',
            timesReported: 3,
            firstSeenAt: '2026-09-14T09:00:00.000Z',
          },
        },
      ],
    });

    expect(rendered).toContain('Use only these keys');
    expect(rendered).toContain('TES-42 — "Invoice API" — Jira status: In Progress');
    expect(rendered).toContain('blocker: waiting for API credentials');
    expect(rendered).toContain('reported 3 time(s) since 2026-09-14');
    expect(rendered).toContain('Pasan, Chandima');
  });

  it('says there is nothing to summarize when the list is empty', () => {
    const rendered = summarizeTeamSkill.buildUserMessage({
      period: 'the last 24 hours',
      today: '2026-09-17',
      contributors: [],
      issues: [],
    });
    expect(rendered).toContain('(none — return empty groups)');
  });
});

describe('explain-proposal (deterministic)', () => {
  it('describes a transition', () => {
    expect(
      describeChange([
        { type: 'transition', fromStatus: 'In Progress', toStatus: 'Done', transitionId: '31' },
      ]),
    ).toBe('In Progress → Done');
  });

  it('describes a transition with a comment', () => {
    expect(
      describeChange([
        { type: 'transition', fromStatus: 'To Do', toStatus: 'In Progress', transitionId: '11' },
        { type: 'comment', body: 'Blocked: waiting' },
      ]),
    ).toBe('To Do → In Progress · comment');
  });

  it('describes a comment-only change', () => {
    expect(describeChange([{ type: 'comment', body: 'Blocked' }])).toBe(
      'No status change · comment',
    );
  });

  it('describes no action', () => {
    expect(describeChange([{ type: 'none', reason: 'nothing changed' }])).toBe('No action');
  });

  it('names the author, quotes their words, and states the Jira fact', () => {
    const { reason } = explainProposal({
      authorName: 'Pasan',
      actions: [
        {
          type: 'transition',
          fromStatus: 'In Progress',
          toStatus: 'Code Review',
          transitionId: '21',
        },
      ],
      evidence: 'the implementation is finished',
      context: present(),
      lowConfidence: false,
    });

    // This is the shape the brief asks for.
    expect(reason).toBe(
      'Pasan said "the implementation is finished". Code Review is an available next transition in Jira.',
    );
  });

  it('explains a no-action outcome using the reason given', () => {
    const { reason } = explainProposal({
      authorName: 'Pasan',
      actions: [{ type: 'none', reason: 'Already Done' }],
      evidence: 'finished TES-31',
      context: present({ status: 'Done' }),
      lowConfidence: false,
    });

    expect(reason).toContain('Pasan said "finished TES-31"');
    expect(reason).toContain('TES-31 stays Done');
  });

  it('appends validator warnings', () => {
    const { reason } = explainProposal({
      authorName: 'Pasan',
      actions: [
        { type: 'transition', fromStatus: 'In Progress', toStatus: 'Done', transitionId: '31' },
      ],
      evidence: 'done',
      context: present(),
      validation: {
        valid: true,
        risk: 'medium',
        warnings: ['Assigned to Chandima, not Pasan'],
        explanation: 'The author is not the assignee.',
      },
      lowConfidence: false,
    });

    expect(reason).toContain('Assigned to Chandima, not Pasan.');
    expect(reason).toContain('The author is not the assignee.');
  });

  it('drops a generic validator sentence rather than showing filler', () => {
    const { reason } = explainProposal({
      authorName: 'Pasan',
      actions: [
        { type: 'transition', fromStatus: 'In Progress', toStatus: 'Done', transitionId: '31' },
      ],
      evidence: 'done',
      context: present(),
      validation: {
        valid: true,
        risk: 'low',
        warnings: [],
        explanation: 'The proposed change appears to be appropriate.',
      },
      lowConfidence: false,
    });

    expect(reason).not.toContain('appears to be appropriate');
  });

  it('flags low confidence', () => {
    const { reason } = explainProposal({
      authorName: 'Pasan',
      actions: [
        { type: 'transition', fromStatus: 'In Progress', toStatus: 'Done', transitionId: '31' },
      ],
      evidence: 'maybe done',
      context: present(),
      lowConfidence: true,
    });
    expect(reason).toContain('Lower confidence — check before approving.');
  });

  it('strips surrounding quotes from the evidence so it is not double-quoted', () => {
    const { reason } = explainProposal({
      authorName: 'Pasan',
      actions: [{ type: 'none', reason: 'x' }],
      evidence: '"finished TES-31"',
      context: present(),
      lowConfidence: false,
    });
    expect(reason).toContain('Pasan said "finished TES-31"');
    expect(reason).not.toContain('""');
  });

  it('falls back to a plain sentence with no evidence and no context', () => {
    const { reason } = explainProposal({
      authorName: 'Pasan',
      actions: [{ type: 'none', reason: 'nothing' }],
      evidence: '',
      context: undefined,
      lowConfidence: false,
    });
    expect(reason).toBe('No action needed.');
  });

  it('identifies generic AI filler', () => {
    for (const filler of [
      'As an AI, I think this is fine',
      'This seems reasonable',
      'No issues found',
      'It appears that the change is correct',
    ]) {
      expect(isGeneric(filler), filler).toBe(true);
    }
    expect(isGeneric('Pasan said the implementation is finished.')).toBe(false);
  });

  it('turns confidence into a word, not a false-precision percentage', () => {
    expect(confidenceWord(0.95)).toBe('High');
    expect(confidenceWord(0.8)).toBe('High');
    expect(confidenceWord(0.65)).toBe('Medium');
    expect(confidenceWord(0.5)).toBe('Medium');
    expect(confidenceWord(0.2)).toBe('Low');
    expect(confidenceWord(0)).toBe('Unknown');
  });

  it('summarizes a proposal for the card', () => {
    const summary = summarizeProposal({
      id: 'p1',
      key: 'TES-31',
      actions: [
        { type: 'transition', fromStatus: 'In Progress', toStatus: 'Done', transitionId: '31' },
      ],
      confidence: 0.95,
      explanation: 'Pasan said "Finished TES-31".',
      selected: true,
      review: { validated: true, risk: 'low', warnings: ['check this'], transitionVerified: true },
    });

    expect(summary).toEqual({
      key: 'TES-31',
      change: 'In Progress → Done',
      reason: 'Pasan said "Finished TES-31".',
      confidenceLabel: 'High',
      risk: 'low',
      verified: true,
      warnings: ['check this'],
    });
  });

  it('reports a V1 proposal as unverified with no warnings', () => {
    const summary = summarizeProposal({
      id: 'p1',
      key: 'TES-31',
      actions: [{ type: 'none', reason: 'x' }],
      confidence: 0.5,
      explanation: 'e',
      selected: false,
    });
    expect(summary.verified).toBe(false);
    expect(summary.warnings).toEqual([]);
    expect(summary.risk).toBeUndefined();
  });
});
