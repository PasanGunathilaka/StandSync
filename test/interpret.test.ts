import { describe, it, expect } from 'vitest';
import { interpretStandup } from '../src/standup/interpret.js';
import {
  buildUserMessage,
  INTERPRETATION_JSON_SCHEMA,
  SYSTEM_PROMPT,
} from '../src/standup/prompts.js';
import { MockLLMClient, heuristicInterpretation } from '../src/llm/mock.js';
import { ClaudeCodeLLMClient } from '../src/llm/claudeCode.js';
import { LLMError, LLMTimeoutError, type LLMClient } from '../src/llm/types.js';
import type { IssueLookup } from '../src/jira/issues.js';
import type { Intent, InterpretationResult } from '../src/types.js';

/**
 * The default run never touches the network: every case drives a scripted
 * MockLLMClient. The single live test at the bottom is opt-in via LIVE=1.
 */

const TIMEOUT = 5_000;

const found = (key: string, status: string, summary = 'demo ticket'): IssueLookup => ({
  key,
  found: true,
  state: { key, summary, status, transitions: [] },
});

const notFound = (key: string): IssueLookup => ({ key, found: false, reason: 'not found' });

/** Runs interpretation against a provider that returns exactly `data`. */
async function interpretWith(
  data: unknown,
  opts: { message: string; keys: string[]; lookups?: IssueLookup[] },
): Promise<InterpretationResult> {
  return interpretStandup({
    rawMessage: opts.message,
    keys: opts.keys,
    lookups: opts.lookups ?? [],
    llm: MockLLMClient.returning(data),
    timeoutMs: TIMEOUT,
  });
}

const ticket = (
  key: string,
  intent: Intent,
  evidence: string,
  extra: Record<string, unknown> = {},
) => ({ key, intent, confidence: 0.9, evidence, ...extra });

describe('interpretStandup — the six cases from the brief', () => {
  it('case 1: "mostly finished but QA found an issue" is not_done_yet, never completed', async () => {
    const message = 'I mostly finished TES-41, but QA found another issue so do not close it yet.';
    const result = await interpretWith(
      {
        tickets: [
          ticket('TES-41', 'not_done_yet', 'mostly finished ... do not close it yet', {
            commentText: 'Mostly complete, but QA found another issue — not ready to close.',
          }),
        ],
        unresolvedMentions: [],
      },
      { message, keys: ['TES-41'] },
    );

    expect(result.tickets[0]?.intent).toBe('not_done_yet');
    expect(result.tickets[0]?.intent).not.toBe('completed');
    expect(result.tickets[0]?.commentText).toContain('QA');
  });

  it('case 2: "still working but waiting on someone" is blocked with a reason', async () => {
    const message = 'Still working on TES-42 but waiting for Kasun to confirm the endpoint.';
    const result = await interpretWith(
      {
        tickets: [
          ticket('TES-42', 'blocked', 'waiting for Kasun to confirm the endpoint', {
            blockerReason: 'Waiting for Kasun to confirm the endpoint.',
            commentText: 'Blocked waiting for Kasun to confirm the endpoint.',
          }),
        ],
        unresolvedMentions: [],
      },
      { message, keys: ['TES-42'] },
    );

    expect(result.tickets[0]?.intent).toBe('blocked');
    expect(result.tickets[0]?.blockerReason).toContain('Kasun');
  });

  it('case 3: "started looking at X and Y" marks both in_progress', async () => {
    const message = 'Started looking at TES-70 and TES-71.';
    const result = await interpretWith(
      {
        tickets: [
          ticket('TES-70', 'in_progress', 'Started looking at TES-70 and TES-71'),
          ticket('TES-71', 'in_progress', 'Started looking at TES-70 and TES-71'),
        ],
        unresolvedMentions: [],
      },
      { message, keys: ['TES-70', 'TES-71'] },
    );

    expect(result.tickets.map((t) => t.intent)).toEqual(['in_progress', 'in_progress']);
  });

  it('case 4: "nothing on X today" is no_change', async () => {
    const result = await interpretWith(
      {
        tickets: [ticket('TES-80', 'no_change', 'Nothing on TES-80 today')],
        unresolvedMentions: [],
      },
      { message: 'Nothing on TES-80 today.', keys: ['TES-80'] },
    );

    expect(result.tickets[0]?.intent).toBe('no_change');
  });

  it('case 5: a ticket already in the target state still reports completed, with live status as context', async () => {
    const lookups = [found('TES-41', 'Done')];
    const llm = new MockLLMClient({
      script: [
        {
          kind: 'data',
          data: {
            tickets: [ticket('TES-41', 'completed', 'I finished TES-41')],
            unresolvedMentions: [],
          },
        },
      ],
    });

    const result = await interpretStandup({
      rawMessage: 'I finished TES-41.',
      keys: ['TES-41'],
      lookups,
      llm,
      timeoutMs: TIMEOUT,
    });

    expect(result.tickets[0]?.intent).toBe('completed');
    // The "already Done" decision belongs to propose.ts, but Claude must be told.
    expect(llm.calls[0]?.userMessage).toContain('currently "Done"');
  });

  it('case 6: a key missing from Jira is surfaced to the model as NOT FOUND', async () => {
    const llm = new MockLLMClient({
      script: [
        {
          kind: 'data',
          data: {
            tickets: [ticket('TES-999', 'completed', 'completed TES-999')],
            unresolvedMentions: [],
          },
        },
      ],
    });

    await interpretStandup({
      rawMessage: 'Yesterday I completed TES-999.',
      keys: ['TES-999'],
      lookups: [notFound('TES-999')],
      llm,
      timeoutMs: TIMEOUT,
    });

    expect(llm.calls[0]?.userMessage).toContain('NOT FOUND in Jira');
  });
});

describe('interpretStandup — additional required cases', () => {
  it('handles multiple Jira keys in a single sentence, in mention order', async () => {
    const message =
      'Yesterday I completed TES-41 and TES-42, and TES-43 is blocked on credentials.';
    const result = await interpretWith(
      {
        tickets: [
          // Deliberately out of order to prove the result is re-ordered.
          ticket('TES-43', 'blocked', 'TES-43 is blocked on credentials', {
            blockerReason: 'Waiting on credentials.',
          }),
          ticket('TES-41', 'completed', 'completed TES-41 and TES-42'),
          ticket('TES-42', 'completed', 'completed TES-41 and TES-42'),
        ],
        unresolvedMentions: [],
      },
      { message, keys: ['TES-41', 'TES-42', 'TES-43'] },
    );

    expect(result.tickets.map((t) => t.key)).toEqual(['TES-41', 'TES-42', 'TES-43']);
    expect(result.tickets.map((t) => t.intent)).toEqual(['completed', 'completed', 'blocked']);
  });

  it('resolves conflicting language in favour of not closing the ticket', async () => {
    const message = 'Finished most of TES-41 but do not close it.';
    const result = await interpretWith(
      {
        tickets: [
          ticket('TES-41', 'not_done_yet', 'Finished most of TES-41 but do not close it', {
            commentText: 'Most of the work is done, but it should stay open.',
          }),
        ],
        unresolvedMentions: [],
      },
      { message, keys: ['TES-41'] },
    );

    expect(result.tickets[0]?.intent).toBe('not_done_yet');
  });

  it('gives up and reports unclear when Claude times out', async () => {
    const llm = new MockLLMClient({ script: [{ kind: 'timeout' }] });
    const result = await interpretStandup({
      rawMessage: 'Yesterday I completed TES-41.',
      keys: ['TES-41'],
      llm,
      timeoutMs: TIMEOUT,
    });

    expect(result.tickets).toEqual([
      {
        key: 'TES-41',
        intent: 'unclear',
        confidence: 0,
        evidence: 'The interpretation service could not be reached.',
      },
    ]);
    // A timeout is terminal — retrying would just burn another timeout.
    expect(llm.calls).toHaveLength(1);
  });

  it('retries once on malformed structured output, then succeeds', async () => {
    const llm = new MockLLMClient({
      script: [
        { kind: 'data', data: { tickets: [{ key: 'TES-41', intent: 'finished-ish' }] } },
        {
          kind: 'data',
          data: {
            tickets: [ticket('TES-41', 'completed', 'completed TES-41')],
            unresolvedMentions: [],
          },
        },
      ],
    });

    const result = await interpretStandup({
      rawMessage: 'Yesterday I completed TES-41.',
      keys: ['TES-41'],
      llm,
      timeoutMs: TIMEOUT,
    });

    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]?.userMessage).toContain('did not match the required schema');
    expect(result.tickets[0]?.intent).toBe('completed');
  });

  it('falls back to unclear when structured output is malformed twice', async () => {
    const llm = new MockLLMClient({
      script: [
        { kind: 'data', data: { nonsense: true } },
        { kind: 'data', data: { also: 'nonsense' } },
      ],
    });

    const result = await interpretStandup({
      rawMessage: 'Yesterday I completed TES-41. TES-42 is blocked.',
      keys: ['TES-41', 'TES-42'],
      llm,
      timeoutMs: TIMEOUT,
    });

    expect(llm.calls).toHaveLength(2);
    expect(result.tickets.map((t) => t.intent)).toEqual(['unclear', 'unclear']);
    expect(result.tickets.every((t) => t.confidence === 0)).toBe(true);
  });

  it('reports unclear when the provider errors outright', async () => {
    const llm = new MockLLMClient({
      script: [{ kind: 'error', error: new LLMError('CLI not found', 'claude-code') }],
    });
    const result = await interpretStandup({
      rawMessage: 'Yesterday I completed TES-41.',
      keys: ['TES-41'],
      llm,
      timeoutMs: TIMEOUT,
    });
    expect(result.tickets[0]?.intent).toBe('unclear');
  });

  it('handles an unknown ticket end to end without throwing', async () => {
    const result = await interpretWith(
      {
        tickets: [ticket('TES-9999', 'completed', 'completed TES-9999')],
        unresolvedMentions: [],
      },
      {
        message: 'Yesterday I completed TES-9999.',
        keys: ['TES-9999'],
        lookups: [notFound('TES-9999')],
      },
    );

    // Interpretation still succeeds; propose.ts is what turns this into "not found".
    expect(result.tickets[0]).toMatchObject({ key: 'TES-9999', intent: 'completed' });
  });
});

describe('interpretStandup — guardrails', () => {
  it('drops keys the model invented', async () => {
    const result = await interpretWith(
      {
        tickets: [
          ticket('TES-41', 'completed', 'completed TES-41'),
          ticket('TES-500', 'completed', 'hallucinated'),
        ],
        unresolvedMentions: [],
      },
      { message: 'Yesterday I completed TES-41.', keys: ['TES-41'] },
    );

    expect(result.tickets.map((t) => t.key)).toEqual(['TES-41']);
  });

  it('fills in keys the model skipped as unclear', async () => {
    const result = await interpretWith(
      {
        tickets: [ticket('TES-41', 'completed', 'completed TES-41')],
        unresolvedMentions: [],
      },
      { message: 'Completed TES-41. Also TES-42.', keys: ['TES-41', 'TES-42'] },
    );

    expect(result.tickets).toHaveLength(2);
    expect(result.tickets[1]).toMatchObject({ key: 'TES-42', intent: 'unclear', confidence: 0 });
  });

  it('de-duplicates a key the model reported twice', async () => {
    const result = await interpretWith(
      {
        tickets: [ticket('TES-41', 'completed', 'first'), ticket('TES-41', 'blocked', 'second')],
        unresolvedMentions: [],
      },
      { message: 'Completed TES-41.', keys: ['TES-41'] },
    );

    expect(result.tickets).toHaveLength(1);
    expect(result.tickets[0]?.intent).toBe('completed');
  });

  it('preserves the evidence phrase so the approval card can explain itself', async () => {
    const evidence = 'blocked because I am waiting for API credentials';
    const result = await interpretWith(
      {
        tickets: [
          ticket('TES-43', 'blocked', evidence, { blockerReason: 'Waiting for API credentials.' }),
        ],
        unresolvedMentions: [],
      },
      { message: `TES-43 is ${evidence}.`, keys: ['TES-43'] },
    );

    expect(result.tickets[0]?.evidence).toBe(evidence);
  });

  it('rejects a confidence outside 0..1 and falls back rather than trusting it', async () => {
    const llm = new MockLLMClient({
      script: [
        {
          kind: 'data',
          data: {
            tickets: [{ ...ticket('TES-41', 'completed', 'x'), confidence: 4 }],
            unresolvedMentions: [],
          },
        },
        {
          kind: 'data',
          data: {
            tickets: [{ ...ticket('TES-41', 'completed', 'x'), confidence: 4 }],
            unresolvedMentions: [],
          },
        },
      ],
    });
    const result = await interpretStandup({
      rawMessage: 'Completed TES-41.',
      keys: ['TES-41'],
      llm,
      timeoutMs: TIMEOUT,
    });
    expect(result.tickets[0]?.intent).toBe('unclear');
  });

  it('short-circuits with no model call when no keys were detected', async () => {
    const llm = new MockLLMClient();
    const result = await interpretStandup({
      rawMessage: 'Good morning everyone, no tickets today.',
      keys: [],
      llm,
      timeoutMs: TIMEOUT,
    });

    expect(result).toEqual({ tickets: [], unresolvedMentions: [] });
    expect(llm.calls).toHaveLength(0);
  });

  it('sends the system prompt and schema, and never the raw message on a command line', async () => {
    const llm = new MockLLMClient();
    await interpretStandup({
      rawMessage: 'Completed TES-41.',
      keys: ['TES-41'],
      llm,
      timeoutMs: TIMEOUT,
    });

    const call = llm.calls[0]!;
    expect(call.systemPrompt).toBe(SYSTEM_PROMPT);
    expect(call.jsonSchema).toEqual(INTERPRETATION_JSON_SCHEMA);
    expect(call.timeoutMs).toBe(TIMEOUT);
    expect(call.userMessage).toContain('Completed TES-41.');
  });
});

describe('ClaudeCodeLLMClient invocation', () => {
  const client = new ClaudeCodeLLMClient({ model: 'claude-sonnet-5' });
  const args = client.buildArgs({
    systemPrompt: SYSTEM_PROMPT,
    userMessage: 'ignored — this goes over stdin',
    jsonSchema: INTERPRETATION_JSON_SCHEMA,
    timeoutMs: TIMEOUT,
  });

  it('requests JSON output from an explicit model id, never an alias', () => {
    expect(args).toContain('--print');
    expect(args.join(' ')).toContain('--output-format json');
    expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-5');
    expect(args).not.toContain('sonnet');
  });

  it('constrains output with the interpretation JSON schema', () => {
    const schema: unknown = JSON.parse(args[args.indexOf('--json-schema') + 1]!);
    expect(schema).toEqual(INTERPRETATION_JSON_SCHEMA);
  });

  it('disables tools, skills and project context', () => {
    expect(args).toContain('--safe-mode');
    expect(args).toContain('--disable-slash-commands');
    expect(args.at(-2)).toBe('--tools');
    expect(args.at(-1)).toBe(''); // variadic, kept last so it swallows nothing
  });

  it('never uses --bare, which cannot read the subscription login', () => {
    expect(args).not.toContain('--bare');
  });

  it('never places the standup text in argv', () => {
    expect(args.join(' ')).not.toContain('this goes over stdin');
  });

  it('surfaces a clear error when the CLI is missing', async () => {
    const missing = new ClaudeCodeLLMClient({
      model: 'claude-sonnet-5',
      cliPath: 'definitely-not-a-real-binary-standsync',
    });
    const err = await missing
      .complete({
        systemPrompt: 'x',
        userMessage: 'y',
        jsonSchema: {},
        timeoutMs: TIMEOUT,
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LLMError);
    expect((err as Error).message).toContain('Is it installed and on PATH?');
  });
});

describe('mock heuristics (offline demo fallback)', () => {
  const intentFor = (message: string, key: string): Intent | undefined =>
    heuristicInterpretation(message).tickets.find((t) => t.key === key)?.intent;

  it('reads the canonical demo standup correctly', () => {
    const message =
      'Yesterday I completed TES-41. Today I am working on TES-42. ' +
      'TES-43 is blocked because I am waiting for API credentials.';
    const { tickets } = heuristicInterpretation(message);

    expect(tickets.map((t) => `${t.key}:${t.intent}`)).toEqual([
      'TES-41:completed',
      'TES-42:in_progress',
      'TES-43:blocked',
    ]);
    expect(tickets[2]?.blockerReason).toContain('API credentials');
  });

  it('prefers not_done_yet over completed when both signals appear', () => {
    expect(intentFor('I mostly finished TES-41 but QA found a bug.', 'TES-41')).toBe(
      'not_done_yet',
    );
  });

  it('prefers blocked over in_progress when both signals appear', () => {
    expect(intentFor('Still working on TES-42 but waiting for Kasun.', 'TES-42')).toBe('blocked');
  });

  it('marks both keys in a shared clause', () => {
    const { tickets } = heuristicInterpretation('Started looking at TES-70 and TES-71.');
    expect(tickets.map((t) => t.intent)).toEqual(['in_progress', 'in_progress']);
  });

  it('detects no_change and falls back to unclear otherwise', () => {
    expect(intentFor('Nothing on TES-80 today.', 'TES-80')).toBe('no_change');
    expect(intentFor('TES-90 exists.', 'TES-90')).toBe('unclear');
  });

  it('reads the standup out of the quoted block in a full user message', () => {
    const wrapped = buildUserMessage(
      'Yesterday I completed TES-41.',
      ['TES-41'],
      [found('TES-41', 'In Progress')],
    );
    expect(intentFor(wrapped, 'TES-41')).toBe('completed');
  });
});

/**
 * Opt-in live check against the real Claude Code CLI: LIVE=1 npx vitest run.
 * Excluded from the default run so `npm test` makes no model calls.
 */
describe.runIf(process.env.LIVE === '1')('live Claude Code interpretation', () => {
  it('interprets the demo standup through the real CLI', async () => {
    const { ClaudeCodeLLMClient: Live } = await import('../src/llm/claudeCode.js');
    const llm: LLMClient = new Live({ model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5' });

    const result = await interpretStandup({
      rawMessage:
        'Yesterday I completed TES-41. Today I am working on TES-42. ' +
        'TES-43 is blocked because I am waiting for API credentials.',
      keys: ['TES-41', 'TES-42', 'TES-43'],
      lookups: [
        found('TES-41', 'In Progress'),
        found('TES-42', 'To Do'),
        found('TES-43', 'In Progress'),
      ],
      llm,
      timeoutMs: 120_000,
    });

    expect(result.tickets.map((t) => t.intent)).toEqual(['completed', 'in_progress', 'blocked']);
    expect(result.tickets[2]?.blockerReason?.toLowerCase()).toContain('credential');
    for (const t of result.tickets) expect(t.evidence.length).toBeGreaterThan(0);
  }, 180_000);

  // Guards the Windows kill-tree path: child.kill() alone can leave the real
  // worker running, which would hold the timeout open indefinitely.
  it('abandons the call and kills the CLI when the timeout expires', async () => {
    const llm = new ClaudeCodeLLMClient({ model: 'claude-sonnet-5' });
    const startedAt = Date.now();

    const err = await llm
      .complete({ systemPrompt: 'x', userMessage: 'hello', jsonSchema: {}, timeoutMs: 1_500 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LLMTimeoutError);
    // A full call takes ~7s; the timeout must cut it far shorter than that.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 60_000);
});
