import { useCallback, useEffect, useState } from 'preact/hooks';
import browser from '../../shared/browser';
import { isSettingsKey } from '../../shared/settings';
import { loadSettings, saveSettings } from '../../shared/settingsStore';
import type { Settings } from '../../shared/types';

/** Live settings: reloads whenever storage.local changes. */
export function useSettings(): [Settings | null, (patch: Partial<Settings>) => Promise<void>] {
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    let alive = true;
    const reload = () => void loadSettings().then((s) => alive && setSettings(s));
    reload();
    const listener = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && Object.keys(changes).some(isSettingsKey)) reload();
    };
    browser.storage.onChanged.addListener(listener);
    return () => {
      alive = false;
      browser.storage.onChanged.removeListener(listener);
    };
  }, []);
  const save = useCallback((patch: Partial<Settings>) => saveSettings(patch), []);
  return [settings, save];
}

/** Calls `fn` now and every `ms` while mounted. */
export function usePoll(fn: () => void, ms: number, deps: unknown[] = []): void {
  useEffect(() => {
    fn();
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  }, deps);
}
