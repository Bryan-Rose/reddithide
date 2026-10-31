// SQLite access. One connection, and only the server touches it (SPEC §4). Every function is
// synchronous, so nothing can run between BEGIN and COMMIT; never pass `tx` an async function.
import { DatabaseSync } from 'node:sqlite';
import type { PipelineState, SubredditRecord, UsageRow } from '../shared/types';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS subreddits (
    name TEXT PRIMARY KEY,
    pipeline_state TEXT NOT NULL,
    pending_at INTEGER,
    record TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS subreddits_state ON subreddits (pipeline_state);
  CREATE INDEX IF NOT EXISTS subreddits_pending ON subreddits (pending_at);
  CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    profile_id TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    ok INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

type Update = SubredditRecord | null | undefined;

let conn: DatabaseSync | null = null;

/** Opens the database, creating tables as needed. Use ':memory:' in tests. */
export function openDb(path: string): void {
  conn?.close();
  conn = new DatabaseSync(path);
  conn.exec(SCHEMA);
}

function db(): DatabaseSync {
  if (!conn) throw new Error('Database is not open');
  return conn;
}

export function tx<T extends object | number | boolean | void>(fn: () => T): T {
  db().exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db().exec('COMMIT');
    return result;
  } catch (e) {
    db().exec('ROLLBACK');
    throw e;
  }
}

/** Throws if the database can't answer (GET /healthz). */
export function pingDb(): void {
  db().prepare('SELECT 1').get();
}

function parseRecord(row: unknown): SubredditRecord {
  return JSON.parse((row as { record: string }).record) as SubredditRecord;
}

export function getRecord(name: string): SubredditRecord | undefined {
  const row = db().prepare('SELECT record FROM subreddits WHERE name = ?').get(name);
  return row && parseRecord(row);
}

export function getAllRecords(): SubredditRecord[] {
  return db().prepare('SELECT record FROM subreddits').all().map(parseRecord);
}

export function getByState(state: PipelineState): SubredditRecord[] {
  return db().prepare('SELECT record FROM subreddits WHERE pipeline_state = ?').all(state).map(parseRecord);
}

/** Applies `fn` to one record; null deletes it and undefined leaves it unchanged. */
function apply(name: string, fn: (rec: SubredditRecord | undefined) => Update): Update {
  const next = fn(getRecord(name));
  if (next === null) {
    db().prepare('DELETE FROM subreddits WHERE name = ?').run(name);
  } else if (next !== undefined) {
    db()
      .prepare(
        'INSERT OR REPLACE INTO subreddits (name, pipeline_state, pending_at, record) VALUES (?, ?, ?, ?)',
      )
      .run(next.name, next.pipelineState, next.pendingAt ?? null, JSON.stringify(next));
  }
  return next;
}

/** Read-modify-write in one transaction. Return null to delete, or undefined to leave it unchanged. */
export function updateRecord(
  name: string,
  fn: (rec: SubredditRecord | undefined) => Update,
): SubredditRecord | undefined {
  return tx(() => ({ next: apply(name, fn) })).next ?? undefined;
}

/** Applies `fn` to many records in one transaction. */
export function updateMany(
  names: string[],
  fn: (rec: SubredditRecord | undefined, name: string) => Update,
): void {
  tx(() => {
    for (const name of names) apply(name, (rec) => fn(rec, name));
  });
}

export function deleteRecords(names: string[]): void {
  updateMany(names, () => null);
}

export function addUsage(row: UsageRow): void {
  db()
    .prepare(
      'INSERT INTO usage (at, profile_id, model, input_tokens, output_tokens, ok) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(row.at, row.profileId, row.model, row.inputTokens, row.outputTokens, row.ok ? 1 : 0);
}

export function getAllUsage(): UsageRow[] {
  const rows = db()
    .prepare(
      `SELECT id, at, profile_id AS profileId, model, input_tokens AS inputTokens,
         output_tokens AS outputTokens, ok FROM usage`,
    )
    .all() as unknown as (Omit<UsageRow, 'ok'> & { ok: number })[];
  return rows.map((r) => ({ ...r, ok: r.ok === 1 }));
}

export function clearAll(): void {
  tx(() => {
    db().exec('DELETE FROM subreddits; DELETE FROM usage;');
  });
}

// ---- Key-value table: settings, runtime status, block set ----

export function getKv<T>(key: string): T | undefined {
  const row = db().prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row && (JSON.parse(row.value) as T);
}

export function setKv(key: string, value: unknown): void {
  db().prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
}

export function deleteKv(...keys: string[]): void {
  for (const key of keys) db().prepare('DELETE FROM kv WHERE key = ?').run(key);
}

export function clearKv(): void {
  db().exec('DELETE FROM kv');
}
