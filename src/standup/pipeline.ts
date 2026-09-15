import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import { logger, type Logger } from '../logger.js';
import type { JiraIssues } from '../jira/issues.js';
import type { LLMClient } from '../llm/types.js';
import type { ApprovalStore } from '../approval/store.js';
import type { ProposalBatch } from '../types.js';
import { extractKeys } from './extractKeys.js';
import { interpretStandup } from './interpret.js';
import { buildProposals } from './propose.js';

/**
 * The whole read-side pipeline, in one place:
 *
 *   message -> keys -> live Jira state -> Claude intent -> proposals -> stored batch
 *
 * The Teams message handler and the /dev/standup endpoint both call this exact
 * function. There is deliberately no second implementation, so the dev demo path
 * and the production path cannot drift apart.
 *
 * Nothing here writes to Jira. The batch is stored as `pending` and waits for a human.
 */

export interface PipelineDeps {
  config: Config;
  store: ApprovalStore;
  issues: JiraIssues;
  llm: LLMClient;
  log?: Logger;
}

export interface StandupInput {
  text: string;
  authorId: string;
  authorName: string;
  conversationId: string;
  messageId: string;
}

/** Strips Teams mention markup and HTML so Claude sees what a human sees. */
export function cleanMessageText(raw: string): string {
  return raw
    .replace(/<at\b[^>]*>.*?<\/at>/gis, ' ') // Teams @mentions
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ') // any remaining HTML
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * Runs the pipeline. Returns null when the message contains no Jira keys — the
 * bot stays silent rather than replying to ordinary channel chatter.
 */
export async function runStandupPipeline(
  deps: PipelineDeps,
  input: StandupInput,
): Promise<ProposalBatch | null> {
  const { config, store, issues, llm } = deps;
  const batchId = randomUUID();
  const log = (deps.log ?? logger).child({ batchId, stage: 'pipeline' });

  const text = cleanMessageText(input.text);
  const keys = extractKeys(text);

  if (keys.length === 0) {
    log.debug({ authorId: input.authorId }, 'no Jira keys in message — staying silent');
    return null;
  }

  log.info({ keys, authorName: input.authorName }, 'standup received');

  // Live Jira state first: Claude gets real context, and a key that does not
  // exist is already known to be missing before any proposal is built.
  const lookups = await issues.getIssueStates(keys);
  log.info(
    { states: lookups.map((l) => `${l.key}:${l.found ? l.state.status : 'not-found'}`) },
    'live Jira state resolved',
  );

  const interpretation = await interpretStandup({
    rawMessage: text,
    keys,
    lookups,
    llm,
    timeoutMs: config.LLM_TIMEOUT_MS,
    batchId,
    log: deps.log,
  });

  const proposals = buildProposals({
    interpretation,
    lookups,
    statuses: {
      done: config.STATUS_DONE,
      inProgress: config.STATUS_IN_PROGRESS,
      todo: config.STATUS_TODO,
    },
    statusOverrides: config.JIRA_STATUS_OVERRIDES,
    batchId,
    log: deps.log,
  });

  const batch: ProposalBatch = {
    id: batchId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    authorId: input.authorId,
    authorName: input.authorName,
    rawMessage: text,
    proposals,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  store.saveBatch(batch);
  log.info({ proposalCount: proposals.length }, 'batch stored, awaiting human approval');

  return batch;
}

/**
 * Whether this batch has anything worth showing. A batch where every ticket
 * resolved to "no action" is still stored for audit, but the caller may prefer
 * a quieter card.
 */
export function hasActionableProposals(batch: ProposalBatch): boolean {
  return batch.proposals.some((p) => p.actions.some((a) => a.type !== 'none'));
}
