import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { IAdaptiveCard } from '@microsoft/teams.cards';
import type { IHttpServerAdapter } from '@microsoft/teams.apps';
import { FastifyHttpServerAdapter, normalizeHeaders } from '../src/teams/fastifyAdapter.js';
import {
  canApprove,
  isAllowedConversation,
  isFromBot,
  type ApprovalPolicy,
} from '../src/teams/channelGuard.js';
import {
  CARD_VERSION,
  buildApplyingCard,
  buildErrorCard,
  buildProposalCard,
  buildRejectedCard,
  buildResultCard,
  buildReviewCard,
  toggleIdFor,
} from '../src/teams/cards.js';
import {
  describeForUser,
  handleCardAction,
  parseCardAction,
  selectedProposalIds,
} from '../src/teams/actions.js';
import { ApprovalStore } from '../src/approval/store.js';
import type { JiraActions } from '../src/jira/actions.js';
import { JiraError } from '../src/jira/client.js';
import type { StandSyncFastify } from '../src/dev/routes.js';
import type { BatchExecution, Proposal, ProposalBatch } from '../src/types.js';

/** Minimal JSON shape of a rendered card, for structural assertions. */
interface CardJson {
  type: string;
  version?: string;
  body?: unknown[];
  actions?: { type: string; title?: string; data?: Record<string, unknown> }[];
}

const asJson = (card: IAdaptiveCard): CardJson => JSON.parse(JSON.stringify(card)) as CardJson;

/** Every element with a `type`, flattened, so we can search a whole card. */
function allElements(
  node: unknown,
  found: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  if (Array.isArray(node)) {
    for (const item of node) allElements(item, found);
    return found;
  }
  if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    if (typeof record['type'] === 'string') found.push(record);
    for (const value of Object.values(record)) allElements(value, found);
  }
  return found;
}

const cardText = (card: IAdaptiveCard): string => JSON.stringify(card);

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  id: 'p-1',
  key: 'TES-41',
  actions: [
    { type: 'transition', fromStatus: 'In Progress', toStatus: 'Done', transitionId: '31' },
  ],
  confidence: 0.97,
  explanation: 'In Progress → Done. Based on: "completed TES-41"',
  selected: true,
  ...over,
});

const batchOf = (proposals: Proposal[], over: Partial<ProposalBatch> = {}): ProposalBatch => ({
  id: 'batch-1',
  conversationId: 'conv-allowed',
  messageId: 'msg-1',
  authorId: 'user-pasan',
  authorName: 'Pasan',
  rawMessage: 'Yesterday I completed TES-41.',
  proposals,
  status: 'pending',
  createdAt: new Date().toISOString(),
  ...over,
});

describe('FastifyHttpServerAdapter', () => {
  it('registers a POST route that bridges the SDK handler onto Fastify', async () => {
    const fastify = Fastify();
    const adapter = new FastifyHttpServerAdapter(fastify as unknown as StandSyncFastify);

    const handler = vi.fn().mockResolvedValue({ status: 200, body: { ok: true } });
    adapter.registerRoute('POST', '/api/messages', handler);

    const res = await fastify.inject({
      method: 'POST',
      url: '/api/messages',
      payload: { type: 'message', text: 'hello' },
      headers: { authorization: 'Bearer token' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const request = handler.mock.calls[0]![0] as {
      body: unknown;
      headers: Record<string, string | string[]>;
    };
    expect(request.body).toEqual({ type: 'message', text: 'hello' });
    expect(request.headers['authorization']).toBe('Bearer token');
  });

  it('passes the SDK status through, including rejections', async () => {
    const fastify = Fastify();
    const adapter = new FastifyHttpServerAdapter(fastify as unknown as StandSyncFastify);
    adapter.registerRoute('POST', '/api/messages', () => Promise.resolve({ status: 401 }));

    const res = await fastify.inject({ method: 'POST', url: '/api/messages', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('completes the response when the SDK returns no body', async () => {
    const fastify = Fastify();
    const adapter = new FastifyHttpServerAdapter(fastify as unknown as StandSyncFastify);
    adapter.registerRoute('POST', '/api/messages', () => Promise.resolve({ status: 200 }));

    // Without an explicit empty send, Fastify would hang waiting for a payload.
    const res = await fastify.inject({ method: 'POST', url: '/api/messages', payload: {} });
    expect(res.statusCode).toBe(200);
  });

  it('rejects non-POST registration rather than silently ignoring it', () => {
    const fastify = Fastify();
    const adapter = new FastifyHttpServerAdapter(fastify as unknown as StandSyncFastify);
    expect(() =>
      adapter.registerRoute('GET' as 'POST', '/x', () => Promise.resolve({ status: 200 })),
    ).toThrow(/only supports POST/);
  });

  it('implements no start/stop, because Fastify owns the lifecycle', () => {
    // Typed as the SDK interface, where start/stop are optional. Leaving them
    // unimplemented is what keeps Fastify in charge of listening and shutdown.
    const adapter: IHttpServerAdapter = new FastifyHttpServerAdapter(
      Fastify() as unknown as StandSyncFastify,
    );
    expect('start' in adapter).toBe(false);
    expect('stop' in adapter).toBe(false);
  });

  it('drops undefined headers to satisfy the SDK contract', () => {
    expect(normalizeHeaders({ a: 'x', b: undefined, c: ['1', '2'] })).toEqual({
      a: 'x',
      c: ['1', '2'],
    });
  });
});

describe('channel guard', () => {
  it('allows only the configured conversation', () => {
    expect(isAllowedConversation('conv-allowed', 'conv-allowed').allowed).toBe(true);
    expect(isAllowedConversation('conv-other', 'conv-allowed').allowed).toBe(false);
  });

  it('ignores every channel when unconfigured, and reports the id to configure', () => {
    const decision = isAllowedConversation('conv-19:abc', '');
    expect(decision.allowed).toBe(false);
    // Failing closed matters: the bot writes to a real Jira project.
    if (!decision.allowed) {
      expect(decision.reason).toContain('TEAMS_ALLOWED_CONVERSATION_ID=conv-19:abc');
      expect(decision.notable).toBe(true);
    }
  });

  it('treats a wrong channel as routine, not as an operator problem', () => {
    const decision = isAllowedConversation('conv-other', 'conv-allowed');
    if (!decision.allowed) expect(decision.notable).toBe(false);
  });

  it('tolerates whitespace in configuration', () => {
    expect(isAllowedConversation('conv-a', '  conv-a  ').allowed).toBe(true);
  });

  it('detects bot senders by role and by app id', () => {
    expect(isFromBot({ role: 'bot', id: 'x' }, 'app-1')).toBe(true);
    expect(isFromBot({ id: '28:app-1' }, 'app-1')).toBe(true);
    expect(isFromBot({ id: 'app-1' }, 'app-1')).toBe(true);
    expect(isFromBot({ id: 'user-pasan' }, 'app-1')).toBe(false);
    expect(isFromBot(undefined, 'app-1')).toBe(false);
  });
});

describe('approval policy', () => {
  const batch = batchOf([proposal()]);

  it('lets anyone approve under APPROVAL_POLICY=anyone', () => {
    expect(canApprove('anyone', batch, 'someone-else').allowed).toBe(true);
  });

  it('restricts approval to the author under author_only', () => {
    expect(canApprove('author_only', batch, 'user-pasan').allowed).toBe(true);

    const denied = canApprove('author_only', batch, 'user-kasun');
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.reason).toContain('Pasan');
  });

  it('denies an unknown user under author_only', () => {
    expect(canApprove('author_only', batch, '').allowed).toBe(false);
  });
});

describe('card payloads', () => {
  const batch = batchOf([
    proposal(),
    proposal({
      id: 'p-2',
      key: 'TES-43',
      actions: [{ type: 'comment', body: 'Blocked on credentials' }],
    }),
    proposal({
      id: 'p-3',
      key: 'TES-80',
      actions: [{ type: 'none', reason: 'already Done' }],
      selected: false,
    }),
  ]);

  it('builds an Adaptive Card 1.5 proposal card', () => {
    const card = asJson(buildProposalCard(batch));
    expect(card.type).toBe('AdaptiveCard');
    expect(card.version).toBe(CARD_VERSION);
    expect(card.version).toBe('1.5');
  });

  it('counts only actionable tickets in the title', () => {
    // 3 proposals, but TES-80 is "no action".
    expect(cardText(buildProposalCard(batch))).toContain('StandSync found 2 Jira updates');
  });

  it('uses Action.Execute for every action, never Action.Submit', () => {
    for (const card of [buildProposalCard(batch), buildReviewCard(batch)]) {
      const json = asJson(card);
      expect(json.actions?.length).toBeGreaterThan(0);
      for (const a of json.actions ?? []) expect(a.type).toBe('Action.Execute');
      expect(JSON.stringify(json)).not.toContain('Action.Submit');
    }
  });

  it('carries { action, batchId } on every action', () => {
    const json = asJson(buildProposalCard(batch));
    const names = (json.actions ?? []).map((a) => a.data?.['action']);
    expect(names).toEqual(['approve_all', 'review', 'reject']);
    for (const a of json.actions ?? []) expect(a.data?.['batchId']).toBe('batch-1');
  });

  it('offers Apply Selected and Cancel in review mode', () => {
    const json = asJson(buildReviewCard(batch));
    expect((json.actions ?? []).map((a) => a.data?.['action'])).toEqual([
      'apply_selected',
      'reject',
    ]);
  });

  it('renders one toggle per actionable proposal, pre-set from `selected`', () => {
    const json = asJson(buildReviewCard(batch));
    const toggles = allElements(json).filter((e) => e['type'] === 'Input.Toggle');

    expect(toggles).toHaveLength(2); // TES-80 has no action, so no toggle
    expect(toggles.map((t) => t['id'])).toEqual([toggleIdFor('p-1'), toggleIdFor('p-2')]);
    expect(toggles[0]?.['value']).toBe('true');
  });

  it('starts a low-confidence toggle switched off', () => {
    const lowConf = batchOf([proposal({ confidence: 0.4, selected: false })]);
    const toggles = allElements(asJson(buildReviewCard(lowConf))).filter(
      (e) => e['type'] === 'Input.Toggle',
    );
    expect(toggles[0]?.['value']).toBe('false');
  });

  it('labels low confidence on the proposal card', () => {
    const lowConf = batchOf([proposal({ confidence: 0.4, selected: false })]);
    expect(cardText(buildProposalCard(lowConf))).toContain('Low confidence');
  });

  it('shows no actions on the Applying card, so it cannot be double-clicked', () => {
    const json = asJson(buildApplyingCard(batch));
    expect(json.actions ?? []).toHaveLength(0);
    expect(JSON.stringify(json)).toContain('Applying to Jira');
  });

  it('renders success, partial and failed result cards', () => {
    const success: BatchExecution = {
      batchId: 'batch-1',
      status: 'executed',
      results: [{ proposalId: 'p-1', key: 'TES-41', ok: true, applied: ['In Progress → Done'] }],
    };
    expect(cardText(buildResultCard(batch, success))).toContain('Jira updated successfully');

    const partial: BatchExecution = {
      batchId: 'batch-1',
      status: 'partial',
      results: [
        { proposalId: 'p-1', key: 'TES-41', ok: true, applied: ['In Progress → Done'] },
        { proposalId: 'p-2', key: 'TES-43', ok: false, applied: [], error: 'Transition invalid' },
      ],
    };
    const partialText = cardText(buildResultCard(batch, partial));
    expect(partialText).toContain('Jira partially updated');
    expect(partialText).toContain('Transition invalid');

    const failed: BatchExecution = {
      batchId: 'batch-1',
      status: 'failed',
      results: [{ proposalId: 'p-1', key: 'TES-41', ok: false, applied: [], error: 'Not found' }],
    };
    expect(cardText(buildResultCard(batch, failed))).toContain('Jira update failed');
  });

  it('result cards carry no actions, so a finished batch cannot be re-approved', () => {
    const execution: BatchExecution = { batchId: 'batch-1', status: 'executed', results: [] };
    expect(asJson(buildResultCard(batch, execution)).actions ?? []).toHaveLength(0);
  });

  it('builds an error card with no stack trace and no actions', () => {
    const json = asJson(buildErrorCard('Could not update Jira', 'Jira rejected the change.'));
    expect(json.version).toBe('1.5');
    expect(json.actions ?? []).toHaveLength(0);
    expect(JSON.stringify(json)).not.toContain('at ');
  });

  it('builds a rejection card naming who rejected it', () => {
    expect(cardText(buildRejectedCard(batch, 'Pasan'))).toContain('Pasan rejected');
  });
});

describe('card action parsing', () => {
  it('accepts the four valid actions', () => {
    for (const action of ['approve_all', 'review', 'apply_selected', 'reject']) {
      expect(parseCardAction({ action, batchId: 'b1' })).toEqual({ action, batchId: 'b1' });
    }
  });

  it('rejects unknown or malformed payloads', () => {
    expect(parseCardAction({ action: 'delete_everything', batchId: 'b1' })).toBeNull();
    expect(parseCardAction({ action: 'approve_all' })).toBeNull();
    expect(parseCardAction({ batchId: 'b1' })).toBeNull();
    expect(parseCardAction(null)).toBeNull();
    expect(parseCardAction('approve_all')).toBeNull();
  });

  it('reads only ticked toggles, ignoring other data keys', () => {
    const data = {
      action: 'apply_selected',
      batchId: 'b1',
      [toggleIdFor('p-1')]: 'true',
      [toggleIdFor('p-2')]: 'false',
      [toggleIdFor('p-3')]: true,
    };
    expect(selectedProposalIds(data)).toEqual(['p-1', 'p-3']);
  });

  it('returns no ids when nothing is ticked', () => {
    expect(selectedProposalIds({ action: 'apply_selected', batchId: 'b1' })).toEqual([]);
    expect(selectedProposalIds(null)).toEqual([]);
  });
});

describe('handleCardAction routing', () => {
  let store: ApprovalStore;
  let transitionIssue: ReturnType<typeof vi.fn>;
  let addComment: ReturnType<typeof vi.fn>;
  let actions: JiraActions;

  const deps = (policy: ApprovalPolicy = 'anyone') => ({
    store,
    actions,
    approvalPolicy: policy,
  });

  beforeEach(() => {
    store = ApprovalStore.open(':memory:');
    transitionIssue = vi.fn().mockResolvedValue(undefined);
    addComment = vi.fn().mockResolvedValue(undefined);
    actions = { transitionIssue, addComment } as unknown as JiraActions;
    store.saveBatch(
      batchOf([
        proposal(),
        proposal({
          id: 'p-2',
          key: 'TES-43',
          actions: [{ type: 'comment', body: 'Blocked on credentials' }],
        }),
      ]),
    );
  });

  const request = (data: unknown, userId = 'user-pasan') => ({
    data,
    userId,
    userName: 'Pasan',
  });

  it('Approve All applies every selected proposal through the shared executor', async () => {
    const outcome = await handleCardAction(
      deps(),
      request({ action: 'approve_all', batchId: 'batch-1' }),
    );

    expect(transitionIssue).toHaveBeenCalledWith('TES-41', '31');
    expect(addComment).toHaveBeenCalledTimes(1);
    expect(cardText(outcome.card)).toContain('Jira updated successfully');
    expect(store.getBatch('batch-1')?.status).toBe('executed');
  });

  it('Review shows the review card and writes nothing', async () => {
    const outcome = await handleCardAction(
      deps(),
      request({ action: 'review', batchId: 'batch-1' }),
    );

    expect(transitionIssue).not.toHaveBeenCalled();
    expect(cardText(outcome.card)).toContain('Review Jira updates');
    expect(store.getBatch('batch-1')?.status).toBe('pending');
  });

  it('Review needs no approval permission, since it only changes the view', async () => {
    const outcome = await handleCardAction(
      deps('author_only'),
      request({ action: 'review', batchId: 'batch-1' }, 'user-kasun'),
    );
    expect(cardText(outcome.card)).toContain('Review Jira updates');
  });

  it('Apply Selected applies only the ticked proposals', async () => {
    const outcome = await handleCardAction(
      deps(),
      request({
        action: 'apply_selected',
        batchId: 'batch-1',
        [toggleIdFor('p-2')]: 'true',
        [toggleIdFor('p-1')]: 'false',
      }),
    );

    expect(addComment).toHaveBeenCalledTimes(1);
    expect(transitionIssue).not.toHaveBeenCalled();
    expect(cardText(outcome.card)).toContain('Jira updated successfully');
  });

  it('Apply Selected with nothing ticked writes nothing and says so', async () => {
    const outcome = await handleCardAction(
      deps(),
      request({ action: 'apply_selected', batchId: 'batch-1' }),
    );

    expect(transitionIssue).not.toHaveBeenCalled();
    expect(addComment).not.toHaveBeenCalled();
    expect(cardText(outcome.card)).toContain('Nothing selected');
    expect(store.getBatch('batch-1')?.status).toBe('pending');
  });

  it('Reject writes nothing to Jira', async () => {
    const outcome = await handleCardAction(
      deps(),
      request({ action: 'reject', batchId: 'batch-1' }),
    );

    expect(transitionIssue).not.toHaveBeenCalled();
    expect(addComment).not.toHaveBeenCalled();
    expect(cardText(outcome.card)).toContain('rejected');
    expect(store.getBatch('batch-1')?.status).toBe('rejected');
  });

  it('blocks a non-author under author_only and writes nothing', async () => {
    const outcome = await handleCardAction(
      deps('author_only'),
      request({ action: 'approve_all', batchId: 'batch-1' }, 'user-kasun'),
    );

    expect(transitionIssue).not.toHaveBeenCalled();
    expect(cardText(outcome.card)).toContain('Not allowed');
    expect(store.getBatch('batch-1')?.status).toBe('pending');
  });

  it('allows the author under author_only', async () => {
    await handleCardAction(
      deps('author_only'),
      request({ action: 'approve_all', batchId: 'batch-1' }, 'user-pasan'),
    );
    expect(transitionIssue).toHaveBeenCalledTimes(1);
  });

  // The Phase 5 SQLite claim is what makes this safe, not anything card-specific.
  it('a second Approve All does not re-apply to Jira', async () => {
    await handleCardAction(deps(), request({ action: 'approve_all', batchId: 'batch-1' }));
    const second = await handleCardAction(
      deps(),
      request({ action: 'approve_all', batchId: 'batch-1' }, 'user-kasun'),
    );

    expect(transitionIssue).toHaveBeenCalledTimes(1);
    expect(addComment).toHaveBeenCalledTimes(1);
    expect(cardText(second.card)).toContain('Jira updated successfully');
  });

  it('cannot approve a batch that was already rejected', async () => {
    await handleCardAction(deps(), request({ action: 'reject', batchId: 'batch-1' }));
    const outcome = await handleCardAction(
      deps(),
      request({ action: 'approve_all', batchId: 'batch-1' }),
    );

    expect(transitionIssue).not.toHaveBeenCalled();
    expect(cardText(outcome.card)).toContain('rejected');
  });

  it('shows an error card for an unknown batch', async () => {
    const outcome = await handleCardAction(
      deps(),
      request({ action: 'approve_all', batchId: 'nope' }),
    );
    expect(cardText(outcome.card)).toContain('no longer available');
  });

  it('shows an error card for a malformed payload', async () => {
    const outcome = await handleCardAction(deps(), request({ action: 'drop_tables' }));
    expect(cardText(outcome.card)).toContain('Unrecognised action');
  });

  it('turns a Jira failure into a partial result card, not a crash', async () => {
    transitionIssue.mockRejectedValue(new JiraError('Transition is not valid', 400, 'TES-41'));
    const outcome = await handleCardAction(
      deps(),
      request({ action: 'approve_all', batchId: 'batch-1' }),
    );
    expect(cardText(outcome.card)).toContain('Jira partially updated');
  });
});

describe('user-facing error text', () => {
  it('translates Jira status codes into actionable language', () => {
    expect(describeForUser(new JiraError('x', 401))).toContain('credentials');
    expect(describeForUser(new JiraError('x', 403))).toContain('credentials');
    expect(describeForUser(new JiraError('x', 404))).toContain('could not find');
    expect(describeForUser(new JiraError('x', 429))).toContain('rate limiting');
  });

  it('never leaks a stack trace', () => {
    const err = new Error('boom\n    at Object.<anonymous> (/app/src/secret/path.ts:1:1)');
    const text = describeForUser(err);
    expect(text).toBe('boom');
    expect(text).not.toContain('at Object');
    expect(text).not.toContain('/app/src');
  });

  it('truncates an overlong message', () => {
    expect(describeForUser(new Error('x'.repeat(500))).length).toBeLessThanOrEqual(300);
  });

  it('handles a non-Error throw', () => {
    expect(describeForUser('something odd')).toBe('An unexpected error occurred.');
  });
});

/**
 * Structural guarantees. These read the source rather than exercise it, because
 * "there is only one Jira write path" is a property of the codebase, not of any
 * single call.
 */
describe('single-pipeline architecture', () => {
  const read = async (p: string): Promise<string> =>
    (await import('node:fs/promises')).readFile(new URL(`../${p}`, import.meta.url), 'utf8');

  const sourceFiles = async (): Promise<{ path: string; text: string }[]> => {
    const { readdir, readFile } = await import('node:fs/promises');
    const out: { path: string; text: string }[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(new URL(`../${dir}`, import.meta.url), {
        withFileTypes: true,
      })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) await walk(rel);
        else if (entry.name.endsWith('.ts')) {
          out.push({
            path: rel,
            text: await readFile(new URL(`../${rel}`, import.meta.url), 'utf8'),
          });
        }
      }
    };
    await walk('src');
    return out;
  };

  it('calls transitionIssue/addComment from execute.ts only', async () => {
    const callers = (await sourceFiles())
      .filter((f) => f.path !== 'src/jira/actions.ts')
      .filter((f) => /\.(transitionIssue|addComment)\(/.test(f.text))
      .map((f) => f.path);

    expect(callers).toEqual(['src/approval/execute.ts']);
  });

  it('routes Teams card actions through the shared executeBatch', async () => {
    const actions = await read('src/teams/actions.ts');
    expect(actions).toContain("from '../approval/execute.js'");
    expect(actions).toContain('executeBatch(');
    // No parallel Jira access from the Teams layer.
    expect(actions).not.toContain('JiraClient');
  });

  it('runs Teams messages through the shared runStandupPipeline', async () => {
    const app = await read('src/teams/app.ts');
    expect(app).toContain("from '../standup/pipeline.js'");
    expect(app).toContain('runStandupPipeline(');
    // Interpretation and proposal building are not re-implemented for Teams.
    expect(app).not.toContain('interpretStandup(');
    expect(app).not.toContain('buildProposals(');
  });

  it('keeps the dev endpoints on the same pipeline and executor', async () => {
    const routes = await read('src/dev/routes.ts');
    expect(routes).toContain('runStandupPipeline(');
    expect(routes).toContain('executeBatch(');
  });

  it('has no botbuilder dependency', async () => {
    const pkg = JSON.parse(await read('package.json')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const all = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(all.filter((d) => d.includes('botbuilder'))).toEqual([]);
    expect(all).toContain('@microsoft/teams.apps');
  });
});
