import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import { logger, type Logger } from '../logger.js';
import { StageLogger } from '../observe/stages.js';
import { summarizeTeam } from '../agents/summary-agent.js';
import { isPresent, type JiraContextService } from '../jira/context.js';
import type { ApprovalStore, BlockerRecord } from '../approval/store.js';
import type { LLMClient } from '../llm/types.js';
import type { SummarizeTeamOutput, SummaryIssue } from '../skills/summarize-team.js';
import type { AgentDeps } from '../agents/types.js';
import { describeActions } from '../standup/propose.js';

/**
 * Team standup summary, on demand.
 *
 * Two design constraints:
 *
 * 1. Read-only by construction. The dependencies are a store and a Jira *reads*
 *    service. There is no JiraActions here, so a summary cannot mutate Jira
 *    even by accident, and the architecture test enforces that this module
 *    never imports the write client.
 *
 * 2. No scheduling. This is a function that produces a summary when called.
 *    A cron job, a Teams card action and an HTTP endpoint can all call it, and
 *    adding a scheduler later means writing a scheduler — not touching this
 *    file or the agent. Coupling "when" into "what" is what makes summary code
 *    hard to test.
 *
 * The material is StandSync's own records: what it interpreted, what it
 * proposed, and which blockers are still open. Jira is consulted only to get
 * each issue's current status and summary, so the output cannot drift from
 * reality.
 */

export interface SummaryDeps {
  config: Config;
  store: ApprovalStore;
  context: JiraContextService;
  llm: LLMClient;
  log?: Logger;
}

export interface SummaryRequest {
  conversationId: string;
  /** How far back to look. Defaults to 24 hours. */
  sinceHours?: number;
}

export type SummaryOutcome =
  | {
      ok: true;
      summary: SummarizeTeamOutput;
      /** What the summary was built from, for the caller to show or log. */
      basis: { issueCount: number; contributors: string[]; openBlockers: number };
      period: string;
    }
  | { ok: false; reason: string };

export async function generateSummary(
  deps: SummaryDeps,
  request: SummaryRequest,
): Promise<SummaryOutcome> {
  const sinceHours = request.sinceHours ?? 24;
  const since = new Date(Date.now() - sinceHours * 3_600_000);
  const traceId = randomUUID();
  const stage = new StageLogger(
    { traceId, conversationId: request.conversationId },
    deps.log ?? logger,
  );

  const activity = deps.store.recentActivity(request.conversationId, since.toISOString());
  const blockers = deps.store.getOpenBlockers(request.conversationId);

  // An open blocker is worth reporting even if nobody mentioned its ticket in
  // this window — a blocker that has gone quiet is exactly what a lead wants to
  // know about.
  const keys = [
    ...new Set([...activity.map((a) => a.issueKey), ...blockers.map((b) => b.issueKey)]),
  ];

  if (keys.length === 0) {
    stage.stage('summary_generated', { issueCount: 0, empty: true });
    return {
      ok: true,
      summary: { completed: [], inProgress: [], blocked: [], attention: [] },
      basis: { issueCount: 0, contributors: [], openBlockers: 0 },
      period: describePeriod(sinceHours),
    };
  }

  // Deterministic Jira reads, exactly as the message pipeline does them.
  const bundles = await deps.context.gatherAll(keys);
  const contextByKey = new Map(bundles.map((b) => [b.key, b.context]));
  const blockerByKey = new Map(blockers.map((b) => [b.issueKey, b]));

  const issues: SummaryIssue[] = keys.map((key) => {
    const context = contextByKey.get(key);
    const observations = activity
      .filter((a) => a.issueKey === key)
      .map((a) => describeObservation(a));

    const blocker = blockerByKey.get(key);

    return {
      key,
      summary: isPresent(context) ? context.summary : '(could not be read from Jira)',
      status: isPresent(context) ? context.status : 'unknown',
      observations,
      ...(blocker ? { blocker: toBlockerInput(blocker) } : {}),
    };
  });

  const contributors = [...new Set(activity.map((a) => a.authorName))].filter(Boolean);

  const agentDeps: AgentDeps = {
    llm: deps.llm,
    timeoutMs: deps.config.AGENT_TIMEOUT_MS,
    store: deps.store,
    log: stage,
    traceId,
  };

  const result = await summarizeTeam(
    {
      period: describePeriod(sinceHours),
      today: new Date().toISOString().slice(0, 10),
      issues,
      contributors,
    },
    agentDeps,
  );

  if (!result.ok) {
    // A failed summary is a failed summary. Nothing else degrades, because
    // nothing else depends on this call.
    return { ok: false, reason: result.reason };
  }

  return {
    ok: true,
    summary: result.summary,
    basis: {
      issueCount: issues.length,
      contributors,
      openBlockers: blockers.length,
    },
    period: describePeriod(sinceHours),
  };
}

/**
 * One recorded observation, phrased factually.
 *
 * Includes whether it was actually applied: "proposed X (approved)" and
 * "proposed X (rejected)" mean very different things in a summary, and a
 * rejected proposal must not be reported as work that happened.
 */
function describeObservation(activity: {
  actions: { type: string }[];
  authorName: string;
  batchStatus: string;
  explanation: string;
}): string {
  const applied =
    activity.batchStatus === 'executed' || activity.batchStatus === 'partial'
      ? 'applied'
      : activity.batchStatus === 'rejected'
        ? 'rejected by a human'
        : `${activity.batchStatus}, not applied`;

  return `${activity.authorName}: ${describeActions(
    activity.actions as Parameters<typeof describeActions>[0],
  )} (${applied})`;
}

function toBlockerInput(blocker: BlockerRecord): NonNullable<SummaryIssue['blocker']> {
  return {
    description: blocker.description ?? 'blocked',
    ...(blocker.dependency ? { dependency: blocker.dependency } : {}),
    ...(blocker.severity ? { severity: blocker.severity } : {}),
    timesReported: blocker.timesReported,
    firstSeenAt: blocker.firstSeenAt,
  };
}

function describePeriod(hours: number): string {
  if (hours === 24) return 'the last 24 hours';
  if (hours % 24 === 0) return `the last ${hours / 24} days`;
  return `the last ${hours} hours`;
}
