import type { Config } from '../config.js';
import type { ProposalAction, RiskLevel } from '../types.js';
import type { StatusResolution } from '../jira/statusMap.js';

/**
 * The one place StandSync decides what to do with a proposed change.
 *
 * Every threshold and every "should we act on this?" rule lives here rather
 * than scattered across handlers, because the thing that makes an assistant
 * trustworthy is that its caution is consistent. A rule spread across three
 * files becomes three slightly different rules.
 *
 * The central principle: model confidence is never sufficient on its own. A
 * decision combines
 *
 *   - model confidence (the interpreter's, per ticket)
 *   - deterministic Jira validation (does the transition actually exist?)
 *   - the validator agent's verdict and risk grade
 *   - the ambiguity verdict
 *   - whether the issue exists and is readable
 *   - author vs assignee
 *
 * and any one of them can veto. Failure of a *stage* is treated as a veto too,
 * which is what makes the degradation strategy fail closed: a validator that
 * could not be reached cannot bless a change.
 */

export interface PolicyThresholds {
  /** At or above this, a valid low-risk change is pre-ticked on the card. */
  autoSelectConfidence: number;
  /** Below this, ask the developer rather than propose. */
  clarifyConfidence: number;
  /** Classifier confidence needed to admit an ambient message. */
  relevanceConfidence: number;
}

export function thresholdsFrom(config: Config): PolicyThresholds {
  return {
    autoSelectConfidence: config.POLICY_AUTO_SELECT_CONFIDENCE,
    clarifyConfidence: config.POLICY_CLARIFY_CONFIDENCE,
    relevanceConfidence: config.POLICY_RELEVANCE_CONFIDENCE,
  };
}

// ---------------------------------------------------------------- relevance

export type RelevanceDecision =
  | { admit: true; reason: 'fast_path' | 'classified_relevant' }
  | { admit: false; reason: 'classified_irrelevant' | 'low_confidence' | 'classifier_failed' };

/**
 * Whether an ambient message enters the pipeline.
 *
 * A failed classifier does NOT admit the message. Silence is the safe failure
 * for ingress: the cost of ignoring one standup is that a developer repeats
 * themselves, while the cost of processing everything is a bot that reacts to a
 * whole channel. Staying quiet also cannot produce a wrong Jira write.
 */
export function decideRelevance(
  input:
    | { kind: 'fast_path' }
    | { kind: 'classifier_failed' }
    | { kind: 'classified'; relevant: boolean; confidence: number },
  thresholds: PolicyThresholds,
): RelevanceDecision {
  if (input.kind === 'fast_path') return { admit: true, reason: 'fast_path' };
  if (input.kind === 'classifier_failed') return { admit: false, reason: 'classifier_failed' };

  if (!input.relevant) return { admit: false, reason: 'classified_irrelevant' };
  if (input.confidence < thresholds.relevanceConfidence) {
    return { admit: false, reason: 'low_confidence' };
  }
  return { admit: true, reason: 'classified_relevant' };
}

// ------------------------------------------------------------- per-proposal

/** What the policy decided to do about one ticket. */
export type ProposalDisposition =
  /** Show it, pre-ticked. High confidence, low risk, verified transition. */
  | { kind: 'propose'; selected: true; risk: RiskLevel }
  /** Show it, unticked — a human should opt in deliberately. */
  | { kind: 'review'; selected: false; risk: RiskLevel; why: ReviewReason }
  /** Ask the developer instead of proposing anything executable. */
  | { kind: 'clarify'; why: ClarifyReason }
  /** Show it as informational only; the action is stripped. */
  | { kind: 'suppress'; why: SuppressReason };

export type ReviewReason =
  | 'medium_confidence'
  | 'medium_risk'
  | 'validator_warned'
  | 'not_assignee'
  | 'validation_unavailable';

export type ClarifyReason = 'ambiguous' | 'low_confidence';

export type SuppressReason =
  | 'invalid_transition'
  | 'already_in_status'
  | 'issue_missing'
  | 'validator_rejected'
  | 'high_risk'
  | 'no_action';

export interface ProposalDecisionInput {
  /** The interpreter's confidence for this ticket. */
  confidence: number;
  /** Deterministic outcome of resolving intent against the live workflow. */
  resolution: StatusResolution | undefined;
  /** False when the issue could not be read from Jira. */
  issueExists: boolean;
  /** The actions StandSync would apply. */
  actions: ProposalAction[];
  /** Validator verdict for this ticket. Absent when the stage did not run. */
  validation?: { valid: boolean; risk: RiskLevel; warnings: string[] };
  /** True when the validator stage failed outright. */
  validationUnavailable?: boolean;
  /** Ambiguity verdict for this ticket. */
  ambiguous?: boolean;
  /** True when the ticket is assigned to someone other than the author. */
  assignedToSomeoneElse?: boolean;
}

/**
 * Decides the fate of one proposed change.
 *
 * Read top to bottom: the checks are ordered from "cannot possibly be right" to
 * "probably right but worth a glance", and the first match wins. Nothing later
 * in the list can upgrade something an earlier check rejected.
 */
export function decideProposal(
  input: ProposalDecisionInput,
  thresholds: PolicyThresholds,
): ProposalDisposition {
  const actionable = input.actions.some((a) => a.type !== 'none');

  // 1. The one veto nothing can override: an issue we could not read. There is
  //    no safe action and nothing worth asking about.
  if (!input.issueExists) return { kind: 'suppress', why: 'issue_missing' };

  // 2. A real, answerable question outranks every reason to suppress the
  //    action, because the question *replaces* the action rather than
  //    performing it.
  //
  //    This ordering is deliberate and it is where V2 earns its keep. Every
  //    reason below — no action available, transition impossible, the validator
  //    objecting that Done skips Code Review — describes the *proposed* change
  //    being wrong. That is precisely what a question resolves. Suppressing
  //    instead would mean StandSync noticed the problem, knew the two or three
  //    plausible answers, and said nothing.
  //
  //    It is safe because `ambiguous` is only ever true when the ambiguity agent
  //    produced at least two options, and those options were already filtered
  //    against the live transition list. So a clarification cannot offer a
  //    status Jira is unable to reach, and answering one still goes through
  //    validation and human approval.
  if (input.ambiguous) return { kind: 'clarify', why: 'ambiguous' };

  // 3. Hard vetoes from deterministic Jira facts. These are not judgement calls.
  if (!actionable) return { kind: 'suppress', why: 'no_action' };

  const wantsTransition = input.actions.some((a) => a.type === 'transition');
  if (wantsTransition && input.resolution?.kind !== 'transition') {
    // A transition StandSync cannot name a live id for must never be offered as
    // executable, whatever the model concluded. The two cases are distinguished
    // because they read very differently to the person seeing the card:
    // "Jira won't allow that" is not the same as "it's already there".
    return input.resolution?.kind === 'already-there'
      ? { kind: 'suppress', why: 'already_in_status' }
      : { kind: 'suppress', why: 'invalid_transition' };
  }

  // 4. The validator's verdict. A rejection or a high-risk grade strips the
  //    action rather than merely unticking it — "high risk" means "we think this
  //    is wrong", and an approver should not be one click from applying it.
  if (input.validation && !input.validation.valid) {
    return { kind: 'suppress', why: 'validator_rejected' };
  }
  if (input.validation?.risk === 'high') {
    return { kind: 'suppress', why: 'high_risk' };
  }

  // 5. Too unsure to propose, but no question was framed for it.
  if (input.confidence < thresholds.clarifyConfidence) {
    return { kind: 'clarify', why: 'low_confidence' };
  }

  const risk: RiskLevel = input.validation?.risk ?? 'medium';

  // 4. Fail closed on a missing validation stage: unticked, never pre-approved.
  if (input.validationUnavailable) {
    return { kind: 'review', selected: false, risk: 'medium', why: 'validation_unavailable' };
  }

  // 5. Soft cautions — show it, but make the human opt in.
  if (input.validation?.warnings.length) {
    return { kind: 'review', selected: false, risk, why: 'validator_warned' };
  }
  if (input.assignedToSomeoneElse) {
    return { kind: 'review', selected: false, risk, why: 'not_assignee' };
  }
  if (risk === 'medium') {
    return { kind: 'review', selected: false, risk, why: 'medium_risk' };
  }
  if (input.confidence < thresholds.autoSelectConfidence) {
    return { kind: 'review', selected: false, risk, why: 'medium_confidence' };
  }

  // 6. High confidence, low risk, verified transition, nothing flagged.
  return { kind: 'propose', selected: true, risk };
}

/** Whether a disposition leaves an executable action on the card. */
export function isExecutable(disposition: ProposalDisposition): boolean {
  return disposition.kind === 'propose' || disposition.kind === 'review';
}

/** Human-readable note for the card, explaining a downgrade. */
export function describeDisposition(disposition: ProposalDisposition): string {
  switch (disposition.kind) {
    case 'propose':
      return '';
    case 'review':
      return REVIEW_NOTES[disposition.why];
    case 'clarify':
      return disposition.why === 'ambiguous'
        ? 'Needs clarification before StandSync proposes anything.'
        : 'Too unclear to propose a change confidently.';
    case 'suppress':
      return SUPPRESS_NOTES[disposition.why];
  }
}

const REVIEW_NOTES: Record<ReviewReason, string> = {
  medium_confidence: 'Moderate confidence — review before approving.',
  medium_risk: 'Worth a check before approving.',
  validator_warned: 'Flagged during validation — see the note above.',
  not_assignee: 'This ticket is assigned to someone else.',
  validation_unavailable: 'Validation could not run, so this is not pre-selected.',
};

const SUPPRESS_NOTES: Record<SuppressReason, string> = {
  invalid_transition: 'Jira offers no transition to that status right now.',
  already_in_status: 'The ticket is already in that status.',
  issue_missing: 'This ticket could not be read from Jira.',
  validator_rejected: 'Validation found this change is not justified.',
  high_risk: 'Validation rated this change high risk, so it is not offered.',
  no_action: 'Nothing to change.',
};

// -------------------------------------------------------------- batch level

export type BatchDisposition =
  /** Post a proposal card. */
  | { kind: 'propose' }
  /** Post a clarification card first. */
  | { kind: 'clarify' }
  /** Store for audit, post nothing. Ambient mode must not produce noise. */
  | { kind: 'silent'; why: 'nothing_actionable' | 'all_suppressed' };

/**
 * What to show in the channel for a whole message.
 *
 * Clarification wins over proposing: if any ticket needs a question, the author
 * answers it and the batch is rebuilt, rather than being shown a card that is
 * half-proposal and half-question.
 *
 * `silent` matters as much as the others, and it is where the two ingress modes
 * legitimately differ. Nobody asked StandSync to read an ambient message, so a
 * batch with nothing to propose is recorded and not posted. A *directed*
 * message is a question from a human, and leaving a question unanswered is its
 * own failure — so when the author addressed StandSync, an explanation is
 * posted even if the answer is "nothing to do".
 */
export function decideBatch(
  dispositions: ProposalDisposition[],
  source: 'mention' | 'ambient' | 'dev' | 'clarification' = 'ambient',
): BatchDisposition {
  const directed = source !== 'ambient';

  if (dispositions.length === 0) {
    return directed ? { kind: 'propose' } : { kind: 'silent', why: 'nothing_actionable' };
  }

  if (dispositions.some((d) => d.kind === 'clarify')) return { kind: 'clarify' };
  if (dispositions.some(isExecutable)) return { kind: 'propose' };
  if (directed) return { kind: 'propose' };

  const hadSomethingToSay = dispositions.some(
    (d) => d.kind === 'suppress' && d.why !== 'no_action',
  );
  return { kind: 'silent', why: hadSomethingToSay ? 'all_suppressed' : 'nothing_actionable' };
}
