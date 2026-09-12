import { describe, it, expect, vi } from 'vitest';
import { JiraClient, JiraAuthError, JiraError, JiraNotFoundError } from '../src/jira/client.js';
import { JiraIssues } from '../src/jira/issues.js';

/** fetch accepts three input shapes; only Request carries the URL on a property. */
const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

const ISSUE = {
  key: 'PAY-142',
  fields: {
    summary: 'Add payment retry',
    status: { name: 'In Progress' },
    assignee: { displayName: 'Pasan' },
  },
};

const TRANSITIONS = {
  transitions: [
    { id: '21', name: 'Start', to: { name: 'In Progress' } },
    { id: '31', name: 'Finish', to: { name: 'Done' } },
  ],
};

/** Builds a client whose backoff does not actually sleep. */
function clientWith(fetchImpl: typeof fetch, maxRetries = 3) {
  return new JiraClient({
    baseUrl: 'https://acme.atlassian.net/',
    email: 'me@acme.com',
    apiToken: 'secret-token',
    fetchImpl,
    maxRetries,
    sleepImpl: async () => {},
  });
}

describe('JiraClient', () => {
  it('sends Basic auth and strips a trailing slash from the base URL', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json(ISSUE));
    await clientWith(fetchImpl).request('/rest/api/3/issue/PAY-142');

    const [rawUrl, init] = fetchImpl.mock.calls[0]!;
    const url = urlOf(rawUrl);
    expect(url).toBe('https://acme.atlassian.net/rest/api/3/issue/PAY-142');
    const auth = (init?.headers as Record<string, string>).Authorization;
    expect(auth).toBe(`Basic ${Buffer.from('me@acme.com:secret-token').toString('base64')}`);
  });

  it('treats 204 No Content as success (the transition response shape)', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    await expect(clientWith(fetchImpl).request('/x', { method: 'POST' })).resolves.toBeUndefined();
  });

  it('maps 404 to JiraNotFoundError naming the issue', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({}, 404));
    await expect(
      clientWith(fetchImpl).request('/x', { issueKey: 'PAY-999' }),
    ).rejects.toBeInstanceOf(JiraNotFoundError);
  });

  it('maps 401 to an actionable auth error that never echoes the token', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({}, 401));
    const err = await clientWith(fetchImpl)
      .request('/x')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JiraAuthError);
    expect((err as Error).message).toContain('JIRA_API_TOKEN');
    expect((err as Error).message).not.toContain('secret-token');
  });

  it('surfaces Jira errorMessages on a 400', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ errorMessages: ['Transition is not valid'] }, 400));
    const err = await clientWith(fetchImpl)
      .request('/x')
      .catch((e: unknown) => e);
    expect((err as JiraError).message).toContain('Transition is not valid');
  });

  it('surfaces per-field Jira errors on a 400', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ errors: { transition: 'Invalid id' } }, 400));
    const err = await clientWith(fetchImpl)
      .request('/x')
      .catch((e: unknown) => e);
    expect((err as JiraError).message).toContain('transition: Invalid id');
  });

  it('retries a 429 and succeeds on a later attempt', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, 429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(json({}, 429))
      .mockResolvedValueOnce(json(ISSUE));

    await expect(clientWith(fetchImpl).request('/x')).resolves.toMatchObject({ key: 'PAY-142' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('gives up after maxRetries on repeated 429s', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({}, 429));
    await expect(clientWith(fetchImpl, 3).request('/x')).rejects.toBeInstanceOf(JiraError);
    expect(fetchImpl).toHaveBeenCalledTimes(4); // initial + 3 retries
  });

  it('retries 5xx but never retries a 400', async () => {
    const server = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json(ISSUE));
    await expect(clientWith(server).request('/x')).resolves.toBeDefined();

    const bad = vi.fn<typeof fetch>().mockResolvedValue(json({ errorMessages: ['nope'] }, 400));
    await expect(clientWith(bad).request('/x')).rejects.toBeInstanceOf(JiraError);
    expect(bad).toHaveBeenCalledTimes(1);
  });
});

describe('JiraIssues', () => {
  const routed = (overrides: Record<string, Response> = {}) =>
    vi.fn<typeof fetch>().mockImplementation((input: string | URL | Request) => {
      const url = urlOf(input);
      for (const [fragment, res] of Object.entries(overrides)) {
        if (url.includes(fragment)) return Promise.resolve(res.clone());
      }
      if (url.includes('/transitions')) return Promise.resolve(json(TRANSITIONS));
      return Promise.resolve(json(ISSUE));
    });

  it('builds live issue state including available transitions', async () => {
    const issues = new JiraIssues(clientWith(routed()));
    const state = await issues.getIssueState('PAY-142');

    expect(state).toEqual({
      key: 'PAY-142',
      summary: 'Add payment retry',
      status: 'In Progress',
      assignee: 'Pasan',
      transitions: [
        { id: '21', name: 'Start', toStatus: 'In Progress' },
        { id: '31', name: 'Finish', toStatus: 'Done' },
      ],
    });
  });

  it('requests only the fields it needs', async () => {
    const fetchImpl = routed();
    await new JiraIssues(clientWith(fetchImpl)).getIssue('PAY-142');
    expect(urlOf(fetchImpl.mock.calls[0]![0])).toContain('fields=summary,status,assignee');
  });

  it('tolerates a missing assignee and a null summary', async () => {
    const sparse = json({ key: 'PAY-153', fields: { summary: null, status: { name: 'To Do' } } });
    const issues = new JiraIssues(clientWith(routed({ 'issue/PAY-153?': sparse })));
    const state = await issues.getIssueState('PAY-153');

    expect(state.summary).toBe('');
    expect(state.assignee).toBeUndefined();
    expect(state.status).toBe('To Do');
  });

  it('falls back to the transition name when `to` is absent', async () => {
    const odd = json({ transitions: [{ id: '9', name: 'Done' }] });
    const issues = new JiraIssues(clientWith(routed({ '/transitions': odd })));
    expect((await issues.getIssueState('PAY-142')).transitions[0]).toEqual({
      id: '9',
      name: 'Done',
      toStatus: 'Done',
    });
  });

  it('rejects a malformed Jira payload rather than passing it downstream', async () => {
    const issues = new JiraIssues(clientWith(routed({ 'issue/PAY-1?': json({ nope: true }) })));
    await expect(issues.getIssue('PAY-1')).rejects.toThrow();
  });

  // One bad key must not sink the whole standup.
  it('reports a missing key as not found while other keys still resolve', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((input: string | URL | Request) => {
      const url = urlOf(input);
      if (url.includes('PAY-999')) return Promise.resolve(json({}, 404));
      if (url.includes('/transitions')) return Promise.resolve(json(TRANSITIONS));
      return Promise.resolve(json(ISSUE));
    });

    const lookups = await new JiraIssues(clientWith(fetchImpl)).getIssueStates([
      'PAY-142',
      'PAY-999',
    ]);

    expect(lookups[0]).toMatchObject({ key: 'PAY-142', found: true });
    expect(lookups[1]).toEqual({ key: 'PAY-999', found: false, reason: 'not found' });
  });

  it('reports an auth failure per key instead of throwing', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({}, 403));
    const [lookup] = await new JiraIssues(clientWith(fetchImpl)).getIssueStates(['PAY-142']);
    expect(lookup).toMatchObject({ found: false });
    expect((lookup as { reason: string }).reason).toContain('403');
  });

  it('builds stale-ticket JQL scoped to the configured project', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ issues: [ISSUE] }));
    const results = await new JiraIssues(clientWith(fetchImpl)).searchAssignedNotUpdated('PAY', 5);

    const body = JSON.parse(fetchImpl.mock.calls[0]![1]?.body as string) as { jql: string };
    expect(body.jql).toContain('project = "PAY"');
    expect(body.jql).toContain('updated <= -5d');
    expect(body.jql).toContain('statusCategory != Done');
    expect(results[0]).toMatchObject({ key: 'PAY-142', assignee: 'Pasan' });
  });
});
