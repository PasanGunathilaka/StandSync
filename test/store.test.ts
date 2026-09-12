import { describe, it, expect } from 'vitest';
import { ApprovalStore } from '../src/approval/store.js';
import type { ProposalBatch } from '../src/types.js';

function batch(overrides: Partial<ProposalBatch> = {}): ProposalBatch {
  return {
    id: 'batch-1',
    conversationId: 'conv-1',
    messageId: 'msg-1',
    authorId: 'user-1',
    authorName: 'Pasan',
    rawMessage: 'Yesterday I completed PAY-142.',
    status: 'pending',
    createdAt: new Date().toISOString(),
    proposals: [
      {
        id: 'prop-1',
        key: 'PAY-142',
        actions: [
          { type: 'transition', fromStatus: 'In Progress', toStatus: 'Done', transitionId: '31' },
        ],
        confidence: 0.95,
        explanation: 'Author said they completed it.',
        selected: true,
      },
    ],
    ...overrides,
  };
}

describe('ApprovalStore', () => {
  it('round-trips a batch with its proposals and actions', () => {
    const store = ApprovalStore.open(':memory:');
    const b = batch();
    store.saveBatch(b);

    const loaded = store.getBatch('batch-1');
    expect(loaded).toBeDefined();
    expect(loaded?.authorName).toBe('Pasan');
    expect(loaded?.proposals).toHaveLength(1);
    expect(loaded?.proposals[0]?.actions[0]).toEqual({
      type: 'transition',
      fromStatus: 'In Progress',
      toStatus: 'Done',
      transitionId: '31',
    });
    store.close();
  });

  it('returns undefined for an unknown batch', () => {
    const store = ApprovalStore.open(':memory:');
    expect(store.getBatch('nope')).toBeUndefined();
    store.close();
  });

  // This is the guard that stops a stale Approve button double-applying to Jira.
  it('allows exactly one execution claim per batch', () => {
    const store = ApprovalStore.open(':memory:');
    store.saveBatch(batch());

    expect(store.claimForExecution('batch-1', 'user-1')).toBe(true);
    expect(store.claimForExecution('batch-1', 'user-1')).toBe(false);
    expect(store.claimForExecution('batch-1', 'user-2')).toBe(false);
    store.close();
  });

  it('will not reject a batch that was already claimed', () => {
    const store = ApprovalStore.open(':memory:');
    store.saveBatch(batch());

    expect(store.claimForExecution('batch-1', 'user-1')).toBe(true);
    expect(store.reject('batch-1', 'user-2')).toBe(false);
    store.close();
  });

  it('persists execution results for audit', () => {
    const store = ApprovalStore.open(':memory:');
    store.saveBatch(batch());
    store.saveResults('batch-1', [
      { proposalId: 'prop-1', key: 'PAY-142', ok: true, applied: ['Transitioned to Done'] },
      { proposalId: 'prop-2', key: 'PAY-999', ok: false, applied: [], error: 'Issue not found' },
    ]);

    const results = store.getResults('batch-1');
    expect(results).toHaveLength(2);
    expect(results[0]?.applied).toEqual(['Transitioned to Done']);
    expect(results[1]?.error).toBe('Issue not found');
    store.close();
  });
});
