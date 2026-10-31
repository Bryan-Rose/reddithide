// Effective block set for the active filter list (SPEC §8), stored for GET /api/blockset.
import { computeBlockSet } from '../filters/evaluate';
import { BLOCKSET_KEY } from '../shared/settings';
import type { BlockSet, Settings, SubredditRecord } from '../shared/types';
import { getAllRecords, getKv, setKv } from './db';
import { getSettings, onSettingsChanged } from './settings';

const AFFECTS_BLOCK_SET = ['filterLists', 'activeFilterListId', 'manualBlock', 'manualAllow', 'behavior'];

let timer: ReturnType<typeof setTimeout> | null = null;

export function scheduleBlockSet(delayMs = 300): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    try {
      publishBlockSet();
    } catch (e) {
      console.error('[RedditHide] block set failed', e);
    }
  }, delayMs);
}

onSettingsChanged((keys) => {
  if (keys.some((k) => AFFECTS_BLOCK_SET.includes(k))) scheduleBlockSet(0);
});

export function buildBlockSet(records: SubredditRecord[], settings: Settings, now = Date.now()): BlockSet {
  const list =
    settings.filterLists.find((f) => f.id === settings.activeFilterListId) ?? settings.filterLists[0]!;
  const { names, reasons } = computeBlockSet(records, list.rule, settings.manualBlock, settings.manualAllow);
  const bs: BlockSet = { type: 'blockSet', names, reasons, behavior: settings.behavior, updatedAt: now };
  if (settings.behavior.hideUnclassified) {
    const blocked = new Set(names);
    const ok = new Set(settings.manualAllow);
    for (const r of records) if ((r.classification || r.overrides) && !blocked.has(r.name)) ok.add(r.name);
    bs.okNames = [...ok].sort();
  }
  return bs;
}

function sameContent(a: BlockSet | undefined, b: BlockSet): a is BlockSet {
  if (!a) return false;
  return JSON.stringify({ ...a, updatedAt: 0 }) === JSON.stringify({ ...b, updatedAt: 0 });
}

/** `updatedAt` changes only with the content, or when `fresh` is set on server start (SPEC §8). */
export function publishBlockSet(fresh = false): BlockSet {
  const previous = getKv<BlockSet>(BLOCKSET_KEY);
  const bs = buildBlockSet(getAllRecords(), getSettings());
  if (!fresh && sameContent(previous, bs)) return previous;
  // The ETag is updatedAt, so two changes in one millisecond must still differ.
  bs.updatedAt = Math.max(bs.updatedAt, (previous?.updatedAt ?? 0) + 1);
  setKv(BLOCKSET_KEY, bs);
  return bs;
}

export function getBlockSet(): BlockSet {
  return getKv<BlockSet>(BLOCKSET_KEY) ?? publishBlockSet();
}
