import type { FastifyInstance } from 'fastify';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import type { Logger as PinoLogger } from 'pino';
import { z } from 'zod';
import { logger } from '../logger.js';
import type { JiraActions } from '../jira/actions.js';
import { executeBatch, BatchNotFoundError, rejectBatch } from '../approval/execute.js';
import { runStandupPipeline, type PipelineDeps } from '../standup/pipeline.js';
import { describeActions } from '../standup/propose.js';
import {
  orchestrateMessage,
  type OrchestrationOutcome,
  type OrchestratorDeps,
} from '../agents/orchestrator.js';
import { resolveClarification } from '../agents/clarification.js';
import { generateSummary } from '../summary/service.js';
import type { JiraContextService } from '../jira/context.js';
import type { SummarizeTeamOutput } from '../skills/summarize-team.js';
import type { ProposalBatch } from '../types.js';

/**
 * Development-only endpoints that drive the real pipeline without Teams.
 *
 * These exist so the product stays demonstrable if tenant policy blocks
 * sideloading the Teams app. They call runStandupPipeline and executeBatch —
 * the same functions the Teams handlers use — so nothing here is a parallel
 * implementation that could pass while the real path is broken.
 *
 * Registered only when NODE_ENV=development.
 */

const StandupBody = z.object({
  text: z.string().min(1, 'text is required'),
  author: z.string().trim().min(1).default('Dev User'),
  authorId: z.string().trim().min(1).default('dev-user'),
  conversationId: z.string().trim().min(1).default('dev-conversation'),
});

const ApproveBody = z
  .object({
    /** Omit to apply everything selected; supply ids for Review-mode subsets. */
    proposalIds: z.array(z.string()).optional(),
    approvedBy: z.string().trim().min(1).default('dev-approver'),
  })
  .default({ approvedBy: 'dev-approver' });

const RejectBody = z
  .object({ rejectedBy: z.string().trim().min(1).default('dev-approver') })
  .default({ rejectedBy: 'dev-approver' });

/**
 * Fastify narrows its instance type around the injected logger, so the default
 * FastifyInstance does not match an app built with loggerInstance: pino.
 */
export type StandSyncFastify = FastifyInstance<Server, IncomingMessage, ServerResponse, PinoLogger>;

export interface DevRouteDeps extends PipelineDeps {
  actions: JiraActions;
  /** V2: required by the orchestrator, clarification and summary endpoints. */
  jiraContext?: JiraContextService;
}

const MessageBody = z.object({
  text: z.string().min(1, 'text is required'),
  author: z.string().trim().min(1).default('Dev User'),
  authorId: z.string().trim().min(1).default('dev-user'),
  conversationId: z.string().trim().min(1).default('dev-conversation'),
  /** Teams activity id. Supply the same one twice to exercise deduplication. */
  messageId: z.string().trim().min(1).optional(),
  threadId: z.string().trim().min(1).optional(),
  /**
   * 'ambient' runs the relevance classifier, exactly as an unaddressed channel
   * message would. 'dev' and 'mention' skip it, as a directed message does.
   */
  source: z.enum(['ambient', 'mention', 'dev']).default('ambient'),
});

const ClarifyBody = z.object({
  optionId: z.string().trim().min(1),
  answeredBy: z.string().trim().min(1).default('dev-user'),
  answeredByName: z.string().trim().min(1).default('Dev User'),
});

const SummaryQuery = z.object({
  conversationId: z.string().trim().min(1).default('dev-conversation'),
  sinceHours: z.coerce.number().int().positive().max(720).default(24),
});

export function registerDevRoutes(app: StandSyncFastify, deps: DevRouteDeps): void {
  const log = logger.child({ scope: 'dev-routes' });

  /** Runs the full read-side pipeline and returns the pending batch. */
  app.post('/dev/standup', async (request, reply) => {
    const parsed = StandupBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid body', issues: parsed.error.issues });
    }
    const { text, author, authorId, conversationId } = parsed.data;

    const batch = await runStandupPipeline(deps, {
      text,
      authorId,
      authorName: author,
      conversationId,
      messageId: `dev-${Date.now()}`,
    });

    if (!batch) {
      return reply
        .status(200)
        .send({ batch: null, message: 'No Jira keys found — StandSync stays silent.' });
    }

    return reply.status(200).send({
      batch,
      // A readable echo of what the Adaptive Card will show in Phase 6.
      summary: {
        title: `StandSync found ${countActionable(batch.proposals)} Jira updates`,
        rows: batch.proposals.map((p) => ({
          key: p.key,
          action: describeActions(p.actions),
          confidence: p.confidence,
          selected: p.selected,
          explanation: p.explanation,
        })),
        actions: ['Approve All', 'Review', 'Reject'],
      },
      approveWith: `curl -X POST http://127.0.0.1:${deps.config.PORT}/dev/approve/${batch.id}`,
    });
  });

  /** Applies an approved batch to real Jira. Safe to call twice. */
  app.post('/dev/approve/:batchId', async (request, reply) => {
    const { batchId } = request.params as { batchId: string };
    const parsed = ApproveBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid body', issues: parsed.error.issues });
    }

    try {
      const execution = await executeBatch(deps, batchId, {
        approvedBy: parsed.data.approvedBy,
        ...(parsed.data.proposalIds ? { proposalIds: parsed.data.proposalIds } : {}),
      });

      return reply.status(200).send({
        ...execution,
        summary: execution.results.map(
          (r) => `${r.ok ? 'OK ' : 'FAIL'} ${r.key}: ${r.ok ? r.applied.join(', ') : r.error}`,
        ),
      });
    } catch (err) {
      if (err instanceof BatchNotFoundError) {
        return reply.status(404).send({ error: err.message });
      }
      log.error({ err, batchId }, 'dev approve failed');
      return reply
        .status(500)
        .send({ error: err instanceof Error ? err.message : 'Execution failed' });
    }
  });

  /** Records a rejection. Never calls Jira. */
  app.post('/dev/reject/:batchId', async (request, reply) => {
    const { batchId } = request.params as { batchId: string };
    const parsed = RejectBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid body', issues: parsed.error.issues });
    }

    const rejected = rejectBatch(deps.store, batchId, parsed.data.rejectedBy);
    return reply.status(200).send({
      batchId,
      rejected,
      message: rejected
        ? 'Batch rejected. Nothing was sent to Jira.'
        : 'Batch was already decided.',
    });
  });

  /** Read-back for the demo and for troubleshooting. */
  app.get('/dev/batch/:batchId', async (request, reply) => {
    const { batchId } = request.params as { batchId: string };
    const batch = deps.store.getBatch(batchId);
    if (!batch) return reply.status(404).send({ error: `No batch ${batchId}` });
    return reply.status(200).send({ batch, results: deps.store.getResults(batchId) });
  });

  // ------------------------------------------------------------------- V2

  /**
   * The V2 orchestrator, driven exactly as a Teams message drives it.
   *
   * This calls orchestrateMessage — the same function src/teams/app.ts calls —
   * so the demo path cannot pass while the real one is broken. There is no
   * separate demo logic anywhere in this file.
   */
  app.post('/dev/message', async (request, reply) => {
    const parsed = MessageBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid body', issues: parsed.error.issues });
    }
    if (!deps.jiraContext) {
      return reply.status(503).send({ error: 'JiraContextService is not wired' });
    }

    const body = parsed.data;
    const outcome = await orchestrateMessage(orchestratorDeps(deps, deps.jiraContext), {
      text: body.text,
      authorId: body.authorId,
      authorName: body.author,
      conversationId: body.conversationId,
      messageId: body.messageId ?? `dev-${Date.now()}`,
      ...(body.threadId ? { threadId: body.threadId } : {}),
      source: body.source,
    });

    return reply.status(200).send(describeOutcome(outcome, deps.config.PORT));
  });

  /**
   * Answers a clarification. Produces a *pending* batch that still needs
   * /dev/approve — answering a question is not approving a change.
   */
  app.post('/dev/clarify/:clarificationId', async (request, reply) => {
    const { clarificationId } = request.params as { clarificationId: string };
    const parsed = ClarifyBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid body', issues: parsed.error.issues });
    }
    if (!deps.jiraContext) {
      return reply.status(503).send({ error: 'JiraContextService is not wired' });
    }

    const outcome = await resolveClarification(orchestratorDeps(deps, deps.jiraContext), {
      clarificationId,
      optionId: parsed.data.optionId,
      answeredBy: parsed.data.answeredBy,
      answeredByName: parsed.data.answeredByName,
    });

    switch (outcome.kind) {
      case 'resolved':
        return reply.status(200).send({
          kind: outcome.kind,
          batch: outcome.batch,
          summary: summarize(outcome.batch),
          note: 'A proposal was created. Nothing has been sent to Jira yet.',
          approveWith: `curl -X POST http://127.0.0.1:${deps.config.PORT}/dev/approve/${outcome.batch.id}`,
        });
      case 'not_found':
        return reply.status(404).send({ error: `No clarification ${clarificationId}` });
      case 'already_answered':
        return reply
          .status(409)
          .send({ kind: outcome.kind, error: 'This clarification was already answered.' });
      case 'invalid_option':
        return reply.status(400).send({
          kind: outcome.kind,
          error: 'Unknown optionId',
          validOptions: outcome.clarification.options,
        });
      case 'failed':
        return reply.status(500).send({ kind: outcome.kind, error: outcome.reason });
    }
  });

  /** Read-back for a clarification, so a demo can see the question and options. */
  app.get('/dev/clarification/:clarificationId', async (request, reply) => {
    const { clarificationId } = request.params as { clarificationId: string };
    const clarification = deps.store.getClarification(clarificationId);
    if (!clarification) {
      return reply.status(404).send({ error: `No clarification ${clarificationId}` });
    }
    return reply.status(200).send({ clarification });
  });

  /** The agent trace for one message: which stages ran, how long, and the outcome. */
  app.get('/dev/agents/:traceId', async (request, reply) => {
    const { traceId } = request.params as { traceId: string };
    const runs = deps.store.getAgentRuns(traceId);
    if (runs.length === 0) return reply.status(404).send({ error: `No agent runs for ${traceId}` });

    return reply.status(200).send({
      traceId,
      runs,
      totalDurationMs: runs.reduce((sum, r) => sum + r.durationMs, 0),
      stages: runs.map((r) => `${r.agentName}:${r.resultType}:${r.durationMs}ms`),
    });
  });

  /** Generates a team summary on demand. Read-only; never touches Jira. */
  app.get('/dev/summary', async (request, reply) => {
    const parsed = SummaryQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid query', issues: parsed.error.issues });
    }
    if (!deps.jiraContext) {
      return reply.status(503).send({ error: 'JiraContextService is not wired' });
    }

    const outcome = await generateSummary(
      {
        config: deps.config,
        store: deps.store,
        context: deps.jiraContext,
        llm: deps.llm,
        ...(deps.log ? { log: deps.log } : {}),
      },
      {
        conversationId: parsed.data.conversationId,
        sinceHours: parsed.data.sinceHours,
      },
    );

    if (!outcome.ok) return reply.status(503).send({ error: outcome.reason });

    return reply.status(200).send({
      period: outcome.period,
      basis: outcome.basis,
      summary: outcome.summary,
      text: renderSummaryText(outcome.summary),
    });
  });

  /** Open blockers StandSync has recorded for a conversation. */
  app.get('/dev/blockers', async (request, reply) => {
    const conversationId =
      (request.query as { conversationId?: string }).conversationId ?? 'dev-conversation';
    return reply.status(200).send({
      conversationId,
      blockers: deps.store.getOpenBlockers(conversationId),
    });
  });

  log.info(
    'dev endpoints enabled: /dev/standup (V1), /dev/message (V2), /dev/clarify/:id, ' +
      '/dev/approve/:id, /dev/reject/:id, /dev/batch/:id, /dev/agents/:traceId, ' +
      '/dev/summary, /dev/blockers',
  );
}

/** The orchestrator's dependency slice. No JiraActions: agents cannot write. */
function orchestratorDeps(deps: DevRouteDeps, jiraContext: JiraContextService): OrchestratorDeps {
  return {
    config: deps.config,
    store: deps.store,
    context: jiraContext,
    llm: deps.llm,
    ...(deps.log ? { log: deps.log } : {}),
  };
}

/** Turns an orchestration outcome into a response a demo can read. */
function describeOutcome(outcome: OrchestrationOutcome, port: number): Record<string, unknown> {
  switch (outcome.kind) {
    case 'ignored':
      return {
        kind: outcome.kind,
        reason: outcome.reason,
        detail: outcome.detail,
        message: 'StandSync stayed silent. Nothing was posted and nothing was changed in Jira.',
      };

    case 'failed':
      return {
        kind: outcome.kind,
        reason: outcome.reason,
        message: 'A reasoning stage failed, so no proposal was created. Jira is untouched.',
      };

    case 'clarification':
      return {
        kind: outcome.kind,
        clarifications: outcome.clarifications.map((c) => ({
          id: c.id,
          issueKey: c.issueKey,
          question: c.question,
          options: c.options,
          answerWith:
            `curl -X POST http://127.0.0.1:${port}/dev/clarify/${c.id} ` +
            `-H "content-type: application/json" -d '{"optionId":"${c.options[0]?.id ?? 'opt0'}"}'`,
        })),
        message: 'StandSync asked instead of guessing. Nothing was changed in Jira.',
      };

    case 'silent':
      return {
        kind: outcome.kind,
        reason: outcome.reason,
        batch: outcome.batch,
        summary: summarize(outcome.batch),
        message: 'Recorded for audit but deliberately not posted to the channel.',
      };

    case 'proposal':
      return {
        kind: outcome.kind,
        batch: outcome.batch,
        summary: summarize(outcome.batch),
        blockers: outcome.blockers,
        traceId: outcome.batch.origin?.traceId,
        message: 'Proposal created. Nothing has been sent to Jira yet.',
        approveWith: `curl -X POST http://127.0.0.1:${port}/dev/approve/${outcome.batch.id}`,
        traceWith: `curl http://127.0.0.1:${port}/dev/agents/${outcome.batch.origin?.traceId ?? ''}`,
      };
  }
}

/** A readable echo of what the Adaptive Card will show. */
function summarize(batch: ProposalBatch): Record<string, unknown> {
  return {
    title: `StandSync understood ${countActionable(batch.proposals)} Jira change(s)`,
    source: batch.origin?.source,
    classification: batch.origin?.classification,
    rows: batch.proposals.map((p) => ({
      key: p.key,
      action: describeActions(p.actions),
      confidence: p.confidence,
      selected: p.selected,
      risk: p.review?.risk,
      validated: p.review?.validated,
      transitionVerified: p.review?.transitionVerified,
      warnings: p.review?.warnings ?? [],
      explanation: p.explanation,
    })),
    actions: ['Approve Selected', 'Review', 'Reject'],
  };
}

/** Plain-text rendering of a summary, matching the card layout. */
function renderSummaryText(summary: SummarizeTeamOutput): string {
  const empty =
    summary.completed.length === 0 &&
    summary.inProgress.length === 0 &&
    summary.blocked.length === 0 &&
    summary.attention.length === 0;

  // Checked up front rather than by testing the joined string: the heading is
  // always present, so a trailing `|| fallback` would never fire.
  if (empty) return 'StandSync Daily Summary\n\nNo standup activity recorded for this period.';

  const lines: string[] = ['StandSync Daily Summary', ''];

  const section = (title: string, items: { key: string; text: string }[]): void => {
    if (items.length === 0) return;
    lines.push(title);
    for (const item of items) lines.push(`• ${item.key} — ${item.text}`);
    lines.push('');
  };

  section('Completed', summary.completed);
  section('In Progress', summary.inProgress);
  section('Blocked', summary.blocked);

  if (summary.attention.length) {
    lines.push('Attention');
    for (const item of summary.attention) lines.push(`• ${item}`);
  }

  return lines.join('\n').trim();
}

function countActionable(proposals: { actions: { type: string }[] }[]): number {
  return proposals.filter((p) => p.actions.some((a) => a.type !== 'none')).length;
}
