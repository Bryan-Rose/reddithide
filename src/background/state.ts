// In-memory settings cache for the background, refreshed on storage changes.
import { computeRubricVersion } from '../classify/rubric';
import browser from '../shared/browser';
import { isSettingsKey } from '../shared/settings';
import { loadSettings } from '../shared/settingsStore';
import type { Settings } from '../shared/types';

let settings: Settings | null = null;
let rubric: string | null = null;
const listeners: ((changed: string[]) => void)[] = [];

export async function getSettings(): Promise<Settings> {
  settings ??= await loadSettings();
  return settings;
}

export async function getRubricVersion(): Promise<string> {
  if (!rubric) {
    const s = await getSettings();
    rubric = await computeRubricVersion(s.attributes, s.topics);
  }
  return rubric;
}

export function onSettingsChanged(fn: (changed: string[]) => void): void {
  listeners.push(fn);
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const keys = Object.keys(changes).filter(isSettingsKey);
  if (!keys.length) return;
  settings = null;
  if (keys.includes('attributes') || keys.includes('topics')) rubric = null;
  for (const fn of listeners) fn(keys);
});
