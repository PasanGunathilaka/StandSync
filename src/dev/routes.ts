import type { FastifyInstance } from 'fastify';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import type { Logger as PinoLogger } from 'pino';
import { z } from 'zod';
import { logger } from '../logger.js';
import type { JiraActions } from '../jira/actions.js';
import { executeBatch, BatchNotFoundError, rejectBatch } from '../approval/execute.js';
import { runStandupPipeline, type PipelineDeps } from '../standup/pipeline.js';
import { describeActions } from '../standup/propose.js';

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
}

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

  log.info(
    'dev endpoints enabled: /dev/standup, /dev/approve/:id, /dev/reject/:id, /dev/batch/:id',
  );
}

function countActionable(proposals: { actions: { type: string }[] }[]): number {
  return proposals.filter((p) => p.actions.some((a) => a.type !== 'none')).length;
}
