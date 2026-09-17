import { runAgent, recordSkipped } from './runAgent.js';
import {
  detectAmbiguitySkill,
  type AmbiguityCandidate,
  type AmbiguousTicket,
  type DetectAmbiguityInput,
} from '../skills/detect-ambiguity.js';
import { isPresent, type IssueContextResult } from '../jira/context.js';
import type { AgentDeps } from './types.js';
import type { ClarificationOption } from '../approval/store.js';

/**
 * Agent 4 — ambiguity detection.
 *
 * Decides where StandSync should ask rather than assume. The rule this enforces
 * is that a hedge is not a decision: "TES-31 is basically finished" is the
 * author telling you they have not decided, and resolving it for them produces a
 * confident-looking card that is wrong a fraction of the time — the worst
 * possible failure mode for something that writes to Jira.
 *
 * Deterministic behaviour around the model:
 *
 * - Options are filtered against the live workflow, so a clarification can
 *   never offer a status Jira cannot reach. The model proposes labels; Jira
 *   decides which survive.
 * - A failed stage means "treat it as ambiguous", not "assume it is clear".
 *   Preferring a question over an assumption is the fail-closed direction here.
 * - A ticket left with fewer than two real options is not ambiguous after all —
 *   there is nothing to ask.
 */

export type AmbiguityVerdict =
  | { kind: 'assessed'; byKey: Map<string, AmbiguityFinding> }
  /** The stage failed. Callers must treat the candidates as ambiguous. */
  | { kind: 'unavailable'; reason: string };

export interface AmbiguityFinding {
  key: string;
  ambiguous: boolean;
  question: string;
  options: ClarificationOption[];
  reason: string;
}

export async function detectAmbiguity(
  input: DetectAmbiguityInput,
  deps: AgentDeps,
): Promise<AmbiguityVerdict> {
  if (input.candidates.length === 0) {
    recordSkipped(deps, detectAmbiguitySkill.name, 'no candidates to assess');
    return { kind: 'assessed', byKey: new Map() };
  }

  const result = await runAgent(detectAmbiguitySkill, input, deps);

  if (!result.ok) {
    deps.log.warn('clarification_required', {
      agent: detectAmbiguitySkill.name,
      outcome: result.kind,
      durationMs: result.meta.durationMs,
    });
    return { kind: 'unavailable', reason: result.reason };
  }

  const byKey = new Map<string, AmbiguityFinding>();

  for (const candidate of input.candidates) {
    const verdict = result.value.tickets.find((t) => t.key === candidate.key);
    const context = input.contexts.find((c) => c.key === candidate.key);
    byKey.set(candidate.key, toFinding(candidate, verdict, context));
  }

  const ambiguous = [...byKey.values()].filter((f) => f.ambiguous);
  if (ambiguous.length) {
    deps.log.stage('clarification_required', {
      agent: detectAmbiguitySkill.name,
      keys: ambiguous.map((f) => f.key),
      durationMs: result.meta.durationMs,
    });
  } else {
    deps.log.quiet('clarification_required', {
      agent: detectAmbiguitySkill.name,
      keys: [],
      durationMs: result.meta.durationMs,
    });
  }

  return { kind: 'assessed', byKey };
}

/**
 * Turns one model verdict into a usable finding, or into "not ambiguous".
 *
 * A verdict the model omitted is not treated as ambiguous: the candidates sent
 * here already passed the confidence threshold, and inventing a question for a
 * ticket the model declined to judge would nag the author for nothing. The
 * fail-closed case that does matter — the whole stage failing — is handled by
 * the caller.
 */
export function toFinding(
  candidate: AmbiguityCandidate,
  verdict: AmbiguousTicket | undefined,
  context: IssueContextResult | undefined,
): AmbiguityFinding {
  const notAmbiguous: AmbiguityFinding = {
    key: candidate.key,
    ambiguous: false,
    question: '',
    options: [],
    reason: '',
  };

  if (!verdict?.ambiguous) return notAmbiguous;

  const options = buildOptions(verdict, context);

  // A question with one answer is not a question.
  if (options.length < 2 || !verdict.question.trim()) return notAmbiguous;

  return {
    key: candidate.key,
    ambiguous: true,
    question: verdict.question.trim(),
    options,
    reason: verdict.reason.trim(),
  };
}

/**
 * Filters the offered options against the live workflow and guarantees an exit.
 *
 * Two things happen here, both deterministic:
 *
 * 1. An option whose label names a status is only kept when the workflow can
 *    actually reach that status. The model proposes labels; Jira decides which
 *    survive, so a developer is never offered a button that resolves to nothing.
 * 2. When a label does name a reachable status, that status is attached as
 *    `targetStatus`. This is what lets "Move to Code Review" mean Code Review:
 *    the intent vocabulary has no term for it, and matching the label against
 *    the live transition list is more reliable than asking the model to restate
 *    the status in a separate field.
 *
 * A "leave it as it is" option is always appended, because declining must never
 * require ignoring the card.
 */
export function buildOptions(
  verdict: AmbiguousTicket,
  context: IssueContextResult | undefined,
): ClarificationOption[] {
  const reachable = isPresent(context) ? context.availableTransitions.filter(Boolean) : [];

  const options: ClarificationOption[] = [];
  const seen = new Set<string>();

  verdict.options.forEach((option, index) => {
    const label = option.label.trim();
    if (!label) return;

    const matched = matchReachableStatus(label, reachable);

    // A label naming a status must name one the workflow offers. Labels that
    // name no status at all ("Keep as is", "Not finished") are kept as written.
    if (reachable.length > 0 && namesAStatus(label) && !matched) return;

    const id = `opt${index}`;
    if (seen.has(label.toLowerCase())) return;
    seen.add(label.toLowerCase());
    options.push({
      id,
      label,
      intent: option.intent,
      // Only for answers that select a destination. A no_change answer must not
      // carry one, or declining would itself become a transition.
      ...(matched && option.intent !== 'no_change' ? { targetStatus: matched } : {}),
    });
  });

  // Always offer a way out that changes nothing.
  if (!options.some((o) => o.intent === 'no_change')) {
    options.push({ id: 'optNoChange', label: 'Leave it as it is', intent: 'no_change' });
  }

  return options.slice(0, 4);
}

/** Heuristic: does this label name a workflow status to move to? */
function namesAStatus(label: string): boolean {
  return /\b(move|transition|set|mark|change)\b/i.test(label);
}

/**
 * The reachable status this label refers to, if any.
 *
 * Longest match wins, so a workflow offering both "Review" and "Code Review"
 * resolves "Move to Code Review" to the more specific one.
 */
export function matchReachableStatus(label: string, reachable: string[]): string | undefined {
  const lower = label.toLowerCase();
  return [...reachable]
    .sort((a, b) => b.length - a.length)
    .find((status) => lower.includes(status.toLowerCase()));
}
