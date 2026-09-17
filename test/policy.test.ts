import { describe, it, expect } from 'vitest';
import {
  decideBatch,
  decideProposal,
  decideRelevance,
  describeDisposition,
  isExecutable,
  thresholdsFrom,
  type PolicyThresholds,
  type ProposalDecisionInput,
  type ProposalDisposition,
} from '../src/policy/decision-policy.js';
import { loadConfig } from '../src/config.js';
import type { ProposalAction, RiskLevel } from '../src/types.js';
import type { StatusResolution } from '../src/jira/statusMap.js';

/**
 * The decision policy is the one place StandSync decides what to do with a
 * proposed change, so every branch is tested here rather than through the
 * orchestrator. A threshold that only works via a model call is a threshold
 * nobody can reason about.
 */

const THRESHOLDS: PolicyThresholds = {
  autoSelectConfidence: 0.8,
  clarifyConfidence: 0.5,
  relevanceConfidence: 0.6,
};

const transition = (
  from = 'In Progress',
  to = 'Done',
): Extract<ProposalAction, { type: 'transition' }> => ({
  type: 'transition',
  fromStatus: from,
  toStatus: to,
  transitionId: '31',
});

const okResolution = (): StatusResolution => ({
  kind: 'transition',
  transition: { id: '31', name: 'Done', toStatus: 'Done' },
  fromStatus: 'In Progress',
  toStatus: 'Done',
});

/** A change that should sail through: confident, valid, low risk, verified. */
const happyPath = (over: Partial<ProposalDecisionInput> = {}): ProposalDecisionInput => ({
  confidence: 0.95,
  resolution: okResolution(),
  issueExists: true,
  actions: [transition()],
  validation: { valid: true, risk: 'low', warnings: [] },
  ...over,
});

describe('thresholdsFrom — policy is configurable, not hardcoded', () => {
  it('reads the defaults from config', () => {
    const config = loadConfig({
      JIRA_BASE_URL: 'https://example.atlassian.net',
      JIRA_EMAIL: 'a@b.c',
      JIRA_API_TOKEN: 't',
    });

    expect(thresholdsFrom(config)).toEqual({
      autoSelectConfidence: 0.8,
      clarifyConfidence: 0.5,
      relevanceConfidence: 0.6,
    });
  });

  it('honours overrides', () => {
    const config = loadConfig({
      JIRA_BASE_URL: 'https://example.atlassian.net',
      JIRA_EMAIL: 'a@b.c',
      JIRA_API_TOKEN: 't',
      POLICY_AUTO_SELECT_CONFIDENCE: '0.95',
      POLICY_CLARIFY_CONFIDENCE: '0.7',
      POLICY_RELEVANCE_CONFIDENCE: '0.4',
    });

    expect(thresholdsFrom(config)).toEqual({
      autoSelectConfidence: 0.95,
      clarifyConfidence: 0.7,
      relevanceConfidence: 0.4,
    });
  });
});

describe('decideRelevance', () => {
  it('admits a fast-path message with no model involvement', () => {
    expect(decideRelevance({ kind: 'fast_path' }, THRESHOLDS)).toEqual({
      admit: true,
      reason: 'fast_path',
    });
  });

  it('admits a confidently relevant message', () => {
    expect(
      decideRelevance({ kind: 'classified', relevant: true, confidence: 0.9 }, THRESHOLDS),
    ).toEqual({ admit: true, reason: 'classified_relevant' });
  });

  it('rejects a message classified as irrelevant', () => {
    expect(
      decideRelevance({ kind: 'classified', relevant: false, confidence: 0.99 }, THRESHOLDS),
    ).toEqual({ admit: false, reason: 'classified_irrelevant' });
  });

  it('rejects a relevant-but-unsure classification', () => {
    expect(
      decideRelevance({ kind: 'classified', relevant: true, confidence: 0.4 }, THRESHOLDS),
    ).toEqual({ admit: false, reason: 'low_confidence' });
  });

  it('admits exactly at the threshold', () => {
    expect(
      decideRelevance({ kind: 'classified', relevant: true, confidence: 0.6 }, THRESHOLDS).admit,
    ).toBe(true);
  });

  it('stays silent when the classifier fails — never assumes relevance', () => {
    expect(decideRelevance({ kind: 'classifier_failed' }, THRESHOLDS)).toEqual({
      admit: false,
      reason: 'classifier_failed',
    });
  });
});

describe('decideProposal — deterministic vetoes', () => {
  it('suppresses a change to an issue that could not be read', () => {
    const decision = decideProposal(happyPath({ issueExists: false }), THRESHOLDS);
    expect(decision).toEqual({ kind: 'suppress', why: 'issue_missing' });
  });

  it('suppresses a transition with no live transition available', () => {
    const decision = decideProposal(
      happyPath({
        resolution: {
          kind: 'no-transition',
          fromStatus: 'In Progress',
          toStatus: 'Done',
          available: ['Code Review'],
        },
      }),
      THRESHOLDS,
    );
    expect(decision).toEqual({ kind: 'suppress', why: 'invalid_transition' });
  });

  it('suppresses a transition when the ticket is already in the target status', () => {
    const decision = decideProposal(
      happyPath({ resolution: { kind: 'already-there', status: 'Done' } }),
      THRESHOLDS,
    );
    // Distinct from invalid_transition: "already there" and "Jira won't allow
    // that" read very differently on the card.
    expect(decision).toEqual({ kind: 'suppress', why: 'already_in_status' });
    expect(describeDisposition(decision)).toContain('already in that status');
  });

  it('reports a no-action proposal as nothing to do', () => {
    const decision = decideProposal(
      happyPath({ actions: [{ type: 'none', reason: 'nothing changed' }] }),
      THRESHOLDS,
    );
    expect(decision).toEqual({ kind: 'suppress', why: 'no_action' });
  });

  it('an unreadable issue beats a perfect model verdict', () => {
    const decision = decideProposal(
      happyPath({
        issueExists: false,
        confidence: 1,
        validation: { valid: true, risk: 'low', warnings: [] },
      }),
      THRESHOLDS,
    );
    expect(decision.kind).toBe('suppress');
  });

  it('does not require a transition for a comment-only change', () => {
    const decision = decideProposal(
      happyPath({
        actions: [{ type: 'comment', body: 'Blocked: waiting on credentials' }],
        resolution: { kind: 'no-target' },
      }),
      THRESHOLDS,
    );
    expect(isExecutable(decision)).toBe(true);
  });
});

describe('decideProposal — validator verdict', () => {
  it('suppresses a change the validator rejected', () => {
    const decision = decideProposal(
      happyPath({ validation: { valid: false, risk: 'medium', warnings: [] } }),
      THRESHOLDS,
    );
    expect(decision).toEqual({ kind: 'suppress', why: 'validator_rejected' });
  });

  it('suppresses a high-risk change rather than merely unticking it', () => {
    const decision = decideProposal(
      happyPath({ validation: { valid: true, risk: 'high', warnings: [] } }),
      THRESHOLDS,
    );
    expect(decision).toEqual({ kind: 'suppress', why: 'high_risk' });
    expect(isExecutable(decision)).toBe(false);
  });

  it('unticks a change the validator warned about', () => {
    const decision = decideProposal(
      happyPath({
        validation: { valid: true, risk: 'low', warnings: ['Assigned to someone else.'] },
      }),
      THRESHOLDS,
    );
    expect(decision).toEqual({
      kind: 'review',
      selected: false,
      risk: 'low',
      why: 'validator_warned',
    });
  });

  it('unticks a medium-risk change', () => {
    const decision = decideProposal(
      happyPath({ validation: { valid: true, risk: 'medium', warnings: [] } }),
      THRESHOLDS,
    );
    expect(decision).toEqual({
      kind: 'review',
      selected: false,
      risk: 'medium',
      why: 'medium_risk',
    });
  });

  it('fails closed when validation could not run', () => {
    const decision = decideProposal(
      // No validation verdict at all, and the stage reported unavailable.
      { ...happyPath(), validation: undefined, validationUnavailable: true },
      THRESHOLDS,
    );
    expect(decision).toEqual({
      kind: 'review',
      selected: false,
      risk: 'medium',
      why: 'validation_unavailable',
    });
    // The critical property: never pre-selected without validation.
    expect(decision.kind === 'review' && decision.selected).toBe(false);
  });
});

describe('decideProposal — ambiguity and confidence', () => {
  it('asks rather than proposing when the statement is ambiguous', () => {
    const decision = decideProposal(happyPath({ ambiguous: true }), THRESHOLDS);
    expect(decision).toEqual({ kind: 'clarify', why: 'ambiguous' });
  });

  it('lets ambiguity beat high model confidence', () => {
    const decision = decideProposal(happyPath({ confidence: 1, ambiguous: true }), THRESHOLDS);
    expect(decision.kind).toBe('clarify');
  });

  it('asks when confidence is below the clarify threshold', () => {
    const decision = decideProposal(happyPath({ confidence: 0.3 }), THRESHOLDS);
    expect(decision).toEqual({ kind: 'clarify', why: 'low_confidence' });
  });

  it('unticks a mid-confidence change instead of asking', () => {
    const decision = decideProposal(happyPath({ confidence: 0.65 }), THRESHOLDS);
    expect(decision).toEqual({
      kind: 'review',
      selected: false,
      risk: 'low',
      why: 'medium_confidence',
    });
  });

  it('unticks a change on someone else’s ticket', () => {
    const decision = decideProposal(happyPath({ assignedToSomeoneElse: true }), THRESHOLDS);
    expect(decision).toEqual({
      kind: 'review',
      selected: false,
      risk: 'low',
      why: 'not_assignee',
    });
  });

  it('pre-selects only a confident, valid, low-risk, verified change', () => {
    const decision = decideProposal(happyPath(), THRESHOLDS);
    expect(decision).toEqual({ kind: 'propose', selected: true, risk: 'low' });
  });

  it('pre-selects exactly at the auto-select threshold', () => {
    const decision = decideProposal(happyPath({ confidence: 0.8 }), THRESHOLDS);
    expect(decision.kind).toBe('propose');
  });

  it('does not pre-select just below the auto-select threshold', () => {
    const decision = decideProposal(happyPath({ confidence: 0.79 }), THRESHOLDS);
    expect(decision.kind).toBe('review');
  });

  it('defaults to medium risk when there is no verdict at all', () => {
    const decision = decideProposal({ ...happyPath(), validation: undefined }, THRESHOLDS);
    // No verdict means no pre-selection: confidence alone is never sufficient.
    expect(decision).toEqual({
      kind: 'review',
      selected: false,
      risk: 'medium',
      why: 'medium_risk',
    });
  });
});

describe('decideProposal — check ordering', () => {
  it('an unreadable issue beats everything, including a framed question', () => {
    const decision = decideProposal(
      happyPath({ issueExists: false, ambiguous: true, confidence: 1 }),
      THRESHOLDS,
    );
    // Nothing to act on and nothing worth asking about.
    expect(decision).toEqual({ kind: 'suppress', why: 'issue_missing' });
  });

  it('asks rather than suppressing when a transition is impossible', () => {
    // The question replaces the impossible action, and its options were already
    // filtered against the live transition list — so asking is both safe and
    // strictly more useful than silence.
    const decision = decideProposal(
      {
        confidence: 1,
        resolution: { kind: 'no-target' },
        issueExists: true,
        actions: [transition()],
        validation: { valid: true, risk: 'low', warnings: [] },
        ambiguous: true,
      },
      THRESHOLDS,
    );
    expect(decision).toEqual({ kind: 'clarify', why: 'ambiguous' });
  });

  it('asks rather than suppressing when the validator objects', () => {
    // "Done skips Code Review" is exactly what a clarification resolves.
    const decision = decideProposal(
      happyPath({ validation: { valid: false, risk: 'high', warnings: [] }, ambiguous: true }),
      THRESHOLDS,
    );
    expect(decision).toEqual({ kind: 'clarify', why: 'ambiguous' });
  });

  it('still suppresses a validator rejection when no question was framed', () => {
    const decision = decideProposal(
      happyPath({ validation: { valid: false, risk: 'low', warnings: [] }, ambiguous: false }),
      THRESHOLDS,
    );
    expect(decision).toEqual({ kind: 'suppress', why: 'validator_rejected' });
  });

  it('a clarification is never itself executable', () => {
    const decision = decideProposal(happyPath({ ambiguous: true }), THRESHOLDS);
    expect(isExecutable(decision)).toBe(false);
  });

  it('nothing downstream can re-enable a suppressed change', () => {
    const inputs: ProposalDecisionInput[] = [
      happyPath({ issueExists: false }),
      happyPath({ validation: { valid: false, risk: 'low', warnings: [] } }),
      happyPath({ validation: { valid: true, risk: 'high', warnings: [] } }),
      happyPath({ resolution: { kind: 'no-target' } }),
    ];
    for (const input of inputs) {
      expect(isExecutable(decideProposal(input, THRESHOLDS))).toBe(false);
    }
  });
});

describe('describeDisposition', () => {
  it('says nothing extra for a clean proposal', () => {
    expect(describeDisposition({ kind: 'propose', selected: true, risk: 'low' })).toBe('');
  });

  it('explains every review reason', () => {
    const reasons = [
      'medium_confidence',
      'medium_risk',
      'validator_warned',
      'not_assignee',
      'validation_unavailable',
    ] as const;
    for (const why of reasons) {
      const note = describeDisposition({ kind: 'review', selected: false, risk: 'medium', why });
      expect(note.length).toBeGreaterThan(0);
    }
  });

  it('explains every suppression reason', () => {
    const reasons = [
      'invalid_transition',
      'already_in_status',
      'issue_missing',
      'validator_rejected',
      'high_risk',
      'no_action',
    ] as const;
    for (const why of reasons) {
      expect(describeDisposition({ kind: 'suppress', why }).length).toBeGreaterThan(0);
    }
  });

  it('never leaks an internal reason code to a human', () => {
    const note = describeDisposition({ kind: 'suppress', why: 'invalid_transition' });
    expect(note).not.toContain('invalid_transition');
  });
});

describe('decideBatch', () => {
  const propose = (): ProposalDisposition => ({ kind: 'propose', selected: true, risk: 'low' });
  const review = (): ProposalDisposition => ({
    kind: 'review',
    selected: false,
    risk: 'medium',
    why: 'medium_risk',
  });
  const clarify = (): ProposalDisposition => ({ kind: 'clarify', why: 'ambiguous' });
  const suppress = (why: 'no_action' | 'high_risk' = 'no_action'): ProposalDisposition => ({
    kind: 'suppress',
    why,
  });

  it('posts a proposal card when something is executable', () => {
    expect(decideBatch([propose()], 'ambient')).toEqual({ kind: 'propose' });
    expect(decideBatch([review()], 'ambient')).toEqual({ kind: 'propose' });
  });

  it('asks first when any ticket needs clarification', () => {
    expect(decideBatch([propose(), clarify()], 'ambient')).toEqual({ kind: 'clarify' });
  });

  it('stays silent on an ambient message with nothing to do', () => {
    expect(decideBatch([suppress('no_action')], 'ambient')).toEqual({
      kind: 'silent',
      why: 'nothing_actionable',
    });
  });

  it('stays silent on an ambient message where everything was suppressed', () => {
    expect(decideBatch([suppress('high_risk')], 'ambient')).toEqual({
      kind: 'silent',
      why: 'all_suppressed',
    });
  });

  it('stays silent on an ambient message with no tickets at all', () => {
    expect(decideBatch([], 'ambient').kind).toBe('silent');
  });

  it('always answers a directed message, even with nothing to do', () => {
    // Someone asked. Leaving a question unanswered is its own failure.
    for (const source of ['mention', 'dev', 'clarification'] as const) {
      expect(decideBatch([suppress('no_action')], source)).toEqual({ kind: 'propose' });
      expect(decideBatch([], source)).toEqual({ kind: 'propose' });
    }
  });

  it('still asks for clarification on a directed message', () => {
    expect(decideBatch([clarify()], 'mention')).toEqual({ kind: 'clarify' });
  });

  it('defaults to the quiet behaviour when no source is given', () => {
    expect(decideBatch([suppress('no_action')]).kind).toBe('silent');
  });
});

describe('isExecutable', () => {
  it('is true only for propose and review', () => {
    const risk: RiskLevel = 'low';
    expect(isExecutable({ kind: 'propose', selected: true, risk })).toBe(true);
    expect(isExecutable({ kind: 'review', selected: false, risk, why: 'medium_risk' })).toBe(true);
    expect(isExecutable({ kind: 'clarify', why: 'ambiguous' })).toBe(false);
    expect(isExecutable({ kind: 'suppress', why: 'high_risk' })).toBe(false);
  });
});
