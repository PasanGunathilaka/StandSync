import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ApprovalStore, openDatabase, hashContent } from '../src/approval/store.js';
import {
  MIGRATIONS,
  currentVersion,
  migrate,
  addColumnIfMissing,
} from '../src/approval/migrations.js';

/**
 * Migrations exist so a live V1 database is upgraded in place rather than
 * rebuilt. The tests that matter are the ones proving V1 data survives and V1
 * approval semantics keep working afterwards.
 */

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'standsync-mig-'));
  tempDirs.push(dir);
  return join(dir, 'standsync.db');
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** The exact V1 schema, with no migration ledger — a database from before V2. */
const V1_SCHEMA_WITH_DATA = `
CREATE TABLE batches (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL,
  author_id TEXT NOT NULL, author_name TEXT NOT NULL, raw_message TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN
    ('pending','approved','rejected','executed','failed','partial')),
  created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT, card_activity_id TEXT);
CREATE TABLE proposals (
  id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  issue_key TEXT NOT NULL, actions_json TEXT NOT NULL, confidence REAL NOT NULL,
  explanation TEXT NOT NULL, selected INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL);
CREATE TABLE results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  proposal_id TEXT NOT NULL, issue_key TEXT NOT NULL, ok INTEGER NOT NULL,
  applied_json TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL);
INSERT INTO batches VALUES
  ('b1','conv-1','msg-1','u1','Pasan','Yesterday I completed TES-41.','pending',
   '2026-09-01T09:00:00.000Z',NULL,NULL,'activity-1');
INSERT INTO proposals VALUES
  ('p1','b1','TES-41',
   '[{"type":"transition","fromStatus":"In Progress","toStatus":"Done","transitionId":"31"}]',
   0.97,'In Progress → Done',1,0);
`;

function seedV1Database(path: string): void {
  const db = new Database(path);
  db.exec(V1_SCHEMA_WITH_DATA);
  db.close();
}

describe('migration ledger', () => {
  it('starts a fresh database at the latest version', () => {
    const path = tempDbPath();
    const db = openDatabase(path);
    expect(currentVersion(db)).toBe(MIGRATIONS.at(-1)?.version);
    db.close();
  });

  it('creates every V1 and V2 table', () => {
    const db = openDatabase(tempDbPath());
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]
    ).map((r) => r.name);

    for (const table of [
      'batches',
      'proposals',
      'results',
      'message_events',
      'agent_runs',
      'clarifications',
      'blockers',
      'channel_config',
      'schema_migrations',
    ]) {
      expect(tables).toContain(table);
    }
    db.close();
  });

  it('is idempotent — re-opening applies nothing new', () => {
    const path = tempDbPath();
    openDatabase(path).close();

    const db = new Database(path);
    expect(migrate(db)).toEqual([]);
    expect(currentVersion(db)).toBe(MIGRATIONS.at(-1)?.version);
    db.close();
  });

  it('records each applied migration once', () => {
    const db = openDatabase(tempDbPath());
    const rows = db.prepare(`SELECT version, name FROM schema_migrations ORDER BY version`).all();
    expect(rows).toHaveLength(MIGRATIONS.length);
    db.close();
  });

  it('versions are unique and ascending, so an appended migration cannot be skipped', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
  });
});

describe('upgrading a live V1 database', () => {
  it('preserves existing batches and proposals', () => {
    const path = tempDbPath();
    seedV1Database(path);

    const store = ApprovalStore.open(path);
    const batch = store.getBatch('b1');

    expect(batch).toBeDefined();
    expect(batch?.authorName).toBe('Pasan');
    expect(batch?.rawMessage).toBe('Yesterday I completed TES-41.');
    expect(batch?.status).toBe('pending');
    expect(batch?.proposals).toHaveLength(1);
    expect(batch?.proposals[0]?.actions).toEqual([
      { type: 'transition', fromStatus: 'In Progress', toStatus: 'Done', transitionId: '31' },
    ]);
    store.close();
  });

  it('leaves V1 rows with no V2 metadata rather than inventing any', () => {
    const path = tempDbPath();
    seedV1Database(path);

    const store = ApprovalStore.open(path);
    const batch = store.getBatch('b1');

    expect(batch?.origin).toBeUndefined();
    expect(batch?.proposals[0]?.review).toBeUndefined();
    store.close();
  });

  it('keeps the card activity id, so an in-flight V1 card still updates', () => {
    const path = tempDbPath();
    seedV1Database(path);

    const store = ApprovalStore.open(path);
    expect(store.getCardActivityId('b1')).toBe('activity-1');
    store.close();
  });

  it('keeps atomic claim semantics after migrating', () => {
    const path = tempDbPath();
    seedV1Database(path);

    const store = ApprovalStore.open(path);
    expect(store.claimForExecution('b1', 'approver-1')).toBe(true);
    // The second claim must lose: this is the idempotency guard.
    expect(store.claimForExecution('b1', 'approver-2')).toBe(false);
    store.close();
  });

  it('adds the V2 columns to the existing tables', () => {
    const path = tempDbPath();
    seedV1Database(path);
    openDatabase(path).close();

    const db = new Database(path);
    const columnNames = (table: string): string[] =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

    expect(columnNames('batches')).toContain('origin_json');
    expect(columnNames('proposals')).toContain('review_json');
    db.close();
  });
});

describe('addColumnIfMissing', () => {
  it('adds a column once and tolerates a second call', () => {
    const path = tempDbPath();
    const db = openDatabase(path);

    addColumnIfMissing(db, 'batches', 'trial_column', 'TEXT');
    addColumnIfMissing(db, 'batches', 'trial_column', 'TEXT');

    const columns = (db.prepare(`PRAGMA table_info(batches)`).all() as { name: string }[]).filter(
      (c) => c.name === 'trial_column',
    );
    expect(columns).toHaveLength(1);
    db.close();
  });
});

describe('migration failure handling', () => {
  it('leaves the version untouched when a migration throws', () => {
    const path = tempDbPath();
    const db = openDatabase(path);
    const before = currentVersion(db);

    const broken = [
      ...MIGRATIONS,
      {
        version: 999,
        name: 'deliberately-broken',
        up: () => {
          throw new Error('boom');
        },
      },
    ];

    expect(() => migrate(db, broken)).toThrow('boom');
    // A partially applied migration must not be recorded as done.
    expect(currentVersion(db)).toBe(before);
    db.close();
  });
});

describe('hashContent', () => {
  it('is stable for the same text', () => {
    expect(hashContent('Finished TES-31')).toBe(hashContent('Finished TES-31'));
  });

  it('ignores surrounding whitespace and case', () => {
    expect(hashContent('  Finished TES-31  ')).toBe(hashContent('finished tes-31'));
  });

  it('differs for materially different text', () => {
    expect(hashContent('Finished TES-31')).not.toBe(hashContent('Finished TES-32'));
  });
});
