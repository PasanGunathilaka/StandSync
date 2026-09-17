import { describe, it, expect } from 'vitest';
import type { IAdaptiveCard } from '@microsoft/teams.cards';
import {
  buildClarificationCard,
  buildClarificationAnsweredCard,
  buildProposalCardV2,
  buildResultCardV2,
  buildSummaryCard,
  CLARIFY_ACTION,
} from '../src/teams/cardsV2.js';
import { CARD_VERSION, CARD_ACTIONS, APPROVAL_ACTIONS } from '../src/teams/cards.js';
import { parseCardAction } from '../src/teams/actions.js';
import type { BlockerObservation } from '../src/agents/blocker-agent.js';
import type { ClarificationRecord } from '../src/approval/store.js';
import type { Proposal, ProposalBatch } from '../src/types.js';

/**
 * V2 Adaptive Cards.
 *
 * Cards are the one part of the system a user actually sees, so what is asserted
 * here is what they can read and what they can click — particularly that a card
 * with nothing to apply carries no Approve button, and that a clarification
 * cannot be mistaken for an approval.
 */

interface CardJson {
  type: string;
  version?: string;
  body?: unknown[];
  actions?: { type: string; title?: string; data?: Record<string, unknown> }[];
}

const asJson = (card: IAdaptiveCard): CardJson => JSON.parse(JSON.stringify(card)) as CardJson;
const cardText = (card: IAdaptiveCard): string => JSON.stringify(card);
const actionTitles = (card: IAdaptiveCard): string[] =>
  (asJson(card).actions ?? []).map((a) => a.title ?? '');

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  id: 'p-1',
  key: 'TES-31',
  actions: [
    { type: 'transition', fromStatus: 'In Progress', toStatus: 'Code Review', transitionId: '21' },
  ],
  confidence: 0.95,
  explanation: 'Pasan said "the implementation is finished". Code Review is available in Jira.',
  selected: true,
  review: { validated: true, risk: 'low', warnings: [], transitionVerified: true },
  ...over,
});

const batch = (proposals: Proposal[], over: Partial<ProposalBatch> = {}): ProposalBatch => ({
  id: 'batch-1',
  conversationId: 'conv-1',
  messageId: 'msg-1',
  authorId: 'user-pasan',
  authorName: 'Pasan',
  rawMessage: 'Finished TES-31.',
  proposals,
  status: 'pending',
  createdAt: new Date().toISOString(),
  origin: { source: 'ambient', traceId: 'trace-1' },
  ...over,
});

const clarification = (over: Partial<ClarificationRecord> = {}): ClarificationRecord => ({
  id: 'clar-1',
  conversationId: 'conv-1',
  messageId: 'msg-1',
  authorId: 'user-pasan',
  authorName: 'Pasan',
  issueKey: 'TES-31',
  originalMessage: 'TES-31 is basically finished.',
  question: 'TES-31 is currently In Progress. What should StandSync propose?',
  options: [
    {
      id: 'opt0',
      label: 'Move to Code Review',
      intent: 'in_progress',
      targetStatus: 'Code Review',
    },
    { id: 'opt1', label: 'Move to Done', intent: 'completed', targetStatus: 'Done' },
    { id: 'optNoChange', label: 'Keep In Progress', intent: 'no_change' },
  ],
  status: 'pending',
  createdAt: new Date().toISOString(),
  ...over,
});

describe('V2 proposal card', () => {
  it('uses the shared card version and the Universal Action Model', () => {
    const card = asJson(buildProposalCardV2(batch([proposal()])));
    expect(card.version).toBe(CARD_VERSION);
    for (const action of card.actions ?? []) {
      // Action.Execute, never the legacy Action.Submit.
      expect(action.type).toBe('Action.Execute');
    }
  });

  it('keeps the V1 approval verbs, so the handler behind them is unchanged', () => {
    const card = asJson(buildProposalCardV2(batch([proposal()])));
    const verbs = (card.actions ?? []).map((a) => a.data?.['action']);
    expect(verbs).toEqual(['approve_all', 'review', 'reject']);
  });

  it('carries the batch id on every action', () => {
    const card = asJson(buildProposalCardV2(batch([proposal()])));
    for (const action of card.actions ?? []) {
      expect(action.data?.['batchId']).toBe('batch-1');
    }
  });

  it('shows the change, the confidence in words, and the Jira verification', () => {
    const text = cardText(buildProposalCardV2(batch([proposal()])));
    expect(text).toContain('TES-31');
    expect(text).toContain('In Progress → Code Review');
    expect(text).toContain('Confidence: High');
    expect(text).toContain('✓ Transition verified in Jira');
  });

  it('shows the factual explanation', () => {
    const text = cardText(buildProposalCardV2(batch([proposal()])));
    expect(text).toContain('Pasan said');
    expect(text).toContain('the implementation is finished');
  });

  it('renders each validator warning as its own attention line', () => {
    const card = buildProposalCardV2(
      batch([
        proposal({
          review: {
            validated: true,
            risk: 'medium',
            warnings: ['Assigned to Chandima, not Pasan'],
            transitionVerified: true,
          },
          selected: false,
        }),
      ]),
    );

    const text = cardText(card);
    expect(text).toContain('⚠ Assigned to Chandima, not Pasan');
    expect(text).toContain('Attention');
  });

  it('says Review recommended for a medium-risk change', () => {
    const text = cardText(
      buildProposalCardV2(
        batch([
          proposal({
            selected: false,
            review: { validated: true, risk: 'medium', warnings: [], transitionVerified: true },
          }),
        ]),
      ),
    );
    expect(text).toContain('Review recommended');
  });

  it('does not claim verification for a non-actionable row', () => {
    const text = cardText(
      buildProposalCardV2(
        batch([
          proposal({
            actions: [{ type: 'none', reason: 'Jira offers no transition to that status.' }],
            selected: false,
            review: { validated: false, risk: 'high', warnings: [], transitionVerified: false },
          }),
        ]),
      ),
    );
    expect(text).not.toContain('Transition verified');
  });

  it('offers no Approve button when there is nothing to apply', () => {
    const card = buildProposalCardV2(
      batch([
        proposal({
          actions: [{ type: 'none', reason: 'Nothing to change.' }],
          selected: false,
        }),
      ]),
    );

    // An approval action that cannot approve anything is a trap.
    expect(asJson(card).actions ?? []).toEqual([]);
    expect(cardText(card)).toContain('StandSync understood your update');
  });

  it('prompts the reader to open Review when nothing is pre-selected', () => {
    const text = cardText(buildProposalCardV2(batch([proposal({ selected: false })])));
    expect(text).toContain('Nothing is pre-selected');
  });

  it('does not prompt for Review when something is pre-selected', () => {
    const text = cardText(buildProposalCardV2(batch([proposal({ selected: true })])));
    expect(text).not.toContain('Nothing is pre-selected');
  });

  it('describes an ambient message differently from a standup', () => {
    expect(
      cardText(buildProposalCardV2(batch([proposal()], { origin: { source: 'ambient' } }))),
    ).toContain("From Pasan's message in this channel");

    expect(
      cardText(buildProposalCardV2(batch([proposal()], { origin: { source: 'mention' } }))),
    ).toContain("From Pasan's standup");
  });

  it('appends a surfaced blocker', () => {
    const blockers: BlockerObservation[] = [
      {
        key: 'TES-42',
        blocked: true,
        description: 'waiting for API credentials',
        dependency: 'platform team',
        needsAttention: true,
        isNew: true,
        timesReported: 1,
        shouldSurface: true,
      },
    ];

    const text = cardText(buildProposalCardV2(batch([proposal()]), blockers));
    expect(text).toContain('⚠ TES-42 blocked: waiting for API credentials');
    expect(text).toContain('waiting on platform team');
  });

  it('omits a blocker that is not worth surfacing again', () => {
    const blockers: BlockerObservation[] = [
      {
        key: 'TES-42',
        blocked: true,
        description: 'waiting for API credentials',
        needsAttention: true,
        isNew: false,
        timesReported: 4,
        shouldSurface: false,
      },
    ];

    // Repeating an unchanged blocker on every standup trains people to ignore it.
    expect(cardText(buildProposalCardV2(batch([proposal()]), blockers))).not.toContain('TES-42');
  });

  it('renders several tickets in mention order', () => {
    const card = cardText(
      buildProposalCardV2(
        batch([
          proposal({ id: 'p1', key: 'TES-31' }),
          proposal({ id: 'p2', key: 'TES-42' }),
          proposal({ id: 'p3', key: 'TES-50' }),
        ]),
      ),
    );
    expect(card.indexOf('TES-31')).toBeLessThan(card.indexOf('TES-42'));
    expect(card.indexOf('TES-42')).toBeLessThan(card.indexOf('TES-50'));
  });
});

describe('clarification card', () => {
  it('offers one action per option, carrying the clarification and option ids', () => {
    const card = asJson(buildClarificationCard(clarification()));

    expect(card.actions).toHaveLength(3);
    for (const action of card.actions ?? []) {
      expect(action.type).toBe('Action.Execute');
      expect(action.data?.['action']).toBe(CLARIFY_ACTION);
      expect(action.data?.['clarificationId']).toBe('clar-1');
    }
    expect((card.actions ?? []).map((a) => a.data?.['optionId'])).toEqual([
      'opt0',
      'opt1',
      'optNoChange',
    ]);
  });

  it('labels the buttons as outcomes', () => {
    expect(actionTitles(buildClarificationCard(clarification()))).toEqual([
      'Move to Code Review',
      'Move to Done',
      'Keep In Progress',
    ]);
  });

  it('shows the question and quotes the original message', () => {
    const text = cardText(buildClarificationCard(clarification()));
    expect(text).toContain('What should StandSync propose?');
    expect(text).toContain('You said: \\"TES-31 is basically finished.\\"');
  });

  it('states plainly that nothing was changed', () => {
    expect(cardText(buildClarificationCard(clarification()))).toContain(
      'Nothing has been changed in Jira',
    );
  });

  it('carries no approval verb — answering is not approving', () => {
    const verbs = (asJson(buildClarificationCard(clarification())).actions ?? []).map((a) =>
      String(a.data?.['action']),
    );
    for (const verb of verbs) {
      expect(APPROVAL_ACTIONS as readonly string[]).not.toContain(verb);
    }
  });

  it('carries no batch id, so it cannot address a batch', () => {
    for (const action of asJson(buildClarificationCard(clarification())).actions ?? []) {
      expect(action.data?.['batchId']).toBeUndefined();
    }
  });

  it('produces a payload the card handler accepts as a clarify action', () => {
    const action = asJson(buildClarificationCard(clarification())).actions?.[0];
    const parsed = parseCardAction(action?.data);

    expect(parsed).toEqual({
      action: 'clarify',
      clarificationId: 'clar-1',
      optionId: 'opt0',
    });
  });

  it('confirms an answer without claiming anything was applied', () => {
    const text = cardText(
      buildClarificationAnsweredCard(clarification(), 'Move to Code Review', 'Pasan'),
    );
    expect(text).toContain('Pasan chose');
    expect(text).toContain('Move to Code Review');
    expect(text).toContain('preparing a proposal for approval');
  });
});

describe('V2 result card', () => {
  it('marks each outcome with a symbol and what landed', () => {
    const text = cardText(
      buildResultCardV2({
        status: 'partial',
        results: [
          { key: 'TES-31', ok: true, applied: ['In Progress → Code Review'] },
          { key: 'TES-42', ok: false, applied: [], error: 'Jira rejected the transition' },
          { key: 'TES-50', ok: true, applied: ['comment added'] },
        ],
      }),
    );

    expect(text).toContain('✓ TES-31 — In Progress → Code Review');
    expect(text).toContain('✗ TES-42 — Jira rejected the transition');
    expect(text).toContain('✓ TES-50 — comment added');
    expect(text).toContain('2 succeeded, 1 failed');
  });

  it('titles each execution status correctly', () => {
    const cases = [
      ['executed', 'Jira updated'],
      ['partial', 'Jira partially updated'],
      ['failed', 'Jira update failed'],
      ['rejected', 'Update rejected'],
    ] as const;

    for (const [status, title] of cases) {
      const text = cardText(buildResultCardV2({ status, results: [] }));
      expect(text, status).toContain(title);
    }
  });

  it('says nothing was sent to Jira for a rejection', () => {
    expect(cardText(buildResultCardV2({ status: 'rejected', results: [] }))).toContain(
      'Nothing was sent to Jira',
    );
  });

  it('carries no actions, so a result cannot be re-approved', () => {
    const card = asJson(
      buildResultCardV2({
        status: 'executed',
        results: [{ key: 'TES-31', ok: true, applied: ['done'] }],
      }),
    );
    expect(card.actions).toBeUndefined();
  });

  it('handles an empty result set', () => {
    expect(cardText(buildResultCardV2({ status: 'executed', results: [] }))).toContain(
      'No changes were applied',
    );
  });
});

describe('summary card', () => {
  const summary = {
    completed: [{ key: 'TES-31', text: 'Payment validation' }],
    inProgress: [{ key: 'TES-50', text: 'Invoice API' }],
    blocked: [{ key: 'TES-42', text: 'Waiting for API credentials' }],
    attention: ['TES-42 has remained blocked across three updates.'],
  };

  it('groups the work under readable headings', () => {
    const text = cardText(
      buildSummaryCard({ summary, period: 'the last 24 hours', generatedAt: 'now' }),
    );

    expect(text).toContain('StandSync Daily Summary');
    expect(text).toContain('Completed');
    expect(text).toContain('• TES-31 — Payment validation');
    expect(text).toContain('In Progress');
    expect(text).toContain('• TES-50 — Invoice API');
    expect(text).toContain('Blocked');
    expect(text).toContain('• TES-42 — Waiting for API credentials');
  });

  it('shows the attention section in attention colour', () => {
    const card = asJson(buildSummaryCard({ summary, period: 'p', generatedAt: 'now' }));
    const text = JSON.stringify(card);
    expect(text).toContain('TES-42 has remained blocked across three updates.');
    expect(text).toContain('Attention');
  });

  it('omits empty groups rather than showing blank headings', () => {
    const text = cardText(
      buildSummaryCard({
        summary: { completed: summary.completed, inProgress: [], blocked: [], attention: [] },
        period: 'p',
        generatedAt: 'now',
      }),
    );
    expect(text).toContain('Completed');
    expect(text).not.toContain('Blocked');
    expect(text).not.toContain('Attention');
  });

  it('says so plainly when there is no activity', () => {
    const text = cardText(
      buildSummaryCard({
        summary: { completed: [], inProgress: [], blocked: [], attention: [] },
        period: 'p',
        generatedAt: 'now',
      }),
    );
    expect(text).toContain('No standup activity recorded');
  });

  it('states that it changed nothing, and carries no actions', () => {
    const card = buildSummaryCard({ summary, period: 'p', generatedAt: 'now' });
    expect(cardText(card)).toContain('nothing in Jira was changed');
    expect(asJson(card).actions).toBeUndefined();
  });
});

describe('card action payload validation', () => {
  it('accepts the four V1 approval verbs with a batch id', () => {
    for (const action of ['approve_all', 'review', 'apply_selected', 'reject']) {
      expect(parseCardAction({ action, batchId: 'b1' })).toEqual({ action, batchId: 'b1' });
    }
  });

  it('accepts a summary request with no other field', () => {
    expect(parseCardAction({ action: 'summary' })).toEqual({ action: 'summary' });
  });

  it('rejects a batch verb with no batch id', () => {
    expect(parseCardAction({ action: 'approve_all' })).toBeNull();
  });

  it('rejects a clarify payload missing an option', () => {
    expect(parseCardAction({ action: 'clarify', clarificationId: 'c1' })).toBeNull();
  });

  it('rejects a clarify payload missing the clarification', () => {
    expect(parseCardAction({ action: 'clarify', optionId: 'opt0' })).toBeNull();
  });

  it('does not let a clarify payload smuggle in a batch id', () => {
    const parsed = parseCardAction({
      action: 'clarify',
      clarificationId: 'c1',
      optionId: 'opt0',
      batchId: 'b1',
    });
    // The union's clarify member has no batchId, so it cannot address a batch.
    expect(parsed).toEqual({ action: 'clarify', clarificationId: 'c1', optionId: 'opt0' });
    expect(parsed && 'batchId' in parsed).toBe(false);
  });

  it('still rejects unknown and malformed payloads', () => {
    expect(parseCardAction({ action: 'delete_everything', batchId: 'b1' })).toBeNull();
    expect(parseCardAction({ batchId: 'b1' })).toBeNull();
    expect(parseCardAction(null)).toBeNull();
    expect(parseCardAction('approve_all')).toBeNull();
  });

  it('keeps the approval verbs a strict subset of all verbs', () => {
    for (const verb of APPROVAL_ACTIONS) {
      expect(CARD_ACTIONS as readonly string[]).toContain(verb);
    }
    expect(APPROVAL_ACTIONS).toEqual(['approve_all', 'apply_selected']);
  });
});
