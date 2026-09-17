import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import { logger, type Logger } from '../logger.js';
import { StageLogger } from '../observe/stages.js';
import type { ApprovalStore, ClarificationRecord } from '../approval/store.js';
import type {
  JiraContextService,
  IssueContextBundle,
  IssueContextResult,
} from '../jira/context.js';
import { contextsOf, lookupsOf, isPresent } from '../jira/context.js';
import { extractKeys, projectKeyOf } from '../standup/extractKeys.js';
import { cleanMessageText } from '../standup/pipeline.js';
import { buildProposals } from '../standup/propose.js';
import { resolveStatusChange, statusesForProject } from '../jira/statusMap.js';
import type { StatusResolution } from '../jira/statusMap.js';
import { classifyMessage } from './message-classifier.js';
import { interpretWork } from './standup-interpreter.js';
import {
  validateProposals,
  assignedToSomeoneElse,
  type DeterministicFinding,
  type ValidationVerdict,
} from './proposal-validator.js';
import { detectAmbiguity, type AmbiguityFinding } from './ambiguity-agent.js';
import { detectBlockers, type BlockerObservation } from './blocker-agent.js';
import { explainProposal, describeChange } from '../skills/explain-proposal.js';
import {
  decideBatch,
  decideProposal,
  decideRelevance,
  describeDisposition,
  thresholdsFrom,
  type ProposalDisposition,
} from '../policy/decision-policy.js';
import type { AgentDeps } from './types.js';
import type { LLMClient } from '../llm/types.js';
import type {
  BatchOrigin,
  Intent,
  MessageKind,
  Proposal,
  ProposalBatch,
  ProposalReview,
} from '../types.js';
import type { TicketIntent } from '../skills/interpret-work.js';

/**
 * The V2 orchestrator: one message in, one decision out.
 *
 *   ingress -> dedupe -> classify -> Jira context -> interpret
 *           -> validate -> ambiguity -> blockers -> policy
 *           -> proposal card | clarification card | silence
 *
 * What this function does NOT do is write to Jira. It produces a stored,
 * `pending` batch and nothing more; src/approval/execute.ts remains the only
 * place a Jira mutation happens, and it only runs after a human clicks Approve.
 * The reasoning stages here are handed an LLMClient and sanitized Jira context —
 * no credentials, no write client, no tools.
 *
 * It reuses the V1 core rather than reimplementing it: extractKeys,
 * statusMap.resolveStatusChange, buildProposals, ApprovalStore and the card
 * builders are all the same code the V1 path uses. The stages added around them
 * are the V2 contribution.
 */

export interface OrchestratorDeps {
  config: Config;
  store: ApprovalStore;
  context: JiraContextService;
  llm: LLMClient;
  log?: Logger;
}

export interface OrchestratorInput {
  text: string;
  authorId: string;
  authorName: string;
  conversationId: string;
  messageId: string;
  threadId?: string;
  /**
   * How the message reached StandSync. 'ambient' is the only source that is
   * filtered for relevance — a directed message is relevant by definition.
   */
  source: NonNullable<BatchOrigin['source']>;
  /** Channel label for prompts. Falls back to the conversation id. */
  conversationName?: string;
}

export type OrchestrationOutcome =
  /** Nothing to do and nothing to say. The event is recorded either way. */
  | { kind: 'ignored'; reason: string; detail?: string }
  /** A batch worth showing. Stored as pending; awaiting human approval. */
  | { kind: 'proposal'; batch: ProposalBatch; blockers: BlockerObservation[] }
  /** Questions to ask before proposing anything executable. */
  | { kind: 'clarification'; clarifications: ClarificationRecord[] }
  /** Recorded for audit, deliberately not posted to the channel. */
  | { kind: 'silent'; batch: ProposalBatch; reason: string }
  /** A stage failed in a way that must not produce a proposal. */
  | { kind: 'failed'; reason: string };

export async function orchestrateMessage(
  deps: OrchestratorDeps,
  input: OrchestratorInput,
): Promise<OrchestrationOutcome> {
  const { config, store } = deps;
  const traceId = randomUUID();
  const stage = new StageLogger(
    {
      traceId,
      messageId: input.messageId,
      conversationId: input.conversationId,
    },
    deps.log ?? logger,
  );

  const text = cleanMessageText(input.text);
  stage.stage('message_received', {
    source: input.source,
    authorId: input.authorId,
    textLength: text.length,
  });

  // 1. Deduplicate. Teams retries activities, and an edit arrives as a fresh
  //    event; neither may produce a second batch for the same update.
  const seen = store.recordMessageEvent({
    id: input.messageId,
    conversationId: input.conversationId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    authorId: input.authorId,
    authorName: input.authorName,
    text,
  });
  if (seen.duplicate) {
    stage.quiet('message_ignored', { reason: 'duplicate', detail: seen.reason });
    return {
      kind: 'ignored',
      reason: 'duplicate',
      ...(seen.reason ? { detail: seen.reason } : {}),
    };
  }

  const keys = extractKeys(text);
  const agentDeps: AgentDeps = {
    llm: deps.llm,
    timeoutMs: config.AGENT_TIMEOUT_MS,
    store,
    log: stage,
    traceId,
    messageId: input.messageId,
  };
  const thresholds = thresholdsFrom(config);

  // 2. Bounded thread context. Never the whole channel.
  const threadContext = store
    .recentContext({
      conversationId: input.conversationId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      excludeMessageId: input.messageId,
      limit: config.CONTEXT_MESSAGE_LIMIT,
      sinceMinutes: config.CONTEXT_WINDOW_MINUTES,
    })
    .map((m) => ({ authorName: m.authorName, text: m.text }));

  const today = new Date().toISOString().slice(0, 10);

  // 3. Relevance. Only ambient messages are filtered: if someone @mentioned
  //    StandSync or hit a dev endpoint, they have already said it is relevant.
  let classified: { type: MessageKind; confidence: number } | undefined;

  if (input.source === 'ambient') {
    const classification = await classifyMessage(
      {
        text,
        authorName: input.authorName,
        conversation: input.conversationName ?? input.conversationId,
        detectedKeys: keys,
        context: threadContext,
        today,
      },
      agentDeps,
    );

    if (classification.kind !== 'classifier_failed') {
      classified = { type: classification.type, confidence: classification.confidence };
    }

    const relevance = decideRelevance(
      classification.kind === 'classified'
        ? {
            kind: 'classified',
            relevant: classification.relevant,
            confidence: classification.confidence,
          }
        : { kind: classification.kind },
      thresholds,
    );

    if (!relevance.admit) {
      store.markMessageEvent(input.messageId, {
        state: 'ignored',
        relevant: false,
        ...(classified ? { classification: classified.type } : {}),
      });
      stage.quiet('message_ignored', { reason: relevance.reason, ...(classified ?? {}) });
      return { kind: 'ignored', reason: relevance.reason };
    }
  }

  // 4. A relevant message with no ticket key is real work StandSync cannot act
  //    on — there is nothing to propose against. Recorded, not answered.
  if (keys.length === 0) {
    store.markMessageEvent(input.messageId, {
      state: 'ignored',
      relevant: true,
      ...(classified ? { classification: classified.type } : {}),
    });
    stage.stage('message_ignored', { reason: 'no_jira_keys' });
    return { kind: 'ignored', reason: 'no_jira_keys' };
  }

  // 5. Deterministic Jira reads. Application code, not an agent.
  const bundles = await deps.context.gatherAll(keys);
  const contexts = contextsOf(bundles);
  const lookups = lookupsOf(bundles);
  stage.stage('jira_context_loaded', {
    keys,
    resolved: contexts.map((c) => `${c.key}:${c.exists ? c.status : 'missing'}`),
  });

  // 6. Interpretation.
  const interpretation = await interpretWork(
    {
      text,
      authorName: input.authorName,
      keys,
      contexts,
      context: threadContext,
      today,
    },
    agentDeps,
  );

  // A degraded interpreter must not produce proposals. Everything is `unclear`,
  // which resolves to no action, so this is fail-closed by construction — but
  // saying so explicitly keeps the guarantee visible.
  if (interpretation.degraded) {
    store.markMessageEvent(input.messageId, { state: 'failed', relevant: true });
    stage.warn('interpretation_complete', { outcome: 'degraded', keys });
    return { kind: 'failed', reason: 'Interpretation was unavailable, so nothing was proposed.' };
  }

  const batchId = randomUUID();
  const batchStage = stage.withBatch(batchId);

  // 7. Draft proposals using the V1 proposal builder: intent + live Jira state
  //    -> concrete actions, with transition ids resolved from the live workflow.
  const draft = buildProposals({
    interpretation: {
      tickets: interpretation.tickets,
      unresolvedMentions: interpretation.unresolvedMentions,
    },
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

  const byKey = new Map(interpretation.tickets.map((t) => [t.key, t]));
  const contextByKey = new Map(contexts.map((c) => [c.key, c]));
  const resolutions = resolutionsFor(interpretation.tickets, bundles, config);

  // 8. Validation, with deterministic findings merged over the model's verdict.
  const validation = await validateProposals(
    {
      text,
      authorName: input.authorName,
      today,
      contexts,
      changes: draft.map((proposal) => {
        const ticket = byKey.get(proposal.key);
        return {
          key: proposal.key,
          proposed: describeChange(proposal.actions),
          intent: ticket?.intent ?? 'unclear',
          evidence: ticket?.evidence ?? '',
          confidence: proposal.confidence,
        };
      }),
      deterministic: deterministicFindings(draft, resolutions, contextByKey, input.authorName),
    },
    agentDeps,
  );

  // 9. Ambiguity — only for tickets where a question is plausible. A confident,
  //    unhedged statement is not worth interrupting the author for.
  const ambiguity = await assessAmbiguity({
    draft,
    byKey,
    contexts,
    text,
    authorName: input.authorName,
    clarifyBelow: thresholds.autoSelectConfidence,
    deps: agentDeps,
  });

  // 10. Blockers — the observational branch. Never gates the Jira path.
  const blockers = await detectBlockers(
    {
      text,
      authorName: input.authorName,
      keys,
      today,
      conversationId: input.conversationId,
      unblockedKeys: interpretation.tickets.filter((t) => t.unblocked).map((t) => t.key),
    },
    agentDeps,
  );

  // 11. Policy. One decision per ticket, from all the signals at once.
  const dispositions = new Map<string, ProposalDisposition>();
  for (const proposal of draft) {
    const ticket = byKey.get(proposal.key);
    const context = contextByKey.get(proposal.key);
    const verdict =
      validation.kind === 'validated' ? validation.byKey.get(proposal.key) : undefined;
    const finding = ambiguity.get(proposal.key);

    // A hedge caps effective confidence regardless of what the model reported.
    // "Basically done, I'm 95% sure" is still a hedge, so it can never be
    // pre-ticked. Whether it becomes a question is the ambiguity agent's call,
    // not an arithmetic side effect of this cap.
    const confidence = ticket?.uncertain
      ? Math.min(proposal.confidence, justBelow(thresholds.autoSelectConfidence))
      : proposal.confidence;

    dispositions.set(
      proposal.key,
      decideProposal(
        {
          confidence,
          resolution: resolutions.get(proposal.key),
          issueExists: isPresent(context),
          actions: proposal.actions,
          ...(verdict
            ? {
                validation: {
                  valid: verdict.valid,
                  risk: verdict.risk,
                  warnings: verdict.warnings,
                },
              }
            : {}),
          validationUnavailable: validation.kind === 'unavailable',
          ambiguous: finding?.ambiguous === true,
          assignedToSomeoneElse: assignedToSomeoneElse(context, input.authorName),
        },
        thresholds,
      ),
    );
  }

  const batchDecision = decideBatch([...dispositions.values()], input.source);

  // 12. Clarification wins: ask rather than show a half-confident proposal.
  if (batchDecision.kind === 'clarify') {
    const clarifications = saveClarifications({
      store,
      input,
      text,
      dispositions,
      ambiguity,
      contexts,
    });

    if (clarifications.length > 0) {
      store.markMessageEvent(input.messageId, { state: 'processed', relevant: true });
      batchStage.stage('clarification_required', {
        keys: clarifications.map((c) => c.issueKey),
        count: clarifications.length,
      });
      return { kind: 'clarification', clarifications };
    }
    // No answerable question could be built, so fall through and show whatever
    // the rest of the batch supports rather than asking nothing and saying nothing.
  }

  // 13. Apply the policy to the proposals and rewrite the explanations.
  const proposals = draft.map((proposal) =>
    applyDisposition({
      proposal,
      disposition: dispositions.get(proposal.key),
      ticket: byKey.get(proposal.key),
      context: contextByKey.get(proposal.key),
      validation,
      authorName: input.authorName,
      autoSelectConfidence: thresholds.autoSelectConfidence,
    }),
  );

  const origin: BatchOrigin = {
    source: input.source,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    traceId,
    ...(classified
      ? { classification: classified.type, classifierConfidence: classified.confidence }
      : {}),
  };

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
    origin,
  };

  store.saveBatch(batch);
  store.markMessageEvent(input.messageId, {
    state: 'processed',
    relevant: true,
    batchId,
  });

  if (batchDecision.kind === 'silent') {
    batchStage.stage('proposal_created', {
      posted: false,
      reason: batchDecision.why,
      proposalCount: proposals.length,
    });
    return { kind: 'silent', batch, reason: batchDecision.why };
  }

  batchStage.stage('proposal_created', {
    posted: true,
    proposalCount: proposals.length,
    selected: proposals.filter((p) => p.selected).length,
    blockers: blockers.observations.filter((b) => b.shouldSurface).map((b) => b.key),
  });

  return { kind: 'proposal', batch, blockers: blockers.observations };
}

// --------------------------------------------------------------------- helpers

/** The largest value still strictly below `threshold`, for capping confidence. */
function justBelow(threshold: number): number {
  return Math.max(0, threshold - 0.01);
}

/**
 * Resolves each ticket's intent against the live workflow, deterministically.
 *
 * This is the same src/jira/statusMap.ts call the V1 proposal builder makes. It
 * is repeated here because the policy and the validator both need the *reason* a
 * transition is or is not possible, not just the resulting action.
 */
function resolutionsFor(
  tickets: TicketIntent[],
  bundles: IssueContextBundle[],
  config: Config,
): Map<string, StatusResolution> {
  const lookupByKey = new Map(bundles.map((b) => [b.key, b.lookup]));
  const resolutions = new Map<string, StatusResolution>();

  for (const ticket of tickets) {
    const lookup = lookupByKey.get(ticket.key);
    if (!lookup?.found) continue;
    resolutions.set(
      ticket.key,
      resolveStatusChange(
        ticket.intent,
        lookup.state,
        statusesForProject(
          projectKeyOf(ticket.key),
          {
            done: config.STATUS_DONE,
            inProgress: config.STATUS_IN_PROGRESS,
            todo: config.STATUS_TODO,
          },
          config.JIRA_STATUS_OVERRIDES,
        ),
      ),
    );
  }

  return resolutions;
}

/** Facts about each change that do not depend on a model's opinion. */
function deterministicFindings(
  draft: Proposal[],
  resolutions: Map<string, StatusResolution>,
  contextByKey: Map<string, IssueContextResult>,
  authorName: string,
): Map<string, DeterministicFinding> {
  const findings = new Map<string, DeterministicFinding>();

  for (const proposal of draft) {
    const resolution = resolutions.get(proposal.key);
    const context = contextByKey.get(proposal.key);
    const wantsTransition = proposal.actions.some((a) => a.type === 'transition');

    findings.set(proposal.key, {
      // Only meaningful when a transition is actually proposed; a comment-only
      // change is not made invalid by the absence of a transition.
      transitionAvailable: !wantsTransition || resolution?.kind === 'transition',
      alreadyInTargetStatus: resolution?.kind === 'already-there',
      issueMissing: !isPresent(context),
      assignedToSomeoneElse: assignedToSomeoneElse(context, authorName),
    });
  }

  return findings;
}

/**
 * Runs the ambiguity stage for the tickets where a question is warranted.
 *
 * Candidates are tickets the author hedged on, or whose confidence is below the
 * auto-select bar, and which would otherwise result in a real action. A ticket
 * already heading for "no action" needs no clarification — there is nothing to
 * be ambiguous about.
 *
 * A failed stage returns every candidate as ambiguous, which is the fail-closed
 * direction: asking is always safer than assuming.
 */
async function assessAmbiguity(params: {
  draft: Proposal[];
  byKey: Map<string, TicketIntent>;
  contexts: IssueContextResult[];
  text: string;
  authorName: string;
  clarifyBelow: number;
  deps: AgentDeps;
}): Promise<Map<string, AmbiguityFinding>> {
  const candidates = params.draft
    .filter((proposal) => {
      const ticket = params.byKey.get(proposal.key);
      const worthAsking = ticket?.uncertain === true || proposal.confidence < params.clarifyBelow;
      if (!worthAsking) return false;

      if (proposal.actions.some((a) => a.type !== 'none')) return true;

      // A hedged statement whose literal reading Jira cannot perform is the
      // *best* case for asking, not a reason to go quiet. "TES-31 is basically
      // finished" on a ticket that can only reach Code Review produces no
      // action from the completed reading — and a one-click question ("review,
      // or done?") is exactly what unblocks it. Only worth asking when the
      // issue is readable and the workflow offers somewhere to go.
      const context = params.contexts.find((c) => c.key === proposal.key);
      return isPresent(context) && context.availableTransitions.length > 0;
    })
    .map((proposal) => {
      const ticket = params.byKey.get(proposal.key);
      return {
        key: proposal.key,
        intent: ticket?.intent ?? 'unclear',
        evidence: ticket?.evidence ?? '',
        confidence: proposal.confidence,
        uncertain: ticket?.uncertain === true,
        proposed: describeChange(proposal.actions),
      };
    });

  if (candidates.length === 0) return new Map();

  const verdict = await detectAmbiguity(
    {
      text: params.text,
      authorName: params.authorName,
      candidates,
      contexts: params.contexts,
    },
    params.deps,
  );

  if (verdict.kind === 'assessed') return verdict.byKey;

  // Stage unavailable: prefer a clarification over an assumption.
  const fallback = new Map<string, AmbiguityFinding>();
  for (const candidate of candidates) {
    fallback.set(candidate.key, {
      key: candidate.key,
      ambiguous: true,
      question: `What should StandSync do with ${candidate.key}?`,
      options: fallbackOptions(
        params.contexts.find((c) => c.key === candidate.key),
        candidate.intent,
      ),
      reason: 'Ambiguity checking was unavailable, so StandSync is asking rather than assuming.',
    });
  }
  return fallback;
}

/**
 * Options built without a model, for when the ambiguity stage is unavailable.
 * Derived from the live workflow, so every offered status is reachable.
 */
function fallbackOptions(
  context: IssueContextResult | undefined,
  intent: Intent,
): AmbiguityFinding['options'] {
  const options: AmbiguityFinding['options'] = [];

  if (isPresent(context)) {
    context.availableTransitions.slice(0, 3).forEach((status, index) => {
      options.push({
        id: `opt${index}`,
        label: `Move to ${status}`,
        intent: intentForStatus(intent),
      });
    });
  }

  options.push({ id: 'optNoChange', label: 'Leave it as it is', intent: 'no_change' });
  return options.slice(0, 4);
}

/**
 * The intent a "move to <status>" fallback option resolves to.
 *
 * Deliberately conservative: without the ambiguity agent we do not know which
 * status means "done" in this workflow, so we keep the interpreter's reading
 * rather than inventing a completion. The proposal builder then resolves that
 * intent against the real workflow as usual.
 */
function intentForStatus(interpreted: Intent): Intent {
  return interpreted === 'unclear' ? 'in_progress' : interpreted;
}

/**
 * Rewrites one proposal according to the policy's decision.
 *
 * `suppress` strips the executable actions and replaces them with an explained
 * `none`, so a change the policy rejected cannot be approved by clicking
 * anything. This is the step that makes the policy load-bearing rather than
 * advisory.
 */
function applyDisposition(params: {
  proposal: Proposal;
  disposition: ProposalDisposition | undefined;
  ticket: TicketIntent | undefined;
  context: IssueContextResult | undefined;
  validation: ValidationVerdict;
  authorName: string;
  autoSelectConfidence: number;
}): Proposal {
  const { proposal, disposition, ticket, context } = params;
  const verdict =
    params.validation.kind === 'validated' ? params.validation.byKey.get(proposal.key) : undefined;

  const review: ProposalReview = {
    ...(verdict
      ? { validated: verdict.valid, risk: verdict.risk, warnings: verdict.warnings }
      : {}),
    ...(disposition
      ? {
          risk:
            disposition.kind === 'suppress'
              ? 'high'
              : disposition.kind === 'clarify'
                ? 'medium'
                : disposition.risk,
        }
      : {}),
    transitionVerified: proposal.actions.some((a) => a.type === 'transition'),
  };

  const note = disposition ? describeDisposition(disposition) : '';

  // Suppressed: keep the row visible for audit, remove the ability to apply it.
  if (disposition?.kind === 'suppress' && disposition.why !== 'no_action') {
    return {
      ...proposal,
      actions: [{ type: 'none', reason: note || 'Not proposed.' }],
      selected: false,
      explanation: joinSentences([
        explainProposal({
          authorName: params.authorName,
          actions: proposal.actions,
          evidence: ticket?.evidence ?? '',
          context,
          ...(verdict
            ? {
                validation: {
                  valid: verdict.valid,
                  risk: verdict.risk,
                  warnings: verdict.warnings,
                  explanation: verdict.explanation,
                },
              }
            : {}),
          lowConfidence: false,
        }).reason,
        note,
      ]),
      review: { ...review, validated: false, transitionVerified: false },
    };
  }

  const explanation = explainProposal({
    authorName: params.authorName,
    actions: proposal.actions,
    evidence: ticket?.evidence ?? '',
    context,
    ...(verdict
      ? {
          validation: {
            valid: verdict.valid,
            risk: verdict.risk,
            warnings: verdict.warnings,
            explanation: verdict.explanation,
          },
        }
      : {}),
    lowConfidence: proposal.confidence < params.autoSelectConfidence,
  });

  return {
    ...proposal,
    selected: disposition?.kind === 'propose',
    explanation: joinSentences([explanation.reason, note]),
    review,
  };
}

function joinSentences(parts: (string | undefined)[]): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const part of parts) {
    const trimmed = part?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    kept.push(trimmed);
  }
  return kept.join(' ') || 'No action needed.';
}

/**
 * Persists one clarification per ambiguous ticket.
 *
 * Each record carries the original message and the question, so answering it
 * later can rebuild a proposal from the author's own words rather than from a
 * remembered guess. No batch is created here: a clarification is explicitly not
 * an executable proposal, and Jira is not touched until the answer has been
 * through the normal pipeline and a human has approved the result.
 */
function saveClarifications(params: {
  store: ApprovalStore;
  input: OrchestratorInput;
  text: string;
  dispositions: Map<string, ProposalDisposition>;
  ambiguity: Map<string, AmbiguityFinding>;
  contexts: IssueContextResult[];
}): ClarificationRecord[] {
  const saved: ClarificationRecord[] = [];

  for (const [key, disposition] of params.dispositions) {
    if (disposition.kind !== 'clarify') continue;

    const finding = params.ambiguity.get(key);
    const context = params.contexts.find((c) => c.key === key);
    const options = finding?.options ?? [];
    if (options.length < 2) continue; // nothing answerable to ask

    const record: ClarificationRecord = {
      id: randomUUID(),
      conversationId: params.input.conversationId,
      ...(params.input.threadId ? { threadId: params.input.threadId } : {}),
      messageId: params.input.messageId,
      authorId: params.input.authorId,
      authorName: params.input.authorName,
      issueKey: key,
      originalMessage: params.text,
      question:
        finding?.question ||
        `${key} is currently ${isPresent(context) ? context.status : 'in an unknown state'}. What should StandSync propose?`,
      options,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    params.store.saveClarification(record);
    saved.push(record);
  }

  return saved;
}
