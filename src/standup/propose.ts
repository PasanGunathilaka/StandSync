import { randomUUID } from 'node:crypto';
import { logger, type Logger } from '../logger.js';
import type { IssueLookup } from '../jira/issues.js';
import { resolveStatusChange, type StatusConfig } from '../jira/statusMap.js';
import type {
  InterpretationResult,
  Proposal,
  ProposalAction,
  TicketInterpretation,
} from '../types.js';

/**
 * Merges Claude's intent with live Jira state to produce concrete proposals.
 *
 * The separation the brief requires lives here:
 *   Claude:     standup text          -> intent
 *   StandSync:  intent + Jira state   -> proposed action (this file)
 *
 * Nothing in this file calls Jira, and nothing here applies anything. It produces
 * recommendations for a human to approve; src/approval/execute.ts is the only
 * place that writes.
 */

/** Below this, a proposal is still shown but is unticked by default in Review. */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;

export interface ProposeParams {
  interpretation: InterpretationResult;
  lookups: IssueLookup[];
  statuses: StatusConfig;
  log?: Logger;
  batchId?: string;
  /** Injectable so tests get stable proposal ids. */
  idFactory?: () => string;
}

export function buildProposals(params: ProposeParams): Proposal[] {
  const { interpretation, lookups, statuses } = params;
  const idFactory = params.idFactory ?? randomUUID;
  const log = (params.log ?? logger).child({ batchId: params.batchId, stage: 'propose' });

  const byKey = new Map(lookups.map((l) => [l.key, l]));

  const proposals = interpretation.tickets.map((ticket) =>
    buildOne(ticket, byKey.get(ticket.key), statuses, idFactory),
  );

  log.info(
    {
      proposalCount: proposals.length,
      summary: proposals.map((p) => `${p.key}:${describeActions(p.actions)}`),
    },
    'proposals built',
  );

  return proposals;
}

function buildOne(
  ticket: TicketInterpretation,
  lookup: IssueLookup | undefined,
  statuses: StatusConfig,
  idFactory: () => string,
): Proposal {
  const lowConfidence = ticket.confidence < LOW_CONFIDENCE_THRESHOLD;

  // A ticket we could not read is never acted on, whatever Claude concluded.
  if (!lookup || !lookup.found) {
    const reason = !lookup ? 'no Jira lookup was performed' : lookup.reason;
    return {
      id: idFactory(),
      key: ticket.key,
      actions: [{ type: 'none', reason: `Not found in Jira (${reason})` }],
      confidence: ticket.confidence,
      explanation: `${ticket.key} could not be read from Jira, so no action is proposed.`,
      selected: false,
    };
  }

  const issue = lookup.state;
  const actions: ProposalAction[] = [];
  const notes: string[] = [];

  // 1. Status change, decided entirely by StandSync from the live workflow.
  const resolution = resolveStatusChange(ticket.intent, issue, statuses);
  switch (resolution.kind) {
    case 'transition':
      actions.push({
        type: 'transition',
        fromStatus: resolution.fromStatus,
        toStatus: resolution.toStatus,
        transitionId: resolution.transition.id,
      });
      notes.push(`${resolution.fromStatus} → ${resolution.toStatus}`);
      break;

    case 'already-there':
      notes.push(`already ${resolution.status}`);
      break;

    case 'no-transition':
      notes.push(
        `No transition to ${resolution.toStatus} available from ${resolution.fromStatus}` +
          (resolution.available.length ? ` (can reach: ${resolution.available.join(', ')})` : ''),
      );
      break;

    case 'no-target':
      // in_progress only yields no-target when the ticket is already Done, so the
      // author's "I'm working on this" contradicts Jira. Say so plainly rather
      // than silently doing nothing.
      if (ticket.intent === 'in_progress') {
        notes.push('Standup indicates active work, but this Jira ticket is already Done');
      }
      break;
  }

  // 2. Comment, if the interpretation carries something worth recording.
  const commentBody = commentFor(ticket);
  if (commentBody) {
    actions.push({ type: 'comment', body: commentBody });
    notes.push('add comment');
  }

  // 3. Nothing actionable — say why, rather than showing an empty row.
  if (actions.length === 0) {
    actions.push({ type: 'none', reason: reasonForNoAction(ticket, notes) });
  }

  const actionable = actions.some((a) => a.type !== 'none');

  return {
    id: idFactory(),
    key: ticket.key,
    actions: dedupeActions(actions),
    confidence: ticket.confidence,
    explanation: buildExplanation(ticket, notes, lowConfidence),
    // Low-confidence rows are shown but unticked, so a human opts in deliberately.
    selected: actionable && !lowConfidence,
  };
}

/**
 * Chooses the comment body. `not_done_yet` and `blocked` are the cases where a
 * comment genuinely adds information a teammate would want; a bare "completed"
 * comment is noise, and the prompt already tells Claude not to suggest one.
 */
function commentFor(ticket: TicketInterpretation): string | undefined {
  const explicit = ticket.commentText?.trim();
  if (explicit) return explicit;

  if (ticket.intent === 'blocked') {
    const reason = ticket.blockerReason?.trim();
    return reason ? `Blocked: ${reason}` : 'Blocked (no reason captured).';
  }

  return undefined;
}

function reasonForNoAction(ticket: TicketInterpretation, notes: string[]): string {
  // Whatever the status resolution already explained is the most specific reason.
  const note = notes[0];
  if (note) return note.endsWith('.') ? note : `${note}.`;

  switch (ticket.intent) {
    case 'no_change':
      return 'Mentioned, but nothing changed.';
    case 'unclear':
      return 'Could not tell what happened to this ticket.';
    case 'not_done_yet':
      return 'Author said it is not finished — leaving the status alone.';
    default:
      return 'No action needed.';
  }
}

function buildExplanation(
  ticket: TicketInterpretation,
  notes: string[],
  lowConfidence: boolean,
): string {
  const parts: string[] = [];
  if (notes.length) parts.push(`${notes.join('; ')}.`);
  if (ticket.evidence.trim()) parts.push(`Based on: "${ticket.evidence.trim()}"`);
  if (lowConfidence) parts.push('Low confidence — review before approving.');
  return parts.join(' ') || 'No action needed.';
}

/**
 * Guarantees a proposal never carries two transitions or duplicate comments.
 * A 'none' is dropped as soon as anything real exists alongside it.
 */
function dedupeActions(actions: ProposalAction[]): ProposalAction[] {
  const hasReal = actions.some((a) => a.type !== 'none');
  const seen = new Set<string>();
  const result: ProposalAction[] = [];

  for (const action of actions) {
    if (hasReal && action.type === 'none') continue;

    const fingerprint =
      action.type === 'transition'
        ? 'transition' // at most one status change per ticket
        : action.type === 'comment'
          ? `comment:${action.body}`
          : `none:${action.reason}`;

    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    result.push(action);
  }

  return result;
}

/** Compact one-line summary used in logs and in the proposal card. */
export function describeActions(actions: ProposalAction[]): string {
  return actions
    .map((a) => {
      switch (a.type) {
        case 'transition':
          return `${a.fromStatus} → ${a.toStatus}`;
        case 'comment':
          return 'add comment';
        case 'none':
          return `no action (${a.reason})`;
      }
    })
    .join(', ');
}

/** True when a proposal would actually change something in Jira. */
export function isActionable(proposal: Proposal): boolean {
  return proposal.actions.some((a) => a.type !== 'none');
}
