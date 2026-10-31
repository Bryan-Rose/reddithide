// Settings, block set and runtime status in browser.storage.local (extension side).
import browser from './browser';
import { BLOCKSET_KEY, defaultRuntimeStatus, RUNTIME_KEY, SETTINGS_KEYS, withDefaults } from './settings';
import type { BlockSet, RuntimeStatus, Settings } from './types';

export async function loadSettings(): Promise<Settings> {
  const stored = (await browser.storage.local.get([...SETTINGS_KEYS])) as Partial<Settings>;
  return withDefaults(stored);
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const toSet: Record<string, unknown> = {};
  const toRemove: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) toRemove.push(k);
    else toSet[k] = v;
  }
  if (Object.keys(toSet).length) await browser.storage.local.set(toSet);
  if (toRemove.length) await browser.storage.local.remove(toRemove);
}

export async function loadBlockSet(): Promise<BlockSet | undefined> {
  const r = await browser.storage.local.get(BLOCKSET_KEY);
  return r[BLOCKSET_KEY] as BlockSet | undefined;
}

export async function loadRuntimeStatus(): Promise<RuntimeStatus> {
  const r = await browser.storage.local.get(RUNTIME_KEY);
  return { ...defaultRuntimeStatus(), ...(r[RUNTIME_KEY] as RuntimeStatus | undefined) };
}
