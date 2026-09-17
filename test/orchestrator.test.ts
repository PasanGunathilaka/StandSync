import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ApprovalStore } from '../src/approval/store.js';
import { JiraClient } from '../src/jira/client.js';
import { JiraIssues } from '../src/jira/issues.js';
import { JiraActions } from '../src/jira/actions.js';
import { JiraContextService } from '../src/jira/context.js';
import { MockLLMClient, type MockBehavior } from '../src/llm/mock.js';
import { orchestrateMessage, type OrchestratorDeps } from '../src/agents/orchestrator.js';
import { resolveClarification } from '../src/agents/clarification.js';
import { executeBatch } from '../src/approval/execute.js';
import { loadConfig, type Config } from '../src/config.js';
import { logger } from '../src/logger.js';

/**
 * Orchestrator integration.
 *
 * Jira is a stubbed `fetch`, so the real JiraClient, JiraIssues,
 * JiraContextService, statusMap and buildProposals all run — only the network is
 * fake. The LLM is scripted, so each reasoning stage's output is exact and the
 * assertions are about what StandSync *does* with that output.
 *
 * The property asserted throughout: no Jira write happens until executeBatch.
 */

// --------------------------------------------------------------- Jira stub

interface StubIssue {
  key: string;
  summary: string;
  status: string;
  issueType?: string;
  assignee?: string | null;
  resolution?: string | null;
  /** Destination statuses, mapped to transition ids. */
  transitions: { id: string; name: string; to: string }[];
}

const TES_31: StubIssue = {
  key: 'TES-31',
  summary: 'Payment validation',
  status: 'In Progress',
  assignee: 'Pasan',
  transitions: [
    { id: '21', name: 'Code Review', to: 'Code Review' },
    { id: '31', name: 'Done', to: 'Done' },
  ],
};

const TES_42: StubIssue = {
  key: 'TES-42',
  summary: 'Invoice API',
  status: 'In Progress',
  assignee: 'Pasan',
  transitions: [{ id: '31', name: 'Done', to: 'Done' }],
};

const TES_50: StubIssue = {
  key: 'TES-50',
  summary: 'Checkout UI',
  status: 'To Do',
  assignee: 'Pasan',
  transitions: [{ id: '11', name: 'Start', to: 'In Progress' }],
};

/** Records every Jira request, so a test can prove no write was attempted. */
class JiraStub {
  readonly requests: { method: string; url: string; body?: unknown }[] = [];
  private readonly issues = new Map<string, StubIssue>();

  constructor(issues: StubIssue[]) {
    for (const issue of issues) this.issues.set(issue.key, issue);
  }

  /** Mutates Jira mid-test, to simulate a ticket moving under StandSync. */
  setIssue(issue: StubIssue): void {
    this.issues.set(issue.key, issue);
  }

  get writes(): { method: string; url: string }[] {
    return this.requests.filter((r) => r.method === 'POST' || r.method === 'PUT');
  }

  /** Jira writes are POSTs to /transitions or /comment. */
  get mutations(): string[] {
    return this.writes
      .filter((r) => /\/transitions$|\/comment$/.test(r.url))
      .map((r) => `${r.method} ${r.url.replace(/^.*\/rest/, '/rest')}`);
  }

  readonly fetch: typeof fetch = (input, init) => {
    // RequestInfo is a union; narrowed rather than stringified so a Request
    // object cannot silently become "[object Object]".
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    this.requests.push({
      method,
      url,
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}),
    });

    const keyMatch = /\/issue\/([^/?]+)/.exec(url);
    const key = keyMatch?.[1] ? decodeURIComponent(keyMatch[1]) : '';
    const issue = this.issues.get(key);

    if (!issue) return Promise.resolve(json({}, 404));

    if (url.includes('/transitions') && method === 'GET') {
      return Promise.resolve(
        json({
          transitions: issue.transitions.map((t) => ({
            id: t.id,
            name: t.name,
            to: { name: t.to },
          })),
        }),
      );
    }
    if (url.includes('/transitions') && method === 'POST') {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (url.includes('/comment')) return Promise.resolve(json({ id: '1' }, 201));

    return Promise.resolve(
      json({
        key: issue.key,
        fields: {
          summary: issue.summary,
          status: { name: issue.status },
          issuetype: { name: issue.issueType ?? 'Task' },
          assignee: issue.assignee ? { displayName: issue.assignee } : null,
          reporter: null,
          resolution: issue.resolution ? { name: issue.resolution } : null,
        },
      }),
    );
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

// ------------------------------------------------------------ test harness

let store: ApprovalStore;

beforeEach(() => {
  store = ApprovalStore.open(':memory:');
});

afterEach(() => {
  store.close();
  vi.restoreAllMocks();
});

const configFor = (over: Record<string, string> = {}): Config =>
  loadConfig({
    JIRA_BASE_URL: 'https://example.atlassian.net',
    JIRA_EMAIL: 'bot@example.com',
    JIRA_API_TOKEN: 'token',
    STANDSYNC_AMBIENT_MODE: 'true',
    TEAMS_ALLOWED_CONVERSATION_ID: 'conv-1',
    ...over,
  });

interface Harness {
  deps: OrchestratorDeps;
  jira: JiraStub;
  llm: MockLLMClient;
  actions: JiraActions;
}

function harness(params: {
  issues?: StubIssue[];
  script: MockBehavior[];
  config?: Record<string, string>;
}): Harness {
  const jira = new JiraStub(params.issues ?? [TES_31, TES_42, TES_50]);
  const client = new JiraClient({
    baseUrl: 'https://example.atlassian.net',
    email: 'bot@example.com',
    apiToken: 'token',
    fetchImpl: jira.fetch,
    maxRetries: 0,
  });
  const issues = new JiraIssues(client);
  const llm = new MockLLMClient({ script: params.script });

  return {
    jira,
    llm,
    actions: new JiraActions(client),
    deps: {
      config: configFor(params.config),
      store,
      context: new JiraContextService({ client, issues, log: logger }),
      llm,
      log: logger,
    },
  };
}

const message = (over: Record<string, unknown> = {}) => ({
  text: 'Finished TES-31.',
  authorId: 'user-pasan',
  authorName: 'Pasan',
  conversationId: 'conv-1',
  messageId: 'msg-1',
  source: 'ambient' as const,
  ...over,
});

// Scripted stage responses, in the order the orchestrator calls them.
const data = (value: unknown): MockBehavior => ({ kind: 'data', data: value });

const interpretation = (tickets: unknown[]): MockBehavior =>
  data({ tickets, unresolvedMentions: [] });

const validation = (changes: unknown[], over: Record<string, unknown> = {}): MockBehavior =>
  data({ valid: true, risk: 'low', changes, explanation: '', ...over });

const NO_BLOCKERS = data({ blockers: [] });

const cleanVerdict = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  valid: true,
  risk: 'low',
  warnings: [],
  explanation: '',
  ...over,
});

// ------------------------------------------------------------------- tests

describe('ambient message → proposal, with no Jira write', () => {
  it('processes a channel message that never mentioned StandSync', async () => {
    const { deps, jira } = harness({
      script: [
        interpretation([
          { key: 'TES-31', intent: 'completed', confidence: 0.95, evidence: 'Finished TES-31' },
        ]),
        validation([cleanVerdict('TES-31')]),
        NO_BLOCKERS,
      ],
    });

    const outcome = await orchestrateMessage(deps, message());

    expect(outcome.kind).toBe('proposal');
    if (outcome.kind !== 'proposal') return;

    expect(outcome.batch.origin?.source).toBe('ambient');
    expect(outcome.batch.proposals).toHaveLength(1);
    expect(outcome.batch.proposals[0]?.actions).toEqual([
      { type: 'transition', fromStatus: 'In Progress', toStatus: 'Done', transitionId: '31' },
    ]);
    // The whole point: nothing was written.
    expect(jira.mutations).toEqual([]);
    expect(outcome.batch.status).toBe('pending');
  });

  it('pre-selects a confident, validated, verified change', async () => {
    const { deps } = harness({
      script: [
        interpretation([
          { key: 'TES-31', intent: 'completed', confidence: 0.95, evidence: 'Finished TES-31' },
        ]),
        validation([cleanVerdict('TES-31')]),
        NO_BLOCKERS,
      ],
    });

    const outcome = await orchestrateMessage(deps, message());
    if (outcome.kind !== 'proposal') throw new Error(`expected proposal, got ${outcome.kind}`);

    const proposal = outcome.batch.proposals[0];
    expect(proposal?.selected).toBe(true);
    expect(proposal?.review?.risk).toBe('low');
    expect(proposal?.review?.transitionVerified).toBe(true);
  });

  it('writes a factual explanation naming the author and their words', async () => {
    const { deps } = harness({
      script: [
        interpretation([
          {
            key: 'TES-31',
            intent: 'completed',
            confidence: 0.95,
            evidence: 'the implementation is finished',
          },
        ]),
        validation([cleanVerdict('TES-31')]),
        NO_BLOCKERS,
      ],
    });

    const outcome = await orchestrateMessage(deps, message());
    if (outcome.kind !== 'proposal') throw new Error('expected proposal');

    const explanation = outcome.batch.proposals[0]?.explanation ?? '';
    expect(explanation).toContain('Pasan said "the implementation is finished"');
    expect(explanation).toContain('Done is an available next transition in Jira');
    // No generic AI filler.
    expect(explanation.toLowerCase()).not.toContain('as an ai');
    expect(explanation.toLowerCase()).not.toContain('it appears that');
  });

  it('records an agent run per stage under one trace id', async () => {
    const { deps } = harness({
      script: [
        interpretation([
          { key: 'TES-31', intent: 'completed', confidence: 0.95, evidence: 'Finished' },
        ]),
        validation([cleanVerdict('TES-31')]),
        NO_BLOCKERS,
      ],
    });

    const outcome = await orchestrateMessage(deps, message());
    if (outcome.kind !== 'proposal') throw new Error('expected proposal');

    const traceId = outcome.batch.origin?.traceId ?? '';
    const runs = store.getAgentRuns(traceId);
    expect(runs.map((r) => r.agentName)).toContain('interpret-work');
    expect(runs.map((r) => r.agentName)).toContain('validate-proposal');
    expect(runs.every((r) => r.model === 'mock-model')).toBe(true);
  });
});

describe('ambient relevance filtering', () => {
  it('stays silent on an irrelevant message and posts nothing', async () => {
    const { deps, jira, llm } = harness({
      script: [data({ relevant: false, type: 'unrelated', confidence: 0.98, reason: 'Social.' })],
    });

    const outcome = await orchestrateMessage(
      deps,
      message({ text: 'Anyone going for lunch?', messageId: 'msg-lunch' }),
    );

    expect(outcome).toEqual({ kind: 'ignored', reason: 'classified_irrelevant' });
    // Only the classifier ran; no Jira read, no interpretation.
    expect(llm.calls).toHaveLength(1);
    expect(jira.requests).toEqual([]);
  });

  it('stays silent when the classifier is unsure', async () => {
    const { deps } = harness({
      script: [data({ relevant: true, type: 'work_update', confidence: 0.3, reason: 'Maybe.' })],
    });

    const outcome = await orchestrateMessage(
      deps,
      message({ text: 'the thing is moving along', messageId: 'msg-vague' }),
    );
    expect(outcome).toEqual({ kind: 'ignored', reason: 'low_confidence' });
  });

  it('stays silent — and touches nothing — when the classifier fails', async () => {
    const { deps, jira } = harness({ script: [{ kind: 'timeout' }] });

    const outcome = await orchestrateMessage(
      deps,
      message({ text: 'some update about work', messageId: 'msg-fail' }),
    );

    expect(outcome).toEqual({ kind: 'ignored', reason: 'classifier_failed' });
    expect(jira.requests).toEqual([]);
  });

  it('skips the classifier entirely on the fast path', async () => {
    const { deps, llm } = harness({
      script: [
        interpretation([
          { key: 'TES-31', intent: 'completed', confidence: 0.95, evidence: 'Finished TES-31' },
        ]),
        validation([cleanVerdict('TES-31')]),
        NO_BLOCKERS,
      ],
    });

    await orchestrateMessage(deps, message({ text: 'Finished TES-31.' }));
    // First call is the interpreter, not the classifier.
    expect(llm.calls[0]?.systemPrompt).toContain('You interpret software team work updates');
  });

  it('skips the classifier for a directed message', async () => {
    const { deps, llm } = harness({
      script: [
        interpretation([
          { key: 'TES-31', intent: 'completed', confidence: 0.9, evidence: 'done with it' },
        ]),
        validation([cleanVerdict('TES-31')]),
        NO_BLOCKERS,
      ],
    });

    await orchestrateMessage(
      deps,
      message({ text: 'TES-31 is all wrapped up now', source: 'mention' }),
    );
    expect(llm.calls[0]?.systemPrompt).toContain('You interpret software team work updates');
  });

  it('records a relevant message with no ticket key, then stays quiet', async () => {
    const { deps, jira } = harness({
      script: [
        data({
          relevant: true,
          type: 'work_update',
          confidence: 0.9,
          reason: 'Describes work with no key.',
        }),
      ],
    });

    const outcome = await orchestrateMessage(
      deps,
      message({ text: 'Started on the payment work today', messageId: 'msg-nokey' }),
    );

    expect(outcome).toEqual({ kind: 'ignored', reason: 'no_jira_keys' });
    expect(jira.requests).toEqual([]);
  });
});

describe('deduplication', () => {
  const okScript = (): MockBehavior[] => [
    interpretation([
      { key: 'TES-31', intent: 'completed', confidence: 0.95, evidence: 'Finished TES-31' },
    ]),
    validation([cleanVerdict('TES-31')]),
    NO_BLOCKERS,
  ];

  it('a re-delivered activity produces no second batch', async () => {
    const { deps } = harness({ script: [...okScript(), ...okScript()] });

    const first = await orchestrateMessage(deps, message());
    const second = await orchestrateMessage(deps, message());

    expect(first.kind).toBe('proposal');
    expect(second).toMatchObject({ kind: 'ignored', reason: 'duplicate' });
  });

  it('identical text under a new activity id is still a duplicate', async () => {
    const { deps } = harness({ script: [...okScript(), ...okScript()] });

    await orchestrateMessage(deps, message({ messageId: 'msg-1' }));
    const retry = await orchestrateMessage(deps, message({ messageId: 'msg-2' }));
    expect(retry).toMatchObject({ kind: 'ignored', reason: 'duplicate' });
  });

  it('an edit with materially new content is processed once', async () => {
    const { deps } = harness({
      issues: [TES_31, TES_50],
      script: [
        ...okScript(),
        interpretation([
          { key: 'TES-31', intent: 'completed', confidence: 0.95, evidence: 'Finished TES-31' },
          { key: 'TES-50', intent: 'in_progress', confidence: 0.9, evidence: 'starting TES-50' },
        ]),
        validation([cleanVerdict('TES-31'), cleanVerdict('TES-50')]),
        NO_BLOCKERS,
      ],
    });

    await orchestrateMessage(deps, message());
    const edited = await orchestrateMessage(
      deps,
      message({ text: 'Finished TES-31. Starting TES-50.' }),
    );
    expect(edited.kind).toBe('proposal');
  });

  it('no Jira read happens for a duplicate', async () => {
    const { deps, jira } = harness({ script: [...okScript(), ...okScript()] });

    await orchestrateMessage(deps, message());
    const readsAfterFirst = jira.requests.length;
    await orchestrateMessage(deps, message());

    expect(jira.requests).toHaveLength(readsAfterFirst);
  });
});

describe('validation gates the proposal', () => {
  it('strips the action when the validator rejects the change', async () => {
    const { deps, jira } = harness({
      script: [
        interpretation([
          {
            key: 'TES-31',
            intent: 'completed',
            confidence: 0.95,
            evidence: 'finished coding TES-31',
          },
        ]),
        validation(
          [
            cleanVerdict('TES-31', {
              valid: false,
              risk: 'high',
              warnings: ['Workflow has a Code Review stage before Done.'],
              explanation: 'Pasan said the implementation is finished, not that it was reviewed.',
            }),
          ],
          { valid: false, risk: 'high' },
        ),
        NO_BLOCKERS,
      ],
    });

    const outcome = await orchestrateMessage(deps, message({ text: 'Finished coding TES-31.' }));

    // Silent because nothing survived, and the message was ambient.
    expect(outcome.kind).toBe('silent');
    if (outcome.kind !== 'silent') return;

    const proposal = outcome.batch.proposals[0];
    expect(proposal?.actions).toHaveLength(1);

    // The executable action is stripped and replaced with an explained no-op,
    // so there is nothing left for an approver to apply.
    const action = proposal?.actions[0];
    expect(action?.type).toBe('none');
    if (action?.type === 'none') expect(action.reason).toContain('not justified');

    expect(proposal?.selected).toBe(false);
    expect(proposal?.explanation).toContain('Code Review');
    expect(jira.mutations).toEqual([]);
  });

  it('unticks rather than strips when the validator only warns', async () => {
    const { deps } = harness({
      script: [
        interpretation([
          { key: 'TES-31', intent: 'completed', confidence: 0.95, evidence: 'Finished TES-31' },
        ]),
        validation([
          cleanVerdict('TES-31', { warnings: ['Double-check this is the right ticket.'] }),
        ]),
        NO_BLOCKERS,
      ],
    });

    const outcome = await orchestrateMessage(deps, message());
    if (outcome.kind !== 'proposal') throw new Error(`expected proposal, got ${outcome.kind}`);

    const proposal = outcome.batch.proposals[0];
    expect(proposal?.selected).toBe(false);
    expect(proposal?.actions[0]?.type).toBe('transition');
    expect(proposal?.review?.warnings).toContain('Double-check this is the right ticket.');
  });

  it('does not pre-select when validation is unavailable', async () => {
    const { deps } = harness({
      script: [
        interpretation([
          { key: 'TES-31', intent: 'completed', confidence: 0.99, evidence: 'Finished TES-31' },
        ]),
        { kind: 'timeout' }, // validator
        NO_BLOCKERS,
      ],
    });

    const outcome = await orchestrateMessage(deps, message());
    if (outcome.kind !== 'proposal') throw new Error(`expected proposal, got ${outcome.kind}`);

    // Fail closed: a validator outage cannot promote a change to pre-approved.
    expect(outcome.batch.proposals[0]?.selected).toBe(false);
    expect(outcome.batch.proposals[0]?.explanation).toContain('Validation could not run');
  });

  it('suppresses a transition Jira cannot perform, whatever the model says', async () => {
    // TES-42 can only reach Done; the interpreter claims it should be started.
    const { deps, jira } = harness({
      issues: [{ ...TES_42, status: 'Done', transitions: [] }],
      script: [
        interpretation([
          { key: 'TES-42', intent: 'in_progress', confidence: 0.99, evidence: 'back on TES-42' },
        ]),
        validation([cleanVerdict('TES-42')]),
        NO_BLOCKERS,
      ],
    });

    // "started" makes this a fast-path candidate, so the classifier is skipped
    // and the script below begins at the interpreter.
    const outcome = await orchestrateMessage(
      deps,
      message({ text: 'Started back on TES-42 today.', messageId: 'msg-42' }),
    );

    const batch = outcome.kind === 'silent' ? outcome.batch : undefined;
    expect(batch?.proposals[0]?.actions.every((a) => a.type === 'none')).toBe(true);
    expect(jira.mutations).toEqual([]);
  });

  it('produces no proposal at all when interpretation fails', async () => {
    const { deps, jira } = harness({ script: [{ kind: 'timeout' }] });

    const outcome = await orchestrateMessage(deps, message({ text: 'Finished TES-31.' }));

    expect(outcome.kind).toBe('failed');
    expect(jira.mutations).toEqual([]);
    // No batch was stored, so nothing is approvable.
    expect(store.recentActivity('conv-1', '2000-01-01T00:00:00.000Z')).toEqual([]);
  });

  it('never acts on a ticket missing from Jira', async () => {
    const { deps, jira } = harness({
      issues: [],
      script: [
        interpretation([
          { key: 'TES-31', intent: 'completed', confidence: 0.95, evidence: 'Finished TES-31' },
        ]),
        validation([cleanVerdict('TES-31')]),
        NO_BLOCKERS,
      ],
    });

    const outcome = await orchestrateMessage(deps, message());
    const batch = outcome.kind === 'silent' ? outcome.batch : undefined;

    expect(batch?.proposals[0]?.actions.every((a) => a.type === 'none')).toBe(true);
    expect(jira.mutations).toEqual([]);
  });
});

describe('directed vs ambient silence', () => {
  const nothingToDoScript = (): MockBehavior[] => [
    interpretation([
      { key: 'TES-31', intent: 'no_change', confidence: 0.9, evidence: 'mentioned TES-31' },
    ]),
    validation([cleanVerdict('TES-31')]),
    NO_BLOCKERS,
  ];

  it('stays silent on an ambient message with nothing to do', async () => {
    const { deps } = harness({ script: nothingToDoScript() });
    const outcome = await orchestrateMessage(
      deps,
      message({ text: 'No progress on TES-31 today.', messageId: 'a' }),
    );
    expect(outcome.kind).toBe('silent');
  });

  it('answers a directed message even with nothing to do', async () => {
    const { deps } = harness({ script: nothingToDoScript() });
    const outcome = await orchestrateMessage(
      deps,
      message({ text: 'No progress on TES-31 today.', messageId: 'b', source: 'mention' }),
    );
    // Somebody asked; leaving a question unanswered is its own failure.
    expect(outcome.kind).toBe('proposal');
  });

  it('stores the silent batch for audit anyway', async () => {
    const { deps } = harness({ script: nothingToDoScript() });
    const outcome = await orchestrateMessage(
      deps,
      message({ text: 'No progress on TES-31 today.', messageId: 'c' }),
    );
    if (outcome.kind !== 'silent') throw new Error('expected silent');
    expect(store.getBatch(outcome.batch.id)).toBeDefined();
  });
});

describe('blocker intelligence', () => {
  it('records a blocker alongside the Jira proposal', async () => {
    const { deps } = harness({
      script: [
        interpretation([
          {
            key: 'TES-42',
            intent: 'blocked',
            confidence: 0.93,
            evidence: 'blocked waiting for API credentials',
            blockerReason: 'waiting for API credentials',
          },
        ]),
        validation([cleanVerdict('TES-42')]),
        data({
          blockers: [
            {
              key: 'TES-42',
              blocked: true,
              category: 'access_or_credentials',
              description: 'waiting for API credentials',
              dependency: 'platform team',
              severity: 'high',
              needsAttention: true,
            },
          ],
        }),
      ],
    });

    const outcome = await orchestrateMessage(
      deps,
      message({ text: 'TES-42 is blocked waiting for API credentials.', messageId: 'msg-blk' }),
    );

    if (outcome.kind !== 'proposal') throw new Error(`expected proposal, got ${outcome.kind}`);
    expect(outcome.blockers[0]?.key).toBe('TES-42');
    expect(outcome.blockers[0]?.shouldSurface).toBe(true);

    const persisted = store.getOpenBlockers('conv-1');
    expect(persisted[0]?.description).toBe('waiting for API credentials');
  });

  it('a blocker-detection failure still leaves the Jira proposal intact', async () => {
    const { deps } = harness({
      script: [
        interpretation([
          { key: 'TES-31', intent: 'completed', confidence: 0.95, evidence: 'Finished TES-31' },
        ]),
        validation([cleanVerdict('TES-31')]),
        { kind: 'timeout' }, // blocker agent
      ],
    });

    const outcome = await orchestrateMessage(deps, message());
    expect(outcome.kind).toBe('proposal');
    if (outcome.kind === 'proposal') {
      expect(outcome.batch.proposals[0]?.actions[0]?.type).toBe('transition');
    }
  });
});

describe('thread context', () => {
  it('passes earlier thread messages to the interpreter, bounded', async () => {
    const { deps, llm } = harness({
      config: { CONTEXT_MESSAGE_LIMIT: '3' },
      script: [
        interpretation([
          { key: 'TES-31', intent: 'completed', confidence: 0.9, evidence: 'Code is done' },
        ]),
        validation([cleanVerdict('TES-31')]),
        NO_BLOCKERS,
      ],
    });

    // Seed a thread the way the orchestrator would have.
    for (const [id, author, text] of [
      ['t1', 'Pasan', 'TES-31 is nearly done'],
      ['t2', 'Chandima', 'Code finished or fully complete?'],
    ] as const) {
      store.recordMessageEvent({
        id,
        conversationId: 'conv-1',
        threadId: 'thread-a',
        authorId: author,
        authorName: author,
        text,
      });
      store.markMessageEvent(id, { state: 'processed', relevant: true });
    }

    await orchestrateMessage(
      deps,
      message({
        text: 'Code is done on TES-31, just needs review',
        messageId: 'msg-reply',
        threadId: 'thread-a',
      }),
    );

    const prompt = llm.calls[0]?.userMessage ?? '';
    expect(prompt).toContain('Chandima: Code finished or fully complete?');
    expect(prompt).toContain('Pasan: TES-31 is nearly done');
  });

  it('sends no context when the limit is zero', async () => {
    const { deps, llm } = harness({
      config: { CONTEXT_MESSAGE_LIMIT: '0' },
      script: [
        interpretation([
          { key: 'TES-31', intent: 'completed', confidence: 0.9, evidence: 'Finished' },
        ]),
        validation([cleanVerdict('TES-31')]),
        NO_BLOCKERS,
      ],
    });

    store.recordMessageEvent({
      id: 't1',
      conversationId: 'conv-1',
      authorId: 'u',
      authorName: 'Someone',
      text: 'earlier chatter',
    });
    store.markMessageEvent('t1', { state: 'processed', relevant: true });

    await orchestrateMessage(deps, message({ messageId: 'msg-nc' }));
    expect(llm.calls[0]?.userMessage).not.toContain('earlier chatter');
  });
});

describe('E2E: multi-ticket ambient standup through to Jira', () => {
  /** The canonical demo: three tickets, three intents, one message, no mention. */
  const script = (): MockBehavior[] => [
    interpretation([
      { key: 'TES-31', intent: 'completed', confidence: 0.95, evidence: 'Finished TES-31' },
      {
        key: 'TES-42',
        intent: 'blocked',
        confidence: 0.93,
        evidence: 'TES-42 is blocked waiting for API access',
        blockerReason: 'waiting for API access',
      },
      { key: 'TES-50', intent: 'in_progress', confidence: 0.9, evidence: 'Starting TES-50' },
    ]),
    validation([cleanVerdict('TES-31'), cleanVerdict('TES-42'), cleanVerdict('TES-50')]),
    data({
      blockers: [
        {
          key: 'TES-42',
          blocked: true,
          category: 'access_or_credentials',
          description: 'waiting for API access',
          dependency: null,
          severity: 'high',
          needsAttention: true,
        },
      ],
    }),
  ];

  const TEXT = 'Finished TES-31. TES-42 is blocked waiting for API access. Starting TES-50.';

  it('interprets three work items, proposes, and writes nothing before approval', async () => {
    const { deps, jira } = harness({ script: script() });

    const outcome = await orchestrateMessage(deps, message({ text: TEXT, messageId: 'msg-e2e' }));

    if (outcome.kind !== 'proposal') throw new Error(`expected proposal, got ${outcome.kind}`);
    const { batch } = outcome;

    expect(batch.proposals.map((p) => p.key)).toEqual(['TES-31', 'TES-42', 'TES-50']);

    // TES-31: In Progress -> Done.
    expect(batch.proposals[0]?.actions).toEqual([
      { type: 'transition', fromStatus: 'In Progress', toStatus: 'Done', transitionId: '31' },
    ]);
    // TES-42: blocked while already In Progress -> comment only, no transition.
    expect(batch.proposals[1]?.actions.map((a) => a.type)).toEqual(['comment']);
    // TES-50: To Do -> In Progress.
    expect(batch.proposals[2]?.actions).toEqual([
      { type: 'transition', fromStatus: 'To Do', toStatus: 'In Progress', transitionId: '11' },
    ]);

    // The critical assertion of the whole architecture.
    expect(jira.mutations).toEqual([]);
    expect(batch.status).toBe('pending');
    expect(outcome.blockers.map((b) => b.key)).toEqual(['TES-42']);
  });

  it('applies exactly the approved changes, and only after approval', async () => {
    const { deps, jira, actions } = harness({ script: script() });

    const outcome = await orchestrateMessage(deps, message({ text: TEXT, messageId: 'msg-e2e-2' }));
    if (outcome.kind !== 'proposal') throw new Error('expected proposal');

    expect(jira.mutations).toEqual([]);

    // The human clicks Approve.
    const execution = await executeBatch({ store, actions, log: logger }, outcome.batch.id, {
      approvedBy: 'user-pasan',
    });

    expect(execution.status).toBe('executed');
    expect(execution.results.map((r) => `${r.key}:${r.ok}`)).toEqual([
      'TES-31:true',
      'TES-42:true',
      'TES-50:true',
    ]);

    // Now, and only now, Jira was written.
    expect(jira.mutations).toEqual([
      'POST /rest/api/3/issue/TES-31/transitions',
      'POST /rest/api/3/issue/TES-42/comment',
      'POST /rest/api/3/issue/TES-50/transitions',
    ]);
  });

  it('is idempotent: a second approval re-reports without touching Jira', async () => {
    const { deps, jira, actions } = harness({ script: script() });

    const outcome = await orchestrateMessage(deps, message({ text: TEXT, messageId: 'msg-e2e-3' }));
    if (outcome.kind !== 'proposal') throw new Error('expected proposal');

    await executeBatch({ store, actions, log: logger }, outcome.batch.id, {
      approvedBy: 'user-pasan',
    });
    const afterFirst = [...jira.mutations];

    const second = await executeBatch({ store, actions, log: logger }, outcome.batch.id, {
      approvedBy: 'user-chandima',
    });

    expect(second.status).toBe('executed');
    expect(jira.mutations).toEqual(afterFirst);
  });

  it('a rejected batch never reaches Jira', async () => {
    const { deps, jira, actions } = harness({ script: script() });

    const outcome = await orchestrateMessage(deps, message({ text: TEXT, messageId: 'msg-e2e-4' }));
    if (outcome.kind !== 'proposal') throw new Error('expected proposal');

    expect(store.reject(outcome.batch.id, 'user-pasan')).toBe(true);

    const execution = await executeBatch({ store, actions, log: logger }, outcome.batch.id, {
      approvedBy: 'user-pasan',
    });

    expect(execution.status).toBe('rejected');
    expect(jira.mutations).toEqual([]);
  });

  it('the summary can later report TES-42 as blocked', async () => {
    const { deps, actions } = harness({ script: script() });

    const outcome = await orchestrateMessage(deps, message({ text: TEXT, messageId: 'msg-e2e-5' }));
    if (outcome.kind !== 'proposal') throw new Error('expected proposal');

    await executeBatch({ store, actions, log: logger }, outcome.batch.id, {
      approvedBy: 'user-pasan',
    });

    const blockers = store.getOpenBlockers('conv-1');
    expect(blockers.map((b) => b.issueKey)).toEqual(['TES-42']);
    expect(blockers[0]?.description).toBe('waiting for API access');

    const activity = store.recentActivity('conv-1', '2000-01-01T00:00:00.000Z');
    expect(activity.map((a) => a.issueKey)).toEqual(['TES-31', 'TES-42', 'TES-50']);
    expect(activity.every((a) => a.batchStatus === 'executed')).toBe(true);
  });
});

describe('E2E: ambiguous message → clarification → proposal → Jira', () => {
  const ambiguousScript = (): MockBehavior[] => [
    interpretation([
      {
        key: 'TES-31',
        intent: 'completed',
        confidence: 0.6,
        evidence: 'TES-31 is basically finished',
        uncertain: true,
      },
    ]),
    validation([cleanVerdict('TES-31', { risk: 'medium' })]),
    // Ambiguity stage.
    data({
      tickets: [
        {
          key: 'TES-31',
          ambiguous: true,
          question:
            'You said TES-31 is "basically finished" — is it ready for review, or fully done?',
          options: [
            { label: 'Move to Code Review', intent: 'in_progress' },
            { label: 'Move to Done', intent: 'completed' },
            { label: 'Keep In Progress', intent: 'no_change' },
          ],
          reason: 'Hedged completion language.',
        },
      ],
    }),
    NO_BLOCKERS,
  ];

  it('asks instead of guessing, and creates no batch', async () => {
    const { deps, jira } = harness({ script: ambiguousScript() });

    const outcome = await orchestrateMessage(
      deps,
      message({ text: 'TES-31 is basically finished.', messageId: 'msg-amb' }),
    );

    expect(outcome.kind).toBe('clarification');
    if (outcome.kind !== 'clarification') return;

    const clarification = outcome.clarifications[0];
    expect(clarification?.issueKey).toBe('TES-31');
    expect(clarification?.question).toContain('basically finished');
    expect(clarification?.options.map((o) => o.label)).toEqual([
      'Move to Code Review',
      'Move to Done',
      'Keep In Progress',
    ]);

    // No proposal batch exists, so there is nothing to approve yet.
    expect(jira.mutations).toEqual([]);
    expect(store.recentActivity('conv-1', '2000-01-01T00:00:00.000Z')).toEqual([]);
  });

  it('an answer produces a pending proposal, not a Jira write', async () => {
    const { deps, jira } = harness({
      script: [
        ...ambiguousScript(),
        // Validation re-runs for the clarified intent.
        validation([cleanVerdict('TES-31')]),
      ],
    });

    const asked = await orchestrateMessage(
      deps,
      message({ text: 'TES-31 is basically finished.', messageId: 'msg-amb-2' }),
    );
    if (asked.kind !== 'clarification') throw new Error('expected clarification');
    const clarification = asked.clarifications[0];
    if (!clarification) throw new Error('expected a clarification record');

    const answered = await resolveClarification(deps, {
      clarificationId: clarification.id,
      // "Move to Code Review"
      optionId: 'opt0',
      answeredBy: 'user-pasan',
      answeredByName: 'Pasan',
    });

    expect(answered.kind).toBe('resolved');
    if (answered.kind !== 'resolved') return;

    expect(answered.batch.status).toBe('pending');
    expect(answered.batch.origin?.source).toBe('clarification');
    expect(answered.batch.origin?.clarificationId).toBe(clarification.id);
    expect(answered.batch.proposals[0]?.explanation).toContain('clarified by Pasan');

    // Answering a question is not authorising a write.
    expect(jira.mutations).toEqual([]);
  });

  it('only the approval after the clarification writes to Jira', async () => {
    const { deps, jira, actions } = harness({
      script: [...ambiguousScript(), validation([cleanVerdict('TES-31')])],
    });

    const asked = await orchestrateMessage(
      deps,
      message({ text: 'TES-31 is basically finished.', messageId: 'msg-amb-3' }),
    );
    if (asked.kind !== 'clarification') throw new Error('expected clarification');
    const clarificationId = asked.clarifications[0]?.id ?? '';

    const answered = await resolveClarification(deps, {
      clarificationId,
      optionId: 'opt0',
      answeredBy: 'user-pasan',
      answeredByName: 'Pasan',
    });
    if (answered.kind !== 'resolved') throw new Error('expected resolved');

    expect(jira.mutations).toEqual([]);

    await executeBatch({ store, actions, log: logger }, answered.batch.id, {
      approvedBy: 'user-pasan',
    });

    expect(jira.mutations).toEqual(['POST /rest/api/3/issue/TES-31/transitions']);
    // Code Review, because that is what the developer chose.
    const transitionRequest = jira.requests.find((r) => r.method === 'POST');
    expect(transitionRequest?.body).toEqual({ transition: { id: '21' } });
  });

  it('records the full clarification trail for audit', async () => {
    const { deps } = harness({
      script: [...ambiguousScript(), validation([cleanVerdict('TES-31')])],
    });

    const asked = await orchestrateMessage(
      deps,
      message({ text: 'TES-31 is basically finished.', messageId: 'msg-amb-4' }),
    );
    if (asked.kind !== 'clarification') throw new Error('expected clarification');
    const clarificationId = asked.clarifications[0]?.id ?? '';

    const answered = await resolveClarification(deps, {
      clarificationId,
      optionId: 'opt1',
      answeredBy: 'user-pasan',
      answeredByName: 'Pasan',
    });
    if (answered.kind !== 'resolved') throw new Error('expected resolved');

    const record = store.getClarification(clarificationId);
    expect(record?.originalMessage).toBe('TES-31 is basically finished.');
    expect(record?.question).toContain('basically finished');
    expect(record?.answer).toBe('opt1');
    expect(record?.answeredBy).toBe('user-pasan');
    expect(record?.status).toBe('answered');
    expect(record?.resolvedBatchId).toBe(answered.batch.id);
  });

  it('a double-clicked clarification answers once', async () => {
    const { deps } = harness({
      script: [...ambiguousScript(), validation([cleanVerdict('TES-31')])],
    });

    const asked = await orchestrateMessage(
      deps,
      message({ text: 'TES-31 is basically finished.', messageId: 'msg-amb-5' }),
    );
    if (asked.kind !== 'clarification') throw new Error('expected clarification');
    const clarificationId = asked.clarifications[0]?.id ?? '';

    const first = await resolveClarification(deps, {
      clarificationId,
      optionId: 'opt0',
      answeredBy: 'user-pasan',
      answeredByName: 'Pasan',
    });
    const second = await resolveClarification(deps, {
      clarificationId,
      optionId: 'opt1',
      answeredBy: 'user-chandima',
      answeredByName: 'Chandima',
    });

    expect(first.kind).toBe('resolved');
    expect(second.kind).toBe('already_answered');
  });

  it('rejects an unknown option rather than guessing one', async () => {
    const { deps } = harness({ script: ambiguousScript() });

    const asked = await orchestrateMessage(
      deps,
      message({ text: 'TES-31 is basically finished.', messageId: 'msg-amb-6' }),
    );
    if (asked.kind !== 'clarification') throw new Error('expected clarification');

    const outcome = await resolveClarification(deps, {
      clarificationId: asked.clarifications[0]?.id ?? '',
      optionId: 'optDoesNotExist',
      answeredBy: 'user-pasan',
      answeredByName: 'Pasan',
    });

    expect(outcome.kind).toBe('invalid_option');
  });

  it('reports a missing clarification rather than failing open', async () => {
    const { deps } = harness({ script: [] });
    const outcome = await resolveClarification(deps, {
      clarificationId: 'nope',
      optionId: 'opt0',
      answeredBy: 'u',
      answeredByName: 'U',
    });
    expect(outcome.kind).toBe('not_found');
  });

  it('never offers a status the workflow cannot reach', async () => {
    // TES-31 can only reach Code Review, so the "Move to Done" option the model
    // suggested must not survive: a developer can never click a button that
    // resolves to nothing.
    const { deps } = harness({
      issues: [{ ...TES_31, transitions: [{ id: '21', name: 'Code Review', to: 'Code Review' }] }],
      script: ambiguousScript(),
    });

    const asked = await orchestrateMessage(
      deps,
      message({ text: 'TES-31 is basically finished.', messageId: 'msg-amb-7' }),
    );
    if (asked.kind !== 'clarification') throw new Error('expected clarification');

    const labels = asked.clarifications[0]?.options.map((o) => o.label) ?? [];
    expect(labels).toContain('Move to Code Review');
    expect(labels).not.toContain('Move to Done');
  });

  it('re-reads Jira, so an answer cannot act on a stale snapshot', async () => {
    const { deps, jira } = harness({
      script: [...ambiguousScript(), validation([cleanVerdict('TES-31')])],
    });

    const asked = await orchestrateMessage(
      deps,
      message({ text: 'TES-31 is basically finished.', messageId: 'msg-amb-8' }),
    );
    if (asked.kind !== 'clarification') throw new Error('expected clarification');
    // Done was reachable when the question was asked.
    expect(asked.clarifications[0]?.options.map((o) => o.label)).toContain('Move to Done');

    // Somebody moves the ticket on before the developer answers.
    jira.setIssue({ ...TES_31, status: 'Code Review', transitions: [] });

    const answered = await resolveClarification(deps, {
      clarificationId: asked.clarifications[0]?.id ?? '',
      optionId: 'opt1', // Move to Done
      answeredBy: 'user-pasan',
      answeredByName: 'Pasan',
    });

    if (answered.kind !== 'resolved') throw new Error('expected resolved');
    // A human disambiguating what they meant does not make Jira able to do it.
    expect(answered.batch.proposals[0]?.actions.every((a) => a.type === 'none')).toBe(true);
    expect(answered.batch.proposals[0]?.selected).toBe(false);
    expect(jira.mutations).toEqual([]);
  });

  it('honours an explicitly chosen status that no intent could express', async () => {
    const { deps, jira, actions } = harness({
      script: [...ambiguousScript(), validation([cleanVerdict('TES-31')])],
    });

    const asked = await orchestrateMessage(
      deps,
      message({ text: 'TES-31 is basically finished.', messageId: 'msg-amb-9' }),
    );
    if (asked.kind !== 'clarification') throw new Error('expected clarification');

    const codeReview = asked.clarifications[0]?.options.find(
      (o) => o.label === 'Move to Code Review',
    );
    // The six-intent vocabulary has no term for Code Review, so the option
    // carries the destination explicitly.
    expect(codeReview?.targetStatus).toBe('Code Review');

    const answered = await resolveClarification(deps, {
      clarificationId: asked.clarifications[0]?.id ?? '',
      optionId: codeReview?.id ?? '',
      answeredBy: 'user-pasan',
      answeredByName: 'Pasan',
    });
    if (answered.kind !== 'resolved') throw new Error('expected resolved');

    expect(answered.batch.proposals[0]?.actions).toEqual([
      {
        type: 'transition',
        fromStatus: 'In Progress',
        toStatus: 'Code Review',
        transitionId: '21',
      },
    ]);

    await executeBatch({ store, actions, log: logger }, answered.batch.id, {
      approvedBy: 'user-pasan',
      proposalIds: answered.batch.proposals.map((p) => p.id),
    });

    // Code Review's transition id, not Done's.
    expect(jira.requests.find((r) => r.method === 'POST')?.body).toEqual({
      transition: { id: '21' },
    });
  });
});
