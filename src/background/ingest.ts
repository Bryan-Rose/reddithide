// Handles discoveries from content scripts (SPEC §5.1).
import { MAX_SAMPLE_TITLES } from '../shared/constants';
import type { SeenMessage, SubredditMetaMessage } from '../shared/messages';
import { normalizeSubreddit } from '../shared/names';
import type { SampleItem, SubredditMeta, SubredditRecord } from '../shared/types';
import { updateMany, updateRecord } from './db';

export function newRecord(name: string, displayName: string, now: number): SubredditRecord {
  return {
    name,
    displayName,
    firstSeenAt: now,
    lastSeenAt: now,
    seenCount: 0,
    pipelineState: 'discovered',
    attempts: 0,
  };
}

function baseMeta(rec: SubredditRecord, now: number): SubredditMeta {
  return rec.meta ?? { fetchedAt: now, source: 'dom', status: 'ok' };
}

/** Merges new sample posts, newest first, deduped by post id, capped at 25. */
export function mergeSamples(rec: SubredditRecord, posts: SampleItem[], now: number): void {
  if (!posts.length) return;
  const existing = rec.samples?.items ?? [];
  const known = new Set(existing.map((i) => i.id));
  const fresh = posts.filter((p) => !known.has(p.id) && p.title);
  if (!fresh.length) return;
  const items = [...fresh, ...existing].slice(0, MAX_SAMPLE_TITLES);
  rec.samples = { fetchedAt: now, source: 'dom', items, titles: items.map((i) => i.title) };
}

/** Returns true if anything changed that the pipeline may care about. */
export async function ingestSeen(msg: SeenMessage, now = Date.now()): Promise<boolean> {
  const byName = new Map<string, SeenMessage['names'][number]>();
  for (const n of msg.names.slice(0, 200)) {
    const name = normalizeSubreddit(n.name);
    if (name) byName.set(name, n);
  }
  let changed = false;
  await updateMany([...byName.keys()], (existing, name) => {
    const s = byName.get(name)!;
    const rec = existing ?? newRecord(name, s.displayName, now);
    if (!existing) changed = true;
    if (s.sighting || !existing) {
      rec.seenCount += 1;
      rec.lastSeenAt = now;
    }
    if (s.displayName) rec.displayName = s.displayName;
    if (s.over18 !== undefined || s.quarantined !== undefined) {
      const meta = baseMeta(rec, now);
      if (s.over18 !== undefined) meta.over18 = s.over18;
      if (s.quarantined !== undefined) meta.quarantined = s.quarantined;
      rec.meta = meta;
    }
    const before = rec.samples?.items?.length ?? 0;
    mergeSamples(
      rec,
      (s.posts ?? []).map((p) => ({ id: p.id, title: p.title.slice(0, 300), lang: p.lang, seenAt: now })),
      now,
    );
    if ((rec.samples?.items?.length ?? 0) !== before) changed = true;
    return rec;
  });
  return changed;
}

export async function ingestMeta(msg: SubredditMetaMessage, now = Date.now()): Promise<void> {
  const name = normalizeSubreddit(msg.name);
  if (!name) return;
  await updateRecord(name, (existing) => {
    const rec = existing ?? { ...newRecord(name, msg.displayName, now), seenCount: 1 };
    const meta = baseMeta(rec, now);
    rec.meta = {
      ...meta,
      fetchedAt: now,
      title: msg.meta.title?.slice(0, 300) ?? meta.title,
      publicDescription: msg.meta.publicDescription?.slice(0, 1000) ?? meta.publicDescription,
      weeklyActiveUsers: msg.meta.weeklyActiveUsers ?? meta.weeklyActiveUsers,
    };
    return rec;
  });
}
