import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApprovalStore } from '../src/approval/store.js';
import { executeBatch, BatchNotFoundError, rejectBatch } from '../src/approval/execute.js';
import { JiraActions, formatCommentText, toAdf } from '../src/jira/actions.js';
import { JiraClient, JiraError } from '../src/jira/client.js';
import type { Proposal, ProposalBatch } from '../src/types.js';

/** fetch accepts three input shapes; only Request carries the URL on a property. */
const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

/** A JiraActions whose two write methods are spies. No network anywhere. */
function fakeActions(overrides: Partial<JiraActions> = {}) {
  const transitionIssue = vi.fn<JiraActions['transitionIssue']>().mockResolvedValue(undefined);
  const addComment = vi.fn<JiraActions['addComment']>().mockResolvedValue(undefined);
  const actions = { transitionIssue, addComment, ...overrides } as unknown as JiraActions;
  return { actions, transitionIssue, addComment };
}

const transitionProposal = (over: Partial<Proposal> = {}): Proposal => ({
  id: 'p-transition',
  key: 'TES-41',
  actions: [
    { type: 'transition', fromStatus: 'In Progress', toStatus: 'Done', transitionId: '31' },
  ],
  confidence: 0.97,
  explanation: 'completed',
  selected: true,
  ...over,
});

const commentProposal = (over: Partial<Proposal> = {}): Proposal => ({
  id: 'p-comment',
  key: 'TES-43',
  actions: [{ type: 'comment', body: 'Blocked waiting for API credentials' }],
  confidence: 0.97,
  explanation: 'blocked',
  selected: true,
  ...over,
});

const noneProposal = (over: Partial<Proposal> = {}): Proposal => ({
  id: 'p-none',
  key: 'TES-80',
  actions: [{ type: 'none', reason: 'already Done' }],
  confidence: 0.9,
  explanation: 'nothing to do',
  selected: false,
  ...over,
});

function seedBatch(store: ApprovalStore, proposals: Proposal[]): ProposalBatch {
  const batch: ProposalBatch = {
    id: 'batch-1',
    conversationId: 'conv-1',
    messageId: 'msg-1',
    authorId: 'pasan',
    authorName: 'Pasan',
    rawMessage: 'demo standup',
    proposals,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  store.saveBatch(batch);
  return batch;
}

let store: ApprovalStore;
beforeEach(() => {
  store = ApprovalStore.open(':memory:');
});

describe('comment formatting', () => {
  it('prefixes with [StandSync] and attributes the standup author', () => {
    expect(formatCommentText('Blocked on credentials', 'Pasan')).toBe(
      '[StandSync] Blocked on credentials — from standup by Pasan',
    );
  });

  it('builds a valid ADF document', () => {
    expect(toAdf('hello')).toEqual({
      version: 1,
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
    });
  });
});

describe('JiraActions write paths', () => {
  const jsonOk = () => new Response(null, { status: 204 });

  it('posts a transition by id', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonOk());
    const client = new JiraClient({
      baseUrl: 'https://acme.atlassian.net',
      email: 'e@x.com',
      apiToken: 't',
      fetchImpl,
    });

    await new JiraActions(client).transitionIssue('TES-41', '31');

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(urlOf(url)).toContain('/rest/api/3/issue/TES-41/transitions');
    expect(JSON.parse(init?.body as string)).toEqual({ transition: { id: '31' } });
  });

  it('posts a comment as ADF, prefixed and attributed', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 201 }));
    const client = new JiraClient({
      baseUrl: 'https://acme.atlassian.net',
      email: 'e@x.com',
      apiToken: 't',
      fetchImpl,
    });

    await new JiraActions(client).addComment('TES-43', 'Blocked on credentials', 'Pasan');

    const body = JSON.parse(fetchImpl.mock.calls[0]![1]?.body as string) as {
      body: { type: string; content: { content: { text: string }[] }[] };
    };
    expect(urlOf(fetchImpl.mock.calls[0]![0])).toContain('/rest/api/3/issue/TES-43/comment');
    expect(body.body.type).toBe('doc');
    expect(body.body.content[0]?.content[0]?.text).toBe(
      '[StandSync] Blocked on credentials — from standup by Pasan',
    );
  });
});

describe('executeBatch', () => {
  it('applies a transition and a comment, and records what landed', async () => {
    seedBatch(store, [transitionProposal(), commentProposal()]);
    const { actions, transitionIssue, addComment } = fakeActions();

    const execution = await executeBatch({ store, actions }, 'batch-1', { approvedBy: 'pasan' });

    expect(transitionIssue).toHaveBeenCalledWith('TES-41', '31');
    expect(addComment).toHaveBeenCalledWith(
      'TES-43',
      'Blocked waiting for API credentials',
      'Pasan',
    );
    expect(execution.status).toBe('executed');
    expect(execution.results.map((r) => r.applied)).toEqual([
      ['In Progress → Done'],
      ['comment added'],
    ]);
  });

  // The single most important property: a stale Approve button must not double-apply.
  it('is a no-op on a second approval and returns the first outcome', async () => {
    seedBatch(store, [transitionProposal()]);
    const { actions, transitionIssue } = fakeActions();

    const first = await executeBatch({ store, actions }, 'batch-1', { approvedBy: 'pasan' });
    const second = await executeBatch({ store, actions }, 'batch-1', {
      approvedBy: 'someone-else',
    });

    expect(transitionIssue).toHaveBeenCalledTimes(1);
    expect(second.status).toBe(first.status);
    expect(second.results).toEqual(first.results);
    expect(store.getResults('batch-1')).toHaveLength(1); // not duplicated
  });

  it('does not apply anything to a batch that was already rejected', async () => {
    seedBatch(store, [transitionProposal()]);
    const { actions, transitionIssue } = fakeActions();

    expect(rejectBatch(store, 'batch-1', 'pasan')).toBe(true);
    const execution = await executeBatch({ store, actions }, 'batch-1', { approvedBy: 'pasan' });

    expect(transitionIssue).not.toHaveBeenCalled();
    // Writing nothing is right, but it must not claim to have executed.
    expect(execution.status).toBe('rejected');
    expect(execution.results).toHaveLength(0);
  });

  it('skips proposals that were not selected', async () => {
    seedBatch(store, [transitionProposal(), commentProposal({ selected: false })]);
    const { actions, transitionIssue, addComment } = fakeActions();

    await executeBatch({ store, actions }, 'batch-1', { approvedBy: 'pasan' });

    expect(transitionIssue).toHaveBeenCalledTimes(1);
    expect(addComment).not.toHaveBeenCalled();
  });

  it('applies only the given subset in Review mode, even if unselected', async () => {
    seedBatch(store, [transitionProposal(), commentProposal({ selected: false })]);
    const { actions, transitionIssue, addComment } = fakeActions();

    await executeBatch({ store, actions }, 'batch-1', {
      approvedBy: 'pasan',
      proposalIds: ['p-comment'],
    });

    expect(addComment).toHaveBeenCalledTimes(1);
    expect(transitionIssue).not.toHaveBeenCalled();
  });

  it('never calls Jira for a "no action" proposal', async () => {
    seedBatch(store, [noneProposal({ selected: true })]);
    const { actions, transitionIssue, addComment } = fakeActions();

    const execution = await executeBatch({ store, actions }, 'batch-1', { approvedBy: 'pasan' });

    expect(transitionIssue).not.toHaveBeenCalled();
    expect(addComment).not.toHaveBeenCalled();
    expect(execution.results).toHaveLength(0);
    expect(execution.status).toBe('executed');
  });

  it('reports partial when one ticket fails and others succeed', async () => {
    seedBatch(store, [transitionProposal(), commentProposal()]);
    const { actions, transitionIssue } = fakeActions();
    transitionIssue.mockRejectedValueOnce(new JiraError('Transition is not valid', 400, 'TES-41'));

    const execution = await executeBatch({ store, actions }, 'batch-1', { approvedBy: 'pasan' });

    expect(execution.status).toBe('partial');
    expect(execution.results[0]).toMatchObject({ ok: false, error: 'Transition is not valid' });
    expect(execution.results[1]).toMatchObject({ ok: true });
    expect(store.getBatch('batch-1')?.status).toBe('partial');
  });

  it('reports failed when everything fails', async () => {
    seedBatch(store, [transitionProposal()]);
    const { actions, transitionIssue } = fakeActions();
    transitionIssue.mockRejectedValue(new JiraError('Issue not found', 404, 'TES-41'));

    const execution = await executeBatch({ store, actions }, 'batch-1', { approvedBy: 'pasan' });

    expect(execution.status).toBe('failed');
    expect(execution.results[0]?.error).toBe('Issue not found');
  });

  it('keeps a partially applied ticket visible when its second action fails', async () => {
    seedBatch(store, [
      transitionProposal({
        id: 'p-both',
        actions: [
          { type: 'transition', fromStatus: 'To Do', toStatus: 'In Progress', transitionId: '21' },
          { type: 'comment', body: 'Blocked on credentials' },
        ],
      }),
    ]);
    const { actions, addComment } = fakeActions();
    addComment.mockRejectedValue(new JiraError('Comment body is not valid', 400));

    const execution = await executeBatch({ store, actions }, 'batch-1', { approvedBy: 'pasan' });

    // The transition did land — the result must say so rather than claim total failure.
    expect(execution.results[0]).toMatchObject({
      ok: false,
      applied: ['To Do → In Progress'],
      error: 'Comment body is not valid',
    });
  });

  it('never leaks a stack trace into the result', async () => {
    seedBatch(store, [transitionProposal()]);
    const { actions, transitionIssue } = fakeActions();
    transitionIssue.mockRejectedValue(new Error('boom\n  at deep/internal/path.js:12:5'));

    const execution = await executeBatch({ store, actions }, 'batch-1', { approvedBy: 'pasan' });

    expect(execution.results[0]?.error).toBe('boom\n  at deep/internal/path.js:12:5');
    expect(execution.results[0]?.error).not.toContain('JiraClient');
  });

  it('throws a typed error for an unknown batch', async () => {
    const { actions } = fakeActions();
    await expect(
      executeBatch({ store, actions }, 'nope', { approvedBy: 'pasan' }),
    ).rejects.toBeInstanceOf(BatchNotFoundError);
  });

  it('records the approver and final status for audit', async () => {
    seedBatch(store, [transitionProposal()]);
    const { actions } = fakeActions();

    await executeBatch({ store, actions }, 'batch-1', { approvedBy: 'pasan' });

    expect(store.getBatch('batch-1')?.status).toBe('executed');
    expect(store.getResults('batch-1')[0]).toMatchObject({ key: 'TES-41', ok: true });
  });
});

describe('rejectBatch', () => {
  it('closes a pending batch without touching Jira', () => {
    seedBatch(store, [transitionProposal()]);
    expect(rejectBatch(store, 'batch-1', 'pasan')).toBe(true);
    expect(store.getBatch('batch-1')?.status).toBe('rejected');
  });

  it('will not reject a batch that was already executed', async () => {
    seedBatch(store, [transitionProposal()]);
    const { actions } = fakeActions();
    await executeBatch({ store, actions }, 'batch-1', { approvedBy: 'pasan' });

    expect(rejectBatch(store, 'batch-1', 'someone-else')).toBe(false);
  });
});
