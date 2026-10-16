// IndexedDB access. Only the background script touches the database (SPEC §2).
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { DB_NAME, DB_VERSION } from '../shared/constants';
import type { PipelineState, SubredditRecord, UsageRow } from '../shared/types';

interface Schema extends DBSchema {
  subreddits: {
    key: string;
    value: SubredditRecord;
    indexes: { lastSeenAt: number; pipelineState: PipelineState; seenCount: number; pendingAt: number };
  };
  usage: {
    key: number;
    value: UsageRow;
    indexes: { at: number };
  };
}

let dbPromise: Promise<IDBPDatabase<Schema>> | null = null;

export function db(): Promise<IDBPDatabase<Schema>> {
  dbPromise ??= openDB<Schema>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      const subs = database.createObjectStore('subreddits', { keyPath: 'name' });
      subs.createIndex('lastSeenAt', 'lastSeenAt');
      subs.createIndex('pipelineState', 'pipelineState');
      subs.createIndex('seenCount', 'seenCount');
      // Sparse: only records with a queued reclassification have pendingAt.
      subs.createIndex('pendingAt', 'pendingAt');
      const usage = database.createObjectStore('usage', { keyPath: 'id', autoIncrement: true });
      usage.createIndex('at', 'at');
    },
  });
  return dbPromise;
}

/** For tests: drop the cached connection. */
export function resetDbForTests(): void {
  dbPromise = null;
}

export async function getRecord(name: string): Promise<SubredditRecord | undefined> {
  return (await db()).get('subreddits', name);
}

export async function getAllRecords(): Promise<SubredditRecord[]> {
  return (await db()).getAll('subreddits');
}

export async function getByState(state: PipelineState): Promise<SubredditRecord[]> {
  return (await db()).getAllFromIndex('subreddits', 'pipelineState', state);
}

export async function getPending(): Promise<SubredditRecord[]> {
  return (await db()).getAllFromIndex('subreddits', 'pendingAt');
}

export async function putRecord(rec: SubredditRecord): Promise<void> {
  await (await db()).put('subreddits', rec);
}

/**
 * Read-modify-write in one transaction so concurrent updates (new sightings while an LLM call is
 * in flight) don't overwrite each other. `fn` must be synchronous; return null to delete, or
 * undefined to leave the record unchanged.
 */
export async function updateRecord(
  name: string,
  fn: (rec: SubredditRecord | undefined) => SubredditRecord | null | undefined,
): Promise<SubredditRecord | undefined> {
  const tx = (await db()).transaction('subreddits', 'readwrite');
  const current = await tx.store.get(name);
  const next = fn(current);
  if (next === null) await tx.store.delete(name);
  else if (next !== undefined) await tx.store.put(next);
  await tx.done;
  return next ?? undefined;
}

/** Applies `fn` to many records in one transaction. */
export async function updateMany(
  names: string[],
  fn: (rec: SubredditRecord | undefined, name: string) => SubredditRecord | null | undefined,
): Promise<void> {
  const tx = (await db()).transaction('subreddits', 'readwrite');
  await Promise.all(
    names.map(async (name) => {
      const next = fn(await tx.store.get(name), name);
      if (next === null) await tx.store.delete(name);
      else if (next !== undefined) await tx.store.put(next);
    }),
  );
  await tx.done;
}

export async function deleteRecords(names: string[]): Promise<void> {
  await updateMany(names, () => null);
}

export async function addUsage(row: UsageRow): Promise<void> {
  await (await db()).add('usage', row);
}

export async function getAllUsage(): Promise<UsageRow[]> {
  return (await db()).getAll('usage');
}

export async function clearAll(): Promise<void> {
  const d = await db();
  const tx = d.transaction(['subreddits', 'usage'], 'readwrite');
  await Promise.all([tx.objectStore('subreddits').clear(), tx.objectStore('usage').clear(), tx.done]);
}
