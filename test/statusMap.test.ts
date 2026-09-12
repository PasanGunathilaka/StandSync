import { describe, it, expect } from 'vitest';
import {
  findTransitionTo,
  isNotStarted,
  isSameStatus,
  resolveStatusChange,
  targetStatusFor,
  type StatusConfig,
} from '../src/jira/statusMap.js';
import type { JiraIssueState } from '../src/types.js';

const STATUSES: StatusConfig = { done: 'Done', inProgress: 'In Progress', todo: 'To Do' };

const TRANSITIONS = [
  { id: '11', name: 'To Do', toStatus: 'To Do' },
  { id: '21', name: 'In Progress', toStatus: 'In Progress' },
  { id: '31', name: 'Done', toStatus: 'Done' },
];

const issue = (
  status: string,
  transitions: JiraIssueState['transitions'] = TRANSITIONS,
): JiraIssueState => ({ key: 'TES-41', summary: 'demo', status, transitions });

describe('isSameStatus', () => {
  it('ignores case and surrounding whitespace', () => {
    expect(isSameStatus('In Progress', '  in progress ')).toBe(true);
    expect(isSameStatus('Done', 'Do Not Do')).toBe(false);
    expect(isSameStatus(undefined, undefined)).toBe(true);
  });
});

describe('isNotStarted', () => {
  it('treats anything that is not In Progress or Done as not started', () => {
    expect(isNotStarted('To Do', STATUSES)).toBe(true);
    expect(isNotStarted('Backlog', STATUSES)).toBe(true);
    expect(isNotStarted('Selected for Development', STATUSES)).toBe(true);
    expect(isNotStarted('In Progress', STATUSES)).toBe(false);
    expect(isNotStarted('Done', STATUSES)).toBe(false);
  });
});

describe('targetStatusFor', () => {
  it('sends completed to Done', () => {
    expect(targetStatusFor('completed', 'In Progress', STATUSES)).toBe('Done');
  });

  it('sends in_progress to In Progress', () => {
    expect(targetStatusFor('in_progress', 'To Do', STATUSES)).toBe('In Progress');
  });

  it('sends blocked to In Progress only from a not-started status', () => {
    expect(targetStatusFor('blocked', 'To Do', STATUSES)).toBe('In Progress');
    expect(targetStatusFor('blocked', 'Backlog', STATUSES)).toBe('In Progress');
    // Already underway, or finished: a blocker note must not move the status.
    expect(targetStatusFor('blocked', 'In Progress', STATUSES)).toBeNull();
    expect(targetStatusFor('blocked', 'Done', STATUSES)).toBeNull();
  });

  it('never produces a target for not_done_yet, no_change or unclear', () => {
    for (const status of ['To Do', 'In Progress', 'Done', 'Backlog']) {
      expect(targetStatusFor('not_done_yet', status, STATUSES)).toBeNull();
      expect(targetStatusFor('no_change', status, STATUSES)).toBeNull();
      expect(targetStatusFor('unclear', status, STATUSES)).toBeNull();
    }
  });

  it('honours renamed statuses from configuration', () => {
    const custom: StatusConfig = { done: 'Closed', inProgress: 'Doing', todo: 'Backlog' };
    expect(targetStatusFor('completed', 'Doing', custom)).toBe('Closed');
    expect(targetStatusFor('in_progress', 'Backlog', custom)).toBe('Doing');
  });
});

describe('findTransitionTo', () => {
  it('matches on destination status, not on the transition label', () => {
    // A workflow whose transition is labelled "Finish" but lands on "Done".
    const odd = [{ id: '99', name: 'Finish', toStatus: 'Done' }];
    expect(findTransitionTo(odd, 'Done')).toMatchObject({ id: '99' });
  });

  it('is case-insensitive on the target status', () => {
    expect(findTransitionTo(TRANSITIONS, 'done')).toMatchObject({ id: '31' });
  });

  it('returns undefined when nothing reaches the target', () => {
    expect(findTransitionTo(TRANSITIONS, 'Released')).toBeUndefined();
    expect(findTransitionTo([], 'Done')).toBeUndefined();
  });
});

describe('resolveStatusChange', () => {
  it('resolves a live transition id rather than inventing one', () => {
    const result = resolveStatusChange('completed', issue('In Progress'), STATUSES);
    expect(result).toEqual({
      kind: 'transition',
      transition: { id: '31', name: 'Done', toStatus: 'Done' },
      fromStatus: 'In Progress',
      toStatus: 'Done',
    });
  });

  it('reports already-there when the ticket is in the target status', () => {
    expect(resolveStatusChange('completed', issue('Done'), STATUSES)).toEqual({
      kind: 'already-there',
      status: 'Done',
    });
    expect(resolveStatusChange('in_progress', issue('In Progress'), STATUSES)).toEqual({
      kind: 'already-there',
      status: 'In Progress',
    });
  });

  it('reports no-transition, with what is reachable, when the workflow cannot get there', () => {
    const restricted = issue('To Do', [{ id: '21', name: 'Start', toStatus: 'In Progress' }]);
    expect(resolveStatusChange('completed', restricted, STATUSES)).toEqual({
      kind: 'no-transition',
      fromStatus: 'To Do',
      toStatus: 'Done',
      available: ['In Progress'],
    });
  });

  it('reports no-target for intents that never move a ticket', () => {
    expect(resolveStatusChange('not_done_yet', issue('In Progress'), STATUSES).kind).toBe(
      'no-target',
    );
    expect(resolveStatusChange('no_change', issue('To Do'), STATUSES).kind).toBe('no-target');
    expect(resolveStatusChange('unclear', issue('To Do'), STATUSES).kind).toBe('no-target');
  });

  it('moves a blocked not-started ticket to In Progress', () => {
    expect(resolveStatusChange('blocked', issue('To Do'), STATUSES)).toMatchObject({
      kind: 'transition',
      toStatus: 'In Progress',
    });
  });

  it('leaves a blocked in-progress ticket where it is', () => {
    expect(resolveStatusChange('blocked', issue('In Progress'), STATUSES).kind).toBe('no-target');
  });
});
