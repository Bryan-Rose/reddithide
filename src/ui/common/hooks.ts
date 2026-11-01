import { useCallback, useEffect, useState } from 'preact/hooks';
import type { Settings } from '../../shared/types';
import { loadSettings, onSettingsChanged, saveSettings } from './backend';

/** Live settings: reloads whenever the backend reports a change. */
export function useSettings(): [Settings | null, (patch: Partial<Settings>) => Promise<void>] {
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    let alive = true;
    const reload = () => void loadSettings().then((s) => alive && setSettings(s));
    reload();
    const unsubscribe = onSettingsChanged(reload);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);
  const save = useCallback((patch: Partial<Settings>) => saveSettings(patch), []);
  return [settings, save];
}

/** Calls `fn` now and every `ms` while mounted, skipping hidden tabs, and again when the tab reappears. */
export function usePoll(fn: () => void, ms: number, deps: unknown[] = []): void {
  useEffect(() => {
    const tick = () => {
      if (!document.hidden) fn();
    };
    tick();
    const id = setInterval(tick, ms);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, deps);
}
