// Settings in SQLite. Listeners run right after a save, replacing storage.onChanged.
import { computeRubricVersion } from '../classify/rubric';
import type { SettingsPatch } from '../shared/messages';
import { SETTINGS_KEYS, withDefaults } from '../shared/settings';
import type { Settings } from '../shared/types';
import { deleteKv, getKv, setKv, tx } from './db';

const listeners: ((changed: string[]) => void)[] = [];

export function getSettings(): Settings {
  return withDefaults(Object.fromEntries(SETTINGS_KEYS.map((k) => [k, getKv(k)])) as Partial<Settings>);
}

export function saveSettings(patch: SettingsPatch): void {
  const entries = Object.entries(patch);
  tx(() => {
    for (const [k, v] of entries) {
      if (v === null || v === undefined) deleteKv(k);
      else setKv(k, v);
    }
  });
  for (const fn of listeners) fn(entries.map(([k]) => k));
}

export function onSettingsChanged(fn: (changed: string[]) => void): void {
  listeners.push(fn);
}

export function getRubricVersion(): Promise<string> {
  const s = getSettings();
  return computeRubricVersion(s.attributes, s.topics);
}
