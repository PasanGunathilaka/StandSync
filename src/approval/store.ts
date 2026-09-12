import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import type {
  BatchStatus,
  ExecutionResult,
  Proposal,
  ProposalAction,
  ProposalBatch,
} from '../types.js';

/**
 * Audit store. Every batch, every proposal and every execution result is written
 * here so "what did StandSync change, and who approved it?" is answerable later.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS batches (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL,
  message_id       TEXT NOT NULL,
  author_id        TEXT NOT NULL,
  author_name      TEXT NOT NULL,
  raw_message      TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN
                     ('pending','approved','rejected','executed','failed','partial')),
  created_at       TEXT NOT NULL,
  decided_at       TEXT,
  decided_by       TEXT,
  card_activity_id TEXT
);

CREATE TABLE IF NOT EXISTS proposals (
  id           TEXT PRIMARY KEY,
  batch_id     TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  issue_key    TEXT NOT NULL,
  actions_json TEXT NOT NULL,
  confidence   REAL NOT NULL,
  explanation  TEXT NOT NULL,
  selected     INTEGER NOT NULL DEFAULT 1,
  position     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS results (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id     TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  proposal_id  TEXT NOT NULL,
  issue_key    TEXT NOT NULL,
  ok           INTEGER NOT NULL,
  applied_json TEXT NOT NULL,
  error        TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_proposals_batch ON proposals(batch_id);
CREATE INDEX IF NOT EXISTS idx_results_batch   ON results(batch_id);
CREATE INDEX IF NOT EXISTS idx_batches_created ON batches(created_at);
`;

export function openDatabase(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
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
          status, created_at, card_activity_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertProposal = this.db.prepare(
      `INSERT INTO proposals
         (id, batch_id, issue_key, actions_json, confidence, explanation, selected, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
        );
      });
    })();
  }

  getBatch(batchId: string): ProposalBatch | undefined {
    const row = this.db.prepare(`SELECT * FROM batches WHERE id = ?`).get(batchId) as
      BatchRow | undefined;
    if (!row) return undefined;

    const proposalRows = this.db
      .prepare(`SELECT * FROM proposals WHERE batch_id = ? ORDER BY position`)
      .all(batchId) as ProposalRow[];

    const proposals: Proposal[] = proposalRows.map((p) => ({
      id: p.id,
      key: p.issue_key,
      actions: JSON.parse(p.actions_json) as ProposalAction[],
      confidence: p.confidence,
      explanation: p.explanation,
      selected: p.selected === 1,
    }));

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

  close(): void {
    this.db.close();
  }
}
