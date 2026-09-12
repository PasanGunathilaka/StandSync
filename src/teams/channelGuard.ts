import type { Logger } from '../logger.js';
import type { ProposalBatch } from '../types.js';

/**
 * Channel allow-listing and approval permission.
 *
 * StandSync writes to a real Jira project, so it must only ever listen to the one
 * channel it was configured for. Everything here is a pure function so the rules
 * are testable without a Teams connection.
 */

export type GuardDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: string;
      /** true when the operator should see it */ notable: boolean;
    };

/**
 * Whether a conversation may drive the pipeline.
 *
 * An unset allow-list is treated as "not yet configured": the message is ignored,
 * but the conversation id is reported so the operator can paste it into
 * TEAMS_ALLOWED_CONVERSATION_ID. Defaulting to "allow everything" would let the
 * bot act on any channel it was added to, which is not a safe default for
 * something that mutates Jira.
 */
export function isAllowedConversation(
  conversationId: string,
  allowedConversationId: string,
): GuardDecision {
  const allowed = allowedConversationId.trim();

  if (!allowed) {
    return {
      allowed: false,
      notable: true,
      reason:
        `TEAMS_ALLOWED_CONVERSATION_ID is not set, so StandSync is ignoring this message. ` +
        `To enable this channel, set TEAMS_ALLOWED_CONVERSATION_ID=${conversationId}`,
    };
  }

  if (conversationId !== allowed) {
    return {
      allowed: false,
      notable: false, // routine: the bot is simply installed elsewhere too
      reason: `conversation ${conversationId} is not the allow-listed channel`,
    };
  }

  return { allowed: true };
}

/** True when the activity came from a bot (including StandSync itself). */
export function isFromBot(
  from: { id?: string; role?: string } | undefined,
  appId: string,
): boolean {
  if (!from) return false;
  if (from.role === 'bot') return true;
  if (!appId || !from.id) return false;
  // Teams bot ids are usually "28:<appId>"; compare on the suffix.
  return from.id === appId || from.id.endsWith(`:${appId}`);
}

export type ApprovalPolicy = 'author_only' | 'anyone';

/**
 * Whether a user may approve or reject a batch. Under `author_only` only the
 * person whose standup produced the batch can act on it.
 */
export function canApprove(
  policy: ApprovalPolicy,
  batch: Pick<ProposalBatch, 'authorId' | 'authorName'>,
  userId: string,
): GuardDecision {
  if (policy === 'anyone') return { allowed: true };
  if (userId && userId === batch.authorId) return { allowed: true };

  return {
    allowed: false,
    notable: true,
    reason: `Only ${batch.authorName} can approve this update (APPROVAL_POLICY=author_only).`,
  };
}

/** Convenience for logging a skipped message without spamming at info level. */
export function logGuardDecision(log: Logger, decision: GuardDecision, context: object): void {
  if (decision.allowed) return;
  if (decision.notable) log.warn(context, decision.reason);
  else log.debug(context, decision.reason);
}
