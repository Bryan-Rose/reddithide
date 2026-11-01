// The server's version of backend.ts: same exports, over fetch instead of the extension APIs.
import type { ServerRpcMethod, ServerRpcMethods, SettingsPatch } from '../../shared/messages';
import type { ProviderProfile, Settings } from '../../shared/types';

/** Methods that change settings, which nothing else tells this page about. */
const SETTINGS_WRITES: ServerRpcMethod[] = ['saveSettings', 'setManual', 'setPaused', 'resetAll'];
const settingsEvents = new EventTarget();

export async function rpc<M extends ServerRpcMethod>(
  method: M,
  ...args: ServerRpcMethods[M]['params'] extends void ? [] : [ServerRpcMethods[M]['params']]
): Promise<ServerRpcMethods[M]['result']> {
  const res = await fetch(`/api/rpc/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args[0]),
  });
  // Reloading shows the login page.
  if (res.status === 401) location.reload();
  const body = (await res.json()) as { ok: boolean; result: ServerRpcMethods[M]['result']; error?: string };
  if (!body.ok) throw new Error(body.error);
  if (SETTINGS_WRITES.includes(method)) settingsEvents.dispatchEvent(new Event('change'));
  return body.result;
}

export const loadSettings = (): Promise<Settings> => rpc('getSettings');

/** JSON drops `undefined`, which the pages use to remove a setting, so it's sent as `null`. */
export function toSettingsPatch(patch: Partial<Settings>): SettingsPatch {
  return Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v ?? null]));
}

export const saveSettings = (patch: Partial<Settings>): Promise<void> =>
  rpc('saveSettings', toSettingsPatch(patch));

/** Other devices can change settings too, so this also reloads when the page comes back into view. */
export function onSettingsChanged(reload: () => void): () => void {
  const onVisible = () => {
    if (!document.hidden) reload();
  };
  settingsEvents.addEventListener('change', reload);
  addEventListener('focus', onVisible);
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    settingsEvents.removeEventListener('change', reload);
    removeEventListener('focus', onVisible);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

/** The server has no CORS limits, so provider hosts need no permission. */
export const requestOrigin = (_profile: ProviderProfile): Promise<boolean> => Promise.resolve(true);

export const resetEverything = (): Promise<void> => rpc('resetAll');
