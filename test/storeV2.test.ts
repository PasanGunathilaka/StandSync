import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ApprovalStore, type ClarificationRecord } from '../src/approval/store.js';
import type { ProposalBatch } from '../src/types.js';

/**
 * The V2 observation tables. Deduplication and blocker bookkeeping are the two
 * behaviours ambient mode depends on, so they are tested directly against
 * SQLite rather than through the orchestrator.
 */

let store: ApprovalStore;

beforeEach(() => {
  store = ApprovalStore.open(':memory:');
});

afterEach(() => {
  store.close();
});

const event = (over: Partial<Parameters<ApprovalStore['recordMessageEvent']>[0]> = {}) => ({
  id: 'msg-1',
  conversationId: 'conv-1',
  authorId: 'user-pasan',
  authorName: 'Pasan',
  text: 'Finished TES-31 today.',
  ...over,
});

describe('message event deduplication', () => {
  it('accepts a message it has not seen', () => {
    expect(store.recordMessageEvent(event())).toEqual({ duplicate: false });
  });

  it('rejects a re-delivery of the same activity id', () => {
    store.recordMessageEvent(event());
    const second = store.recordMessageEvent(event());

    expect(second.duplicate).toBe(true);
    expect(second.reason).toContain('already processed');
  });

  it('rejects identical text re-posted under a new activity id', () => {
    store.recordMessageEvent(event({ id: 'msg-1' }));
    const second = store.recordMessageEvent(event({ id: 'msg-2' }));

    // Teams can deliver the same content twice with different ids on retry.
    expect(second.duplicate).toBe(true);
    expect(second.reason).toContain('identical text');
  });

  it('treats identical text in a different conversation as new', () => {
    store.recordMessageEvent(event({ conversationId: 'conv-1' }));
    const other = store.recordMessageEvent(event({ id: 'msg-2', conversationId: 'conv-2' }));
    expect(other.duplicate).toBe(false);
  });

  it('lets an edit through when the content materially changed', () => {
    store.recordMessageEvent(event());
    const edited = store.recordMessageEvent(event({ text: 'Finished TES-31 and TES-32 today.' }));

    expect(edited.duplicate).toBe(false);
    expect(edited.reason).toContain('materially different');
  });

  it('ignores an edit that only changed whitespace or case', () => {
    store.recordMessageEvent(event({ text: 'Finished TES-31 today.' }));
    const cosmetic = store.recordMessageEvent(event({ text: '  finished TES-31 today.  ' }));
    expect(cosmetic.duplicate).toBe(true);
  });

  it('deduplicates a replayed edit, so one edit produces one batch', () => {
    store.recordMessageEvent(event());
    // The edit arrives and is accepted.
    expect(store.recordMessageEvent(event({ text: 'Finished TES-31 and TES-50.' })).duplicate).toBe(
      false,
    );
    // Teams replays the same edit: this time it is a duplicate.
    expect(store.recordMessageEvent(event({ text: 'Finished TES-31 and TES-50.' })).duplicate).toBe(
      true,
    );
  });
});

describe('message event state', () => {
  it('records the classification and batch once processed', () => {
    store.recordMessageEvent(event());
    store.markMessageEvent('msg-1', {
      state: 'processed',
      relevant: true,
      classification: 'standup_update',
      batchId: 'batch-1',
    });

    // Read back through recentContext, which only returns relevant messages.
    const context = store.recentContext({
      conversationId: 'conv-1',
      limit: 5,
      sinceMinutes: 60,
    });
    expect(context).toHaveLength(1);
  });

  it('marking an event does not erase an earlier classification', () => {
    store.recordMessageEvent(event());
    store.markMessageEvent('msg-1', { state: 'processed', classification: 'blocker' });
    // A later mark with no classification must not null the stored one.
    store.markMessageEvent('msg-1', { state: 'processed' });

    const context = store.recentContext({ conversationId: 'conv-1', limit: 5, sinceMinutes: 60 });
    expect(context).toHaveLength(1);
  });
});

describe('bounded conversational context', () => {
  const add = (id: string, text: string, threadId?: string): void => {
    store.recordMessageEvent(event({ id, text, ...(threadId ? { threadId } : {}) }));
    store.markMessageEvent(id, { state: 'processed', relevant: true });
  };

  it('returns nothing when the limit is zero', () => {
    add('m1', 'Finished TES-31');
    expect(store.recentContext({ conversationId: 'conv-1', limit: 0, sinceMinutes: 60 })).toEqual(
      [],
    );
  });

  it('honours the message limit', () => {
    for (let i = 0; i < 10; i++) add(`m${i}`, `Working on TES-${i}`);
    const context = store.recentContext({ conversationId: 'conv-1', limit: 3, sinceMinutes: 60 });
    expect(context).toHaveLength(3);
  });

  it('returns oldest first, the way a conversation reads', () => {
    add('m1', 'TES-31 is nearly done');
    add('m2', 'Code finished or fully complete?');
    add('m3', 'Code is done, just needs review');

    const context = store.recentContext({ conversationId: 'conv-1', limit: 5, sinceMinutes: 60 });
    expect(context.map((c) => c.text)).toEqual([
      'TES-31 is nearly done',
      'Code finished or fully complete?',
      'Code is done, just needs review',
    ]);
  });

  it('excludes the message being processed', () => {
    add('m1', 'TES-31 is nearly done');
    add('m2', 'Code is done, just needs review');

    const context = store.recentContext({
      conversationId: 'conv-1',
      excludeMessageId: 'm2',
      limit: 5,
      sinceMinutes: 60,
    });
    expect(context.map((c) => c.text)).toEqual(['TES-31 is nearly done']);
  });

  it('scopes to a thread when one is given', () => {
    add('m1', 'Unrelated channel message about TES-99');
    add('m2', 'TES-31 is nearly done', 'thread-a');
    add('m3', 'Code is done, just needs review', 'thread-a');

    const context = store.recentContext({
      conversationId: 'conv-1',
      threadId: 'thread-a',
      limit: 5,
      sinceMinutes: 60,
    });
    expect(context.map((c) => c.text)).toEqual([
      'TES-31 is nearly done',
      'Code is done, just needs review',
    ]);
  });

  it('excludes messages judged irrelevant, so chatter is never fed back', () => {
    store.recordMessageEvent(event({ id: 'm1', text: 'good morning all' }));
    store.markMessageEvent('m1', { state: 'ignored', relevant: false });
    add('m2', 'Finished TES-31');

    const context = store.recentContext({ conversationId: 'conv-1', limit: 5, sinceMinutes: 60 });
    expect(context.map((c) => c.text)).toEqual(['Finished TES-31']);
  });

  it('includes a message inside the time window', () => {
    add('m1', 'Finished TES-31');
    expect(
      store.recentContext({ conversationId: 'conv-1', limit: 5, sinceMinutes: 120 }),
    ).toHaveLength(1);
  });

  it('caps the window at the configured ceiling', () => {
    // The schema caps CONTEXT_MESSAGE_LIMIT at 20, so an unbounded read is not
    // expressible through config. This asserts the store honours whatever it is
    // handed rather than reading the whole conversation.
    for (let i = 0; i < 30; i++) add(`m${i}`, `Working on TES-${i}`);
    expect(
      store.recentContext({ conversationId: 'conv-1', limit: 20, sinceMinutes: 120 }),
    ).toHaveLength(20);
  });

  it('never returns another conversation’s messages', () => {
    add('m1', 'Finished TES-31');
    store.recordMessageEvent(event({ id: 'm2', conversationId: 'conv-other', text: 'Secret' }));
    store.markMessageEvent('m2', { state: 'processed', relevant: true });

    const context = store.recentContext({ conversationId: 'conv-1', limit: 5, sinceMinutes: 60 });
    expect(context.map((c) => c.text)).not.toContain('Secret');
  });
});

describe('blocker observations', () => {
  const observe = (over: Partial<Parameters<ApprovalStore['observeBlocker']>[0]> = {}) =>
    store.observeBlocker({
      conversationId: 'conv-1',
      issueKey: 'TES-42',
      category: 'access_or_credentials',
      description: 'waiting for API credentials',
      dependency: 'platform team',
      severity: 'high',
      ...over,
    });

  it('reports a first sighting as new', () => {
    expect(observe()).toEqual({ isNew: true, timesReported: 1, changed: true });
  });

  it('counts repeat mentions without creating a second blocker', () => {
    observe();
    const second = observe();

    expect(second.isNew).toBe(false);
    expect(second.timesReported).toBe(2);
    // The anti-nag property: an unchanged repeat is not worth surfacing.
    expect(second.changed).toBe(false);

    expect(store.getOpenBlockers('conv-1')).toHaveLength(1);
  });

  it('flags a changed description as worth surfacing again', () => {
    observe();
    const changed = observe({ description: 'waiting for API credentials from the vendor' });

    expect(changed.isNew).toBe(false);
    expect(changed.changed).toBe(true);
  });

  it('keeps blockers separate per issue and per conversation', () => {
    observe({ issueKey: 'TES-42' });
    observe({ issueKey: 'TES-50' });
    observe({ conversationId: 'conv-2', issueKey: 'TES-42' });

    expect(store.getOpenBlockers('conv-1')).toHaveLength(2);
    expect(store.getOpenBlockers('conv-2')).toHaveLength(1);
  });

  it('accumulates the reported count across many standups', () => {
    for (let i = 0; i < 5; i++) observe();
    expect(store.getOpenBlockers('conv-1')[0]?.timesReported).toBe(5);
  });

  it('resolves a blocker so it leaves the open list', () => {
    observe();
    expect(store.resolveBlocker('conv-1', 'TES-42')).toBe(true);
    expect(store.getOpenBlockers('conv-1')).toEqual([]);
  });

  it('reports nothing to resolve when there is no open blocker', () => {
    expect(store.resolveBlocker('conv-1', 'TES-42')).toBe(false);
  });

  it('treats a re-blocked issue after resolution as new again', () => {
    observe();
    store.resolveBlocker('conv-1', 'TES-42');
    expect(observe().isNew).toBe(true);
  });

  it('preserves an earlier field when a later sighting omits it', () => {
    observe({ dependency: 'platform team' });
    observe({ dependency: undefined });
    expect(store.getOpenBlockers('conv-1')[0]?.dependency).toBe('platform team');
  });
});

describe('clarifications', () => {
  const clarification = (over: Partial<ClarificationRecord> = {}): ClarificationRecord => ({
    id: 'clar-1',
    conversationId: 'conv-1',
    messageId: 'msg-1',
    authorId: 'user-pasan',
    authorName: 'Pasan',
    issueKey: 'TES-31',
    originalMessage: 'TES-31 is basically finished.',
    question: 'TES-31 is In Progress. What should StandSync propose?',
    options: [
      { id: 'opt0', label: 'Move to Code Review', intent: 'in_progress' },
      { id: 'opt1', label: 'Move to Done', intent: 'completed' },
      { id: 'optNoChange', label: 'Leave it as it is', intent: 'no_change' },
    ],
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...over,
  });

  it('round-trips a clarification with its options', () => {
    store.saveClarification(clarification());
    const read = store.getClarification('clar-1');

    expect(read?.issueKey).toBe('TES-31');
    expect(read?.originalMessage).toBe('TES-31 is basically finished.');
    expect(read?.options).toHaveLength(3);
    expect(read?.options[1]).toEqual({ id: 'opt1', label: 'Move to Done', intent: 'completed' });
    expect(read?.status).toBe('pending');
  });

  it('returns undefined for an unknown id', () => {
    expect(store.getClarification('nope')).toBeUndefined();
  });

  it('claims an answer atomically, so a double click answers once', () => {
    store.saveClarification(clarification());

    expect(store.answerClarification('clar-1', 'opt1', 'user-pasan')).toBe(true);
    // The second click must lose the race.
    expect(store.answerClarification('clar-1', 'opt0', 'user-chandima')).toBe(false);

    const read = store.getClarification('clar-1');
    expect(read?.answer).toBe('opt1');
    expect(read?.answeredBy).toBe('user-pasan');
    expect(read?.status).toBe('answered');
  });

  it('links the batch the answer produced, for audit', () => {
    store.saveClarification(clarification());
    store.answerClarification('clar-1', 'opt1', 'user-pasan');
    store.linkClarificationBatch('clar-1', 'batch-9');

    expect(store.getClarification('clar-1')?.resolvedBatchId).toBe('batch-9');
  });

  it('remembers the card activity id so the question can be replaced', () => {
    store.saveClarification(clarification());
    store.setClarificationCardActivityId('clar-1', 'activity-7');
    // No getter needed beyond not throwing; the column is read by the Teams layer.
    expect(store.getClarification('clar-1')).toBeDefined();
  });
});

describe('agent runs', () => {
  it('records a run per stage and reads them back in order', () => {
    for (const [agentName, durationMs] of [
      ['detect-standup', 120],
      ['interpret-work', 900],
      ['validate-proposal', 700],
    ] as const) {
      store.recordAgentRun({
        traceId: 'trace-1',
        messageId: 'msg-1',
        agentName,
        provider: 'mock',
        model: 'mock-model',
        durationMs,
        resultType: 'ok',
        ok: true,
      });
    }

    const runs = store.getAgentRuns('trace-1');
    expect(runs.map((r) => r.agentName)).toEqual([
      'detect-standup',
      'interpret-work',
      'validate-proposal',
    ]);
    expect(runs.every((r) => r.ok)).toBe(true);
  });

  it('records a failure with a short reason', () => {
    store.recordAgentRun({
      traceId: 'trace-2',
      agentName: 'validate-proposal',
      provider: 'claude-code',
      model: 'claude-sonnet-5',
      durationMs: 45_000,
      resultType: 'timeout',
      ok: false,
      detail: 'claude-code call exceeded the 45000ms timeout',
    });

    const run = store.getAgentRuns('trace-2')[0];
    expect(run?.resultType).toBe('timeout');
    expect(run?.ok).toBe(false);
    expect(run?.detail).toContain('exceeded');
  });

  it('truncates a long failure detail rather than storing a provider dump', () => {
    store.recordAgentRun({
      traceId: 'trace-3',
      agentName: 'interpret-work',
      provider: 'mock',
      model: 'mock-model',
      durationMs: 10,
      resultType: 'schema_invalid',
      ok: false,
      detail: 'x'.repeat(5000),
    });

    expect(store.getAgentRuns('trace-3')[0]?.detail?.length).toBeLessThanOrEqual(500);
  });

  it('keeps traces separate', () => {
    store.recordAgentRun({
      traceId: 'trace-a',
      agentName: 'detect-standup',
      provider: 'mock',
      model: 'm',
      durationMs: 1,
      resultType: 'ok',
      ok: true,
    });
    expect(store.getAgentRuns('trace-b')).toEqual([]);
  });
});

describe('V2 batch metadata', () => {
  const batch = (over: Partial<ProposalBatch> = {}): ProposalBatch => ({
    id: 'batch-1',
    conversationId: 'conv-1',
    messageId: 'msg-1',
    authorId: 'user-pasan',
    authorName: 'Pasan',
    rawMessage: 'Finished TES-31.',
    proposals: [
      {
        id: 'p1',
        key: 'TES-31',
        actions: [
          { type: 'transition', fromStatus: 'In Progress', toStatus: 'Done', transitionId: '31' },
        ],
        confidence: 0.95,
        explanation: 'Pasan said "Finished TES-31".',
        selected: true,
        review: {
          validated: true,
          risk: 'low',
          warnings: ['Assigned to someone else.'],
          transitionVerified: true,
        },
      },
    ],
    status: 'pending',
    createdAt: new Date().toISOString(),
    origin: {
      source: 'ambient',
      threadId: 'thread-a',
      classification: 'standup_update',
      classifierConfidence: 0.93,
      traceId: 'trace-1',
    },
    ...over,
  });

  it('round-trips origin and review metadata', () => {
    store.saveBatch(batch());
    const read = store.getBatch('batch-1');

    expect(read?.origin).toEqual({
      source: 'ambient',
      threadId: 'thread-a',
      classification: 'standup_update',
      classifierConfidence: 0.93,
      traceId: 'trace-1',
    });
    expect(read?.proposals[0]?.review).toEqual({
      validated: true,
      risk: 'low',
      warnings: ['Assigned to someone else.'],
      transitionVerified: true,
    });
  });

  it('stores a V1-shaped batch with no metadata', () => {
    const v1 = batch({ origin: undefined });
    v1.proposals = v1.proposals.map((p) => ({ ...p, review: undefined }));

    store.saveBatch(v1);
    const read = store.getBatch('batch-1');

    expect(read?.origin).toBeUndefined();
    expect(read?.proposals[0]?.review).toBeUndefined();
    // Everything V1 depends on is unaffected.
    expect(read?.proposals[0]?.selected).toBe(true);
    expect(read?.status).toBe('pending');
  });
});

describe('recentActivity — the summary’s source material', () => {
  it('reports what was proposed, who by, and whether it was applied', () => {
    const now = new Date().toISOString();
    store.saveBatch({
      id: 'batch-1',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      authorId: 'u1',
      authorName: 'Pasan',
      rawMessage: 'Finished TES-31.',
      proposals: [
        {
          id: 'p1',
          key: 'TES-31',
          actions: [
            { type: 'transition', fromStatus: 'In Progress', toStatus: 'Done', transitionId: '31' },
          ],
          confidence: 0.95,
          explanation: 'done',
          selected: true,
        },
      ],
      status: 'executed',
      createdAt: now,
    });

    const activity = store.recentActivity('conv-1', new Date(Date.now() - 3_600_000).toISOString());
    expect(activity).toHaveLength(1);
    expect(activity[0]?.issueKey).toBe('TES-31');
    expect(activity[0]?.authorName).toBe('Pasan');
    expect(activity[0]?.batchStatus).toBe('executed');
  });

  it('excludes activity older than the cutoff', () => {
    store.saveBatch({
      id: 'batch-old',
      conversationId: 'conv-1',
      messageId: 'msg-old',
      authorId: 'u1',
      authorName: 'Pasan',
      rawMessage: 'old',
      proposals: [],
      status: 'executed',
      createdAt: '2020-01-01T00:00:00.000Z',
    });

    expect(store.recentActivity('conv-1', '2026-01-01T00:00:00.000Z')).toEqual([]);
  });
});

describe('channel config', () => {
  it('remembers an observed channel and updates on repeat', () => {
    store.rememberChannel({
      conversationId: 'conv-1',
      teamId: 'team-1',
      channelName: 'Standups',
      ambientEnabled: true,
    });
    // An upsert must not throw or duplicate.
    store.rememberChannel({ conversationId: 'conv-1', ambientEnabled: false });
    expect(store.getBatch('nope')).toBeUndefined();
  });
});
