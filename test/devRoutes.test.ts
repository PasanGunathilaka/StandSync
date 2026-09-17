import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { ApprovalStore } from '../src/approval/store.js';
import { JiraClient } from '../src/jira/client.js';
import { JiraIssues } from '../src/jira/issues.js';
import { JiraActions } from '../src/jira/actions.js';
import { JiraContextService } from '../src/jira/context.js';
import { MockLLMClient, type MockBehavior } from '../src/llm/mock.js';
import { registerDevRoutes, type StandSyncFastify } from '../src/dev/routes.js';
import { generateSummary } from '../src/summary/service.js';
import { loadConfig } from '../src/config.js';
import { logger } from '../src/logger.js';

/**
 * The dev endpoints and the summary service.
 *
 * These exist so the whole V2 architecture is demonstrable without a Teams
 * tenant. The property worth testing is that they are not a demo: /dev/message
 * drives the same orchestrateMessage that Teams drives, so a passing demo
 * cannot hide a broken product.
 *
 * Response bodies are read with `.json<Shape>()` rather than `.json() as Shape`
 * — light-my-request types it generically, so the call form keeps the shape
 * explicit without a redundant assertion.
 */

/** Fields the dev endpoints return, named once. */
interface OutcomeBody {
  kind: string;
  reason?: string;
  message?: string;
  traceId?: string;
  approveWith?: string;
  note?: string;
  batch: { id: string; proposals: { id: string; key: string; review?: unknown }[] };
  summary: {
    rows: { key: string; action: string; selected: boolean; explanation: string }[];
  };
  clarifications: { id: string; question: string; answerWith: string }[];
}

// A minimal Jira, recording every request so writes can be asserted against.
class JiraStub {
  readonly requests: { method: string; url: string }[] = [];
  private readonly statuses = new Map<string, string>([
    ['TES-31', 'In Progress'],
    ['TES-42', 'In Progress'],
  ]);

  get mutations(): string[] {
    return this.requests
      .filter((r) => /\/transitions$|\/comment$/.test(r.url) && r.method === 'POST')
      .map((r) => r.url.replace(/^.*\/rest/, '/rest'));
  }

  readonly fetch: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    this.requests.push({ method, url });

    const key = /\/issue\/([^/?]+)/.exec(url)?.[1] ?? '';
    const status = this.statuses.get(decodeURIComponent(key));
    if (!status) return Promise.resolve(res({}, 404));

    if (url.includes('/transitions') && method === 'GET') {
      return Promise.resolve(
        res({ transitions: [{ id: '31', name: 'Done', to: { name: 'Done' } }] }),
      );
    }
    if (url.includes('/transitions')) return Promise.resolve(new Response(null, { status: 204 }));
    if (url.includes('/comment')) return Promise.resolve(res({ id: '1' }, 201));

    return Promise.resolve(
      res({
        key: decodeURIComponent(key),
        fields: {
          summary: `Summary for ${decodeURIComponent(key)}`,
          status: { name: status },
          issuetype: { name: 'Task' },
          assignee: { displayName: 'Pasan' },
          reporter: null,
          resolution: null,
        },
      }),
    );
  };
}

const res = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const data = (value: unknown): MockBehavior => ({ kind: 'data', data: value });

let store: ApprovalStore;

beforeEach(() => {
  store = ApprovalStore.open(':memory:');
});

afterEach(() => {
  store.close();
});

const devConfig = () =>
  loadConfig({
    JIRA_BASE_URL: 'https://example.atlassian.net',
    JIRA_EMAIL: 'bot@example.com',
    JIRA_API_TOKEN: 'token',
  });

interface Harness {
  app: StandSyncFastify;
  jira: JiraStub;
  llm: MockLLMClient;
}

function harness(script: MockBehavior[]): Harness {
  const jira = new JiraStub();
  const client = new JiraClient({
    baseUrl: 'https://example.atlassian.net',
    email: 'bot@example.com',
    apiToken: 'token',
    fetchImpl: jira.fetch,
    maxRetries: 0,
  });
  const issues = new JiraIssues(client);
  const llm = new MockLLMClient({ script });

  const app = Fastify() as unknown as StandSyncFastify;
  registerDevRoutes(app, {
    config: devConfig(),
    store,
    issues,
    actions: new JiraActions(client),
    jiraContext: new JiraContextService({ client, issues, log: logger }),
    llm,
    log: logger,
  });

  return { app, jira, llm };
}

/** The stub assigns every issue to Pasan, so Pasan is the unremarkable author. */
const OK_SCRIPT = (): MockBehavior[] => [
  data({
    tickets: [
      { key: 'TES-31', intent: 'completed', confidence: 0.95, evidence: 'Finished TES-31' },
    ],
    unresolvedMentions: [],
  }),
  data({
    valid: true,
    risk: 'low',
    changes: [{ key: 'TES-31', valid: true, risk: 'low', warnings: [], explanation: '' }],
    explanation: '',
  }),
  data({ blockers: [] }),
];

const finishedTes31 = (over: Record<string, unknown> = {}) => ({
  text: 'Finished TES-31.',
  source: 'dev',
  author: 'Pasan',
  ...over,
});

describe('POST /dev/message — the V2 orchestrator without Teams', () => {
  it('produces a proposal and writes nothing to Jira', async () => {
    const { app, jira } = harness(OK_SCRIPT());

    const response = await app.inject({
      method: 'POST',
      url: '/dev/message',
      payload: finishedTes31(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<OutcomeBody>();

    expect(body.kind).toBe('proposal');
    expect(body.summary.rows[0]?.key).toBe('TES-31');
    expect(body.summary.rows[0]?.action).toBe('In Progress → Done');
    expect(body.approveWith).toContain('/dev/approve/');
    expect(jira.mutations).toEqual([]);
  });

  it('reports the classifier decision for an ambient message', async () => {
    const { app } = harness([
      data({ relevant: false, type: 'unrelated', confidence: 0.98, reason: 'Social chatter.' }),
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/dev/message',
      payload: { text: 'Anyone going for lunch?', source: 'ambient' },
    });

    const body = response.json<OutcomeBody>();
    expect(body.kind).toBe('ignored');
    expect(body.reason).toBe('classified_irrelevant');
    expect(body.message).toContain('stayed silent');
  });

  it('exposes the agent trace so the pipeline is inspectable', async () => {
    const { app } = harness(OK_SCRIPT());

    const created = await app.inject({
      method: 'POST',
      url: '/dev/message',
      payload: finishedTes31(),
    });
    const { traceId } = created.json<OutcomeBody>();

    const trace = await app.inject({ method: 'GET', url: `/dev/agents/${traceId ?? ''}` });
    expect(trace.statusCode).toBe(200);

    const body = trace.json<{ runs: { agentName: string }[]; stages: string[] }>();
    expect(body.runs.map((r) => r.agentName)).toContain('interpret-work');
    expect(body.runs.map((r) => r.agentName)).toContain('validate-proposal');
    expect(body.stages.every((s) => s.includes('ms'))).toBe(true);
  });

  it('404s an unknown trace', async () => {
    const { app } = harness([]);
    const response = await app.inject({ method: 'GET', url: '/dev/agents/nope' });
    expect(response.statusCode).toBe(404);
  });

  it('deduplicates a replayed message id', async () => {
    const { app } = harness([...OK_SCRIPT(), ...OK_SCRIPT()]);
    const payload = finishedTes31({ messageId: 'fixed-id' });

    const first = await app.inject({ method: 'POST', url: '/dev/message', payload });
    const second = await app.inject({ method: 'POST', url: '/dev/message', payload });

    expect(first.json<OutcomeBody>().kind).toBe('proposal');
    expect(second.json<OutcomeBody>().kind).toBe('ignored');
    expect(second.json<OutcomeBody>().reason).toBe('duplicate');
  });

  it('does not pre-select a change on someone else’s ticket', async () => {
    const { app, jira } = harness(OK_SCRIPT());

    // The stub assigns TES-31 to Pasan; this update comes from someone else.
    const created = await app.inject({
      method: 'POST',
      url: '/dev/message',
      payload: finishedTes31({ author: 'Chandima' }),
    });

    const body = created.json<OutcomeBody>();

    expect(body.summary.rows[0]?.selected).toBe(false);
    expect(body.summary.rows[0]?.explanation).toContain(
      'Assigned to someone other than the author of the update',
    );

    // Approve All therefore applies nothing: the human has to opt in via Review.
    const approved = await app.inject({ method: 'POST', url: `/dev/approve/${body.batch.id}` });
    expect(approved.json<{ results: unknown[] }>().results).toEqual([]);
    expect(jira.mutations).toEqual([]);
  });

  it('applies an unselected row when Review explicitly opts in', async () => {
    const { app, jira } = harness(OK_SCRIPT());

    const created = await app.inject({
      method: 'POST',
      url: '/dev/message',
      payload: finishedTes31({ author: 'Chandima' }),
    });
    const { batch } = created.json<OutcomeBody>();

    const approved = await app.inject({
      method: 'POST',
      url: `/dev/approve/${batch.id}`,
      payload: { proposalIds: batch.proposals.map((p) => p.id) },
    });

    expect(approved.json<{ status: string }>().status).toBe('executed');
    expect(jira.mutations).toEqual(['/rest/api/3/issue/TES-31/transitions']);
  });

  it('rejects an empty body', async () => {
    const { app } = harness([]);
    const response = await app.inject({
      method: 'POST',
      url: '/dev/message',
      payload: { text: '' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('applies only after /dev/approve, through the shared executor', async () => {
    const { app, jira } = harness(OK_SCRIPT());

    const created = await app.inject({
      method: 'POST',
      url: '/dev/message',
      payload: finishedTes31(),
    });
    const { batch } = created.json<OutcomeBody>();

    expect(jira.mutations).toEqual([]);

    const approved = await app.inject({
      method: 'POST',
      url: `/dev/approve/${batch.id}`,
      payload: { approvedBy: 'dev-approver' },
    });

    expect(approved.statusCode).toBe(200);
    expect(approved.json<{ status: string }>().status).toBe('executed');
    expect(jira.mutations).toEqual(['/rest/api/3/issue/TES-31/transitions']);
  });

  it('a second approval re-reports without touching Jira', async () => {
    const { app, jira } = harness(OK_SCRIPT());

    const created = await app.inject({
      method: 'POST',
      url: '/dev/message',
      payload: finishedTes31(),
    });
    const { batch } = created.json<OutcomeBody>();

    await app.inject({ method: 'POST', url: `/dev/approve/${batch.id}` });
    const afterFirst = [...jira.mutations];
    await app.inject({ method: 'POST', url: `/dev/approve/${batch.id}` });

    expect(jira.mutations).toEqual(afterFirst);
  });

  it('a rejection never reaches Jira', async () => {
    const { app, jira } = harness(OK_SCRIPT());

    const created = await app.inject({
      method: 'POST',
      url: '/dev/message',
      payload: finishedTes31(),
    });
    const { batch } = created.json<OutcomeBody>();

    const rejected = await app.inject({ method: 'POST', url: `/dev/reject/${batch.id}` });
    expect(rejected.json<{ rejected: boolean }>().rejected).toBe(true);

    await app.inject({ method: 'POST', url: `/dev/approve/${batch.id}` });
    expect(jira.mutations).toEqual([]);
  });
});

describe('the clarification endpoints', () => {
  const AMBIGUOUS_SCRIPT = (): MockBehavior[] => [
    data({
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
    }),
    data({
      valid: true,
      risk: 'medium',
      changes: [{ key: 'TES-31', valid: true, risk: 'medium', warnings: [], explanation: '' }],
      explanation: '',
    }),
    data({
      tickets: [
        {
          key: 'TES-31',
          ambiguous: true,
          question: 'Is TES-31 ready for review, or fully done?',
          options: [
            { label: 'Move to Done', intent: 'completed' },
            { label: 'Keep In Progress', intent: 'no_change' },
          ],
          reason: 'Hedged completion.',
        },
      ],
    }),
    data({ blockers: [] }),
    data({
      valid: true,
      risk: 'low',
      changes: [{ key: 'TES-31', valid: true, risk: 'low', warnings: [], explanation: '' }],
      explanation: '',
    }),
  ];

  const ask = async (app: StandSyncFastify): Promise<OutcomeBody> => {
    const response = await app.inject({
      method: 'POST',
      url: '/dev/message',
      payload: { text: 'TES-31 is basically finished.', source: 'dev', author: 'Pasan' },
    });
    return response.json<OutcomeBody>();
  };

  it('returns a question with a curl command to answer it', async () => {
    const { app, jira } = harness(AMBIGUOUS_SCRIPT());
    const body = await ask(app);

    expect(body.kind).toBe('clarification');
    expect(body.clarifications[0]?.question).toContain('ready for review');
    expect(body.clarifications[0]?.answerWith).toContain('/dev/clarify/');
    expect(body.message).toContain('asked instead of guessing');
    expect(jira.mutations).toEqual([]);
  });

  it('reads a clarification back', async () => {
    const { app } = harness(AMBIGUOUS_SCRIPT());
    const id = (await ask(app)).clarifications[0]?.id ?? '';

    const read = await app.inject({ method: 'GET', url: `/dev/clarification/${id}` });
    expect(read.statusCode).toBe(200);
    expect(
      read.json<{ clarification: { originalMessage: string } }>().clarification.originalMessage,
    ).toBe('TES-31 is basically finished.');
  });

  it('answering produces a pending proposal, not a Jira write', async () => {
    const { app, jira } = harness(AMBIGUOUS_SCRIPT());
    const clarificationId = (await ask(app)).clarifications[0]?.id ?? '';

    const answered = await app.inject({
      method: 'POST',
      url: `/dev/clarify/${clarificationId}`,
      payload: { optionId: 'opt0' },
    });

    expect(answered.statusCode).toBe(200);
    const body = answered.json<OutcomeBody>();
    expect(body.kind).toBe('resolved');
    expect(body.note).toContain('Nothing has been sent to Jira yet');
    expect(body.approveWith).toContain('/dev/approve/');
    expect(jira.mutations).toEqual([]);
  });

  it('409s a second answer to the same question', async () => {
    const { app } = harness(AMBIGUOUS_SCRIPT());
    const id = (await ask(app)).clarifications[0]?.id ?? '';

    await app.inject({ method: 'POST', url: `/dev/clarify/${id}`, payload: { optionId: 'opt0' } });
    const second = await app.inject({
      method: 'POST',
      url: `/dev/clarify/${id}`,
      payload: { optionId: 'opt1' },
    });

    expect(second.statusCode).toBe(409);
  });

  it('400s an unknown option and lists the valid ones', async () => {
    const { app } = harness(AMBIGUOUS_SCRIPT());
    const id = (await ask(app)).clarifications[0]?.id ?? '';

    const bad = await app.inject({
      method: 'POST',
      url: `/dev/clarify/${id}`,
      payload: { optionId: 'nope' },
    });

    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ validOptions: unknown[] }>().validOptions.length).toBeGreaterThan(0);
  });

  it('404s an unknown clarification', async () => {
    const { app } = harness([]);
    const response = await app.inject({
      method: 'POST',
      url: '/dev/clarify/nope',
      payload: { optionId: 'opt0' },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('GET /dev/summary and /dev/blockers', () => {
  interface SummaryBody {
    basis: { issueCount: number; contributors: string[]; openBlockers: number };
    summary: { completed: { key: string }[] };
    text: string;
  }

  it('reports no activity for an empty period without calling a model', async () => {
    const { app, llm } = harness([]);

    const response = await app.inject({
      method: 'GET',
      url: '/dev/summary?conversationId=conv-empty',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<SummaryBody>();
    expect(body.basis.issueCount).toBe(0);
    expect(body.text).toContain('No standup activity');
    expect(llm.calls).toHaveLength(0);
  });

  it('summarizes recorded activity, grounded in real keys', async () => {
    const { app, jira } = harness([
      ...OK_SCRIPT(),
      data({
        completed: [{ key: 'TES-31', text: 'Payment validation' }],
        inProgress: [],
        blocked: [],
        attention: [],
      }),
    ]);

    const created = await app.inject({
      method: 'POST',
      url: '/dev/message',
      payload: finishedTes31({ conversationId: 'conv-sum' }),
    });
    const { batch } = created.json<OutcomeBody>();
    await app.inject({ method: 'POST', url: `/dev/approve/${batch.id}` });

    const summary = await app.inject({
      method: 'GET',
      url: '/dev/summary?conversationId=conv-sum',
    });

    expect(summary.statusCode).toBe(200);
    const body = summary.json<SummaryBody>();

    expect(body.summary.completed.map((c) => c.key)).toEqual(['TES-31']);
    expect(body.basis.contributors).toContain('Pasan');
    expect(body.text).toContain('• TES-31 — Payment validation');

    // A summary is read-only: the only write is the earlier human approval.
    expect(jira.mutations).toEqual(['/rest/api/3/issue/TES-31/transitions']);
  });

  it('lists open blockers', async () => {
    const { app } = harness([
      data({
        tickets: [
          {
            key: 'TES-42',
            intent: 'blocked',
            confidence: 0.9,
            evidence: 'blocked on credentials',
            blockerReason: 'waiting for API credentials',
          },
        ],
        unresolvedMentions: [],
      }),
      data({
        valid: true,
        risk: 'low',
        changes: [{ key: 'TES-42', valid: true, risk: 'low', warnings: [], explanation: '' }],
        explanation: '',
      }),
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
    ]);

    await app.inject({
      method: 'POST',
      url: '/dev/message',
      payload: {
        text: 'TES-42 is blocked waiting for API credentials.',
        source: 'dev',
        author: 'Pasan',
        conversationId: 'conv-blk',
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/dev/blockers?conversationId=conv-blk',
    });

    const body = response.json<{ blockers: { issueKey: string; description: string }[] }>();
    expect(body.blockers[0]?.issueKey).toBe('TES-42');
    expect(body.blockers[0]?.description).toBe('waiting for API credentials');
  });

  it('reports a summary failure without affecting anything else', async () => {
    const { app } = harness([...OK_SCRIPT(), { kind: 'timeout' }]);

    const created = await app.inject({
      method: 'POST',
      url: '/dev/message',
      payload: finishedTes31({ conversationId: 'conv-fail' }),
    });
    // The Jira synchronisation path still worked.
    expect(created.json<OutcomeBody>().kind).toBe('proposal');

    const summary = await app.inject({
      method: 'GET',
      url: '/dev/summary?conversationId=conv-fail',
    });
    expect(summary.statusCode).toBe(503);
  });
});

describe('the V1 endpoint still works unchanged', () => {
  it('POST /dev/standup drives the V1 pipeline', async () => {
    const { app, jira } = harness([
      data({
        tickets: [
          { key: 'TES-31', intent: 'completed', confidence: 0.95, evidence: 'Finished TES-31' },
        ],
        unresolvedMentions: [],
      }),
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/dev/standup',
      payload: { text: 'Yesterday I completed TES-31.' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<OutcomeBody>();

    expect(body.batch.proposals[0]?.key).toBe('TES-31');
    expect(body.summary.rows[0]?.action).toBe('In Progress → Done');
    // No V2 metadata on the V1 path.
    expect(body.batch.proposals[0]?.review).toBeUndefined();
    expect(jira.mutations).toEqual([]);
  });

  it('stays silent on a message with no Jira keys', async () => {
    const { app } = harness([]);
    const response = await app.inject({
      method: 'POST',
      url: '/dev/standup',
      payload: { text: 'Good morning everyone' },
    });

    expect(response.json<{ batch: null }>().batch).toBeNull();
  });
});

describe('generateSummary — read-only by construction', () => {
  it('includes an open blocker even when nobody mentioned it this period', async () => {
    const jira = new JiraStub();
    const client = new JiraClient({
      baseUrl: 'https://example.atlassian.net',
      email: 'bot@example.com',
      apiToken: 'token',
      fetchImpl: jira.fetch,
      maxRetries: 0,
    });
    const issues = new JiraIssues(client);

    // A blocker recorded earlier, with no recent proposal activity.
    store.observeBlocker({
      conversationId: 'conv-quiet',
      issueKey: 'TES-42',
      description: 'waiting for API credentials',
      severity: 'high',
    });

    const llm = new MockLLMClient({
      script: [
        data({
          completed: [],
          inProgress: [],
          blocked: [{ key: 'TES-42', text: 'Waiting for API credentials' }],
          attention: ['TES-42 has been blocked since it was first reported.'],
        }),
      ],
    });

    const outcome = await generateSummary(
      {
        config: devConfig(),
        store,
        context: new JiraContextService({ client, issues, log: logger }),
        llm,
        log: logger,
      },
      { conversationId: 'conv-quiet' },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // A blocker that has gone quiet is exactly what a lead wants to know about.
    expect(outcome.summary.blocked.map((b) => b.key)).toEqual(['TES-42']);
    expect(outcome.basis.openBlockers).toBe(1);
    expect(jira.mutations).toEqual([]);
  });
});
