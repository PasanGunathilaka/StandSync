import { App } from '@microsoft/teams.apps';
import type { Config } from '../config.js';
import { logger, type Logger } from '../logger.js';
import type { JiraActions } from '../jira/actions.js';
import type { PipelineDeps } from '../standup/pipeline.js';
import { runStandupPipeline } from '../standup/pipeline.js';
import type { StandSyncFastify } from '../dev/routes.js';
import { FastifyHttpServerAdapter } from './fastifyAdapter.js';
import { isAllowedConversation, logGuardDecision } from './channelGuard.js';
import { classifyIngress, ambientConversations, type AmbientActivity } from './ambient.js';
import { handleCardAction, describeForUser } from './actions.js';
import { buildApplyingCard, buildErrorCard, buildProposalCard } from './cards.js';
import { buildClarificationCard, buildProposalCardV2, buildSummaryCard } from './cardsV2.js';
import { orchestrateMessage, type OrchestratorDeps } from '../agents/orchestrator.js';
import { resolveClarification } from '../agents/clarification.js';
import { generateSummary } from '../summary/service.js';
import type { JiraContextService } from '../jira/context.js';
import type { IAdaptiveCard } from '@microsoft/teams.cards';

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
 *
 * V2 adds one branch at the top of the message handler. When
 * STANDSYNC_AMBIENT_MODE is off, behaviour is exactly V1: only messages Teams
 * delivers to the bot (in a channel, @mentions) reach runStandupPipeline. When
 * it is on, every message in an allow-listed conversation reaches the V2
 * orchestrator, which decides for itself whether to respond at all.
 */

export interface TeamsDeps extends PipelineDeps {
  config: Config;
  actions: JiraActions;
  /** V2: deterministic Jira reads for the orchestrator. */
  context?: JiraContextService;
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
    const text = ctx.activity.text ?? '';

    const activity: AmbientActivity = {
      id: ctx.activity.id,
      conversationId,
      ...(ctx.activity.replyToId ? { threadId: ctx.activity.replyToId } : {}),
      authorId: from.id,
      ...(from.name ? { authorName: from.name } : {}),
      ...(from.role ? { authorRole: from.role } : {}),
      text,
      mentionsBot: mentionsBot(ctx.activity, config.MICROSOFT_APP_ID),
      hasCardAttachment: (ctx.activity.attachments ?? []).some((a) =>
        String(a.contentType ?? '').includes('card'),
      ),
    };

    // 1. Deterministic ingress filtering: bots, system activities, empty
    //    messages, unconfigured channels and obvious chatter, all before any
    //    model call. Mentions always pass.
    const ingress = classifyIngress(activity, config);
    if (!ingress.process) {
      log.debug(
        { conversationId, reason: ingress.reason, detail: ingress.detail },
        'ambient ingress: message not processed',
      );
      return;
    }

    // 2. The V1 channel allow-list still gates everything. Ambient mode widens
    //    *which messages* are considered, never which channels.
    const guard = isAllowedConversation(conversationId, config.TEAMS_ALLOWED_CONVERSATION_ID);
    if (!guard.allowed && !isAmbientAllowed(activity, config)) {
      logGuardDecision(log, guard, { conversationId });
      return;
    }

    try {
      // 3. V2 path when ambient mode is on; otherwise the V1 pipeline, byte for
      //    byte as it behaves today.
      if (config.STANDSYNC_AMBIENT_MODE) {
        await handleAmbientMessage(ctx, deps, activity, ingress.reason, log);
        return;
      }

      // runStandupPipeline returns null when there are no Jira keys, which is
      // how V1 StandSync stays silent on ordinary channel chatter.
      const batch = await runStandupPipeline(deps, {
        text,
        authorId: from.id,
        authorName: from.name ?? 'a teammate',
        conversationId,
        messageId: ctx.activity.id,
      });

      if (!batch) return;

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
        // Both V2 handlers are read/propose only. Neither can reach executeBatch:
        // onClarify produces a pending batch that still needs Approve, and
        // onSummary produces a card with no actions at all.
        onClarify: (request) => clarifyAndPropose(deps, request),
        onSummary: () => postTeamSummary(deps, conversationId),
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
      ambientMode: config.STANDSYNC_AMBIENT_MODE,
      ambientConversations: config.STANDSYNC_AMBIENT_MODE
        ? ambientConversations(config)
        : '(ambient mode off — mention required)',
    },
    'Teams app created on the Fastify server',
  );

  return app;
}

/**
 * Whether ambient mode itself authorises this conversation.
 *
 * Ambient conversations are an explicit allow-list, so a message can be
 * processed either because it came from the primary configured channel or
 * because that channel id was listed for ambient observation. Both are
 * deliberate operator choices; there is no path here that accepts an
 * unconfigured channel.
 */
function isAmbientAllowed(activity: AmbientActivity, config: Config): boolean {
  return (
    config.STANDSYNC_AMBIENT_MODE && ambientConversations(config).includes(activity.conversationId)
  );
}

/**
 * True when the activity @mentioned StandSync.
 *
 * Read from the mention entities rather than the text, because the SDK is
 * configured with `mentions.stripText`, so by the time we see `activity.text`
 * the mention markup is gone.
 */
function mentionsBot(
  activity: { entities?: { type?: string; mentioned?: { id?: string } }[] },
  appId: string,
): boolean {
  const mentions = (activity.entities ?? []).filter((e) => e.type === 'mention');
  if (mentions.length === 0) return false;
  if (!appId) return true; // unconfigured id: treat any mention as ours

  return mentions.some((mention) => {
    const id = mention.mentioned?.id ?? '';
    return id === appId || id.endsWith(`:${appId}`);
  });
}

/**
 * The V2 ambient path: hand the message to the orchestrator and post whatever
 * it decided — a proposal, a clarification, or nothing at all.
 *
 * Silence is a first-class outcome here. `ignored` and `silent` produce no reply
 * by design, which is the difference between a bot that can listen to a channel
 * and one that has to be muted.
 */
async function handleAmbientMessage(
  ctx: CardReplyContext,
  deps: TeamsDeps,
  activity: AmbientActivity,
  ingressReason: 'mention' | 'ambient_candidate',
  log: Logger,
): Promise<void> {
  if (!deps.context) {
    log.error('ambient mode is enabled but no JiraContextService was wired — refusing to process');
    return;
  }

  const orchestratorDeps: OrchestratorDeps = {
    config: deps.config,
    store: deps.store,
    context: deps.context,
    llm: deps.llm,
    ...(deps.log ? { log: deps.log } : {}),
  };

  const outcome = await orchestrateMessage(orchestratorDeps, {
    text: activity.text,
    authorId: activity.authorId,
    authorName: activity.authorName ?? 'a teammate',
    conversationId: activity.conversationId,
    messageId: activity.id,
    ...(activity.threadId ? { threadId: activity.threadId } : {}),
    // A mention is a directed message even in ambient mode, so it skips the
    // relevance gate and always gets an answer.
    source: ingressReason === 'mention' ? 'mention' : 'ambient',
  });

  switch (outcome.kind) {
    case 'ignored':
      log.debug(
        { messageId: activity.id, reason: outcome.reason, detail: outcome.detail },
        'orchestrator ignored the message',
      );
      return;

    case 'failed':
      // A failed reasoning stage is only reported when somebody asked. Replying
      // to an ambient message with an error would make every outage noisy.
      if (ingressReason === 'mention') {
        await reply(ctx, buildErrorCard('StandSync could not read that update', outcome.reason));
      } else {
        log.warn({ messageId: activity.id, reason: outcome.reason }, 'orchestration failed');
      }
      return;

    case 'silent':
      log.info(
        { batchId: outcome.batch.id, reason: outcome.reason },
        'batch stored but not posted',
      );
      return;

    case 'clarification': {
      for (const clarification of outcome.clarifications) {
        const sent = await reply(ctx, buildClarificationCard(clarification));
        if (sent?.id) deps.store.setClarificationCardActivityId(clarification.id, sent.id);
      }
      log.info(
        {
          count: outcome.clarifications.length,
          keys: outcome.clarifications.map((c) => c.issueKey),
        },
        'clarification card(s) posted',
      );
      return;
    }

    case 'proposal': {
      const sent = await reply(ctx, buildProposalCardV2(outcome.batch, outcome.blockers));
      if (sent?.id) deps.store.setCardActivityId(outcome.batch.id, sent.id);
      log.info({ batchId: outcome.batch.id, activityId: sent?.id }, 'V2 proposal card posted');
      return;
    }
  }
}

/**
 * The slice of the SDK's activity context these helpers need: the ability to
 * post a card reply. Typed structurally so the helpers are unit-testable with a
 * stub rather than a whole Teams context.
 */
export interface CardReplyContext {
  reply: (activity: {
    type: 'message';
    attachments: { contentType: string; content: unknown }[];
  }) => Promise<{ id?: string }>;
}

/** Posts one Adaptive Card as a reply, tolerating a send failure. */
async function reply(ctx: CardReplyContext, card: unknown): Promise<{ id?: string } | undefined> {
  try {
    return await ctx.reply({
      type: 'message',
      attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }],
    });
  } catch {
    // A card that could not be delivered must not crash the handler; the batch
    // is already stored, so the state is recoverable.
    return undefined;
  }
}

/**
 * Answers a clarification and returns the card to show in its place.
 *
 * The important property: this returns a *proposal* card, not a result card.
 * Answering "what did you mean?" produces something that still has to be
 * approved, so a clarification click can never be the last click before a Jira
 * write.
 */
async function clarifyAndPropose(
  deps: TeamsDeps,
  request: {
    clarificationId: string;
    optionId: string;
    answeredBy: string;
    answeredByName: string;
  },
): Promise<IAdaptiveCard> {
  if (!deps.context) {
    return buildErrorCard('Not available', 'StandSync is not configured to read Jira.');
  }

  const outcome = await resolveClarification(
    {
      config: deps.config,
      store: deps.store,
      context: deps.context,
      llm: deps.llm,
      ...(deps.log ? { log: deps.log } : {}),
    },
    request,
  );

  switch (outcome.kind) {
    case 'resolved':
      return buildProposalCardV2(outcome.batch);
    case 'already_answered':
      return buildErrorCard(
        'Already answered',
        'Someone has already answered this question. Nothing was changed in Jira.',
      );
    case 'not_found':
      return buildErrorCard(
        'No longer available',
        'That question has expired. Post your update again if it still applies.',
      );
    case 'invalid_option':
      return buildErrorCard('Unrecognised choice', 'StandSync could not read that answer.');
    case 'failed':
      return buildErrorCard('Could not build a proposal', outcome.reason);
  }
}

/** Builds and posts a team summary on request. Never touches Jira. */
export async function postTeamSummary(
  deps: TeamsDeps,
  conversationId: string,
): Promise<IAdaptiveCard> {
  if (!deps.context) {
    return buildErrorCard('Summary unavailable', 'StandSync is not configured to read Jira.');
  }

  const outcome = await generateSummary(
    {
      config: deps.config,
      store: deps.store,
      context: deps.context,
      llm: deps.llm,
      ...(deps.log ? { log: deps.log } : {}),
    },
    { conversationId },
  );

  if (!outcome.ok) {
    return buildErrorCard(
      'Summary unavailable',
      'StandSync could not build a summary just now. Nothing in Jira was affected.',
    );
  }

  return buildSummaryCard({
    summary: outcome.summary,
    period: `Standup activity for ${outcome.period}`,
    generatedAt: new Date().toISOString(),
  });
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
