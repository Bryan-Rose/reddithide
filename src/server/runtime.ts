// Runtime status shown in the popup: errors and rate-limit backoff.
import { defaultRuntimeStatus, RUNTIME_KEY } from '../shared/settings';
import type { RuntimeError, RuntimeErrorKind, RuntimeStatus } from '../shared/types';
import { getKv, setKv } from './db';

export function getRuntime(): RuntimeStatus {
  return { ...defaultRuntimeStatus(), ...getKv<RuntimeStatus>(RUNTIME_KEY) };
}

/** Adds an error, replacing an earlier one of the same kind and profile. */
export function reportError(kind: RuntimeErrorKind, message: string, profileId?: string): void {
  const rt = getRuntime();
  rt.errors = rt.errors.filter((e) => !(e.kind === kind && e.profileId === profileId));
  const err: RuntimeError = { kind, message, profileId, at: Date.now() };
  rt.errors.push(err);
  rt.errors = rt.errors.slice(-10);
  setKv(RUNTIME_KEY, rt);
}

export function clearErrors(kinds?: RuntimeErrorKind[]): void {
  const rt = getRuntime();
  rt.errors = kinds ? rt.errors.filter((e) => !kinds.includes(e.kind)) : [];
  setKv(RUNTIME_KEY, rt);
}

export function setBackoff(profileId: string, until: number): void {
  const rt = getRuntime();
  rt.backoffUntil[profileId] = until;
  setKv(RUNTIME_KEY, rt);
}

export function backoffUntil(profileId: string): number {
  return getRuntime().backoffUntil[profileId] ?? 0;
}
