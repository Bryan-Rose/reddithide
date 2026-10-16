// Connector interface (SPEC §6.3) and the shared HTTP/error plumbing both connectors use.
import { isLocalUrl } from '../shared/constants';
import type { ProviderProfile } from '../shared/types';

export interface ClassifyRequest {
  system: string;
  user: string;
  schema: object;
  schemaName: string;
  /** Set on the single validation retry (§6.6). */
  retry?: { previousOutput: string; feedback: string };
}

export interface ClassifyResponse {
  json: unknown;
  rawText: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  refused: boolean;
  refusalText?: string;
}

export interface Connector {
  classify(profile: ProviderProfile, req: ClassifyRequest, signal: AbortSignal): Promise<ClassifyResponse>;
  listModels(profile: ProviderProfile): Promise<string[]>;
}

export type ProviderErrorKind = 'auth' | 'rate_limit' | 'server' | 'network' | 'timeout' | 'bad_request' | 'other';

export class ProviderError extends Error {
  constructor(
    public readonly kind: ProviderErrorKind,
    message: string,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export const OLLAMA_CORS_HINT =
  'Local servers reject browser-extension origins by default. For Ollama, start it with OLLAMA_ORIGINS="moz-extension://*" (e.g. `OLLAMA_ORIGINS="moz-extension://*" ollama serve`, or set it in the systemd unit).';

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** Parses Retry-After (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/** Removes anything that looks like an API key from text before it is shown or stored. */
export function scrubSecrets(text: string, profile: ProviderProfile): string {
  let t = text;
  if (profile.apiKey) t = t.split(profile.apiKey).join('••••');
  return t.replace(/\b(sk-[A-Za-z0-9_-]{8,})/g, '••••');
}

/**
 * fetch with timeout, mapping failures to ProviderError. `signal` aborts from outside (e.g. shutdown).
 */
export async function providerFetch(
  profile: ProviderProfile,
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  const timeout = AbortSignal.timeout(profile.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: combined, credentials: 'omit' });
  } catch (e) {
    if (timeout.aborted) throw new ProviderError('timeout', `Request timed out after ${profile.timeoutMs} ms`);
    if (signal?.aborted) throw new ProviderError('other', 'Request cancelled');
    const local = isLocalUrl(profile.baseUrl);
    throw new ProviderError(
      'network',
      `Network error contacting ${new URL(url).host}: ${e instanceof Error ? e.message : String(e)}`,
      undefined,
      undefined,
      local ? OLLAMA_CORS_HINT : undefined,
    );
  }
  if (res.ok) return res;

  const body = scrubSecrets((await res.text().catch(() => '')).slice(0, 2000), profile);
  const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
  const summary = `HTTP ${res.status} from ${profile.name}: ${body.slice(0, 300) || res.statusText}`;
  if (res.status === 401 || res.status === 403) {
    // Ollama answers 403 for disallowed Origins, which is a CORS setting, not a bad key.
    const hint = isLocalUrl(profile.baseUrl) ? OLLAMA_CORS_HINT : undefined;
    throw new ProviderError('auth', summary, res.status, undefined, hint);
  }
  if (res.status === 429) throw new ProviderError('rate_limit', summary, 429, retryAfterMs);
  if (res.status >= 500) throw new ProviderError('server', summary, res.status, retryAfterMs);
  const hint = /response_format|json_schema/i.test(body)
    ? 'This provider rejected the structured-output request. Try "json_object" or "prompt_only" for this profile.'
    : undefined;
  throw new ProviderError('bad_request', summary, res.status, undefined, hint);
}

/** Removes code fences and, if needed, takes the outermost {...} substring (SPEC §6.5). */
export function parseJsonLenient(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    // fall through
  }
  const unfenced = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    // fall through
  }
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(unfenced.slice(start, end + 1));
    } catch {
      // fall through
    }
  }
  return undefined;
}
