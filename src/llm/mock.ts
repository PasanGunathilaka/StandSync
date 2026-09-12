import type { Intent } from '../types.js';
import { INTENTS } from '../standup/prompts.js';
import {
  LLMError,
  LLMTimeoutError,
  type LLMClient,
  type LLMRequest,
  type LLMResponse,
} from './types.js';

/**
 * Deterministic provider. Two jobs:
 *
 * 1. Unit tests — hand it scripted responses (including malformed output and
 *    thrown errors) so the whole interpretation path is exercised with no network.
 * 2. Offline demo fallback — with no script it falls back to keyword heuristics,
 *    so `LLM_PROVIDER=mock` still demonstrates the end-to-end flow with no model.
 *
 * The heuristics are intentionally crude. They exist to keep a demo alive, not to
 * rival the model; anything ambiguous resolves to `unclear`.
 */

export type MockBehavior =
  { kind: 'data'; data: unknown } | { kind: 'error'; error: Error } | { kind: 'timeout' };

export interface MockOptions {
  /** Consumed in order, one per call. When exhausted, the last one repeats. */
  script?: MockBehavior[];
  model?: string;
}

export class MockLLMClient implements LLMClient {
  readonly name = 'mock';
  readonly model: string;
  /** Every request received, for assertions about what was sent to the model. */
  readonly calls: LLMRequest[] = [];
  private readonly script: MockBehavior[];
  private callIndex = 0;

  constructor(opts: MockOptions = {}) {
    this.script = opts.script ?? [];
    this.model = opts.model ?? 'mock-model';
  }

  /** Convenience for the common "always return this object" case. */
  static returning(data: unknown): MockLLMClient {
    return new MockLLMClient({ script: [{ kind: 'data', data }] });
  }

  complete(req: LLMRequest): Promise<LLMResponse> {
    this.calls.push(req);
    const startedAt = Date.now();

    const behavior = this.script.length
      ? (this.script[Math.min(this.callIndex, this.script.length - 1)] as MockBehavior)
      : ({ kind: 'data', data: heuristicInterpretation(req.userMessage) } as MockBehavior);
    this.callIndex++;

    if (behavior.kind === 'timeout')
      return Promise.reject(new LLMTimeoutError(this.name, req.timeoutMs));
    if (behavior.kind === 'error') return Promise.reject(behavior.error);

    return Promise.resolve({
      data: behavior.data,
      meta: { provider: this.name, model: this.model, durationMs: Date.now() - startedAt },
    });
  }
}

/** Re-exported so callers can build an "unavailable provider" case. */
export const mockUnavailable = (): MockLLMClient =>
  new MockLLMClient({ script: [{ kind: 'error', error: new LLMError('provider down', 'mock') }] });

const KEY_PATTERN = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]+-\d+)(?![0-9])/g;

/** Phrase sets, checked in priority order — the earlier an intent, the stronger. */
const NOT_DONE_YET = [
  'mostly finished',
  'mostly done',
  'almost done',
  'almost finished',
  'nearly done',
  "don't close",
  'do not close',
  "didn't close",
  'not done yet',
  'not finished',
  'qa found',
  'found a bug',
  'found another issue',
  'reopened',
];
const BLOCKED = [
  'blocked',
  'waiting for',
  'waiting on',
  'waiting to',
  'cannot proceed',
  "can't proceed",
  'stuck',
  'need credentials',
  'needs credentials',
  'depends on',
  'held up',
];
const COMPLETED = [
  'completed',
  'finished',
  'shipped',
  'merged',
  'closed',
  'done with',
  'wrapped up',
];
const IN_PROGRESS = [
  'working on',
  'started',
  'starting',
  'picking up',
  'picked up',
  'looking at',
  'in progress',
  'continuing',
];
const NO_CHANGE = [
  'nothing on',
  'no update',
  'no progress',
  'no change',
  'did not touch',
  "didn't touch",
];

const has = (haystack: string, needles: string[]): string | undefined =>
  needles.find((n) => haystack.includes(n));

/**
 * Splits into clauses, attributes each key to the clause it appears in, and
 * classifies that clause. Keeps the matched phrase as evidence so the approval
 * card can still explain itself in mock mode.
 */
export function heuristicInterpretation(text: string): {
  tickets: {
    key: string;
    intent: Intent;
    blockerReason?: string;
    commentText?: string;
    confidence: number;
    evidence: string;
  }[];
  unresolvedMentions: string[];
} {
  // The user turn wraps the standup in triple quotes; interpret only that part.
  const quoted = /"""\s*([\s\S]*?)\s*"""/.exec(text);
  const message = quoted?.[1] ?? text;

  const clauses = message
    .split(/(?<=[.;!?])\s+|\n+/)
    .map((c) => c.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const tickets: ReturnType<typeof heuristicInterpretation>['tickets'] = [];

  for (const clause of clauses) {
    const lower = clause.toLowerCase();
    const keys = [...clause.matchAll(KEY_PATTERN)].map((m) => m[1]).filter((k): k is string => !!k);
    if (!keys.length) continue;

    // Order matters: "mostly finished ... don't close" must beat "finished".
    let intent: Intent = 'unclear';
    let confidence = 0.3;
    let blockerReason: string | undefined;
    let commentText: string | undefined;

    if (has(lower, NOT_DONE_YET)) {
      intent = 'not_done_yet';
      confidence = 0.8;
      commentText = clause;
    } else if (has(lower, BLOCKED)) {
      intent = 'blocked';
      confidence = 0.85;
      blockerReason = clause;
      commentText = clause;
    } else if (has(lower, NO_CHANGE)) {
      intent = 'no_change';
      confidence = 0.8;
    } else if (has(lower, COMPLETED)) {
      intent = 'completed';
      confidence = 0.85;
    } else if (has(lower, IN_PROGRESS)) {
      intent = 'in_progress';
      confidence = 0.8;
    }

    for (const key of keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      tickets.push({
        key,
        intent,
        confidence,
        evidence: clause,
        ...(blockerReason ? { blockerReason } : {}),
        ...(commentText ? { commentText } : {}),
      });
    }
  }

  return { tickets, unresolvedMentions: [] };
}

/** Guard so the heuristic can never emit an intent outside the enum. */
export const isIntent = (value: string): value is Intent =>
  (INTENTS as readonly string[]).includes(value);
