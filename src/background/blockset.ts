// Effective block set for the active filter list (SPEC §8), published to content scripts via
// storage.local (they read it at document_start and listen for changes).
import { computeBlockSet } from '../filters/evaluate';
import browser from '../shared/browser';
import { BLOCKSET_KEY } from '../shared/settings';
import { loadBlockSet } from '../shared/settingsStore';
import type { BlockSet, SubredditRecord } from '../shared/types';
import { getAllRecords } from './db';
import { getSettings } from './state';

let timer: ReturnType<typeof setTimeout> | null = null;

export function scheduleBlockSet(delayMs = 300): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void publishBlockSet().catch((e) => console.error('[RedditHide] block set failed', e));
  }, delayMs);
}

export function buildBlockSet(
  records: SubredditRecord[],
  settings: Awaited<ReturnType<typeof getSettings>>,
  now = Date.now(),
): BlockSet {
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

function sameContent(a: BlockSet | undefined, b: BlockSet): boolean {
  if (!a) return false;
  return JSON.stringify({ ...a, updatedAt: 0 }) === JSON.stringify({ ...b, updatedAt: 0 });
}

export async function publishBlockSet(): Promise<BlockSet> {
  const [records, settings, previous] = await Promise.all([getAllRecords(), getSettings(), loadBlockSet()]);
  const bs = buildBlockSet(records, settings);
  if (!sameContent(previous, bs)) await browser.storage.local.set({ [BLOCKSET_KEY]: bs });
  return bs;
}
