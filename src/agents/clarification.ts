import { randomUUID } from 'node:crypto';
import { logger } from '../logger.js';
import { StageLogger } from '../observe/stages.js';
import { contextsOf, lookupsOf, isPresent } from '../jira/context.js';
import { buildProposals } from '../standup/propose.js';
import { explainProposal, describeChange } from '../skills/explain-proposal.js';
import {
  validateProposals,
  assignedToSomeoneElse,
  type DeterministicFinding,
} from './proposal-validator.js';
import { decideProposal, describeDisposition, thresholdsFrom } from '../policy/decision-policy.js';
import {
  findTransitionTo,
  isSameStatus,
  resolveStatusChange,
  statusesForProject,
} from '../jira/statusMap.js';
import type { StatusResolution } from '../jira/statusMap.js';
import { projectKeyOf } from '../standup/extractKeys.js';
import type { OrchestratorDeps } from './orchestrator.js';
import type { AgentDeps } from './types.js';
import type { ClarificationRecord } from '../approval/store.js';
import type { JiraIssueState, Proposal, ProposalBatch, ProposalReview } from '../types.js';

/**
 * Resolving a clarification: the answer re-enters the normal pipeline.
 *
 * This is the part of the clarification flow that matters for safety. An answer
 * does NOT apply anything to Jira. It resolves the ambiguity into a definite
 * intent, and that intent then goes through exactly the same steps any other
 * interpretation does — proposal building against the live workflow, validation,
 * the decision policy — and ends in a `pending` batch that still needs a human
 * to click Approve.
 *
 * So the developer answers two questions rather than one: "what did you mean?"
 * and then "shall I apply it?". That is deliberate. Answering a question is not
 * the same act as authorising a write, and conflating them would make the
 * clarification card a disguised Approve button.
 */

/**
 * Resolves a developer-named status against the live workflow.
 *
 * Reuses findTransitionTo, so a clarification is held to exactly the same
 * standard as any other proposal: if Jira offers no transition to the status the
 * developer picked, that is a `no-transition` resolution and the policy
 * suppresses it. A human choosing a destination does not make Jira able to
 * reach it.
 */
function resolveExplicitStatus(state: JiraIssueState, targetStatus: string): StatusResolution {
  if (isSameStatus(state.status, targetStatus)) {
    return { kind: 'already-there', status: state.status };
  }

  const transition = findTransitionTo(state.transitions, targetStatus);
  if (!transition) {
    return {
      kind: 'no-transition',
      fromStatus: state.status,
      toStatus: targetStatus,
      available: state.transitions.map((t) => t.toStatus),
    };
  }

  return { kind: 'transition', transition, fromStatus: state.status, toStatus: targetStatus };
}

/** The proposal for an explicitly chosen destination. */
function explicitProposal(
  key: string,
  resolution: Extract<StatusResolution, { kind: 'transition' }>,
  evidence: string,
): Proposal {
  return {
    id: randomUUID(),
    key,
    actions: [
      {
        type: 'transition',
        fromStatus: resolution.fromStatus,
        toStatus: resolution.toStatus,
        transitionId: resolution.transition.id,
      },
    ],
    confidence: 1,
    explanation: evidence,
    // Never pre-selected here. The policy decides selection below, so an answer
    // cannot promote itself past validation.
    selected: false,
  };
}

export type ClarificationOutcome =
  | { kind: 'resolved'; batch: ProposalBatch; clarification: ClarificationRecord }
  /** Someone already answered this one. No second batch is created. */
  | { kind: 'already_answered'; clarification: ClarificationRecord }
  | { kind: 'not_found' }
  | { kind: 'invalid_option'; clarification: ClarificationRecord }
  | { kind: 'failed'; reason: string };

export interface ResolveClarificationRequest {
  clarificationId: string;
  /** The option id the developer picked. */
  optionId: string;
  answeredBy: string;
  answeredByName: string;
}

export async function resolveClarification(
  deps: OrchestratorDeps,
  request: ResolveClarificationRequest,
): Promise<ClarificationOutcome> {
  const { config, store } = deps;

  const clarification = store.getClarification(request.clarificationId);
  if (!clarification) return { kind: 'not_found' };

  const option = clarification.options.find((o) => o.id === request.optionId);
  if (!option) return { kind: 'invalid_option', clarification };

  // Claim it atomically, exactly as executeBatch claims a batch. A double-click
  // on a clarification card must not produce two batches for one message.
  if (!store.answerClarification(clarification.id, option.id, request.answeredBy)) {
    return {
      kind: 'already_answered',
      clarification: store.getClarification(clarification.id) ?? clarification,
    };
  }

  const traceId = randomUUID();
  const batchId = randomUUID();
  const stage = new StageLogger(
    {
      traceId,
      messageId: clarification.messageId,
      conversationId: clarification.conversationId,
      batchId,
    },
    deps.log ?? logger,
  );

  stage.stage('message_received', {
    source: 'clarification',
    clarificationId: clarification.id,
    issueKey: clarification.issueKey,
    answer: option.label,
  });

  const agentDeps: AgentDeps = {
    llm: deps.llm,
    timeoutMs: config.AGENT_TIMEOUT_MS,
    store,
    log: stage,
    traceId,
    messageId: clarification.messageId,
  };
  const thresholds = thresholdsFrom(config);

  // Re-read Jira. The ticket may have moved since the question was asked, and
  // acting on the state we saw then would be acting on stale facts.
  const bundles = await deps.context.gatherAll([clarification.issueKey]);
  const contexts = contextsOf(bundles);
  const lookups = lookupsOf(bundles);
  const context = contexts[0];
  stage.stage('jira_context_loaded', {
    keys: [clarification.issueKey],
    resolved: contexts.map((c) => `${c.key}:${c.exists ? c.status : 'missing'}`),
  });

  // The developer's answer *is* the interpretation. Confidence is 1 because a
  // human stated it — but note that this only removes the ambiguity, not the
  // approval: validation and the policy still run below.
  const evidence = `clarified by ${request.answeredByName}: ${option.label}`;
  const interpretation = {
    tickets: [
      {
        key: clarification.issueKey,
        intent: option.intent,
        confidence: 1,
        evidence,
      },
    ],
    unresolvedMentions: [],
  };
  stage.stage('interpretation_complete', {
    source: 'clarification',
    intents: [`${clarification.issueKey}:${option.intent}`],
  });

  const lookup = lookups[0];

  /**
   * Two ways to turn the answer into a proposal.
   *
   * When the developer named a destination ("Move to Code Review"), that is
   * honoured literally: the status is resolved to a live transition id here. The
   * six-intent vocabulary cannot express an arbitrary workflow stage, so routing
   * an explicit choice through it would quietly lose the distinction between
   * Code Review and Done — exactly the distinction the question was asked to
   * settle.
   *
   * Otherwise the answer is an intent ("Not finished yet", "Leave it as it is")
   * and goes through the shared V1 proposal builder like any interpretation.
   *
   * Either way the transition id comes from the live workflow, never from the
   * answer, and the result is still validated and still needs approval.
   */
  const explicit =
    option.targetStatus && lookup?.found
      ? resolveExplicitStatus(lookup.state, option.targetStatus)
      : undefined;

  const draft =
    explicit?.kind === 'transition'
      ? [explicitProposal(clarification.issueKey, explicit, evidence)]
      : buildProposals({
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

  const resolution =
    explicit ??
    (isPresent(context) && lookup?.found
      ? resolveStatusChange(
          option.intent,
          lookup.state,
          statusesForProject(
            projectKeyOf(clarification.issueKey),
            {
              done: config.STATUS_DONE,
              inProgress: config.STATUS_IN_PROGRESS,
              todo: config.STATUS_TODO,
            },
            config.JIRA_STATUS_OVERRIDES,
          ),
        )
      : undefined);

  // Validation is NOT skipped just because a human disambiguated. They resolved
  // what they meant; whether Jira can honour it is still a separate question.
  const deterministic = new Map<string, DeterministicFinding>();
  for (const proposal of draft) {
    const wantsTransition = proposal.actions.some((a) => a.type === 'transition');
    deterministic.set(proposal.key, {
      transitionAvailable: !wantsTransition || resolution?.kind === 'transition',
      alreadyInTargetStatus: resolution?.kind === 'already-there',
      issueMissing: !isPresent(context),
      assignedToSomeoneElse: assignedToSomeoneElse(context, clarification.authorName),
    });
  }

  const validation = await validateProposals(
    {
      text: `${clarification.originalMessage}\n\n[Author was asked: ${clarification.question}]\n[Author answered: ${option.label}]`,
      authorName: clarification.authorName,
      today: new Date().toISOString().slice(0, 10),
      contexts,
      changes: draft.map((proposal) => ({
        key: proposal.key,
        proposed: describeChange(proposal.actions),
        intent: option.intent,
        evidence,
        confidence: 1,
      })),
      deterministic,
    },
    agentDeps,
  );

  const proposals: Proposal[] = draft.map((proposal) => {
    const verdict =
      validation.kind === 'validated' ? validation.byKey.get(proposal.key) : undefined;

    const disposition = decideProposal(
      {
        confidence: 1,
        resolution,
        issueExists: isPresent(context),
        actions: proposal.actions,
        ...(verdict
          ? { validation: { valid: verdict.valid, risk: verdict.risk, warnings: verdict.warnings } }
          : {}),
        validationUnavailable: validation.kind === 'unavailable',
        // The whole point of the answer is that the ambiguity is gone.
        ambiguous: false,
        assignedToSomeoneElse: assignedToSomeoneElse(context, clarification.authorName),
      },
      thresholds,
    );

    const note = describeDisposition(disposition);
    const suppressed = disposition.kind === 'suppress' && disposition.why !== 'no_action';

    const review: ProposalReview = {
      ...(verdict
        ? { validated: verdict.valid, risk: verdict.risk, warnings: verdict.warnings }
        : {}),
      transitionVerified: !suppressed && proposal.actions.some((a) => a.type === 'transition'),
    };

    const explanation = explainProposal({
      authorName: clarification.authorName,
      actions: proposal.actions,
      evidence,
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
    });

    if (suppressed) {
      return {
        ...proposal,
        actions: [{ type: 'none' as const, reason: note || 'Not proposed.' }],
        selected: false,
        explanation: [explanation.reason, note].filter(Boolean).join(' '),
        review: { ...review, validated: false },
      };
    }

    return {
      ...proposal,
      selected: disposition.kind === 'propose',
      explanation: [explanation.reason, note].filter(Boolean).join(' '),
      review,
    };
  });

  const batch: ProposalBatch = {
    id: batchId,
    conversationId: clarification.conversationId,
    // The clarification's own id namespaces the message, so answering a second
    // clarification about the same original message is not seen as a duplicate.
    messageId: `clarify-${clarification.id}`,
    authorId: clarification.authorId,
    authorName: clarification.authorName,
    rawMessage: clarification.originalMessage,
    proposals,
    status: 'pending',
    createdAt: new Date().toISOString(),
    origin: {
      source: 'clarification',
      ...(clarification.threadId ? { threadId: clarification.threadId } : {}),
      traceId,
      clarificationId: clarification.id,
    },
  };

  store.saveBatch(batch);
  store.linkClarificationBatch(clarification.id, batchId);

  stage.stage('proposal_created', {
    source: 'clarification',
    posted: true,
    proposalCount: proposals.length,
    selected: proposals.filter((p) => p.selected).length,
  });

  return {
    kind: 'resolved',
    batch,
    clarification: {
      ...clarification,
      answer: option.id,
      answeredBy: request.answeredBy,
      status: 'answered',
    },
  };
}
