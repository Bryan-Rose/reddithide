import type { AttributeResult, AttributeValue } from '../../shared/types';

export function formatValue(v: AttributeValue | number | undefined): string {
  if (v === undefined) return '';
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

export function formatAgo(ts: number | undefined, now = Date.now()): string {
  if (!ts) return '';
  const s = Math.round((now - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function formatNumber(n: number | undefined): string {
  if (n === undefined) return '';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

/** Effective value for display: override wins. */
export function effective(
  attr: string,
  values: Record<string, AttributeResult> | undefined,
  overrides: Record<string, AttributeValue> | undefined,
): { value: AttributeValue; confidence: number; overridden: boolean } | undefined {
  const o = overrides?.[attr];
  if (o !== undefined) return { value: o, confidence: 1, overridden: true };
  const v = values?.[attr];
  return v ? { value: v.value, confidence: v.confidence, overridden: false } : undefined;
}
