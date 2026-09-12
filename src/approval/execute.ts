import { logger, type Logger } from '../logger.js';
import { JiraError } from '../jira/client.js';
import type { JiraActions } from '../jira/actions.js';
import type { ApprovalStore } from './store.js';
import type { BatchExecution, ExecutionResult, Proposal, ProposalBatch } from '../types.js';

/**
 * Applies an approved batch to Jira. This is the only place Jira is written.
 *
 * Idempotency is the critical property: a Teams card can be clicked twice, a
 * network retry can replay a request, and two people can hit Approve at once.
 * The batch is claimed atomically in SQLite *before* any Jira call, so a second
 * attempt returns the first attempt's recorded results instead of re-applying.
 */

export interface ExecuteDeps {
  store: ApprovalStore;
  actions: JiraActions;
  log?: Logger;
}

export interface ExecuteOptions {
  /** Who approved. Recorded for audit. */
  approvedBy: string;
  /** Subset from Review mode. Omitted means "every selected proposal". */
  proposalIds?: string[];
}

export class BatchNotFoundError extends Error {
  constructor(batchId: string) {
    super(`No proposal batch with id ${batchId}`);
    this.name = 'BatchNotFoundError';
  }
}

export async function executeBatch(
  deps: ExecuteDeps,
  batchId: string,
  options: ExecuteOptions,
): Promise<BatchExecution> {
  const { store, actions } = deps;
  const log = (deps.log ?? logger).child({ batchId, stage: 'execute' });

  const batch = store.getBatch(batchId);
  if (!batch) throw new BatchNotFoundError(batchId);

  // Claim first, act second. Losing the race means someone already applied this.
  if (!store.claimForExecution(batchId, options.approvedBy)) {
    const existing = store.getResults(batchId);
    log.info(
      { status: batch.status, resultCount: existing.length, approvedBy: options.approvedBy },
      'batch already decided — returning the recorded outcome without touching Jira',
    );
    return {
      batchId,
      status: statusFor(batch.status, existing),
      results: existing,
    };
  }

  const toApply = selectProposals(batch, options.proposalIds);
  log.info(
    { approvedBy: options.approvedBy, applying: toApply.map((p) => p.key) },
    'applying approved proposals to Jira',
  );

  const results: ExecutionResult[] = [];
  for (const proposal of toApply) {
    results.push(await applyProposal(actions, proposal, batch.authorName, log));
  }

  const status = overallStatus(results);
  store.saveResults(batchId, results);
  store.setStatus(batchId, status);

  log.info(
    {
      status,
      ok: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    },
    'batch execution complete',
  );

  return { batchId, status, results };
}

/**
 * Review mode sends explicit ids; Approve All uses whatever was pre-selected.
 * Either way, proposals with nothing to do are skipped — approving a "no action"
 * row must never produce a Jira call.
 */
function selectProposals(batch: ProposalBatch, proposalIds?: string[]): Proposal[] {
  const chosen = proposalIds
    ? batch.proposals.filter((p) => proposalIds.includes(p.id))
    : batch.proposals.filter((p) => p.selected);

  return chosen.filter((p) => p.actions.some((a) => a.type !== 'none'));
}

/**
 * Applies one proposal's actions in order. A failure stops that ticket only —
 * the rest of the batch still runs, so one bad transition cannot strand the others.
 */
async function applyProposal(
  actions: JiraActions,
  proposal: Proposal,
  authorName: string,
  log: Logger,
): Promise<ExecutionResult> {
  const applied: string[] = [];

  try {
    for (const action of proposal.actions) {
      switch (action.type) {
        case 'transition':
          await actions.transitionIssue(proposal.key, action.transitionId);
          applied.push(`${action.fromStatus} → ${action.toStatus}`);
          break;

        case 'comment':
          await actions.addComment(proposal.key, action.body, authorName);
          applied.push('comment added');
          break;

        case 'none':
          break;
      }
    }

    log.info({ key: proposal.key, applied }, 'proposal applied');
    return { proposalId: proposal.id, key: proposal.key, ok: true, applied };
  } catch (err) {
    const message = describeFailure(err);
    log.warn({ key: proposal.key, applied, error: message }, 'proposal failed');
    // `applied` is kept: a partial application must stay visible on the card.
    return { proposalId: proposal.id, key: proposal.key, ok: false, applied, error: message };
  }
}

/** Human-readable failure text for the result card. Never leaks a stack trace. */
function describeFailure(err: unknown): string {
  if (err instanceof JiraError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

function overallStatus(results: ExecutionResult[]): BatchExecution['status'] {
  if (results.length === 0) return 'executed';
  const failed = results.filter((r) => !r.ok).length;
  if (failed === 0) return 'executed';
  if (failed === results.length) return 'failed';
  return 'partial';
}

/** Best-effort status for a replayed (already-decided) batch. */
function statusFor(
  batchStatus: ProposalBatch['status'],
  results: ExecutionResult[],
): BatchExecution['status'] {
  // A rejected batch must never report itself as executed, even though it
  // correctly wrote nothing — the result card has to tell the truth.
  if (
    batchStatus === 'executed' ||
    batchStatus === 'failed' ||
    batchStatus === 'partial' ||
    batchStatus === 'rejected'
  ) {
    return batchStatus;
  }
  return overallStatus(results);
}

/** Records a rejection. No Jira calls; the batch is closed out for audit. */
export function rejectBatch(store: ApprovalStore, batchId: string, rejectedBy: string): boolean {
  return store.reject(batchId, rejectedBy);
}
