import {
  DEFAULT_ATTRIBUTES,
  DEFAULT_BEHAVIOR,
  DEFAULT_ENRICHMENT,
  DEFAULT_FILTER_LIST,
  DEFAULT_QUEUE,
  DEFAULT_TOPICS,
} from './constants';
import type { RuntimeStatus, Settings } from './types';

export const SETTINGS_KEYS = [
  'attributes',
  'topics',
  'profiles',
  'defaultProfileId',
  'fallbackProfileId',
  'filterLists',
  'activeFilterListId',
  'manualBlock',
  'manualAllow',
  'behavior',
  'enrichment',
  'queue',
] as const satisfies readonly (keyof Settings)[];

/** Non-settings keys kept in storage.local. */
export const BLOCKSET_KEY = 'blockSet';
export const RUNTIME_KEY = 'runtimeStatus';

export function defaultSettings(): Settings {
  return {
    attributes: structuredClone(DEFAULT_ATTRIBUTES),
    topics: [...DEFAULT_TOPICS],
    profiles: [],
    filterLists: [structuredClone(DEFAULT_FILTER_LIST)],
    activeFilterListId: DEFAULT_FILTER_LIST.id,
    manualBlock: [],
    manualAllow: [],
    behavior: { ...DEFAULT_BEHAVIOR },
    enrichment: { ...DEFAULT_ENRICHMENT },
    queue: { ...DEFAULT_QUEUE },
  };
}

/** Fills missing keys with defaults; nested objects get missing fields filled too. */
export function withDefaults(stored: Partial<Settings>): Settings {
  const d = defaultSettings();
  const s: Settings = { ...d, ...stripUndefined(stored) };
  s.behavior = { ...d.behavior, ...stored.behavior };
  s.enrichment = { ...d.enrichment, ...stored.enrichment };
  s.queue = { ...d.queue, ...stored.queue };
  if (!s.filterLists.length) s.filterLists = d.filterLists;
  if (!s.filterLists.some((f) => f.id === s.activeFilterListId)) s.activeFilterListId = s.filterLists[0]!.id;
  return s;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function isSettingsKey(k: string): k is (typeof SETTINGS_KEYS)[number] {
  return (SETTINGS_KEYS as readonly string[]).includes(k);
}

export function defaultRuntimeStatus(): RuntimeStatus {
  return { errors: [], backoffUntil: {}, redditPermission: true };
}
