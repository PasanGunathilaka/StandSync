import { runAgent } from './runAgent.js';
import {
  summarizeTeamSkill,
  type SummarizeTeamInput,
  type SummarizeTeamOutput,
} from '../skills/summarize-team.js';
import type { AgentDeps } from './types.js';

/**
 * Agent 9 — team standup summary.
 *
 * Summarizes what StandSync has already recorded. It is read-only by
 * construction: the service that drives it is handed a store and a Jira *reads*
 * client, never JiraActions, so there is no path from a summary to a Jira write
 * even if the model asked for one.
 *
 * Grounding is enforced rather than requested. The model is given a closed list
 * of issues and its output is filtered back down to that list here — a key it
 * invents is dropped rather than shown, so a summary cannot name a ticket the
 * team does not have.
 */

export type SummaryResult =
  { ok: true; summary: SummarizeTeamOutput } | { ok: false; reason: string };

export async function summarizeTeam(
  input: SummarizeTeamInput,
  deps: AgentDeps,
): Promise<SummaryResult> {
  if (input.issues.length === 0) {
    // Nothing recorded is a real answer, and it needs no model call.
    return {
      ok: true,
      summary: { completed: [], inProgress: [], blocked: [], attention: [] },
    };
  }

  const result = await runAgent(summarizeTeamSkill, input, deps);

  if (!result.ok) {
    // A summary failure must not affect anything else. The caller reports that
    // the summary is unavailable; Jira synchronisation is untouched.
    deps.log.warn('summary_generated', {
      agent: summarizeTeamSkill.name,
      outcome: result.kind,
      durationMs: result.meta.durationMs,
    });
    return { ok: false, reason: result.reason };
  }

  const summary = groundToInput(result.value, input);

  deps.log.stage('summary_generated', {
    agent: summarizeTeamSkill.name,
    completed: summary.completed.length,
    inProgress: summary.inProgress.length,
    blocked: summary.blocked.length,
    attention: summary.attention.length,
    durationMs: result.meta.durationMs,
  });

  return { ok: true, summary };
}

/**
 * Drops anything the model introduced that was not in the input.
 *
 * A summary is only useful if it is true. The model is asked not to invent
 * tickets; this makes it structurally unable to. A ticket listed in more than
 * one group is kept in the first one, so a reader never sees the same key under
 * both Completed and Blocked.
 */
export function groundToInput(
  output: SummarizeTeamOutput,
  input: SummarizeTeamInput,
): SummarizeTeamOutput {
  const allowed = new Set(input.issues.map((i) => i.key));
  const placed = new Set<string>();

  const filter = (lines: SummarizeTeamOutput['completed']): SummarizeTeamOutput['completed'] =>
    lines.filter((line) => {
      if (!allowed.has(line.key) || placed.has(line.key)) return false;
      placed.add(line.key);
      return true;
    });

  // Blocked first: a blocked ticket must not be reported as merely in progress.
  const blocked = filter(output.blocked);
  const completed = filter(output.completed);
  const inProgress = filter(output.inProgress);

  return {
    completed,
    inProgress,
    blocked,
    attention: output.attention.filter((item) => item.trim().length > 0),
  };
}
