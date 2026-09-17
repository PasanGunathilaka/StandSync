import { runAgent, recordSkipped } from './runAgent.js';
import {
  validateProposalSkill,
  type ProposedChange,
  type ValidateProposalInput,
  type ValidatedChange,
} from '../skills/validate-proposal.js';
import { isPresent, type IssueContextResult } from '../jira/context.js';
import type { AgentDeps } from './types.js';
import type { RiskLevel } from '../types.js';

/**
 * Agent 3 — proposal validator / critic.
 *
 * A second reasoning pass whose job is to disagree when disagreement is
 * warranted. It receives what StandSync intends to do and the live Jira state,
 * and reports per-ticket verdicts and risk.
 *
 * Two deterministic guarantees wrap the model here, and they are what make this
 * stage worth having rather than just a second opinion:
 *
 * 1. Deterministic checks run regardless. src/jira/statusMap.ts already knows
 *    whether a transition exists; a model agreeing that an impossible transition
 *    is fine cannot make it possible. Those findings are merged in and can only
 *    make the verdict stricter.
 * 2. A failed validation stage is reported as unavailable, never as success.
 *    src/policy/decision-policy.ts turns that into an unticked proposal, so a
 *    validator outage cannot silently promote a change to pre-approved.
 *
 * It has no Jira write access and cannot request one.
 */

export type ValidationVerdict =
  | {
      kind: 'validated';
      overall: { valid: boolean; risk: RiskLevel; explanation: string };
      byKey: Map<string, ValidatedChange>;
    }
  | { kind: 'unavailable'; reason: string };

export interface ValidateInput extends ValidateProposalInput {
  /**
   * Deterministic findings from the workflow, per key. Merged over whatever the
   * model concludes.
   */
  deterministic: Map<string, DeterministicFinding>;
}

/**
 * What StandSync established about a change without asking a model. These are
 * facts, not opinions, so they override the validator.
 */
export interface DeterministicFinding {
  /** False when there is no live transition to the wanted status. */
  transitionAvailable: boolean;
  /** True when the ticket is already in the status the change targets. */
  alreadyInTargetStatus: boolean;
  /** True when the issue could not be read from Jira. */
  issueMissing: boolean;
  /** True when the assignee is somebody other than the message's author. */
  assignedToSomeoneElse: boolean;
}

export async function validateProposals(
  input: ValidateInput,
  deps: AgentDeps,
): Promise<ValidationVerdict> {
  if (input.changes.length === 0) {
    recordSkipped(deps, validateProposalSkill.name, 'no changes to validate');
    return {
      kind: 'validated',
      overall: { valid: true, risk: 'low', explanation: '' },
      byKey: new Map(),
    };
  }

  const result = await runAgent(validateProposalSkill, input, deps);

  if (!result.ok) {
    deps.log.warn('validation_complete', {
      agent: validateProposalSkill.name,
      outcome: result.kind,
      durationMs: result.meta.durationMs,
    });
    // Fail closed. The policy must not read a missing verdict as approval.
    return { kind: 'unavailable', reason: result.reason };
  }

  const byKey = new Map<string, ValidatedChange>();
  for (const change of result.value.changes) {
    // Ignore verdicts about keys we did not ask about.
    if (!input.changes.some((c) => c.key === change.key)) continue;
    if (!byKey.has(change.key)) byKey.set(change.key, change);
  }

  // Any key the validator skipped is treated as un-validated, not as fine.
  for (const change of input.changes) {
    if (!byKey.has(change.key)) {
      byKey.set(change.key, {
        key: change.key,
        valid: true,
        risk: 'medium',
        warnings: ['Validation did not cover this ticket.'],
        explanation: '',
      });
    }
  }

  // Deterministic facts override the model, in the strict direction only.
  for (const [key, finding] of input.deterministic) {
    const current = byKey.get(key);
    if (!current) continue;
    byKey.set(key, applyDeterministic(current, finding));
  }

  const merged = [...byKey.values()];
  const overall = {
    // The batch is only valid if every change in it is.
    valid: merged.every((c) => c.valid),
    risk: highestRisk(merged.map((c) => c.risk)),
    explanation: result.value.explanation,
  };

  deps.log.stage('validation_complete', {
    agent: validateProposalSkill.name,
    valid: overall.valid,
    risk: overall.risk,
    verdicts: merged.map((c) => `${c.key}:${c.valid ? 'ok' : 'rejected'}/${c.risk}`),
    durationMs: result.meta.durationMs,
  });

  return { kind: 'validated', overall, byKey };
}

/**
 * Merges a deterministic finding into a model verdict.
 *
 * Only ever tightens: a fact can invalidate a change or raise its risk, never
 * bless one the model rejected. If Jira says the transition is unavailable, no
 * amount of model confidence makes it available.
 */
export function applyDeterministic(
  verdict: ValidatedChange,
  finding: DeterministicFinding,
): ValidatedChange {
  const warnings = [...verdict.warnings];
  let valid = verdict.valid;
  let risk = verdict.risk;

  if (finding.issueMissing) {
    valid = false;
    risk = 'high';
    warnings.push('This ticket could not be read from Jira.');
  }
  if (!finding.transitionAvailable) {
    valid = false;
    risk = 'high';
    warnings.push('Jira offers no transition to that status from the current one.');
  }
  if (finding.alreadyInTargetStatus) {
    valid = false;
    risk = highestRisk([risk, 'medium']);
    warnings.push('The ticket is already in that status.');
  }
  if (finding.assignedToSomeoneElse) {
    risk = highestRisk([risk, 'medium']);
    warnings.push('Assigned to someone other than the author of the update.');
  }

  return { ...verdict, valid, risk, warnings: [...new Set(warnings)].slice(0, 5) };
}

export function highestRisk(risks: RiskLevel[]): RiskLevel {
  if (risks.includes('high')) return 'high';
  if (risks.includes('medium')) return 'medium';
  return 'low';
}

/** Builds the model-facing description of a change, without transition ids. */
export function toProposedChange(params: {
  key: string;
  change: string;
  intent: string;
  evidence: string;
  confidence: number;
}): ProposedChange {
  return {
    key: params.key,
    proposed: params.change,
    intent: params.intent,
    evidence: params.evidence,
    confidence: params.confidence,
  };
}

/** True when the issue exists and its assignee is not the update's author. */
export function assignedToSomeoneElse(
  context: IssueContextResult | undefined,
  authorName: string,
): boolean {
  if (!isPresent(context) || !context.assignee) return false;
  return context.assignee.trim().toLowerCase() !== authorName.trim().toLowerCase();
}
