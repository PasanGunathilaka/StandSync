import {
  AdaptiveCard,
  Column,
  ColumnSet,
  Container,
  ExecuteAction,
  TextBlock,
  ToggleInput,
  type IAdaptiveCard,
} from '@microsoft/teams.cards';
import { describeActions } from '../standup/propose.js';
import type { BatchExecution, Proposal, ProposalBatch } from '../types.js';

/**
 * Adaptive Card builders for the approval flow.
 *
 * Every interactive action is Action.Execute (the Universal Action Model), never
 * the legacy Action.Submit, and every action carries `{ action, batchId }` so the
 * handler never has to infer intent from button text.
 *
 * Card states: proposal (pending) -> review -> applying -> result, plus error.
 */

export const CARD_VERSION = '1.5' as const;

/**
 * The action verbs the card handlers accept.
 *
 * The first four are the V1 approval verbs and behave identically. V2 adds
 * `clarify` (answering a question, which produces a proposal that still needs
 * approving) and `summary` (read-only). Neither is an approval verb, and
 * neither reaches executeBatch.
 */
export const CARD_ACTIONS = [
  'approve_all',
  'review',
  'apply_selected',
  'reject',
  'clarify',
  'summary',
] as const;
export type CardActionName = (typeof CARD_ACTIONS)[number];

/** The verbs that can cause a Jira write once a human has approved. */
export const APPROVAL_ACTIONS = ['approve_all', 'apply_selected'] as const;

/** Input id prefix for Review-mode toggles, so toggles are separable from other data. */
export const TOGGLE_PREFIX = 'sel_';

export const toggleIdFor = (proposalId: string): string => `${TOGGLE_PREFIX}${proposalId}`;

function action(name: CardActionName, batchId: string, title: string): ExecuteAction {
  return new ExecuteAction({ title })
    .withData({ action: name, batchId })
    .withAssociatedInputs('auto');
}

const actionable = (p: Proposal): boolean => p.actions.some((a) => a.type !== 'none');

/** "97%" — confidence as a badge a human can scan. */
function confidenceLabel(proposal: Proposal): string {
  const pct = Math.round(proposal.confidence * 100);
  return actionable(proposal) && !proposal.selected && proposal.confidence < 0.6
    ? `${pct}% · Low confidence`
    : `${pct}%`;
}

function ticketRow(proposal: Proposal): ColumnSet {
  return new ColumnSet()
    .withColumns(
      new Column(new TextBlock(proposal.key, { weight: 'Bolder', wrap: true })).withWidth('auto'),
      new Column(new TextBlock(describeActions(proposal.actions), { wrap: true })).withWidth(
        'stretch',
      ),
      new Column(
        new TextBlock(confidenceLabel(proposal), {
          wrap: true,
          isSubtle: true,
          horizontalAlignment: 'Right',
        }),
      ).withWidth('auto'),
    )
    .withSpacing('Small');
}

/**
 * The pending proposal card: one row per ticket plus Approve All / Review / Reject.
 */
export function buildProposalCard(batch: ProposalBatch): IAdaptiveCard {
  const count = batch.proposals.filter(actionable).length;

  const rows = batch.proposals.flatMap((p) => [
    ticketRow(p),
    new TextBlock(p.explanation, { wrap: true, isSubtle: true, size: 'Small' }),
  ]);

  return new AdaptiveCard(
    new TextBlock(`StandSync found ${count} Jira update${count === 1 ? '' : 's'}`, {
      size: 'Large',
      weight: 'Bolder',
      wrap: true,
    }),
    new TextBlock(`From ${batch.authorName}'s standup`, {
      isSubtle: true,
      size: 'Small',
      wrap: true,
    }),
    new Container(...rows).withSpacing('Medium'),
  )
    .withVersion(CARD_VERSION)
    .withActions(
      action('approve_all', batch.id, 'Approve All').withStyle('positive'),
      action('review', batch.id, 'Review'),
      action('reject', batch.id, 'Reject').withStyle('destructive'),
    );
}

/**
 * Review mode: a toggle per actionable proposal, pre-ticked from `selected` so
 * low-confidence rows start off. Replaces the proposal card.
 */
export function buildReviewCard(batch: ProposalBatch): IAdaptiveCard {
  const choices = batch.proposals.filter(actionable);
  const skipped = batch.proposals.filter((p) => !actionable(p));

  const toggles = choices.map((p) =>
    new ToggleInput(`${p.key} — ${describeActions(p.actions)}`)
      .withId(toggleIdFor(p.id))
      .withValue(p.selected ? 'true' : 'false')
      .withWrap(true),
  );

  const skippedNote = skipped.length
    ? [
        new TextBlock(`No action for: ${skipped.map((p) => p.key).join(', ')}`, {
          wrap: true,
          isSubtle: true,
          size: 'Small',
        }),
      ]
    : [];

  return new AdaptiveCard(
    new TextBlock('Review Jira updates', { size: 'Large', weight: 'Bolder', wrap: true }),
    new TextBlock('Tick the changes you want applied.', { isSubtle: true, wrap: true }),
    new Container(...toggles, ...skippedNote).withSpacing('Medium'),
  )
    .withVersion(CARD_VERSION)
    .withActions(
      action('apply_selected', batch.id, 'Apply Selected').withStyle('positive'),
      action('reject', batch.id, 'Cancel').withStyle('destructive'),
    );
}

/**
 * Transient state shown while Jira is being updated. Carries no actions, which
 * is what prevents a second click while execution is in flight.
 */
export function buildApplyingCard(batch: ProposalBatch): IAdaptiveCard {
  return new AdaptiveCard(
    new TextBlock('Applying to Jira…', { size: 'Large', weight: 'Bolder', wrap: true }),
    new TextBlock(`Updating ${batch.proposals.filter(actionable).length} ticket(s).`, {
      isSubtle: true,
      wrap: true,
    }),
  ).withVersion(CARD_VERSION);
}

/** Final card: per-ticket outcome with the error text on failures. */
export function buildResultCard(batch: ProposalBatch, execution: BatchExecution): IAdaptiveCard {
  const { title, subtitle } = resultHeading(execution);

  const rows = execution.results.map((r) =>
    new ColumnSet()
      .withColumns(
        new Column(new TextBlock(r.ok ? '✅' : '❌')).withWidth('auto'),
        new Column(new TextBlock(r.key, { weight: 'Bolder', wrap: true })).withWidth('auto'),
        new Column(
          new TextBlock(r.ok ? r.applied.join(', ') : (r.error ?? 'Failed'), { wrap: true }),
        ).withWidth('stretch'),
      )
      .withSpacing('Small'),
  );

  const body =
    rows.length > 0
      ? [new Container(...rows).withSpacing('Medium')]
      : [new TextBlock('No changes were applied.', { wrap: true, isSubtle: true })];

  return new AdaptiveCard(
    new TextBlock(title, { size: 'Large', weight: 'Bolder', wrap: true }),
    new TextBlock(subtitle, { isSubtle: true, size: 'Small', wrap: true }),
    ...body,
  ).withVersion(CARD_VERSION);
}

function resultHeading(execution: BatchExecution): { title: string; subtitle: string } {
  const ok = execution.results.filter((r) => r.ok).length;
  const failed = execution.results.length - ok;

  switch (execution.status) {
    case 'executed':
      return { title: 'Jira updated successfully', subtitle: `${ok} ticket(s) updated.` };
    case 'partial':
      return {
        title: 'Jira partially updated',
        subtitle: `${ok} succeeded, ${failed} failed. Nothing else was changed.`,
      };
    case 'failed':
      return { title: 'Jira update failed', subtitle: `${failed} ticket(s) could not be updated.` };
    case 'rejected':
      return { title: 'Update rejected', subtitle: 'Nothing was sent to Jira.' };
  }
}

/** Card for a rejected batch. */
export function buildRejectedCard(batch: ProposalBatch, rejectedBy: string): IAdaptiveCard {
  return new AdaptiveCard(
    new TextBlock('Update rejected', { size: 'Large', weight: 'Bolder', wrap: true }),
    new TextBlock(`${rejectedBy} rejected these updates. Nothing was sent to Jira.`, {
      isSubtle: true,
      wrap: true,
    }),
    new TextBlock(`Tickets: ${batch.proposals.map((p) => p.key).join(', ')}`, {
      wrap: true,
      size: 'Small',
      isSubtle: true,
    }),
  ).withVersion(CARD_VERSION);
}

/**
 * Plain error card. Takes an already-sanitised message — callers must never pass
 * a raw error, so stack traces and credentials cannot reach a Teams channel.
 */
export function buildErrorCard(title: string, message: string): IAdaptiveCard {
  return new AdaptiveCard(
    new TextBlock(title, { size: 'Large', weight: 'Bolder', wrap: true, color: 'Attention' }),
    new TextBlock(message, { wrap: true }),
    new TextBlock('Nothing was changed in Jira.', { wrap: true, isSubtle: true, size: 'Small' }),
  ).withVersion(CARD_VERSION);
}
