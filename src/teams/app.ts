import { App } from '@microsoft/teams.apps';
import type { Config } from '../config.js';
import { logger, type Logger } from '../logger.js';
import type { JiraActions } from '../jira/actions.js';
import type { PipelineDeps } from '../standup/pipeline.js';
import { runStandupPipeline } from '../standup/pipeline.js';
import type { StandSyncFastify } from '../dev/routes.js';
import { FastifyHttpServerAdapter } from './fastifyAdapter.js';
import { isAllowedConversation, isFromBot, logGuardDecision } from './channelGuard.js';
import { handleCardAction, describeForUser } from './actions.js';
import { buildApplyingCard, buildErrorCard, buildProposalCard } from './cards.js';

/**
 * Teams wiring.
 *
 * The Teams SDK runs on the existing Fastify server via FastifyHttpServerAdapter,
 * so there is exactly one HTTP server. `app.initialize()` registers the messaging
 * endpoint on Fastify; `app.start()` is never called, because Fastify owns
 * listening.
 *
 * Message handling and card actions both delegate to the same pipeline and
 * executor the /dev/* endpoints use.
 */

export interface TeamsDeps extends PipelineDeps {
  config: Config;
  actions: JiraActions;
  log?: Logger;
}

export function isTeamsConfigured(config: Config): boolean {
  return Boolean(config.MICROSOFT_APP_ID && config.MICROSOFT_APP_PASSWORD);
}

/**
 * Builds the Teams App bound to Fastify. Call `await app.initialize()` before
 * Fastify starts listening so the route exists when the first activity arrives.
 */
export function createTeamsApp(fastify: StandSyncFastify, deps: TeamsDeps): App {
  const { config } = deps;
  const log = (deps.log ?? logger).child({ scope: 'teams' });

  const app = new App({
    clientId: config.MICROSOFT_APP_ID,
    clientSecret: config.MICROSOFT_APP_PASSWORD,
    ...(config.MICROSOFT_APP_TENANT_ID ? { tenantId: config.MICROSOFT_APP_TENANT_ID } : {}),
    httpServerAdapter: new FastifyHttpServerAdapter(fastify),
    messagingEndpoint: config.TEAMS_MESSAGING_ENDPOINT,
    // Local development without a real bot registration; never enable in production.
    dangerouslyAllowUnauthenticatedRequests: config.TEAMS_ALLOW_UNAUTHENTICATED,
    // Mention markup is stripped again in cleanMessageText, this just helps.
    activity: { mentions: { stripText: true } },
  });

  app.on('message', async (ctx) => {
    const conversationId = ctx.activity.conversation.id;
    const from = ctx.activity.from;

    // 1. Never react to our own (or any bot's) messages.
    if (isFromBot(from, config.MICROSOFT_APP_ID)) {
      log.debug({ conversationId }, 'ignoring bot message');
      return;
    }

    // 2. Only the configured channel may drive Jira changes.
    const guard = isAllowedConversation(conversationId, config.TEAMS_ALLOWED_CONVERSATION_ID);
    if (!guard.allowed) {
      logGuardDecision(log, guard, { conversationId });
      return;
    }

    const text = ctx.activity.text ?? '';

    try {
      // 3. runStandupPipeline returns null when there are no Jira keys, which is
      //    how StandSync stays silent on ordinary channel chatter.
      const batch = await runStandupPipeline(deps, {
        text,
        authorId: from.id,
        authorName: from.name ?? 'a teammate',
        conversationId,
        messageId: ctx.activity.id,
      });

      if (!batch) return;

      // 4. Reply in-thread with the proposal card.
      const sent = await ctx.reply({
        type: 'message',
        attachments: [
          {
            contentType: 'application/vnd.microsoft.card.adaptive',
            content: buildProposalCard(batch),
          },
        ],
      });

      // Remember the card so it can be updated to "Applying…" later.
      if (sent.id) deps.store.setCardActivityId(batch.id, sent.id);
      log.info({ batchId: batch.id, activityId: sent.id }, 'proposal card posted');
    } catch (err) {
      log.error({ err, conversationId }, 'standup pipeline failed');
      await ctx
        .reply({
          type: 'message',
          attachments: [
            {
              contentType: 'application/vnd.microsoft.card.adaptive',
              content: buildErrorCard(
                'StandSync could not read that standup',
                describeForUser(err),
              ),
            },
          ],
        })
        .catch(() => {
          /* a failed error reply must not crash the handler */
        });
    }
  });

  /**
   * Action.Execute handler. Returning a card response replaces the card in place,
   * which is how the flow moves Pending -> Applying -> Result.
   */
  app.on('card.action', async (ctx) => {
    const from = ctx.activity.from;
    const conversationId = ctx.activity.conversation.id;

    const guard = isAllowedConversation(conversationId, config.TEAMS_ALLOWED_CONVERSATION_ID);
    if (!guard.allowed) {
      logGuardDecision(log, guard, { conversationId, scope: 'card-action' });
      return cardResponse(
        buildErrorCard('Not available here', 'StandSync is not enabled for this channel.'),
      );
    }

    const data: unknown = ctx.activity.value?.action?.data;

    // Show "Applying…" in place of the buttons before the Jira calls start, so a
    // slow Jira cannot leave a live Approve button on screen.
    const applyingFor = pendingBatchForApply(data, deps);
    if (applyingFor) {
      await updateCard(ctx, applyingFor.cardActivityId, buildApplyingCard(applyingFor.batch)).catch(
        (err: unknown) => log.debug({ err }, 'could not show Applying card'),
      );
    }

    const outcome = await handleCardAction(
      {
        store: deps.store,
        actions: deps.actions,
        approvalPolicy: config.APPROVAL_POLICY,
        log: deps.log,
      },
      {
        data,
        userId: from.id,
        userName: from.name ?? 'A teammate',
      },
    );

    return cardResponse(outcome.card);
  });

  log.info(
    {
      endpoint: config.TEAMS_MESSAGING_ENDPOINT,
      allowedConversation: config.TEAMS_ALLOWED_CONVERSATION_ID || '(not set — will ignore all)',
      approvalPolicy: config.APPROVAL_POLICY,
    },
    'Teams app created on the Fastify server',
  );

  return app;
}

/** The invoke response shape that replaces the current card. */
function cardResponse(card: unknown) {
  return {
    statusCode: 200 as const,
    type: 'application/vnd.microsoft.card.adaptive' as const,
    value: card as never,
  };
}

/**
 * Resolves the batch for an apply-style action, so the card can be flipped to
 * "Applying…" first. Returns undefined for review/reject, which are instant.
 */
function pendingBatchForApply(
  data: unknown,
  deps: TeamsDeps,
):
  | { batch: NonNullable<ReturnType<TeamsDeps['store']['getBatch']>>; cardActivityId?: string }
  | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const record = data as Record<string, unknown>;
  const action = record['action'];
  const batchId = record['batchId'];

  if (action !== 'approve_all' && action !== 'apply_selected') return undefined;
  if (typeof batchId !== 'string') return undefined;

  const batch = deps.store.getBatch(batchId);
  if (!batch || batch.status !== 'pending') return undefined;

  const cardActivityId = deps.store.getCardActivityId(batchId);
  return cardActivityId ? { batch, cardActivityId } : { batch };
}

/** Replaces an already-posted card via the conversation API. */
async function updateCard(
  ctx: { api: { conversations: unknown }; activity: { conversation: { id: string } } },
  activityId: string | undefined,
  card: unknown,
): Promise<void> {
  if (!activityId) return;
  const conversations = ctx.api.conversations as {
    activities: (conversationId: string) => {
      update: (id: string, params: unknown) => Promise<unknown>;
    };
  };

  await conversations.activities(ctx.activity.conversation.id).update(activityId, {
    type: 'message',
    attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }],
  });
}
