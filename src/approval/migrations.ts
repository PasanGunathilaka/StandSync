import type { Database as DB } from 'better-sqlite3';

/**
 * Versioned SQLite migrations.
 *
 * V1 shipped by exec'ing one `CREATE TABLE IF NOT EXISTS` blob on every open.
 * That is fine for creating tables and useless for changing them, so V2
 * introduces a real migration ledger. Migration 1 is the V1 schema verbatim, so
 * an existing `data/standsync.db` is recognised rather than rebuilt: every
 * statement in it is `IF NOT EXISTS`, and applying it to a live V1 database is a
 * no-op that simply records the version.
 *
 * Rules for adding a migration:
 * - Append; never edit a released one.
 * - Each runs inside a transaction, so a failure leaves the version untouched.
 * - Use addColumnIfMissing() rather than bare ALTER TABLE, so a database that
 *   was half-migrated by an interrupted run can still move forward.
 */

export interface Migration {
  version: number;
  name: string;
  up: (db: DB) => void;
}

/** The V1 schema, unchanged. */
const V1_SCHEMA = `
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

/**
 * The V2 observation tables.
 *
 * `message_events` is the deduplication ledger and the bounded thread-context
 * source. It stores the message text because interpreting a clarification reply
 * needs the message it replies to — but only for observed conversations, and
 * only messages the classifier judged relevant enough to keep.
 *
 * No table here holds credentials, tokens or model reasoning traces.
 */
const V2_SCHEMA = `
CREATE TABLE IF NOT EXISTS message_events (
  id               TEXT PRIMARY KEY,          -- Teams activity id
  conversation_id  TEXT NOT NULL,
  thread_id        TEXT,                      -- replyToId, when in a thread
  author_id        TEXT NOT NULL,
  author_name      TEXT NOT NULL,
  content_hash     TEXT NOT NULL,             -- sha256 of the cleaned text
  text             TEXT NOT NULL,
  classification   TEXT,                      -- MessageKind, once classified
  relevant         INTEGER,                   -- 1/0/NULL (not yet classified)
  processed_state  TEXT NOT NULL CHECK (processed_state IN
                     ('received','ignored','processed','failed')),
  batch_id         TEXT,                      -- set when it produced a batch
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id            TEXT PRIMARY KEY,
  trace_id      TEXT NOT NULL,                -- correlates one message's stages
  message_id    TEXT,
  batch_id      TEXT,
  agent_name    TEXT NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  duration_ms   INTEGER NOT NULL,
  result_type   TEXT NOT NULL CHECK (result_type IN
                  ('ok','schema_invalid','provider_error','timeout','skipped')),
  ok            INTEGER NOT NULL,
  detail        TEXT,                         -- short reason on failure only
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clarifications (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL,
  thread_id         TEXT,
  message_id        TEXT NOT NULL,
  author_id         TEXT NOT NULL,
  author_name       TEXT NOT NULL,
  issue_key         TEXT NOT NULL,
  original_message  TEXT NOT NULL,
  question          TEXT NOT NULL,
  options_json      TEXT NOT NULL,            -- the offered choices
  answer            TEXT,                     -- the chosen option id
  answered_by       TEXT,
  answered_at       TEXT,
  resolved_batch_id TEXT,                     -- batch the answer produced
  card_activity_id  TEXT,
  status            TEXT NOT NULL CHECK (status IN ('pending','answered','abandoned')),
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS blockers (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL,
  issue_key        TEXT NOT NULL,
  category         TEXT,
  description      TEXT,
  dependency       TEXT,
  severity         TEXT,
  times_reported   INTEGER NOT NULL DEFAULT 1,
  first_seen_at    TEXT NOT NULL,
  last_seen_at     TEXT NOT NULL,
  resolved_at      TEXT
);

CREATE TABLE IF NOT EXISTS channel_config (
  conversation_id  TEXT PRIMARY KEY,
  team_id          TEXT,
  channel_name     TEXT,
  ambient_enabled  INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_conversation
  ON message_events(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_thread   ON message_events(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_hash     ON message_events(conversation_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_agent_runs_trace ON agent_runs(trace_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_batch ON agent_runs(batch_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_blockers_open
  ON blockers(conversation_id, issue_key) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_clarifications_status
  ON clarifications(status, created_at);
`;

/** ALTER TABLE ADD COLUMN, skipped when the column is already there. */
export function addColumnIfMissing(
  db: DB,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'v1-batches-proposals-results',
    up: (db) => db.exec(V1_SCHEMA),
  },
  {
    version: 2,
    name: 'v2-agentic-observations',
    up: (db) => {
      db.exec(V2_SCHEMA);
      // V2 audit metadata on existing rows. Nullable: a V1 batch has none.
      addColumnIfMissing(db, 'batches', 'origin_json', 'TEXT');
      addColumnIfMissing(db, 'proposals', 'review_json', 'TEXT');
    },
  },
];

const LEDGER = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`;

/** The highest migration version applied to this database. */
export function currentVersion(db: DB): number {
  db.exec(LEDGER);
  const row = db.prepare(`SELECT MAX(version) AS v FROM schema_migrations`).get() as {
    v: number | null;
  };
  return row.v ?? 0;
}

/**
 * Applies every migration newer than the recorded version, in order, each in its
 * own transaction. Returns the versions applied, so a caller can log them.
 */
export function migrate(db: DB, migrations: readonly Migration[] = MIGRATIONS): number[] {
  const from = currentVersion(db);
  const record = db.prepare(
    `INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`,
  );
  const applied: number[] = [];

  for (const migration of migrations) {
    if (migration.version <= from) continue;
    db.transaction(() => {
      migration.up(db);
      record.run(migration.version, migration.name, new Date().toISOString());
    })();
    applied.push(migration.version);
  }

  return applied;
}
