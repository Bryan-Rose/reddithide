// Runtime status shown in the popup: errors, rate-limit backoff, reddit permission.
import browser from '../shared/browser';
import { defaultRuntimeStatus, loadRuntimeStatus, RUNTIME_KEY } from '../shared/settings';
import type { RuntimeError, RuntimeErrorKind, RuntimeStatus } from '../shared/types';

let cache: RuntimeStatus | null = null;

export async function getRuntime(): Promise<RuntimeStatus> {
  cache ??= await loadRuntimeStatus();
  return cache;
}

async function save(): Promise<void> {
  await browser.storage.local.set({ [RUNTIME_KEY]: cache ?? defaultRuntimeStatus() });
  await updateErrorBadge();
}

/** Adds an error, replacing an earlier one of the same kind and profile. */
export async function reportError(
  kind: RuntimeErrorKind,
  message: string,
  profileId?: string,
): Promise<void> {
  const rt = await getRuntime();
  rt.errors = rt.errors.filter((e) => !(e.kind === kind && e.profileId === profileId));
  const err: RuntimeError = { kind, message, profileId, at: Date.now() };
  rt.errors.push(err);
  rt.errors = rt.errors.slice(-10);
  await save();
}

export async function clearErrors(kinds?: RuntimeErrorKind[]): Promise<void> {
  const rt = await getRuntime();
  rt.errors = kinds ? rt.errors.filter((e) => !kinds.includes(e.kind)) : [];
  await save();
}

export async function setBackoff(profileId: string, until: number): Promise<void> {
  const rt = await getRuntime();
  rt.backoffUntil[profileId] = until;
  await save();
}

export async function backoffUntil(profileId: string): Promise<number> {
  return (await getRuntime()).backoffUntil[profileId] ?? 0;
}

export async function setRedditPermission(granted: boolean): Promise<void> {
  const rt = await getRuntime();
  if (rt.redditPermission === granted) return;
  rt.redditPermission = granted;
  await save();
}

async function updateErrorBadge(): Promise<void> {
  const rt = cache;
  const serious = rt?.errors.some((e) => e.kind === 'auth' || e.kind === 'reddit_permission');
  await browser.action.setBadgeBackgroundColor({ color: serious ? '#d93a00' : '#555' });
  await browser.action.setBadgeText({ text: serious ? '!' : '' });
}
