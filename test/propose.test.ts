import { describe, it, expect } from 'vitest';
import { buildProposals, isActionable, LOW_CONFIDENCE_THRESHOLD } from '../src/standup/propose.js';
import type { StatusConfig } from '../src/jira/statusMap.js';
import type { IssueLookup } from '../src/jira/issues.js';
import type { Intent, Proposal, ProposalAction, TicketInterpretation } from '../src/types.js';

const STATUSES: StatusConfig = { done: 'Done', inProgress: 'In Progress', todo: 'To Do' };

const TRANSITIONS = [
  { id: '11', name: 'To Do', toStatus: 'To Do' },
  { id: '21', name: 'In Progress', toStatus: 'In Progress' },
  { id: '31', name: 'Done', toStatus: 'Done' },
];

let counter = 0;
const stableId = () => `proposal-${++counter}`;

const found = (key: string, status: string, transitions = TRANSITIONS): IssueLookup => ({
  key,
  found: true,
  state: { key, summary: `${key} summary`, status, transitions },
});

const missing = (key: string, reason = 'not found'): IssueLookup => ({ key, found: false, reason });

const interp = (
  key: string,
  intent: Intent,
  extra: Partial<TicketInterpretation> = {},
): TicketInterpretation => ({
  key,
  intent,
  confidence: 0.9,
  evidence: `evidence for ${key}`,
  ...extra,
});

/** Builds one proposal for one ticket against one live Jira state. */
function propose(
  ticket: TicketInterpretation,
  lookup: IssueLookup,
  statuses: StatusConfig = STATUSES,
): Proposal {
  const [proposal] = buildProposals({
    interpretation: { tickets: [ticket], unresolvedMentions: [] },
    lookups: [lookup],
    statuses,
    idFactory: stableId,
  });
  return proposal!;
}

const transitionOf = (p: Proposal) =>
  p.actions.find(
    (a): a is Extract<ProposalAction, { type: 'transition' }> => a.type === 'transition',
  );
const commentOf = (p: Proposal) =>
  p.actions.find((a): a is Extract<ProposalAction, { type: 'comment' }> => a.type === 'comment');
const noneOf = (p: Proposal) =>
  p.actions.find((a): a is Extract<ProposalAction, { type: 'none' }> => a.type === 'none');

describe('proposal mapping table', () => {
  it('completed + In Progress → transition to Done', () => {
    const p = propose(interp('TES-41', 'completed'), found('TES-41', 'In Progress'));

    expect(transitionOf(p)).toEqual({
      type: 'transition',
      fromStatus: 'In Progress',
      toStatus: 'Done',
      transitionId: '31', // read from the live workflow, never hardcoded
    });
    expect(p.selected).toBe(true);
  });

  it('completed + already Done → no action, explained as "already Done"', () => {
    const p = propose(interp('TES-41', 'completed'), found('TES-41', 'Done'));

    expect(transitionOf(p)).toBeUndefined();
    expect(noneOf(p)?.reason).toContain('already Done');
    expect(isActionable(p)).toBe(false);
    expect(p.selected).toBe(false);
  });

  it('in_progress + To Do → transition to In Progress', () => {
    const p = propose(interp('TES-42', 'in_progress'), found('TES-42', 'To Do'));

    expect(transitionOf(p)).toMatchObject({
      fromStatus: 'To Do',
      toStatus: 'In Progress',
      transitionId: '21',
    });
  });

  it('in_progress + already In Progress → no action', () => {
    const p = propose(interp('TES-42', 'in_progress'), found('TES-42', 'In Progress'));

    expect(transitionOf(p)).toBeUndefined();
    expect(noneOf(p)?.reason).toContain('already In Progress');
    expect(isActionable(p)).toBe(false);
  });

  it('blocked + To Do → transition to In Progress AND a blocker comment', () => {
    const p = propose(
      interp('TES-43', 'blocked', { blockerReason: 'Waiting for API credentials' }),
      found('TES-43', 'To Do'),
    );

    expect(transitionOf(p)).toMatchObject({ toStatus: 'In Progress', transitionId: '21' });
    expect(commentOf(p)?.body).toContain('API credentials');
    expect(p.actions).toHaveLength(2);
  });

  it('blocked + In Progress → comment only, no transition', () => {
    const p = propose(
      interp('TES-43', 'blocked', { blockerReason: 'Waiting for API credentials' }),
      found('TES-43', 'In Progress'),
    );

    expect(transitionOf(p)).toBeUndefined();
    expect(commentOf(p)?.body).toContain('API credentials');
    expect(p.actions).toHaveLength(1);
  });

  it('not_done_yet never transitions to Done, from any status', () => {
    for (const status of ['To Do', 'In Progress', 'Done', 'Backlog']) {
      const p = propose(
        interp('TES-41', 'not_done_yet', { commentText: 'QA found another issue.' }),
        found('TES-41', status),
      );
      expect(transitionOf(p)).toBeUndefined();
      expect(p.actions.every((a) => a.type !== 'transition')).toBe(true);
    }
  });

  it('not_done_yet proposes a comment when there is one, else no action', () => {
    const withComment = propose(
      interp('TES-41', 'not_done_yet', { commentText: 'Mostly done; QA found a bug.' }),
      found('TES-41', 'In Progress'),
    );
    expect(commentOf(withComment)?.body).toBe('Mostly done; QA found a bug.');

    const withoutComment = propose(
      interp('TES-41', 'not_done_yet'),
      found('TES-41', 'In Progress'),
    );
    expect(commentOf(withoutComment)).toBeUndefined();
    expect(noneOf(withoutComment)?.reason).toContain('not finished');
  });

  it('no_change → no action', () => {
    const p = propose(interp('TES-80', 'no_change'), found('TES-80', 'To Do'));
    expect(isActionable(p)).toBe(false);
    expect(noneOf(p)?.reason).toContain('nothing changed');
  });

  it('unclear → no action', () => {
    const p = propose(interp('TES-90', 'unclear'), found('TES-90', 'To Do'));
    expect(isActionable(p)).toBe(false);
    expect(noneOf(p)?.reason).toContain('Could not tell');
  });
});

describe('confidence handling', () => {
  it('shows a low-confidence proposal but leaves it unselected', () => {
    const p = propose(
      interp('TES-41', 'completed', { confidence: 0.4 }),
      found('TES-41', 'In Progress'),
    );

    // Still visible and still actionable — a human just has to opt in.
    expect(transitionOf(p)).toBeDefined();
    expect(p.selected).toBe(false);
    expect(p.confidence).toBe(0.4);
    expect(p.explanation).toContain('Low confidence');
  });

  it('selects a proposal at or above the threshold', () => {
    const at = propose(
      interp('TES-41', 'completed', { confidence: LOW_CONFIDENCE_THRESHOLD }),
      found('TES-41', 'In Progress'),
    );
    expect(at.selected).toBe(true);

    const below = propose(
      interp('TES-41', 'completed', { confidence: LOW_CONFIDENCE_THRESHOLD - 0.01 }),
      found('TES-41', 'In Progress'),
    );
    expect(below.selected).toBe(false);
  });

  it('never selects a proposal that would do nothing, however confident', () => {
    const p = propose(interp('TES-41', 'completed', { confidence: 1 }), found('TES-41', 'Done'));
    expect(p.selected).toBe(false);
  });
});

describe('workflow and lookup edge cases', () => {
  it('target status exists but no live transition → no action with a clear explanation', () => {
    const restricted = found('TES-41', 'To Do', [
      { id: '21', name: 'Start', toStatus: 'In Progress' },
    ]);
    const p = propose(interp('TES-41', 'completed'), restricted);

    expect(transitionOf(p)).toBeUndefined();
    expect(noneOf(p)?.reason).toContain('No transition to Done available from To Do');
    expect(noneOf(p)?.reason).toContain('In Progress'); // tells the human what IS reachable
    expect(p.selected).toBe(false);
  });

  it('an issue with no transitions at all produces no action', () => {
    const p = propose(interp('TES-41', 'completed'), found('TES-41', 'To Do', []));
    expect(transitionOf(p)).toBeUndefined();
    expect(noneOf(p)?.reason).toContain('No transition to Done');
  });

  it('a ticket missing from Jira gets no Jira action whatever Claude concluded', () => {
    const p = propose(interp('TES-999', 'completed'), missing('TES-999'));

    expect(p.actions).toEqual([{ type: 'none', reason: 'Not found in Jira (not found)' }]);
    expect(isActionable(p)).toBe(false);
    expect(p.selected).toBe(false);
  });

  it('an unreadable ticket (auth failure) also gets no action', () => {
    const p = propose(interp('TES-41', 'completed'), missing('TES-41', 'Jira returned 403'));
    expect(isActionable(p)).toBe(false);
    expect(noneOf(p)?.reason).toContain('403');
  });

  it('a ticket with no lookup at all gets no action', () => {
    const [p] = buildProposals({
      interpretation: { tickets: [interp('TES-41', 'completed')], unresolvedMentions: [] },
      lookups: [], // nothing resolved
      statuses: STATUSES,
      idFactory: stableId,
    });
    expect(isActionable(p!)).toBe(false);
  });

  it('honours renamed statuses from configuration', () => {
    const custom: StatusConfig = { done: 'Closed', inProgress: 'Doing', todo: 'Backlog' };
    const lookup = found('TES-41', 'Doing', [{ id: '77', name: 'Close', toStatus: 'Closed' }]);
    const p = propose(interp('TES-41', 'completed'), lookup, custom);

    expect(transitionOf(p)).toMatchObject({ toStatus: 'Closed', transitionId: '77' });
  });
});

describe('action hygiene', () => {
  it('never produces duplicate actions', () => {
    const p = propose(
      interp('TES-43', 'blocked', {
        blockerReason: 'Waiting for API credentials',
        commentText: 'Blocked waiting for API credentials',
      }),
      found('TES-43', 'To Do'),
    );

    const transitions = p.actions.filter((a) => a.type === 'transition');
    const comments = p.actions.filter((a) => a.type === 'comment');
    expect(transitions).toHaveLength(1);
    expect(comments).toHaveLength(1);
  });

  it('never mixes a none action with a real one', () => {
    const p = propose(
      interp('TES-43', 'blocked', { blockerReason: 'waiting' }),
      found('TES-43', 'To Do'),
    );
    expect(p.actions.some((a) => a.type === 'none')).toBe(false);
  });

  it('emits exactly one none action when nothing can be done', () => {
    const p = propose(interp('TES-90', 'unclear'), found('TES-90', 'To Do'));
    expect(p.actions).toHaveLength(1);
    expect(p.actions[0]?.type).toBe('none');
  });

  it('gives every proposal a distinct id', () => {
    const proposals = buildProposals({
      interpretation: {
        tickets: [interp('TES-41', 'completed'), interp('TES-42', 'in_progress')],
        unresolvedMentions: [],
      },
      lookups: [found('TES-41', 'In Progress'), found('TES-42', 'To Do')],
      statuses: STATUSES,
      idFactory: stableId,
    });
    expect(new Set(proposals.map((p) => p.id)).size).toBe(2);
  });

  it('carries the evidence phrase into the explanation so the card can justify itself', () => {
    const p = propose(
      interp('TES-43', 'blocked', {
        evidence: 'TES-43 is blocked because I am waiting for API credentials',
        blockerReason: 'Waiting for API credentials',
      }),
      found('TES-43', 'In Progress'),
    );
    expect(p.explanation).toContain('waiting for API credentials');
  });
});

describe('the TES demo standup end to end', () => {
  it('produces exactly the three expected proposals', () => {
    const proposals = buildProposals({
      interpretation: {
        tickets: [
          interp('TES-41', 'completed', { confidence: 0.97 }),
          interp('TES-42', 'in_progress', { confidence: 0.95 }),
          interp('TES-43', 'blocked', {
            confidence: 0.97,
            blockerReason: 'Waiting for API credentials',
            commentText: 'Blocked waiting on API credentials to proceed.',
          }),
        ],
        unresolvedMentions: [],
      },
      lookups: [
        found('TES-41', 'In Progress'),
        found('TES-42', 'To Do'),
        found('TES-43', 'In Progress'),
      ],
      statuses: STATUSES,
      idFactory: stableId,
    });

    expect(proposals).toHaveLength(3);
    expect(transitionOf(proposals[0]!)).toMatchObject({
      fromStatus: 'In Progress',
      toStatus: 'Done',
    });
    expect(transitionOf(proposals[1]!)).toMatchObject({
      fromStatus: 'To Do',
      toStatus: 'In Progress',
    });
    expect(transitionOf(proposals[2]!)).toBeUndefined();
    expect(commentOf(proposals[2]!)?.body).toContain('API credentials');
    expect(proposals.every((p) => p.selected)).toBe(true);
  });
});
