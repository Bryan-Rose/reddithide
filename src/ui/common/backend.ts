// What the options and review pages need from wherever they run. build.mjs swaps in backend.server.ts
// for the pages the server serves. #23 deletes this file and the swap.
import browser from '../../shared/browser';
import { rpc } from '../../shared/rpc';
import { isSettingsKey } from '../../shared/settings';
import { originPattern } from '../../shared/util';
import type { ProviderProfile } from '../../shared/types';

export { rpc };
export { loadSettings, saveSettings } from '../../shared/settingsStore';

export function onSettingsChanged(reload: () => void): () => void {
  const listener = (changes: Record<string, unknown>, area: string) => {
    if (area === 'local' && Object.keys(changes).some(isSettingsKey)) reload();
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

/** Starts a permission request for the profile's origin. Call synchronously from a click handler. */
export function requestOrigin(profile: ProviderProfile): Promise<boolean> {
  const pattern = originPattern(profile.baseUrl);
  if (!pattern) return Promise.resolve(false);
  return browser.permissions.request({ origins: [pattern] });
}

export async function resetEverything(): Promise<void> {
  await rpc('clearAllData');
  await browser.storage.local.clear();
}
