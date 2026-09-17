import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { migrate } from './migrations.js';
import type {
  BatchOrigin,
  BatchStatus,
  ExecutionResult,
  Intent,
  MessageKind,
  Proposal,
  ProposalAction,
  ProposalBatch,
  ProposalReview,
} from '../types.js';

/**
 * Audit store. Every batch, every proposal and every execution result is written
 * here so "what did StandSync change, and who approved it?" is answerable later.
 *
 * V2 adds the observation tables — message events, agent runs, clarifications and
 * blockers — behind the same class, because they share the batch lifecycle and a
 * second database would make "what happened to this message?" unanswerable.
 */

export function openDatabase(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

/** Stable content fingerprint, used to spot a re-delivered or edited message. */
export function hashContent(text: string): string {
  return createHash('sha256').update(text.trim().toLowerCase()).digest('hex').slice(0, 32);
}

interface BatchRow {
  id: string;
  conversation_id: string;
  message_id: string;
  author_id: string;
  author_name: string;
  raw_message: string;
  status: BatchStatus;
  created_at: string;
}

interface ProposalRow {
  id: string;
  issue_key: string;
  actions_json: string;
  confidence: number;
  explanation: string;
  selected: number;
  review_json: string | null;
}

/** Tolerant JSON read for a nullable metadata column. */
function parseJsonColumn<T>(raw: string | null): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Audit metadata must never break reading a batch back for approval.
    return undefined;
  }
}

export class ApprovalStore {
  constructor(private readonly db: DB) {}

  static open(path: string): ApprovalStore {
    return new ApprovalStore(openDatabase(path));
  }

  saveBatch(batch: ProposalBatch, cardActivityId?: string): void {
    const insertBatch = this.db.prepare(
      `INSERT INTO batches
         (id, conversation_id, message_id, author_id, author_name, raw_message,
          status, created_at, card_activity_id, origin_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertProposal = this.db.prepare(
      `INSERT INTO proposals
         (id, batch_id, issue_key, actions_json, confidence, explanation, selected,
          position, review_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.db.transaction(() => {
      insertBatch.run(
        batch.id,
        batch.conversationId,
        batch.messageId,
        batch.authorId,
        batch.authorName,
        batch.rawMessage,
        batch.status,
        batch.createdAt,
        cardActivityId ?? null,
        batch.origin ? JSON.stringify(batch.origin) : null,
      );
      batch.proposals.forEach((p, i) => {
        insertProposal.run(
          p.id,
          batch.id,
          p.key,
          JSON.stringify(p.actions),
          p.confidence,
          p.explanation,
          p.selected ? 1 : 0,
          i,
          p.review ? JSON.stringify(p.review) : null,
        );
      });
    })();
  }

  getBatch(batchId: string): ProposalBatch | undefined {
    const row = this.db.prepare(`SELECT * FROM batches WHERE id = ?`).get(batchId) as
      (BatchRow & { origin_json: string | null }) | undefined;
    if (!row) return undefined;

    const proposalRows = this.db
      .prepare(`SELECT * FROM proposals WHERE batch_id = ? ORDER BY position`)
      .all(batchId) as ProposalRow[];

    const proposals: Proposal[] = proposalRows.map((p) => {
      const review = parseJsonColumn<ProposalReview>(p.review_json);
      return {
        id: p.id,
        key: p.issue_key,
        actions: JSON.parse(p.actions_json) as ProposalAction[],
        confidence: p.confidence,
        explanation: p.explanation,
        selected: p.selected === 1,
        ...(review ? { review } : {}),
      };
    });

    const origin = parseJsonColumn<BatchOrigin>(row.origin_json);

    return {
      id: row.id,
      conversationId: row.conversation_id,
      messageId: row.message_id,
      authorId: row.author_id,
      authorName: row.author_name,
      rawMessage: row.raw_message,
      proposals,
      status: row.status,
      createdAt: row.created_at,
      ...(origin ? { origin } : {}),
    };
  }

  getCardActivityId(batchId: string): string | undefined {
    const row = this.db
      .prepare(`SELECT card_activity_id FROM batches WHERE id = ?`)
      .get(batchId) as { card_activity_id: string | null } | undefined;
    return row?.card_activity_id ?? undefined;
  }

  setCardActivityId(batchId: string, activityId: string): void {
    this.db
      .prepare(`UPDATE batches SET card_activity_id = ? WHERE id = ?`)
      .run(activityId, batchId);
  }

  /**
   * Atomically moves a batch out of `pending` so it can be executed exactly once.
   * Returns false if some other click already claimed it — this is the guard that
   * stops a stale Approve button from double-applying changes to Jira.
   */
  claimForExecution(batchId: string, decidedBy: string): boolean {
    const info = this.db
      .prepare(
        `UPDATE batches SET status = 'approved', decided_at = ?, decided_by = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(new Date().toISOString(), decidedBy, batchId);
    return info.changes === 1;
  }

  reject(batchId: string, decidedBy: string): boolean {
    const info = this.db
      .prepare(
        `UPDATE batches SET status = 'rejected', decided_at = ?, decided_by = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(new Date().toISOString(), decidedBy, batchId);
    return info.changes === 1;
  }

  setStatus(batchId: string, status: BatchStatus): void {
    this.db.prepare(`UPDATE batches SET status = ? WHERE id = ?`).run(status, batchId);
  }

  saveResults(batchId: string, results: ExecutionResult[]): void {
    const insert = this.db.prepare(
      `INSERT INTO results (batch_id, proposal_id, issue_key, ok, applied_json, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = new Date().toISOString();
    this.db.transaction(() => {
      for (const r of results) {
        insert.run(
          batchId,
          r.proposalId,
          r.key,
          r.ok ? 1 : 0,
          JSON.stringify(r.applied),
          r.error ?? null,
          now,
        );
      }
    })();
  }

  getResults(batchId: string): ExecutionResult[] {
    const rows = this.db
      .prepare(`SELECT * FROM results WHERE batch_id = ? ORDER BY id`)
      .all(batchId) as {
      proposal_id: string;
      issue_key: string;
      ok: number;
      applied_json: string;
      error: string | null;
    }[];
    return rows.map((r) => ({
      proposalId: r.proposal_id,
      key: r.issue_key,
      ok: r.ok === 1,
      applied: JSON.parse(r.applied_json) as string[],
      ...(r.error ? { error: r.error } : {}),
    }));
  }

  // ---------------------------------------------------------------- V2: events

  /**
   * Records a message the bot observed, and reports whether it is new.
   *
   * This is the deduplication boundary for ambient mode. Teams re-delivers
   * activities on retry and sends an edit as a fresh event, so "have I already
   * handled this?" has to be answered from storage rather than memory — an
   * in-process Set would forget everything on restart and would not be shared
   * between two instances behind the same endpoint.
   *
   * `duplicate` means the same activity id, or the same text already seen in this
   * conversation. An edit that materially changed the text hashes differently and
   * is therefore treated as new work.
   */
  recordMessageEvent(event: {
    id: string;
    conversationId: string;
    threadId?: string;
    authorId: string;
    authorName: string;
    text: string;
  }): { duplicate: boolean; reason?: string } {
    const hash = hashContent(event.text);

    const byId = this.db
      .prepare(`SELECT id, content_hash FROM message_events WHERE id = ?`)
      .get(event.id) as { id: string; content_hash: string } | undefined;

    if (byId) {
      // Same activity id. An edit with genuinely new text is allowed through
      // once, and the stored hash is advanced so the next replay is a duplicate.
      if (byId.content_hash === hash) {
        return { duplicate: true, reason: 'activity already processed' };
      }
      this.db
        .prepare(
          `UPDATE message_events SET content_hash = ?, text = ?, processed_state = 'received',
             classification = NULL, relevant = NULL WHERE id = ?`,
        )
        .run(hash, event.text, event.id);
      return { duplicate: false, reason: 'edited with materially different content' };
    }

    const byHash = this.db
      .prepare(
        `SELECT id FROM message_events WHERE conversation_id = ? AND content_hash = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(event.conversationId, hash) as { id: string } | undefined;

    if (byHash) return { duplicate: true, reason: 'identical text already processed' };

    this.db
      .prepare(
        `INSERT INTO message_events
           (id, conversation_id, thread_id, author_id, author_name, content_hash, text,
            processed_state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'received', ?)`,
      )
      .run(
        event.id,
        event.conversationId,
        event.threadId ?? null,
        event.authorId,
        event.authorName,
        hash,
        event.text,
        new Date().toISOString(),
      );

    return { duplicate: false };
  }

  /** Updates an observed message once the pipeline has decided what it was. */
  markMessageEvent(
    messageId: string,
    update: {
      state: 'ignored' | 'processed' | 'failed';
      classification?: MessageKind;
      relevant?: boolean;
      batchId?: string;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE message_events
           SET processed_state = ?, classification = COALESCE(?, classification),
               relevant = COALESCE(?, relevant), batch_id = COALESCE(?, batch_id)
         WHERE id = ?`,
      )
      .run(
        update.state,
        update.classification ?? null,
        update.relevant === undefined ? null : update.relevant ? 1 : 0,
        update.batchId ?? null,
        messageId,
      );
  }

  /**
   * Bounded conversational context: the most recent relevant messages from the
   * same thread, or the same conversation when the message is not in a thread.
   *
   * Never returns the whole channel. `limit` and `sinceMinutes` are configured
   * ceilings, and only messages that were judged relevant (or not yet judged)
   * are returned, so social chatter is not fed back into a prompt.
   */
  recentContext(params: {
    conversationId: string;
    threadId?: string;
    excludeMessageId?: string;
    limit: number;
    sinceMinutes: number;
  }): { authorName: string; text: string; createdAt: string }[] {
    if (params.limit <= 0) return [];

    const since = new Date(Date.now() - params.sinceMinutes * 60_000).toISOString();
    const scope = params.threadId
      ? { clause: `thread_id = ?`, value: params.threadId }
      : { clause: `conversation_id = ?`, value: params.conversationId };

    const rows = this.db
      .prepare(
        `SELECT author_name, text, created_at FROM message_events
         WHERE ${scope.clause}
           AND created_at >= ?
           AND id != ?
           AND (relevant IS NULL OR relevant = 1)
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(scope.value, since, params.excludeMessageId ?? '', params.limit) as {
      author_name: string;
      text: string;
      created_at: string;
    }[];

    // Oldest first, which is how a conversation reads.
    return rows
      .map((r) => ({ authorName: r.author_name, text: r.text, createdAt: r.created_at }))
      .reverse();
  }

  // ------------------------------------------------------------ V2: agent runs

  /** One row per bounded agent call. Holds timings and outcomes, never reasoning. */
  recordAgentRun(run: {
    traceId: string;
    messageId?: string;
    batchId?: string;
    agentName: string;
    provider: string;
    model: string;
    durationMs: number;
    resultType: 'ok' | 'schema_invalid' | 'provider_error' | 'timeout' | 'skipped';
    ok: boolean;
    detail?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO agent_runs
           (id, trace_id, message_id, batch_id, agent_name, provider, model, duration_ms,
            result_type, ok, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        run.traceId,
        run.messageId ?? null,
        run.batchId ?? null,
        run.agentName,
        run.provider,
        run.model,
        Math.round(run.durationMs),
        run.resultType,
        run.ok ? 1 : 0,
        // Truncated: a failure reason is useful, a full provider dump is not.
        run.detail ? run.detail.slice(0, 500) : null,
        new Date().toISOString(),
      );
  }

  getAgentRuns(traceId: string): AgentRunRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM agent_runs WHERE trace_id = ? ORDER BY created_at, rowid`)
      .all(traceId) as {
      agent_name: string;
      provider: string;
      model: string;
      duration_ms: number;
      result_type: AgentRunRecord['resultType'];
      ok: number;
      detail: string | null;
      created_at: string;
    }[];

    return rows.map((r) => ({
      agentName: r.agent_name,
      provider: r.provider,
      model: r.model,
      durationMs: r.duration_ms,
      resultType: r.result_type,
      ok: r.ok === 1,
      ...(r.detail ? { detail: r.detail } : {}),
      createdAt: r.created_at,
    }));
  }

  // --------------------------------------------------------- V2: clarifications

  saveClarification(clarification: ClarificationRecord): void {
    this.db
      .prepare(
        `INSERT INTO clarifications
           (id, conversation_id, thread_id, message_id, author_id, author_name, issue_key,
            original_message, question, options_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        clarification.id,
        clarification.conversationId,
        clarification.threadId ?? null,
        clarification.messageId,
        clarification.authorId,
        clarification.authorName,
        clarification.issueKey,
        clarification.originalMessage,
        clarification.question,
        JSON.stringify(clarification.options),
        clarification.createdAt,
      );
  }

  getClarification(id: string): ClarificationRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM clarifications WHERE id = ?`).get(id) as
      | {
          id: string;
          conversation_id: string;
          thread_id: string | null;
          message_id: string;
          author_id: string;
          author_name: string;
          issue_key: string;
          original_message: string;
          question: string;
          options_json: string;
          answer: string | null;
          answered_by: string | null;
          resolved_batch_id: string | null;
          status: ClarificationRecord['status'];
          created_at: string;
        }
      | undefined;
    if (!row) return undefined;

    return {
      id: row.id,
      conversationId: row.conversation_id,
      ...(row.thread_id ? { threadId: row.thread_id } : {}),
      messageId: row.message_id,
      authorId: row.author_id,
      authorName: row.author_name,
      issueKey: row.issue_key,
      originalMessage: row.original_message,
      question: row.question,
      options: parseJsonColumn<ClarificationOption[]>(row.options_json) ?? [],
      ...(row.answer ? { answer: row.answer } : {}),
      ...(row.answered_by ? { answeredBy: row.answered_by } : {}),
      ...(row.resolved_batch_id ? { resolvedBatchId: row.resolved_batch_id } : {}),
      status: row.status,
      createdAt: row.created_at,
    };
  }

  /**
   * Atomically claims a pending clarification, exactly as claimForExecution()
   * claims a batch. A double-click on a clarification card must not produce two
   * proposal batches for the same message.
   */
  answerClarification(id: string, answer: string, answeredBy: string): boolean {
    const info = this.db
      .prepare(
        `UPDATE clarifications SET answer = ?, answered_by = ?, answered_at = ?,
           status = 'answered'
         WHERE id = ? AND status = 'pending'`,
      )
      .run(answer, answeredBy, new Date().toISOString(), id);
    return info.changes === 1;
  }

  linkClarificationBatch(id: string, batchId: string): void {
    this.db
      .prepare(`UPDATE clarifications SET resolved_batch_id = ? WHERE id = ?`)
      .run(batchId, id);
  }

  setClarificationCardActivityId(id: string, activityId: string): void {
    this.db
      .prepare(`UPDATE clarifications SET card_activity_id = ? WHERE id = ?`)
      .run(activityId, id);
  }

  // --------------------------------------------------------------- V2: blockers

  /**
   * Upserts a blocker observation for an issue and reports whether it is new.
   *
   * `isNew` is what stops StandSync nagging: a blocker mentioned in three
   * standups is one open blocker seen three times, and only the first sighting
   * (or a change of description) warrants drawing attention to it.
   */
  observeBlocker(observation: {
    conversationId: string;
    issueKey: string;
    category?: string;
    description?: string;
    dependency?: string;
    severity?: string;
  }): { isNew: boolean; timesReported: number; changed: boolean } {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare(
        `SELECT id, description, times_reported FROM blockers
         WHERE conversation_id = ? AND issue_key = ? AND resolved_at IS NULL`,
      )
      .get(observation.conversationId, observation.issueKey) as
      { id: string; description: string | null; times_reported: number } | undefined;

    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO blockers
             (id, conversation_id, issue_key, category, description, dependency, severity,
              times_reported, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          randomUUID(),
          observation.conversationId,
          observation.issueKey,
          observation.category ?? null,
          observation.description ?? null,
          observation.dependency ?? null,
          observation.severity ?? null,
          now,
          now,
        );
      return { isNew: true, timesReported: 1, changed: true };
    }

    const changed = (observation.description ?? null) !== existing.description;
    const timesReported = existing.times_reported + 1;

    this.db
      .prepare(
        `UPDATE blockers
           SET times_reported = ?, last_seen_at = ?,
               category = COALESCE(?, category),
               description = COALESCE(?, description),
               dependency = COALESCE(?, dependency),
               severity = COALESCE(?, severity)
         WHERE id = ?`,
      )
      .run(
        timesReported,
        now,
        observation.category ?? null,
        observation.description ?? null,
        observation.dependency ?? null,
        observation.severity ?? null,
        existing.id,
      );

    return { isNew: false, timesReported, changed };
  }

  /** Closes an open blocker, e.g. when the author says the work is unblocked. */
  resolveBlocker(conversationId: string, issueKey: string): boolean {
    const info = this.db
      .prepare(
        `UPDATE blockers SET resolved_at = ?
         WHERE conversation_id = ? AND issue_key = ? AND resolved_at IS NULL`,
      )
      .run(new Date().toISOString(), conversationId, issueKey);
    return info.changes > 0;
  }

  getOpenBlockers(conversationId: string): BlockerRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM blockers WHERE conversation_id = ? AND resolved_at IS NULL
         ORDER BY first_seen_at`,
      )
      .all(conversationId) as {
      issue_key: string;
      category: string | null;
      description: string | null;
      dependency: string | null;
      severity: string | null;
      times_reported: number;
      first_seen_at: string;
      last_seen_at: string;
    }[];

    return rows.map((r) => ({
      issueKey: r.issue_key,
      ...(r.category ? { category: r.category } : {}),
      ...(r.description ? { description: r.description } : {}),
      ...(r.dependency ? { dependency: r.dependency } : {}),
      ...(r.severity ? { severity: r.severity } : {}),
      timesReported: r.times_reported,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
    }));
  }

  // -------------------------------------------------------------- V2: summaries

  /**
   * Interpreted activity for the summary agent: what StandSync actually proposed
   * or applied recently, per issue. Read from our own records rather than from
   * Jira history, so the summary describes the team's standups.
   */
  recentActivity(conversationId: string, sinceIso: string): ActivityRecord[] {
    const rows = this.db
      .prepare(
        `SELECT p.issue_key, p.actions_json, p.explanation, b.author_name, b.status, b.created_at
         FROM proposals p JOIN batches b ON b.id = p.batch_id
         WHERE b.conversation_id = ? AND b.created_at >= ?
         ORDER BY b.created_at`,
      )
      .all(conversationId, sinceIso) as {
      issue_key: string;
      actions_json: string;
      explanation: string;
      author_name: string;
      status: BatchStatus;
      created_at: string;
    }[];

    return rows.map((r) => ({
      issueKey: r.issue_key,
      actions: JSON.parse(r.actions_json) as ProposalAction[],
      explanation: r.explanation,
      authorName: r.author_name,
      batchStatus: r.status,
      createdAt: r.created_at,
    }));
  }

  // ---------------------------------------------------------- V2: channel config

  /** Records an observed channel, so an operator can see what the bot can hear. */
  rememberChannel(config: {
    conversationId: string;
    teamId?: string;
    channelName?: string;
    ambientEnabled: boolean;
  }): void {
    this.db
      .prepare(
        `INSERT INTO channel_config
           (conversation_id, team_id, channel_name, ambient_enabled, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET
           team_id = COALESCE(excluded.team_id, team_id),
           channel_name = COALESCE(excluded.channel_name, channel_name),
           ambient_enabled = excluded.ambient_enabled`,
      )
      .run(
        config.conversationId,
        config.teamId ?? null,
        config.channelName ?? null,
        config.ambientEnabled ? 1 : 0,
        new Date().toISOString(),
      );
  }

  close(): void {
    this.db.close();
  }
}

export interface AgentRunRecord {
  agentName: string;
  provider: string;
  model: string;
  durationMs: number;
  resultType: 'ok' | 'schema_invalid' | 'provider_error' | 'timeout' | 'skipped';
  ok: boolean;
  detail?: string;
  createdAt: string;
}

/**
 * One selectable answer on a clarification card.
 *
 * `targetStatus` exists because the six-intent vocabulary cannot express every
 * destination a real workflow offers. "Move to Code Review" is a perfectly good
 * answer to "is it done?", but no intent maps to it — `completed` means the
 * configured Done status and `in_progress` means the configured In Progress
 * status. When the developer names a destination, StandSync honours that name
 * literally and resolves it against the live transition list, rather than
 * round-tripping it through an intent that would lose the distinction.
 *
 * `intent` remains the fallback for answers that name no status ("Not finished
 * yet", "Leave it as it is").
 */
export interface ClarificationOption {
  id: string;
  label: string;
  /** The intent this answer resolves to, fed back into the normal pipeline. */
  intent: Intent;
  /** A live Jira status this answer explicitly selects, when it names one. */
  targetStatus?: string;
}

export interface ClarificationRecord {
  id: string;
  conversationId: string;
  threadId?: string;
  messageId: string;
  authorId: string;
  authorName: string;
  issueKey: string;
  originalMessage: string;
  question: string;
  options: ClarificationOption[];
  answer?: string;
  answeredBy?: string;
  resolvedBatchId?: string;
  status: 'pending' | 'answered' | 'abandoned';
  createdAt: string;
}

export interface BlockerRecord {
  issueKey: string;
  category?: string;
  description?: string;
  dependency?: string;
  severity?: string;
  timesReported: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ActivityRecord {
  issueKey: string;
  actions: ProposalAction[];
  explanation: string;
  authorName: string;
  batchStatus: BatchStatus;
  createdAt: string;
}
