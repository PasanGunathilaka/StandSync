import { z } from 'zod';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ApprovalStore } from '../src/approval/store.js';
import { MockLLMClient } from '../src/llm/mock.js';
import { LLMError } from '../src/llm/types.js';
import { StageLogger } from '../src/observe/stages.js';
import { runAgent, recordSkipped, summarizeZodError } from '../src/agents/runAgent.js';
import { classifyMessage } from '../src/agents/message-classifier.js';
import { interpretWork, reconcile, allUnclear } from '../src/agents/standup-interpreter.js';
import {
  validateProposals,
  applyDeterministic,
  assignedToSomeoneElse,
  highestRisk,
  type DeterministicFinding,
} from '../src/agents/proposal-validator.js';
import { detectAmbiguity, buildOptions, toFinding } from '../src/agents/ambiguity-agent.js';
import { detectBlockers } from '../src/agents/blocker-agent.js';
import { summarizeTeam, groundToInput } from '../src/agents/summary-agent.js';
import { detectStandupSkill } from '../src/skills/detect-standup.js';
import type { AgentDeps } from '../src/agents/types.js';
import type { IssueContext, IssueContextResult } from '../src/jira/context.js';

/**
 * The bounded reasoning components.
 *
 * Every test here uses the deterministic MockLLMClient, so what is under test is
 * the *deterministic wrapper* around each model call: the fast paths, the
 * reconciliation, the fail-closed defaults and the guarantees that stop a model
 * from doing something StandSync did not sanction.
 */

let store: ApprovalStore;

beforeEach(() => {
  store = ApprovalStore.open(':memory:');
});

afterEach(() => {
  store.close();
});

const depsFor = (llm: MockLLMClient, traceId = 'trace-1'): AgentDeps => ({
  llm,
  timeoutMs: 1_000,
  store,
  log: new StageLogger({ traceId, messageId: 'msg-1' }),
  traceId,
  messageId: 'msg-1',
});

const present = (over: Partial<IssueContext> = {}): IssueContext => ({
  key: 'TES-31',
  exists: true,
  summary: 'Payment validation',
  status: 'In Progress',
  issueType: 'Task',
  assignee: 'Pasan',
  availableTransitions: ['Code Review', 'Done'],
  ...over,
});

// --------------------------------------------------------------- runAgent

describe('runAgent — the single bounded execution path', () => {
  it('validates and returns a well-formed result', async () => {
    const llm = MockLLMClient.returning({
      relevant: true,
      type: 'standup_update',
      confidence: 0.9,
      reason: 'Reports finishing a ticket.',
    });

    const result = await runAgent(
      detectStandupSkill,
      {
        text: 'Finished TES-31',
        authorName: 'Pasan',
        conversation: 'Standups',
        detectedKeys: ['TES-31'],
        today: '2026-09-17',
        context: [],
      },
      depsFor(llm),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.type).toBe('standup_update');
  });

  it('sends the skill’s system prompt and JSON schema', async () => {
    const llm = MockLLMClient.returning({
      relevant: false,
      type: 'unrelated',
      confidence: 0.99,
      reason: 'Greeting.',
    });

    await runAgent(
      detectStandupSkill,
      {
        text: 'good morning',
        authorName: 'Pasan',
        conversation: 'Standups',
        detectedKeys: [],
        today: '2026-09-17',
        context: [],
      },
      depsFor(llm),
    );

    const call = llm.calls[0];
    expect(call?.systemPrompt).toBe(detectStandupSkill.systemPrompt);
    expect(call?.jsonSchema).toBe(detectStandupSkill.jsonSchema);
    expect(call?.timeoutMs).toBe(1_000);
  });

  it('retries once on a schema failure, feeding back the error', async () => {
    const llm = new MockLLMClient({
      script: [
        { kind: 'data', data: { relevant: 'yes please' } },
        {
          kind: 'data',
          data: { relevant: true, type: 'work_update', confidence: 0.8, reason: 'ok' },
        },
      ],
    });

    const result = await runAgent(
      detectStandupSkill,
      {
        text: 'Finished TES-31',
        authorName: 'Pasan',
        conversation: 'c',
        detectedKeys: [],
        today: '2026-09-17',
        context: [],
      },
      depsFor(llm),
    );

    expect(result.ok).toBe(true);
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]?.userMessage).toContain('did not match the required schema');
  });

  it('gives up after two schema failures rather than guessing', async () => {
    const llm = new MockLLMClient({ script: [{ kind: 'data', data: { nope: true } }] });

    const result = await runAgent(
      detectStandupSkill,
      {
        text: 'x',
        authorName: 'Pasan',
        conversation: 'c',
        detectedKeys: [],
        today: '2026-09-17',
        context: [],
      },
      depsFor(llm),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('schema_invalid');
    expect(llm.calls).toHaveLength(2);
  });

  it('does not retry a provider error — there is nothing to correct', async () => {
    const llm = new MockLLMClient({
      script: [{ kind: 'error', error: new LLMError('provider down', 'mock') }],
    });

    const result = await runAgent(
      detectStandupSkill,
      {
        text: 'x',
        authorName: 'Pasan',
        conversation: 'c',
        detectedKeys: [],
        today: '2026-09-17',
        context: [],
      },
      depsFor(llm),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('provider_error');
    expect(llm.calls).toHaveLength(1);
  });

  it('distinguishes a timeout from any other provider failure', async () => {
    const llm = new MockLLMClient({ script: [{ kind: 'timeout' }] });
    const result = await runAgent(
      detectStandupSkill,
      {
        text: 'x',
        authorName: 'Pasan',
        conversation: 'c',
        detectedKeys: [],
        today: '2026-09-17',
        context: [],
      },
      depsFor(llm),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('timeout');
  });

  it('returns a failure value rather than throwing, so callers must handle it', async () => {
    const llm = new MockLLMClient({ script: [{ kind: 'timeout' }] });
    // No rejection: the whole degradation strategy relies on this.
    await expect(
      runAgent(
        detectStandupSkill,
        {
          text: 'x',
          authorName: 'P',
          conversation: 'c',
          detectedKeys: [],
          today: '2026-09-17',
          context: [],
        },
        depsFor(llm),
      ),
    ).resolves.toBeDefined();
  });

  it('records an agent run for both success and failure', async () => {
    const ok = MockLLMClient.returning({
      relevant: true,
      type: 'work_update',
      confidence: 0.9,
      reason: 'r',
    });
    await runAgent(
      detectStandupSkill,
      { text: 'a', authorName: 'P', conversation: 'c', detectedKeys: [], today: 'd', context: [] },
      depsFor(ok, 'trace-ok'),
    );

    const bad = new MockLLMClient({ script: [{ kind: 'timeout' }] });
    await runAgent(
      detectStandupSkill,
      { text: 'a', authorName: 'P', conversation: 'c', detectedKeys: [], today: 'd', context: [] },
      depsFor(bad, 'trace-bad'),
    );

    expect(store.getAgentRuns('trace-ok')[0]?.resultType).toBe('ok');
    expect(store.getAgentRuns('trace-bad')[0]?.resultType).toBe('timeout');
  });

  it('records a skipped stage so the trace has no gaps', () => {
    const llm = new MockLLMClient();
    recordSkipped(depsFor(llm, 'trace-skip'), 'detect-standup', 'fast path');
    const run = store.getAgentRuns('trace-skip')[0];
    expect(run?.resultType).toBe('skipped');
    expect(run?.detail).toBe('fast path');
  });

  it('works with no store — audit is optional, reasoning is not', async () => {
    const llm = MockLLMClient.returning({
      relevant: true,
      type: 'work_update',
      confidence: 0.9,
      reason: 'r',
    });
    const result = await runAgent(
      detectStandupSkill,
      { text: 'a', authorName: 'P', conversation: 'c', detectedKeys: [], today: 'd', context: [] },
      { ...depsFor(llm), store: undefined },
    );
    expect(result.ok).toBe(true);
  });
});

// --------------------------------------------------- message classifier

describe('message classifier', () => {
  const input = (text: string) => ({
    text,
    authorName: 'Pasan',
    conversation: 'Standups',
    detectedKeys: [],
    context: [],
    today: '2026-09-17',
  });

  it('fast-paths a Jira key plus a work verb with no model call', async () => {
    const llm = new MockLLMClient();
    const result = await classifyMessage(input('Finished TES-31 today.'), depsFor(llm));

    expect(result.kind).toBe('fast_path');
    expect(llm.calls).toHaveLength(0);
  });

  it('consults the model when there is no ticket key', async () => {
    const llm = MockLLMClient.returning({
      relevant: true,
      type: 'work_update',
      confidence: 0.75,
      reason: 'Describes starting work.',
    });
    const result = await classifyMessage(input('Started on the payment work.'), depsFor(llm));

    expect(result.kind).toBe('classified');
    if (result.kind === 'classified') {
      expect(result.relevant).toBe(true);
      expect(result.type).toBe('work_update');
    }
    expect(llm.calls).toHaveLength(1);
  });

  it('treats "unrelated" as irrelevant even if the model set relevant: true', async () => {
    const llm = MockLLMClient.returning({
      relevant: true,
      type: 'unrelated',
      confidence: 0.9,
      reason: 'contradictory',
    });
    const result = await classifyMessage(input('Anyone going for lunch?'), depsFor(llm));

    if (result.kind === 'classified') expect(result.relevant).toBe(false);
  });

  it('treats a bare ticket reference as irrelevant', async () => {
    const llm = MockLLMClient.returning({
      relevant: true,
      type: 'jira_reference',
      confidence: 0.9,
      reason: 'Mentions a ticket but reports no progress.',
    });
    // Mentioning a ticket is not reporting progress on it.
    const result = await classifyMessage(input('did anyone look at that ticket?'), depsFor(llm));
    if (result.kind === 'classified') expect(result.relevant).toBe(false);
  });

  it('reports a failure rather than defaulting to relevant', async () => {
    const llm = new MockLLMClient({ script: [{ kind: 'timeout' }] });
    const result = await classifyMessage(input('something vague'), depsFor(llm));
    expect(result.kind).toBe('classifier_failed');
  });
});

// -------------------------------------------------- standup interpreter

describe('standup interpreter', () => {
  const input = (text: string, keys: string[], contexts: IssueContextResult[] = []) => ({
    text,
    authorName: 'Pasan',
    keys,
    contexts,
    context: [],
    today: '2026-09-17',
  });

  it('separates three tickets with three different intents', async () => {
    const llm = MockLLMClient.returning({
      tickets: [
        { key: 'TES-31', intent: 'completed', confidence: 0.95, evidence: 'Finished TES-31' },
        {
          key: 'TES-42',
          intent: 'blocked',
          confidence: 0.92,
          evidence: 'blocked waiting for API access',
          blockerReason: 'waiting for API access',
        },
        { key: 'TES-50', intent: 'in_progress', confidence: 0.8, evidence: 'Starting TES-50' },
      ],
      unresolvedMentions: [],
    });

    const result = await interpretWork(
      input('Finished TES-31. TES-42 is blocked waiting for API access. Starting TES-50.', [
        'TES-31',
        'TES-42',
        'TES-50',
      ]),
      depsFor(llm),
    );

    expect(result.tickets.map((t) => `${t.key}:${t.intent}`)).toEqual([
      'TES-31:completed',
      'TES-42:blocked',
      'TES-50:in_progress',
    ]);
    expect(result.degraded).toBe(false);
  });

  it('carries the uncertain flag for a hedged statement', async () => {
    const llm = MockLLMClient.returning({
      tickets: [
        {
          key: 'TES-31',
          intent: 'completed',
          confidence: 0.6,
          evidence: 'basically finished',
          uncertain: true,
        },
      ],
      unresolvedMentions: [],
    });

    const result = await interpretWork(
      input('TES-31 is basically finished.', ['TES-31']),
      depsFor(llm),
    );
    expect(result.tickets[0]?.uncertain).toBe(true);
  });

  it('carries the unblocked flag when a blocker clears', async () => {
    const llm = MockLLMClient.returning({
      tickets: [
        {
          key: 'TES-42',
          intent: 'in_progress',
          confidence: 0.9,
          evidence: 'got the credentials',
          unblocked: true,
        },
      ],
      unresolvedMentions: [],
    });

    const result = await interpretWork(
      input('Got the credentials for TES-42, back on it.', ['TES-42']),
      depsFor(llm),
    );
    expect(result.tickets[0]?.unblocked).toBe(true);
  });

  it('makes no model call when there are no keys', async () => {
    const llm = new MockLLMClient();
    const result = await interpretWork(input('no tickets here', []), depsFor(llm));

    expect(result.tickets).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });

  it('falls back to unclear for everything when the provider fails', async () => {
    const llm = new MockLLMClient({ script: [{ kind: 'timeout' }] });
    const result = await interpretWork(input('Finished TES-31', ['TES-31']), depsFor(llm));

    expect(result.degraded).toBe(true);
    expect(result.tickets).toEqual([
      { key: 'TES-31', intent: 'unclear', confidence: 0, evidence: 'Interpretation timed out.' },
    ]);
  });

  it('includes the Jira status in the prompt so "finished" can be disambiguated', async () => {
    const llm = MockLLMClient.returning({
      tickets: [{ key: 'TES-31', intent: 'completed', confidence: 0.9, evidence: 'done' }],
      unresolvedMentions: [],
    });

    await interpretWork(
      input('Finished TES-31', ['TES-31'], [present({ status: 'Code Review' })]),
      depsFor(llm),
    );

    const prompt = llm.calls[0]?.userMessage ?? '';
    expect(prompt).toContain('currently "Code Review"');
    expect(prompt).toContain('can move to: Code Review, Done');
  });

  it('never puts a transition id in the prompt', async () => {
    const llm = MockLLMClient.returning({
      tickets: [{ key: 'TES-31', intent: 'completed', confidence: 0.9, evidence: 'done' }],
      unresolvedMentions: [],
    });
    await interpretWork(input('Finished TES-31', ['TES-31'], [present()]), depsFor(llm));

    // Transition ids are StandSync's alone; a model must not be able to name one.
    expect(llm.calls[0]?.userMessage).not.toMatch(/transitionId|"id"\s*:/);
  });
});

describe('interpreter reconciliation', () => {
  it('drops a key the model invented', () => {
    const tickets = reconcile(
      [
        { key: 'TES-31', intent: 'completed', confidence: 0.9, evidence: 'a' },
        { key: 'TES-999', intent: 'completed', confidence: 0.9, evidence: 'invented' },
      ],
      ['TES-31'],
    );
    expect(tickets.map((t) => t.key)).toEqual(['TES-31']);
  });

  it('fills in a key the model skipped as unclear', () => {
    const tickets = reconcile(
      [{ key: 'TES-31', intent: 'completed', confidence: 0.9, evidence: 'a' }],
      ['TES-31', 'TES-42'],
    );
    expect(tickets[1]).toEqual({ key: 'TES-42', intent: 'unclear', confidence: 0, evidence: '' });
  });

  it('keeps the first reading of a duplicated key', () => {
    const tickets = reconcile(
      [
        { key: 'TES-31', intent: 'completed', confidence: 0.9, evidence: 'first' },
        { key: 'TES-31', intent: 'blocked', confidence: 0.5, evidence: 'second' },
      ],
      ['TES-31'],
    );
    expect(tickets).toHaveLength(1);
    expect(tickets[0]?.evidence).toBe('first');
  });

  it('preserves mention order, so the card reads back as written', () => {
    const tickets = reconcile(
      [
        { key: 'TES-50', intent: 'in_progress', confidence: 0.8, evidence: 'c' },
        { key: 'TES-31', intent: 'completed', confidence: 0.9, evidence: 'a' },
      ],
      ['TES-31', 'TES-50'],
    );
    expect(tickets.map((t) => t.key)).toEqual(['TES-31', 'TES-50']);
  });

  it('allUnclear covers every key with zero confidence', () => {
    expect(allUnclear(['A-1', 'B-2'], 'because')).toEqual([
      { key: 'A-1', intent: 'unclear', confidence: 0, evidence: 'because' },
      { key: 'B-2', intent: 'unclear', confidence: 0, evidence: 'because' },
    ]);
  });
});

// -------------------------------------------------- proposal validator

describe('proposal validator', () => {
  const finding = (over: Partial<DeterministicFinding> = {}): DeterministicFinding => ({
    transitionAvailable: true,
    alreadyInTargetStatus: false,
    issueMissing: false,
    assignedToSomeoneElse: false,
    ...over,
  });

  const validateInput = (over: Record<string, unknown> = {}) => ({
    text: 'Finished coding TES-31.',
    authorName: 'Pasan',
    today: '2026-09-17',
    contexts: [present()],
    changes: [
      {
        key: 'TES-31',
        proposed: 'In Progress → Done',
        intent: 'completed',
        evidence: 'Finished coding',
        confidence: 0.9,
      },
    ],
    deterministic: new Map([['TES-31', finding()]]),
    ...over,
  });

  it('passes a clean change through', async () => {
    const llm = MockLLMClient.returning({
      valid: true,
      risk: 'low',
      changes: [{ key: 'TES-31', valid: true, risk: 'low', warnings: [], explanation: 'Matches.' }],
      explanation: 'Fine.',
    });

    const verdict = await validateProposals(validateInput(), depsFor(llm));
    expect(verdict.kind).toBe('validated');
    if (verdict.kind === 'validated') {
      expect(verdict.overall.valid).toBe(true);
      expect(verdict.byKey.get('TES-31')?.risk).toBe('low');
    }
  });

  it('surfaces a Code Review objection when the model raises one', async () => {
    const llm = MockLLMClient.returning({
      valid: false,
      risk: 'high',
      changes: [
        {
          key: 'TES-31',
          valid: false,
          risk: 'high',
          warnings: ['Workflow has a Code Review stage before Done.'],
          explanation: 'Pasan said the implementation is finished, not that it was reviewed.',
        },
      ],
      explanation: 'Moving straight to Done skips Code Review.',
    });

    const verdict = await validateProposals(validateInput(), depsFor(llm));
    if (verdict.kind === 'validated') {
      expect(verdict.overall.valid).toBe(false);
      expect(verdict.byKey.get('TES-31')?.warnings[0]).toContain('Code Review');
    }
  });

  it('fails closed when the stage fails — never reports success', async () => {
    const llm = new MockLLMClient({ script: [{ kind: 'timeout' }] });
    const verdict = await validateProposals(validateInput(), depsFor(llm));
    expect(verdict.kind).toBe('unavailable');
  });

  it('treats a key the validator skipped as un-validated, not as fine', async () => {
    const llm = MockLLMClient.returning({
      valid: true,
      risk: 'low',
      changes: [], // said nothing about TES-31
      explanation: '',
    });

    const verdict = await validateProposals(validateInput(), depsFor(llm));
    if (verdict.kind === 'validated') {
      const verdictForKey = verdict.byKey.get('TES-31');
      expect(verdictForKey?.risk).toBe('medium');
      expect(verdictForKey?.warnings.join(' ')).toContain('did not cover');
    }
  });

  it('ignores a verdict about a key it did not ask about', async () => {
    const llm = MockLLMClient.returning({
      valid: true,
      risk: 'low',
      changes: [
        { key: 'TES-31', valid: true, risk: 'low', warnings: [], explanation: 'ok' },
        { key: 'TES-999', valid: true, risk: 'low', warnings: [], explanation: 'invented' },
      ],
      explanation: '',
    });

    const verdict = await validateProposals(validateInput(), depsFor(llm));
    if (verdict.kind === 'validated') {
      expect([...verdict.byKey.keys()]).toEqual(['TES-31']);
    }
  });

  it('skips the model when there is nothing to validate', async () => {
    const llm = new MockLLMClient();
    const verdict = await validateProposals(
      validateInput({ changes: [], deterministic: new Map() }),
      depsFor(llm),
    );
    expect(verdict.kind).toBe('validated');
    expect(llm.calls).toHaveLength(0);
  });

  it('never sends a transition id to the validator', async () => {
    const llm = MockLLMClient.returning({
      valid: true,
      risk: 'low',
      changes: [{ key: 'TES-31', valid: true, risk: 'low', warnings: [], explanation: 'ok' }],
      explanation: '',
    });
    await validateProposals(validateInput(), depsFor(llm));
    expect(llm.calls[0]?.userMessage).not.toMatch(/transitionId/);
  });
});

describe('deterministic findings override the validator', () => {
  const clean = {
    key: 'TES-31',
    valid: true,
    risk: 'low' as const,
    warnings: [] as string[],
    explanation: 'Looks fine.',
  };

  it('invalidates a change when the transition is unavailable, whatever the model said', () => {
    const merged = applyDeterministic(clean, {
      transitionAvailable: false,
      alreadyInTargetStatus: false,
      issueMissing: false,
      assignedToSomeoneElse: false,
    });

    expect(merged.valid).toBe(false);
    expect(merged.risk).toBe('high');
    expect(merged.warnings.join(' ')).toContain('no transition');
  });

  it('invalidates a change to an unreadable issue', () => {
    const merged = applyDeterministic(clean, {
      transitionAvailable: true,
      alreadyInTargetStatus: false,
      issueMissing: true,
      assignedToSomeoneElse: false,
    });
    expect(merged.valid).toBe(false);
    expect(merged.risk).toBe('high');
  });

  it('invalidates a change to a ticket already in that status', () => {
    const merged = applyDeterministic(clean, {
      transitionAvailable: true,
      alreadyInTargetStatus: true,
      issueMissing: false,
      assignedToSomeoneElse: false,
    });
    expect(merged.valid).toBe(false);
    expect(merged.warnings.join(' ')).toContain('already in that status');
  });

  it('raises risk but keeps validity for someone else’s ticket', () => {
    const merged = applyDeterministic(clean, {
      transitionAvailable: true,
      alreadyInTargetStatus: false,
      issueMissing: false,
      assignedToSomeoneElse: true,
    });
    // Teams hand work over; this is a caution, not a rejection.
    expect(merged.valid).toBe(true);
    expect(merged.risk).toBe('medium');
  });

  it('only ever tightens — it cannot bless a change the model rejected', () => {
    const rejected = { ...clean, valid: false, risk: 'high' as const };
    const merged = applyDeterministic(rejected, {
      transitionAvailable: true,
      alreadyInTargetStatus: false,
      issueMissing: false,
      assignedToSomeoneElse: false,
    });
    expect(merged.valid).toBe(false);
    expect(merged.risk).toBe('high');
  });

  it('de-duplicates and caps warnings', () => {
    const noisy = { ...clean, warnings: Array.from({ length: 10 }, () => 'same warning') };
    const merged = applyDeterministic(noisy, {
      transitionAvailable: false,
      alreadyInTargetStatus: true,
      issueMissing: true,
      assignedToSomeoneElse: true,
    });
    expect(merged.warnings.length).toBeLessThanOrEqual(5);
    expect(new Set(merged.warnings).size).toBe(merged.warnings.length);
  });
});

describe('risk and assignee helpers', () => {
  it('highestRisk takes the worst', () => {
    expect(highestRisk(['low', 'medium', 'high'])).toBe('high');
    expect(highestRisk(['low', 'medium'])).toBe('medium');
    expect(highestRisk(['low'])).toBe('low');
    expect(highestRisk([])).toBe('low');
  });

  it('assignedToSomeoneElse compares case- and space-insensitively', () => {
    expect(assignedToSomeoneElse(present({ assignee: 'Pasan' }), 'pasan ')).toBe(false);
    expect(assignedToSomeoneElse(present({ assignee: 'Chandima' }), 'Pasan')).toBe(true);
  });

  it('is false for an unassigned or unreadable issue', () => {
    expect(assignedToSomeoneElse(present({ assignee: undefined }), 'Pasan')).toBe(false);
    expect(
      assignedToSomeoneElse({ key: 'TES-31', exists: false, reason: 'not found' }, 'Pasan'),
    ).toBe(false);
    expect(assignedToSomeoneElse(undefined, 'Pasan')).toBe(false);
  });
});

// ------------------------------------------------------- ambiguity agent

describe('ambiguity agent', () => {
  const candidate = {
    key: 'TES-31',
    intent: 'completed' as const,
    evidence: 'basically finished',
    confidence: 0.6,
    uncertain: true,
    proposed: 'In Progress → Done',
  };

  const ambiguityInput = {
    text: 'TES-31 is basically finished.',
    authorName: 'Pasan',
    candidates: [candidate],
    contexts: [present()],
  };

  it('produces a question with reachable options', async () => {
    const llm = MockLLMClient.returning({
      tickets: [
        {
          key: 'TES-31',
          ambiguous: true,
          question: 'You said TES-31 is "basically finished" — is it ready for review, or done?',
          options: [
            { label: 'Move to Code Review', intent: 'in_progress' },
            { label: 'Move to Done', intent: 'completed' },
            { label: 'Keep In Progress', intent: 'no_change' },
          ],
          reason: 'Hedged completion language.',
        },
      ],
    });

    const verdict = await detectAmbiguity(ambiguityInput, depsFor(llm));
    expect(verdict.kind).toBe('assessed');
    if (verdict.kind === 'assessed') {
      const finding = verdict.byKey.get('TES-31');
      expect(finding?.ambiguous).toBe(true);
      expect(finding?.options.map((o) => o.label)).toEqual([
        'Move to Code Review',
        'Move to Done',
        'Keep In Progress',
      ]);
    }
  });

  it('reports not-ambiguous when the model says so', async () => {
    const llm = MockLLMClient.returning({
      tickets: [{ key: 'TES-31', ambiguous: false, question: '', options: [], reason: '' }],
    });
    const verdict = await detectAmbiguity(ambiguityInput, depsFor(llm));
    if (verdict.kind === 'assessed') {
      expect(verdict.byKey.get('TES-31')?.ambiguous).toBe(false);
    }
  });

  it('reports unavailable when the stage fails', async () => {
    const llm = new MockLLMClient({ script: [{ kind: 'timeout' }] });
    const verdict = await detectAmbiguity(ambiguityInput, depsFor(llm));
    expect(verdict.kind).toBe('unavailable');
  });

  it('skips the model with no candidates', async () => {
    const llm = new MockLLMClient();
    const verdict = await detectAmbiguity({ ...ambiguityInput, candidates: [] }, depsFor(llm));
    expect(verdict.kind).toBe('assessed');
    expect(llm.calls).toHaveLength(0);
  });
});

describe('ambiguity option filtering', () => {
  const verdict = (
    options: { label: string; intent: 'completed' | 'in_progress' | 'no_change' }[],
  ) => ({
    key: 'TES-31',
    ambiguous: true,
    question: 'What should StandSync propose?',
    options,
    reason: 'hedged',
  });

  it('drops a status the live workflow cannot reach', () => {
    const options = buildOptions(
      verdict([
        { label: 'Move to Code Review', intent: 'in_progress' },
        { label: 'Move to Released', intent: 'completed' }, // not reachable
      ]),
      present({ availableTransitions: ['Code Review', 'Done'] }),
    );

    expect(options.map((o) => o.label)).toEqual(['Move to Code Review', 'Leave it as it is']);
  });

  it('keeps a label that names no status', () => {
    const options = buildOptions(
      verdict([{ label: 'Not finished yet', intent: 'in_progress' }]),
      present(),
    );
    expect(options.map((o) => o.label)).toContain('Not finished yet');
  });

  it('always appends a no-change escape hatch', () => {
    const options = buildOptions(
      verdict([{ label: 'Move to Done', intent: 'completed' }]),
      present(),
    );
    // Declining must be one click, never "ignore the card".
    expect(options.some((o) => o.intent === 'no_change')).toBe(true);
  });

  it('does not duplicate an existing no-change option', () => {
    const options = buildOptions(
      verdict([
        { label: 'Move to Done', intent: 'completed' },
        { label: 'Keep as is', intent: 'no_change' },
      ]),
      present(),
    );
    expect(options.filter((o) => o.intent === 'no_change')).toHaveLength(1);
  });

  it('caps the option count so a card stays readable', () => {
    const options = buildOptions(
      verdict([
        { label: 'A', intent: 'completed' },
        { label: 'B', intent: 'in_progress' },
        { label: 'C', intent: 'completed' },
        { label: 'D', intent: 'in_progress' },
      ]),
      present(),
    );
    expect(options.length).toBeLessThanOrEqual(4);
  });

  it('treats a question with fewer than two options as not ambiguous', () => {
    const finding = toFinding(
      {
        key: 'TES-31',
        intent: 'completed',
        evidence: 'e',
        confidence: 0.6,
        uncertain: true,
        proposed: 'x',
      },
      { key: 'TES-31', ambiguous: true, question: 'Hmm?', options: [], reason: 'r' },
      // No reachable transitions, so only the no-change option survives.
      present({ availableTransitions: [] }),
    );
    // A question with one answer is not a question.
    expect(finding.ambiguous).toBe(false);
  });

  it('treats an empty question as not ambiguous', () => {
    const finding = toFinding(
      {
        key: 'TES-31',
        intent: 'completed',
        evidence: 'e',
        confidence: 0.6,
        uncertain: true,
        proposed: 'x',
      },
      {
        key: 'TES-31',
        ambiguous: true,
        question: '   ',
        options: [
          { label: 'Move to Done', intent: 'completed' },
          { label: 'Keep as is', intent: 'no_change' },
        ],
        reason: 'r',
      },
      present(),
    );
    expect(finding.ambiguous).toBe(false);
  });

  it('is not ambiguous when the model returned no verdict for the key', () => {
    const finding = toFinding(
      {
        key: 'TES-31',
        intent: 'completed',
        evidence: 'e',
        confidence: 0.9,
        uncertain: false,
        proposed: 'x',
      },
      undefined,
      present(),
    );
    expect(finding.ambiguous).toBe(false);
  });
});

// --------------------------------------------------------- blocker agent

describe('blocker agent', () => {
  const blockerInput = (over: Record<string, unknown> = {}) => ({
    text: 'TES-42 is blocked waiting for API credentials.',
    authorName: 'Pasan',
    keys: ['TES-42'],
    today: '2026-09-17',
    conversationId: 'conv-1',
    unblockedKeys: [],
    ...over,
  });

  const blockerResponse = (over: Record<string, unknown> = {}) => ({
    blockers: [
      {
        key: 'TES-42',
        blocked: true,
        category: 'access_or_credentials',
        description: 'waiting for API credentials',
        dependency: 'platform team',
        severity: 'high',
        needsAttention: true,
        ...over,
      },
    ],
  });

  it('records a new blocker and marks it worth surfacing', async () => {
    const llm = MockLLMClient.returning(blockerResponse());
    const result = await detectBlockers(blockerInput(), depsFor(llm));

    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.isNew).toBe(true);
    expect(result.observations[0]?.shouldSurface).toBe(true);
    expect(store.getOpenBlockers('conv-1')).toHaveLength(1);
  });

  it('does not re-surface the same unresolved blocker', async () => {
    const llm = new MockLLMClient({
      script: [
        { kind: 'data', data: blockerResponse() },
        { kind: 'data', data: blockerResponse() },
      ],
    });

    await detectBlockers(blockerInput(), depsFor(llm));
    const second = await detectBlockers(blockerInput(), depsFor(llm, 'trace-2'));

    // The anti-nag rule: recorded again, reported once.
    expect(second.observations[0]?.isNew).toBe(false);
    expect(second.observations[0]?.timesReported).toBe(2);
    expect(second.observations[0]?.shouldSurface).toBe(false);
    expect(store.getOpenBlockers('conv-1')).toHaveLength(1);
  });

  it('re-surfaces when the blocker description changes', async () => {
    const llm = new MockLLMClient({
      script: [
        { kind: 'data', data: blockerResponse() },
        { kind: 'data', data: blockerResponse({ description: 'vendor has not replied' }) },
      ],
    });

    await detectBlockers(blockerInput(), depsFor(llm));
    const second = await detectBlockers(blockerInput(), depsFor(llm, 'trace-2'));
    expect(second.observations[0]?.shouldSurface).toBe(true);
  });

  it('ignores a ticket reported as not blocked', async () => {
    const llm = MockLLMClient.returning({
      blockers: [
        {
          key: 'TES-42',
          blocked: false,
          category: null,
          description: null,
          dependency: null,
          severity: null,
          needsAttention: false,
        },
      ],
    });

    const result = await detectBlockers(blockerInput(), depsFor(llm));
    expect(result.observations).toEqual([]);
    expect(store.getOpenBlockers('conv-1')).toEqual([]);
  });

  it('ignores a key it was not given', async () => {
    const llm = MockLLMClient.returning(blockerResponse({ key: 'TES-999' }));
    const result = await detectBlockers(blockerInput(), depsFor(llm));
    expect(result.observations).toEqual([]);
  });

  it('resolves a blocker deterministically when the author says it cleared', async () => {
    const llm = new MockLLMClient({
      script: [
        { kind: 'data', data: blockerResponse() },
        { kind: 'data', data: { blockers: [] } },
      ],
    });

    await detectBlockers(blockerInput(), depsFor(llm));
    expect(store.getOpenBlockers('conv-1')).toHaveLength(1);

    await detectBlockers(
      blockerInput({ text: 'Got the credentials for TES-42.', unblockedKeys: ['TES-42'] }),
      depsFor(llm, 'trace-2'),
    );
    expect(store.getOpenBlockers('conv-1')).toEqual([]);
  });

  it('degrades without failing when the stage errors', async () => {
    const llm = new MockLLMClient({ script: [{ kind: 'timeout' }] });
    const result = await detectBlockers(blockerInput(), depsFor(llm));

    // A blocker-detection failure must not stop Jira synchronisation.
    expect(result.degraded).toBe(true);
    expect(result.observations).toEqual([]);
  });

  it('skips the model when there are no keys', async () => {
    const llm = new MockLLMClient();
    const result = await detectBlockers(blockerInput({ keys: [] }), depsFor(llm));
    expect(result.degraded).toBe(false);
    expect(llm.calls).toHaveLength(0);
  });
});

// --------------------------------------------------------- summary agent

describe('summary agent', () => {
  const summaryInput = (over: Record<string, unknown> = {}) => ({
    period: 'the last 24 hours',
    today: '2026-09-17',
    contributors: ['Pasan'],
    issues: [
      { key: 'TES-31', summary: 'Payment validation', status: 'Done', observations: ['applied'] },
      { key: 'TES-42', summary: 'Invoice API', status: 'In Progress', observations: [] },
    ],
    ...over,
  });

  it('returns empty groups with no model call when nothing was recorded', async () => {
    const llm = new MockLLMClient();
    const result = await summarizeTeam(summaryInput({ issues: [] }), depsFor(llm));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.summary.completed).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });

  it('groups issues from the supplied list', async () => {
    const llm = MockLLMClient.returning({
      completed: [{ key: 'TES-31', text: 'Payment validation' }],
      inProgress: [{ key: 'TES-42', text: 'Invoice API' }],
      blocked: [],
      attention: [],
    });

    const result = await summarizeTeam(summaryInput(), depsFor(llm));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.completed.map((l) => l.key)).toEqual(['TES-31']);
      expect(result.summary.inProgress.map((l) => l.key)).toEqual(['TES-42']);
    }
  });

  it('reports a failure without affecting anything else', async () => {
    const llm = new MockLLMClient({ script: [{ kind: 'timeout' }] });
    const result = await summarizeTeam(summaryInput(), depsFor(llm));
    expect(result.ok).toBe(false);
  });
});

describe('summary grounding', () => {
  const input = {
    period: 'p',
    today: 'd',
    contributors: [],
    issues: [
      { key: 'TES-31', summary: 's', status: 'Done', observations: [] },
      { key: 'TES-42', summary: 's', status: 'In Progress', observations: [] },
    ],
  };

  it('drops a ticket the model invented', () => {
    const grounded = groundToInput(
      {
        completed: [
          { key: 'TES-31', text: 'real' },
          { key: 'TES-999', text: 'hallucinated' },
        ],
        inProgress: [],
        blocked: [],
        attention: [],
      },
      input,
    );
    expect(grounded.completed.map((l) => l.key)).toEqual(['TES-31']);
  });

  it('places a ticket in only one group, blocked winning', () => {
    const grounded = groundToInput(
      {
        completed: [{ key: 'TES-42', text: 'x' }],
        inProgress: [{ key: 'TES-42', text: 'x' }],
        blocked: [{ key: 'TES-42', text: 'x' }],
        attention: [],
      },
      input,
    );
    expect(grounded.blocked.map((l) => l.key)).toEqual(['TES-42']);
    expect(grounded.completed).toEqual([]);
    expect(grounded.inProgress).toEqual([]);
  });

  it('drops empty attention items', () => {
    const grounded = groundToInput(
      { completed: [], inProgress: [], blocked: [], attention: ['real concern', '   ', ''] },
      input,
    );
    expect(grounded.attention).toEqual(['real concern']);
  });
});

describe('summarizeZodError', () => {
  it('keeps a validation failure to one greppable line', async () => {
    const llm = new MockLLMClient({ script: [{ kind: 'data', data: {} }] });
    const result = await runAgent(
      detectStandupSkill,
      { text: 'x', authorName: 'P', conversation: 'c', detectedKeys: [], today: 'd', context: [] },
      depsFor(llm),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('detect-standup did not return a valid result');
    expect(result.reason.split('\n')).toHaveLength(1);
  });

  it('caps the number of issues reported, so one line stays readable', () => {
    const schema = z.object({
      a: z.string(),
      b: z.string(),
      c: z.string(),
      d: z.string(),
      e: z.string(),
      f: z.string(),
      g: z.string(),
    });

    const parsed = schema.safeParse({});
    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    const summary = summarizeZodError(parsed.error);
    expect(summary.split('; ')).toHaveLength(5);
    expect(summary).toContain('a:');
  });
});
