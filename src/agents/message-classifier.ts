import { runAgent, recordSkipped } from './runAgent.js';
import { detectStandupSkill, type ClassifyOutput } from '../skills/detect-standup.js';
import { isFastPathCandidate } from '../teams/ambient.js';
import type { AgentDeps } from './types.js';
import type { MessageKind } from '../types.js';

/**
 * Agent 1 — message relevance classifier.
 *
 * Decides whether an ambient message enters the pipeline at all. The bounded
 * reasoning lives in the detect-standup skill; this file is the deterministic
 * wrapper around it:
 *
 * - a fast path, so an unambiguous work update costs no model call
 * - a typed failure that the policy reads as "stay silent", not "assume relevant"
 *
 * The asymmetry is intentional. The fast path only ever *admits* a message for
 * further reasoning — it never concludes that something is irrelevant, because
 * a regex is the wrong tool for deciding that a human's sentence does not
 * matter. Irrelevance is always either obvious chatter (handled before this, in
 * src/teams/ambient.ts) or the model's judgement.
 */

export interface ClassificationInput {
  text: string;
  authorName: string;
  conversation: string;
  detectedKeys: string[];
  context: { authorName: string; text: string }[];
  today: string;
}

export type Classification =
  | {
      kind: 'fast_path';
      relevant: true;
      type: MessageKind;
      confidence: number;
      reason: string;
    }
  | {
      kind: 'classified';
      relevant: boolean;
      type: MessageKind;
      confidence: number;
      reason: string;
    }
  | { kind: 'classifier_failed'; reason: string };

export async function classifyMessage(
  input: ClassificationInput,
  deps: AgentDeps,
): Promise<Classification> {
  // A Jira key plus a work verb is not a judgement call. Skip the model.
  if (isFastPathCandidate(input.text)) {
    recordSkipped(deps, detectStandupSkill.name, 'fast path: Jira key with a work verb');
    return {
      kind: 'fast_path',
      relevant: true,
      type: 'work_update',
      confidence: 1,
      reason: 'Message names a Jira ticket and describes work on it.',
    };
  }

  const result = await runAgent(detectStandupSkill, input, deps);

  if (!result.ok) {
    deps.log.warn('classification_complete', {
      agent: detectStandupSkill.name,
      outcome: result.kind,
      durationMs: result.meta.durationMs,
    });
    return { kind: 'classifier_failed', reason: result.reason };
  }

  const value: ClassifyOutput = result.value;

  deps.log.stage('classification_complete', {
    agent: detectStandupSkill.name,
    type: value.type,
    relevant: value.relevant,
    confidence: value.confidence,
    durationMs: result.meta.durationMs,
  });

  return {
    kind: 'classified',
    // 'unrelated' and 'jira_reference' are never relevant, whatever the model
    // set on the boolean — the type it chose is the stronger signal, and a
    // self-contradicting answer should resolve to the quieter reading.
    relevant: value.relevant && value.type !== 'unrelated' && value.type !== 'jira_reference',
    type: value.type,
    confidence: value.confidence,
    reason: value.reason,
  };
}
