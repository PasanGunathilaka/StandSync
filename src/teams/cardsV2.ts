import {
  AdaptiveCard,
  Column,
  ColumnSet,
  Container,
  ExecuteAction,
  TextBlock,
  type IAdaptiveCard,
} from '@microsoft/teams.cards';
import { CARD_VERSION } from './cards.js';
import { confidenceWord, describeChange } from '../skills/explain-proposal.js';
import type { ClarificationRecord } from '../approval/store.js';
import type { BlockerObservation } from '../agents/blocker-agent.js';
import type { Proposal, ProposalBatch } from '../types.js';
import type { SummarizeTeamOutput } from '../skills/summarize-team.js';

/**
 * V2 Adaptive Cards.
 *
 * Kept alongside the V1 builders in src/teams/cards.ts rather than replacing
 * them: the V1 cards are what the V1 path posts, they are covered by tests, and
 * a card is the one part of the system a user sees, so changing it is not a
 * free refactor. Approve / Review / Reject, the action verbs and the
 * Action.Execute model are all shared, so the approval mechanics are identical —
 * only the presentation is richer.
 *
 * These cards say more about *why*: confidence in words, whether the transition
 * was verified against Jira, validator warnings, and blockers. None of it
 * changes what approval means; it changes how much the approver knows before
 * clicking.
 */

export const CLARIFY_ACTION = 'clarify' as const;
export const SUMMARY_ACTION = 'summary' as const;

/** Toggle prefix, shared with the V1 review card so the handler is unchanged. */
export { TOGGLE_PREFIX, toggleIdFor } from './cards.js';

const actionable = (p: Proposal): boolean => p.actions.some((a) => a.type !== 'none');

function executeAction(name: string, data: Record<string, unknown>, title: string): ExecuteAction {
  return new ExecuteAction({ title })
    .withData({ action: name, ...data })
    .withAssociatedInputs('auto');
}

/** "Confidence: High · ✓ Transition verified in Jira" */
function signalLine(proposal: Proposal): string {
  const parts = [`Confidence: ${confidenceWord(proposal.confidence)}`];

  if (proposal.review?.transitionVerified && actionable(proposal)) {
    parts.push('✓ Transition verified in Jira');
  }
  if (proposal.review?.risk === 'medium') parts.push('Review recommended');

  return parts.join(' · ');
}

/**
 * One ticket's block: key, the change, the signal line, the reason, and any
 * warnings. Warnings are rendered as their own attention-coloured lines so an
 * approver cannot skim past them.
 */
function ticketBlock(proposal: Proposal): Container {
  const elements: (TextBlock | ColumnSet)[] = [
    new ColumnSet()
      .withColumns(
        new Column(new TextBlock(proposal.key, { weight: 'Bolder', wrap: true })).withWidth('auto'),
        new Column(new TextBlock(describeChange(proposal.actions), { wrap: true })).withWidth(
          'stretch',
        ),
      )
      .withSpacing('Small'),
    new TextBlock(signalLine(proposal), { isSubtle: true, size: 'Small', wrap: true }),
  ];

  if (proposal.explanation.trim()) {
    elements.push(new TextBlock(proposal.explanation, { wrap: true, size: 'Small' }));
  }

  for (const warning of proposal.review?.warnings ?? []) {
    elements.push(
      new TextBlock(`⚠ ${warning}`, {
        wrap: true,
        size: 'Small',
        color: 'Attention',
      }),
    );
  }

  return new Container(...elements).withSpacing('Medium');
}

/** Blocker lines appended to a proposal card, for blockers worth surfacing. */
function blockerBlocks(blockers: BlockerObservation[]): TextBlock[] {
  return blockers
    .filter((b) => b.shouldSurface)
    .map((blocker) => {
      const detail = blocker.description ?? 'blocked';
      const waiting = blocker.dependency ? ` (waiting on ${blocker.dependency})` : '';
      return new TextBlock(`⚠ ${blocker.key} blocked: ${detail}${waiting}`, {
        wrap: true,
        size: 'Small',
        color: 'Attention',
      });
    });
}

/**
 * The V2 proposal card.
 *
 * Same three actions as V1 — Approve Selected, Review, Reject — so the
 * permission and idempotency path behind them is unchanged. "Approve Selected"
 * rather than "Approve All" is the one wording change, and it is an honest one:
 * the policy pre-ticks only what it is confident about, so a blanket "All"
 * would misdescribe what the button does.
 */
export function buildProposalCardV2(
  batch: ProposalBatch,
  blockers: BlockerObservation[] = [],
): IAdaptiveCard {
  const selected = batch.proposals.filter((p) => p.selected).length;
  const shown = batch.proposals.filter(actionable).length;

  const heading =
    shown === 0
      ? 'StandSync understood your update'
      : `StandSync understood your update — ${shown} Jira change${shown === 1 ? '' : 's'}`;

  const subtitle =
    batch.origin?.source === 'ambient'
      ? `From ${batch.authorName}'s message in this channel`
      : `From ${batch.authorName}'s standup`;

  const body = [
    new TextBlock(heading, { size: 'Large', weight: 'Bolder', wrap: true }),
    new TextBlock(subtitle, { isSubtle: true, size: 'Small', wrap: true }),
    ...batch.proposals.map(ticketBlock),
    ...blockerBlocks(blockers),
  ];

  if (shown > 0 && selected === 0) {
    body.push(
      new TextBlock('Nothing is pre-selected — open Review to choose what to apply.', {
        wrap: true,
        isSubtle: true,
        size: 'Small',
      }),
    );
  }

  const card = new AdaptiveCard(...body).withVersion(CARD_VERSION);

  // A card with nothing to apply gets no Approve button. An approval action
  // that cannot approve anything is a trap.
  if (shown === 0) return card;

  return card.withActions(
    executeAction('approve_all', { batchId: batch.id }, 'Approve Selected').withStyle('positive'),
    executeAction('review', { batchId: batch.id }, 'Review'),
    executeAction('reject', { batchId: batch.id }, 'Reject').withStyle('destructive'),
  );
}

/**
 * The clarification card.
 *
 * Each option is an Action.Execute carrying the clarification id and the chosen
 * option id. Clicking one answers a question — it does not approve anything, and
 * the handler routes it into the orchestrator, which produces an ordinary
 * proposal card that still needs Approve.
 */
export function buildClarificationCard(clarification: ClarificationRecord): IAdaptiveCard {
  return new AdaptiveCard(
    new TextBlock('StandSync needs one detail', {
      size: 'Large',
      weight: 'Bolder',
      wrap: true,
    }),
    new TextBlock(clarification.question, { wrap: true, spacing: 'Medium' }),
    new TextBlock(`You said: "${clarification.originalMessage}"`, {
      wrap: true,
      isSubtle: true,
      size: 'Small',
    }),
    new TextBlock('Nothing has been changed in Jira.', {
      wrap: true,
      isSubtle: true,
      size: 'Small',
    }),
  )
    .withVersion(CARD_VERSION)
    .withActions(
      ...clarification.options.map((option) =>
        executeAction(
          CLARIFY_ACTION,
          { clarificationId: clarification.id, optionId: option.id },
          option.label,
        ),
      ),
    );
}

/** Shown once a clarification has been answered, replacing the question. */
export function buildClarificationAnsweredCard(
  clarification: ClarificationRecord,
  answerLabel: string,
  answeredByName: string,
): IAdaptiveCard {
  return new AdaptiveCard(
    new TextBlock('Thanks — noted', { size: 'Large', weight: 'Bolder', wrap: true }),
    new TextBlock(`${answeredByName} chose "${answerLabel}" for ${clarification.issueKey}.`, {
      wrap: true,
    }),
    new TextBlock('StandSync is preparing a proposal for approval.', {
      wrap: true,
      isSubtle: true,
      size: 'Small',
    }),
  ).withVersion(CARD_VERSION);
}

/**
 * The V2 result card. Per-ticket outcome with an explicit symbol, and the
 * failure reason where there is one — already sanitized by
 * src/teams/actions.ts, so no stack trace can reach a channel.
 */
export function buildResultCardV2(execution: {
  status: 'executed' | 'failed' | 'partial' | 'rejected';
  results: { key: string; ok: boolean; applied: string[]; error?: string }[];
}): IAdaptiveCard {
  const ok = execution.results.filter((r) => r.ok).length;
  const failed = execution.results.length - ok;

  const heading: Record<typeof execution.status, { title: string; subtitle: string }> = {
    executed: { title: 'Jira updated', subtitle: `${ok} ticket(s) updated.` },
    partial: {
      title: 'Jira partially updated',
      subtitle: `${ok} succeeded, ${failed} failed. Nothing else was changed.`,
    },
    failed: { title: 'Jira update failed', subtitle: `${failed} ticket(s) could not be updated.` },
    rejected: { title: 'Update rejected', subtitle: 'Nothing was sent to Jira.' },
  };

  const { title, subtitle } = heading[execution.status];

  const rows = execution.results.map(
    (result) =>
      new TextBlock(
        `${result.ok ? '✓' : '✗'} ${result.key} — ${
          result.ok ? result.applied.join(', ') || 'no change needed' : (result.error ?? 'failed')
        }`,
        { wrap: true },
      ),
  );

  return new AdaptiveCard(
    new TextBlock(title, { size: 'Large', weight: 'Bolder', wrap: true }),
    new TextBlock(subtitle, { isSubtle: true, size: 'Small', wrap: true }),
    rows.length
      ? new Container(...rows).withSpacing('Medium')
      : new TextBlock('No changes were applied.', { wrap: true, isSubtle: true }),
  ).withVersion(CARD_VERSION);
}

/** The team summary card. Read-only; it carries no approval action at all. */
export function buildSummaryCard(params: {
  summary: SummarizeTeamOutput;
  period: string;
  generatedAt: string;
}): IAdaptiveCard {
  const { summary } = params;

  const section = (title: string, lines: { key: string; text: string }[]): TextBlock[] => {
    if (lines.length === 0) return [];
    return [
      new TextBlock(title, { weight: 'Bolder', wrap: true, spacing: 'Medium' }),
      ...lines.map(
        (line) => new TextBlock(`• ${line.key} — ${line.text}`, { wrap: true, size: 'Small' }),
      ),
    ];
  };

  const sections = [
    ...section('Completed', summary.completed),
    ...section('In Progress', summary.inProgress),
    ...section('Blocked', summary.blocked),
  ];

  const attention = summary.attention.length
    ? [
        new TextBlock('Attention', { weight: 'Bolder', wrap: true, spacing: 'Medium' }),
        ...summary.attention.map(
          (item) => new TextBlock(`• ${item}`, { wrap: true, size: 'Small', color: 'Attention' }),
        ),
      ]
    : [];

  const empty = sections.length === 0 && attention.length === 0;

  return new AdaptiveCard(
    new TextBlock('StandSync Daily Summary', { size: 'Large', weight: 'Bolder', wrap: true }),
    new TextBlock(params.period, { isSubtle: true, size: 'Small', wrap: true }),
    ...(empty
      ? [
          new TextBlock('No standup activity recorded for this period.', {
            wrap: true,
            isSubtle: true,
          }),
        ]
      : [...sections, ...attention]),
    new TextBlock('Summary only — nothing in Jira was changed.', {
      wrap: true,
      isSubtle: true,
      size: 'Small',
      spacing: 'Medium',
    }),
  ).withVersion(CARD_VERSION);
}
