// Background event page: message routing, alarms, startup checks.
import browser, { type Runtime } from '../shared/browser';
import type { ContentToBackground, RpcRequest } from '../shared/messages';
import { errorMessage } from '../shared/util';
import { publishBlockSet, scheduleBlockSet } from './blockset';
import { ingestMeta, ingestSeen } from './ingest';
import { maintenance, pump, setOnClassified } from './pipeline';
import { handleRpc, REDDIT_ORIGINS } from './router';
import { reportError, clearErrors, setRedditPermission } from './runtime';
import { onSettingsChanged } from './state';

declare const __DEBUG_BRIDGE__: boolean;

const PUMP_ALARM = 'pump';

/** RPC comes from our own pages; content scripts on reddit.com never need it. */
function isTrustedSender(sender: Runtime.MessageSender): boolean {
  if (sender.id !== browser.runtime.id) return false;
  if (sender.url?.startsWith(browser.runtime.getURL(''))) return true;
  return __DEBUG_BRIDGE__ && !!sender.tab;
}
const MAINTENANCE_KEY = 'lastMaintenanceAt';
const DAY = 24 * 3600 * 1000;

setOnClassified(() => scheduleBlockSet());

let pumpTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePump(delayMs = 2000): void {
  if (pumpTimer) return;
  pumpTimer = setTimeout(() => {
    pumpTimer = null;
    pump();
  }, delayMs);
}

browser.runtime.onMessage.addListener((raw: unknown, sender: Runtime.MessageSender) => {
  const msg = raw as ContentToBackground | RpcRequest;
  switch (msg?.type) {
    case 'rpc':
      if (!isTrustedSender(sender)) return Promise.resolve({ ok: false, error: 'RPC is only available to extension pages' });
      return handleRpc(msg.method, msg.params).then(
        (result) => ({ ok: true, result }),
        (e: unknown) => ({ ok: false, error: errorMessage(e) }),
      );
    case 'seen':
      return ingestSeen(msg).then((changed) => {
        if (changed) schedulePump();
      });
    case 'subredditMeta':
      return ingestMeta(msg).then(() => schedulePump());
    case 'pageStats': {
      const tabId = sender.tab?.id;
      if (tabId === undefined) return undefined;
      return browser.action.setBadgeText({ tabId, text: msg.hidden ? String(msg.hidden) : '' }).catch(() => {});
    }
    default:
      return undefined;
  }
});

onSettingsChanged((keys) => {
  const affectsBlockSet = ['filterLists', 'activeFilterListId', 'manualBlock', 'manualAllow', 'behavior'];
  if (keys.some((k) => affectsBlockSet.includes(k))) scheduleBlockSet(0);
  if (keys.includes('queue') || keys.includes('profiles') || keys.includes('defaultProfileId')) {
    if (keys.includes('profiles')) void clearErrors(['no_profile']);
    pump();
  }
});

browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== PUMP_ALARM) return;
  pump();
  const stored = await browser.storage.local.get(MAINTENANCE_KEY);
  const last = (stored[MAINTENANCE_KEY] as number | undefined) ?? 0;
  if (Date.now() - last > DAY) {
    await browser.storage.local.set({ [MAINTENANCE_KEY]: Date.now() });
    await maintenance();
  }
});

async function checkRedditPermission(): Promise<void> {
  const granted = await browser.permissions.contains({ origins: REDDIT_ORIGINS });
  await setRedditPermission(granted);
  if (granted) await clearErrors(['reddit_permission']);
  else await reportError('reddit_permission', 'RedditHide needs access to reddit.com. Click "Grant access" in the popup.');
}

browser.permissions.onAdded.addListener(() => void checkRedditPermission());
browser.permissions.onRemoved.addListener(() => void checkRedditPermission());

async function start(): Promise<void> {
  const existing = await browser.alarms.get(PUMP_ALARM);
  if (!existing) await browser.alarms.create(PUMP_ALARM, { periodInMinutes: 1 });
  await checkRedditPermission();
  await publishBlockSet();
  pump();
}

browser.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') void browser.runtime.openOptionsPage().catch(() => {});
});

void start().catch((e) => console.error('[RedditHide] startup failed', e));
