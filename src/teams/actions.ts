import { z } from 'zod';
import type { IAdaptiveCard } from '@microsoft/teams.cards';
import { logger, type Logger } from '../logger.js';
import { JiraError } from '../jira/client.js';
import { executeBatch, rejectBatch, BatchNotFoundError } from '../approval/execute.js';
import type { ExecuteDeps } from '../approval/execute.js';
import type { ApprovalStore } from '../approval/store.js';
import { canApprove, type ApprovalPolicy } from './channelGuard.js';
import {
  CARD_ACTIONS,
  TOGGLE_PREFIX,
  buildErrorCard,
  buildRejectedCard,
  buildResultCard,
  buildReviewCard,
  type CardActionName,
} from './cards.js';

/**
 * Card action routing.
 *
 * These handlers own presentation and permission only. Every Jira write goes
 * through the Phase 5 `executeBatch`, which is also what /dev/approve calls —
 * there is no second write path and no second idempotency mechanism.
 */

/** Action payloads arrive from a client and are validated like any external input. */
const CardActionData = z.object({
  action: z.enum(CARD_ACTIONS),
  batchId: z.string().min(1),
});

export interface CardActionRequest {
  /** Raw `action.data` from the Action.Execute invoke. */
  data: unknown;
  userId: string;
  userName: string;
}

export interface CardActionDeps extends ExecuteDeps {
  store: ApprovalStore;
  approvalPolicy: ApprovalPolicy;
  log?: Logger;
}

export interface CardActionOutcome {
  /** Card to display in place of the current one. */
  card: IAdaptiveCard;
  /** Shown before execution so the user sees progress on a slow Jira. */
  applyingCardFor?: string;
  action?: CardActionName;
}

/** Parses and validates an action payload. Returns null when it is not ours. */
export function parseCardAction(data: unknown): { action: CardActionName; batchId: string } | null {
  const parsed = CardActionData.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/**
 * Reads Review-mode toggles. Adaptive Cards return input values as strings
 * alongside the action data, keyed by input id.
 */
export function selectedProposalIds(data: unknown): string[] {
  if (typeof data !== 'object' || data === null) return [];
  return Object.entries(data as Record<string, unknown>)
    .filter(([key, value]) => key.startsWith(TOGGLE_PREFIX) && isTrue(value))
    .map(([key]) => key.slice(TOGGLE_PREFIX.length));
}

const isTrue = (value: unknown): boolean => value === true || value === 'true';

/**
 * Handles one card action end to end and returns the card that should replace
 * the current one. Throws nothing: every failure becomes an error card.
 */
export async function handleCardAction(
  deps: CardActionDeps,
  request: CardActionRequest,
): Promise<CardActionOutcome> {
  const log = (deps.log ?? logger).child({ scope: 'card-action', userId: request.userId });

  const parsed = parseCardAction(request.data);
  if (!parsed) {
    log.warn('card action payload failed validation');
    return {
      card: buildErrorCard(
        'Unrecognised action',
        'StandSync could not read that button. Please post your standup again.',
      ),
    };
  }

  const { action, batchId } = parsed;
  const batch = deps.store.getBatch(batchId);
  if (!batch) {
    return {
      card: buildErrorCard(
        'Update no longer available',
        'This proposal has expired or was cleared from StandSync.',
      ),
    };
  }

  // Review needs no permission: it only changes what the clicker sees.
  if (action === 'review') {
    log.info({ batchId }, 'review requested');
    return { card: buildReviewCard(batch), action };
  }

  const permission = canApprove(deps.approvalPolicy, batch, request.userId);
  if (!permission.allowed) {
    log.warn({ batchId, action }, 'approval blocked by policy');
    return { card: buildErrorCard('Not allowed', permission.reason), action };
  }

  if (action === 'reject') {
    const rejected = rejectBatch(deps.store, batchId, request.userId);
    log.info({ batchId, rejected }, 'batch rejected');
    return {
      card: rejected
        ? buildRejectedCard(batch, request.userName)
        : buildErrorCard('Already decided', 'This update was already approved or rejected.'),
      action,
    };
  }

  // approve_all | apply_selected — both land on the same executor.
  const proposalIds = action === 'apply_selected' ? selectedProposalIds(request.data) : undefined;

  if (action === 'apply_selected' && proposalIds?.length === 0) {
    return {
      card: buildErrorCard('Nothing selected', 'Tick at least one update, then Apply Selected.'),
      action,
    };
  }

  try {
    const execution = await executeBatch(deps, batchId, {
      approvedBy: request.userId,
      ...(proposalIds ? { proposalIds } : {}),
    });

    log.info({ batchId, status: execution.status, action }, 'batch executed from Teams card');
    return { card: buildResultCard(batch, execution), applyingCardFor: batchId, action };
  } catch (err) {
    log.error({ err, batchId }, 'card-driven execution failed');
    return {
      card: buildErrorCard('Could not update Jira', describeForUser(err)),
      applyingCardFor: batchId,
      action,
    };
  }
}

/**
 * Converts an error into something safe to show in a channel: no stack traces,
 * no URLs with credentials, no internal type names.
 */
export function describeForUser(err: unknown): string {
  if (err instanceof BatchNotFoundError) {
    return 'This proposal is no longer available.';
  }
  if (err instanceof JiraError) {
    if (err.status === 401 || err.status === 403) {
      return 'Jira rejected StandSync’s credentials. An administrator needs to check the API token.';
    }
    if (err.status === 404) {
      return 'Jira could not find that issue. It may have been moved or deleted.';
    }
    if (err.status === 429) {
      return 'Jira is rate limiting requests right now. Please try again shortly.';
    }
    return `Jira rejected the change: ${firstLine(err.message)}`;
  }
  if (err instanceof Error) return firstLine(err.message);
  return 'An unexpected error occurred.';
}

/** Strips multi-line detail so a stack trace can never reach a channel. */
function firstLine(message: string): string {
  const line = message.split('\n')[0]?.trim() ?? '';
  return line.length > 300 ? `${line.slice(0, 297)}…` : line || 'An unexpected error occurred.';
}
