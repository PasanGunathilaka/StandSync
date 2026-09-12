import type { Intent, JiraIssueState } from '../types.js';

/**
 * Maps interpreted intent onto a *desired* Jira status, then resolves that status
 * to a transition id from the issue's live `/transitions` list.
 *
 * This file is the boundary the brief insists on: Claude produced the Intent, and
 * everything from here is StandSync's decision. Transition ids are never invented,
 * never cached and never shown to Claude — they are read from the live workflow at
 * proposal time, because a workflow's ids differ per project and per issue state.
 */

/** Status names as configured for this Jira instance. */
export interface StatusConfig {
  done: string;
  inProgress: string;
  todo: string;
}

/** Case- and whitespace-insensitive status comparison. */
export function isSameStatus(a: string | undefined, b: string | undefined): boolean {
  return (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
}

/**
 * True when the issue has not been started: anything that is neither the
 * configured In Progress status nor the configured Done status. This is what lets
 * "Backlog", "Selected for Development" and "To Do" all behave the same way
 * without hardcoding a list of names.
 */
export function isNotStarted(status: string, statuses: StatusConfig): boolean {
  return !isSameStatus(status, statuses.inProgress) && !isSameStatus(status, statuses.done);
}

/**
 * The status an intent wants the ticket to be in, or null when the intent implies
 * no movement at all.
 *
 * `not_done_yet` deliberately returns null: the whole point of that intent is that
 * the author said not to close it, so it must never resolve to Done.
 */
export function targetStatusFor(
  intent: Intent,
  currentStatus: string,
  statuses: StatusConfig,
): string | null {
  switch (intent) {
    case 'completed':
      return statuses.done;

    case 'in_progress':
      return statuses.inProgress;

    case 'blocked':
      // Blocked implies the work is underway. Move it to In Progress only from a
      // not-started state; never drag a Done ticket backwards over a blocker note.
      return isNotStarted(currentStatus, statuses) ? statuses.inProgress : null;

    case 'not_done_yet':
    case 'no_change':
    case 'unclear':
      return null;
  }
}

export interface TransitionMatch {
  id: string;
  name: string;
  toStatus: string;
}

/**
 * Finds the transition that lands on `targetStatus`, matching on the destination
 * status rather than the transition's label — workflows routinely name a
 * transition "Done" while it actually targets "Closed", and vice versa.
 */
export function findTransitionTo(
  transitions: JiraIssueState['transitions'],
  targetStatus: string,
): TransitionMatch | undefined {
  return transitions.find((t) => isSameStatus(t.toStatus, targetStatus));
}

export type StatusResolution =
  /** Already where the intent wants it; nothing to do. */
  | { kind: 'already-there'; status: string }
  /** A live transition exists to the target status. */
  | { kind: 'transition'; transition: TransitionMatch; fromStatus: string; toStatus: string }
  /** The target status is wanted, but this workflow offers no way to reach it now. */
  | { kind: 'no-transition'; fromStatus: string; toStatus: string; available: string[] }
  /** The intent implies no status change at all. */
  | { kind: 'no-target' };

/**
 * Resolves intent + live issue state into a concrete status decision.
 * Returns a description of what is possible; it does not perform anything.
 */
export function resolveStatusChange(
  intent: Intent,
  issue: JiraIssueState,
  statuses: StatusConfig,
): StatusResolution {
  const target = targetStatusFor(intent, issue.status, statuses);
  if (target === null) return { kind: 'no-target' };

  if (isSameStatus(issue.status, target)) {
    return { kind: 'already-there', status: issue.status };
  }

  const transition = findTransitionTo(issue.transitions, target);
  if (!transition) {
    return {
      kind: 'no-transition',
      fromStatus: issue.status,
      toStatus: target,
      available: issue.transitions.map((t) => t.toStatus),
    };
  }

  return { kind: 'transition', transition, fromStatus: issue.status, toStatus: target };
}
