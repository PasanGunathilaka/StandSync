import { runAgent, recordSkipped } from './runAgent.js';
import {
  detectBlockersSkill,
  type DetectBlockersInput,
  type DetectedBlocker,
} from '../skills/detect-blockers.js';
import type { AgentDeps } from './types.js';
import type { ApprovalStore } from '../approval/store.js';

/**
 * Agent 5 — blocker / risk intelligence.
 *
 * This is the observational branch of the pipeline. It records what is holding
 * work up, which is the material a team summary is actually made of, and it does
 * so whether or not the message also warrants a Jira change.
 *
 * Two constraints define it:
 *
 * 1. It never causes a Jira write. Detecting a blocker records an observation;
 *    if a blocker also justifies a Jira action, that action comes from the
 *    normal interpret → validate → policy → approve path like anything else.
 *    This file is handed no JiraActions and could not write if asked.
 * 2. It must not nag. A blocker mentioned in five standups is one open blocker,
 *    not five, so the store deduplicates on (conversation, issue) and this agent
 *    only raises attention for a first sighting or a changed description.
 */

export interface BlockerObservation {
  key: string;
  blocked: boolean;
  category?: string;
  description?: string;
  dependency?: string;
  severity?: string;
  /** True when someone other than the author must act. */
  needsAttention: boolean;
  /** First time this blocker has been seen on this issue in this channel. */
  isNew: boolean;
  /** How many updates have now mentioned it. */
  timesReported: number;
  /** True when this sighting should be surfaced rather than just recorded. */
  shouldSurface: boolean;
}

export interface BlockerResult {
  observations: BlockerObservation[];
  /** True when the stage could not run. Summaries degrade; Jira is unaffected. */
  degraded: boolean;
}

export interface BlockerDeps extends AgentDeps {
  store?: ApprovalStore;
}

export async function detectBlockers(
  input: DetectBlockersInput & { conversationId: string; unblockedKeys: string[] },
  deps: BlockerDeps,
): Promise<BlockerResult> {
  // An author saying a blocker cleared is a deterministic fact about our own
  // records, not something to ask a model about.
  for (const key of input.unblockedKeys) {
    if (deps.store?.resolveBlocker(input.conversationId, key)) {
      deps.log.stage('blocker_detected', { key, resolved: true });
    }
  }

  if (input.keys.length === 0) {
    recordSkipped(deps, detectBlockersSkill.name, 'no keys to check');
    return { observations: [], degraded: false };
  }

  const result = await runAgent(detectBlockersSkill, input, deps);

  if (!result.ok) {
    // A blocker-detection failure degrades summaries only. It must not stop the
    // Jira synchronisation path, which is why this returns rather than throws.
    deps.log.warn('blocker_detected', {
      agent: detectBlockersSkill.name,
      outcome: result.kind,
      durationMs: result.meta.durationMs,
    });
    return { observations: [], degraded: true };
  }

  const observations: BlockerObservation[] = [];

  for (const detected of result.value.blockers) {
    if (!input.keys.includes(detected.key)) continue; // never trust a stray key
    if (!detected.blocked) continue;

    observations.push(persist(detected, input.conversationId, deps.store));
  }

  if (observations.length) {
    deps.log.stage('blocker_detected', {
      agent: detectBlockersSkill.name,
      blockers: observations.map(
        (o) => `${o.key}:${o.category ?? 'other'}${o.isNew ? ':new' : `:x${o.timesReported}`}`,
      ),
      durationMs: result.meta.durationMs,
    });
  }

  return { observations, degraded: false };
}

/**
 * Records one blocker and decides whether it is worth surfacing.
 *
 * `shouldSurface` is the anti-nag rule: a blocker is drawn attention to the
 * first time it is seen, or when its description materially changes. Repeating
 * "TES-42 is still blocked" on every standup trains people to ignore the bot.
 */
function persist(
  detected: DetectedBlocker,
  conversationId: string,
  store: ApprovalStore | undefined,
): BlockerObservation {
  const base = {
    key: detected.key,
    blocked: true as const,
    ...(detected.category ? { category: detected.category } : {}),
    ...(detected.description ? { description: detected.description } : {}),
    ...(detected.dependency ? { dependency: detected.dependency } : {}),
    ...(detected.severity ? { severity: detected.severity } : {}),
    needsAttention: detected.needsAttention,
  };

  if (!store) {
    return { ...base, isNew: true, timesReported: 1, shouldSurface: true };
  }

  const outcome = store.observeBlocker({
    conversationId,
    issueKey: detected.key,
    ...(detected.category ? { category: detected.category } : {}),
    ...(detected.description ? { description: detected.description } : {}),
    ...(detected.dependency ? { dependency: detected.dependency } : {}),
    ...(detected.severity ? { severity: detected.severity } : {}),
  });

  return {
    ...base,
    isNew: outcome.isNew,
    timesReported: outcome.timesReported,
    shouldSurface: outcome.isNew || outcome.changed,
  };
}
