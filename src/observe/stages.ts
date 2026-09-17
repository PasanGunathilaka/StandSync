import { logger, type Logger } from '../logger.js';

/**
 * Structured logging for the V2 orchestration.
 *
 * Every stage of a message's journey logs the same shape — `stage`, `traceId`,
 * `messageId`, and a duration — so "why did StandSync stay silent on my
 * message?" is answerable from the log without attaching a debugger.
 *
 * Nothing here logs message content beyond a length, and nothing logs secrets:
 * the pino instance redacts credentials as a backstop, but the call sites below
 * never pass them in the first place.
 */

export const STAGES = [
  'message_received',
  'message_ignored',
  'classification_complete',
  'jira_context_loaded',
  'interpretation_complete',
  'validation_complete',
  'blocker_detected',
  'clarification_required',
  'proposal_created',
  'approval_received',
  'execution_started',
  'execution_finished',
  'summary_generated',
] as const;

export type Stage = (typeof STAGES)[number];

/** Ids that correlate one message across every stage and agent run. */
export interface TraceContext {
  /** Correlates all stages for one observed message. */
  traceId: string;
  messageId?: string;
  conversationId?: string;
  /** Present once a batch exists. */
  batchId?: string;
}

/**
 * A logger bound to one message's trace. Stage names are typed, so a typo
 * becomes a compile error rather than a log line nobody greps for.
 */
export class StageLogger {
  private readonly log: Logger;
  private readonly startedAt = Date.now();

  constructor(
    readonly trace: TraceContext,
    log: Logger = logger,
  ) {
    this.log = log.child({ traceId: trace.traceId, scope: 'orchestrator' });
  }

  /** Narrows the trace once a batch id exists, keeping later logs correlated. */
  withBatch(batchId: string): StageLogger {
    return new StageLogger({ ...this.trace, batchId }, this.log);
  }

  stage(stage: Stage, detail: Record<string, unknown> = {}): void {
    this.log.info(this.payload(stage, detail), stage);
  }

  /** For stages whose outcome is routine but worth having at debug level. */
  quiet(stage: Stage, detail: Record<string, unknown> = {}): void {
    this.log.debug(this.payload(stage, detail), stage);
  }

  warn(stage: Stage, detail: Record<string, unknown> = {}): void {
    this.log.warn(this.payload(stage, detail), stage);
  }

  error(stage: Stage, detail: Record<string, unknown> = {}): void {
    this.log.error(this.payload(stage, detail), stage);
  }

  /** Total wall time from the first stage to now. */
  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  private payload(stage: Stage, detail: Record<string, unknown>): Record<string, unknown> {
    return {
      stage,
      ...this.trace,
      elapsedMs: Date.now() - this.startedAt,
      ...detail,
    };
  }
}

/** Measures one stage and returns both the value and how long it took. */
export async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; durationMs: number }> {
  const startedAt = Date.now();
  const value = await fn();
  return { value, durationMs: Date.now() - startedAt };
}
