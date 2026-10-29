// Turns validated model output into final attribute values (SPEC §7.3–7.5).
import { LANGUAGE_MIN_PERCENTAGE, LANGUAGE_OPTIONS, NSFW_CONFIDENCE_ALONE } from '../shared/constants';
import type {
  AttributeDef,
  AttributeResult,
  DetectedLanguage,
  SampleItem,
  SubredditRecord,
} from '../shared/types';
import { llmAttributes, optionsFor, type RawClassification } from './schema';

export interface Normalized {
  summary: string;
  values: Record<string, AttributeResult>;
  languageGuess?: AttributeResult;
  /** Unknown values that were mapped to 'other' (logged, SPEC §7.5). */
  mappings: string[];
  /** Values that could not be mapped; treated like a validation failure. */
  problems: string[];
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5);
const norm = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
const shortReason = (s: string) => (s.length > 200 ? `${s.slice(0, 200)}…` : s);

export function normalizeClassification(
  raw: RawClassification,
  attrs: AttributeDef[],
  topics: string[],
): Normalized {
  const out: Normalized = {
    summary: raw.summary.trim().slice(0, 300),
    values: {},
    mappings: [],
    problems: [],
  };
  for (const attr of llmAttributes(attrs)) {
    const entry = raw.attributes[attr.id];
    if (!entry) {
      out.problems.push(`${attr.id}: missing`);
      continue;
    }
    const base = { confidence: clamp01(entry.confidence), reason: shortReason(entry.reason) };
    if (attr.type === 'boolean') {
      out.values[attr.id] = { value: entry.value === true, ...base };
      continue;
    }
    const options = optionsFor(attr, topics);
    const optionSet = new Set(options);
    const mapOne = (v: string): string | null => {
      const n = norm(v);
      if (optionSet.has(n)) return n;
      const exact = options.find((o) => o.toLowerCase() === v.trim().toLowerCase());
      if (exact) return exact;
      if (optionSet.has('other')) {
        out.mappings.push(`${attr.id}: "${v}" → other`);
        return 'other';
      }
      out.problems.push(`${attr.id}: "${v}" is not an allowed value`);
      return null;
    };
    if (attr.type === 'enum') {
      const v = Array.isArray(entry.value) ? entry.value[0] : String(entry.value);
      const mapped = v === undefined ? null : mapOne(v);
      if (mapped !== null) out.values[attr.id] = { value: mapped, ...base };
      continue;
    }
    const list = Array.isArray(entry.value) ? entry.value : [String(entry.value)];
    const mapped = [...new Set(list.map(mapOne).filter((v): v is string => v !== null))];
    // 'other' only makes sense on its own.
    const cleaned = mapped.length > 1 ? mapped.filter((v) => v !== 'other') : mapped;
    if (!cleaned.length) {
      out.problems.push(`${attr.id}: no allowed values`);
      continue;
    }
    out.values[attr.id] = { value: cleaned.slice(0, attr.maxSelections ?? 3), ...base };
  }
  if (raw.language_guess) {
    const code = String(raw.language_guess.value).trim().toLowerCase().slice(0, 5);
    out.languageGuess = {
      value: LANGUAGE_OPTIONS.includes(code) ? code : 'und',
      confidence: clamp01(raw.language_guess.confidence),
      reason: shortReason(raw.language_guess.reason),
    };
  }
  return out;
}

// ---- Language (§7.3) ----

export function languageIsSettled(d: DetectedLanguage | undefined): boolean {
  return !!d && d.reliable && d.percentage >= LANGUAGE_MIN_PERCENTAGE && d.code !== 'und';
}

export function resolveLanguage(
  detected: DetectedLanguage | undefined,
  guess: AttributeResult | undefined,
  redditLang: string | undefined,
): AttributeResult {
  if (detected && languageIsSettled(detected)) {
    const via =
      detected.source === 'browser.i18n' ? 'browser language detection' : "Reddit's post-language tags";
    return {
      value: detected.code,
      confidence: detected.percentage / 100,
      reason: `${via}: ${detected.percentage}%`,
    };
  }
  if (guess && guess.value !== 'und') return { ...guess, reason: `model guess: ${guess.reason}` };
  if (redditLang) {
    const code = redditLang.toLowerCase().slice(0, 2);
    if (LANGUAGE_OPTIONS.includes(code))
      return { value: code, confidence: 0.5, reason: "Reddit's subreddit lang field" };
  }
  return { value: 'und', confidence: 0, reason: 'not enough evidence' };
}

/**
 * Votes from Reddit's per-post `post-language` attribute. Settled when there are at least
 * 3 tagged posts and one language has ≥70% of them.
 */
export function languageFromPostTags(items: SampleItem[] | undefined): DetectedLanguage | undefined {
  const tagged = (items ?? []).filter((i) => i.lang);
  if (tagged.length < 3) return undefined;
  const counts = new Map<string, number>();
  for (const i of tagged) {
    const code = i.lang!.toLowerCase().slice(0, 2);
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const [code, n] = [...counts].sort((a, b) => b[1] - a[1])[0]!;
  const percentage = Math.round((n / tagged.length) * 100);
  return {
    code,
    percentage,
    reliable: percentage >= LANGUAGE_MIN_PERCENTAGE,
    source: 'reddit_post_language',
  };
}

// ---- NSFW combination (§7.4) ----

export function combineNsfw(llm: AttributeResult, over18: boolean | undefined): AttributeResult {
  const llmTrue = llm.value === true;
  const final = (over18 === true && llmTrue) || (llmTrue && llm.confidence >= NSFW_CONFIDENCE_ALONE);
  if (final === llmTrue) return { ...llm, rawValue: llm.value };
  return {
    value: false,
    confidence: llm.confidence,
    rawValue: llm.value,
    reason: `model said true at ${llm.confidence.toFixed(2)} without Reddit's over18 flag: ${llm.reason}`,
  };
}

/** Applies the language and NSFW rules to normalized values. */
export function finalizeValues(
  normalized: Normalized,
  rec: SubredditRecord,
  attrs: AttributeDef[],
): Record<string, AttributeResult> {
  const values = { ...normalized.values };
  const langAttr = attrs.find((a) => a.enabled && a.source === 'language_builtin');
  if (langAttr)
    values[langAttr.id] = resolveLanguage(rec.detectedLanguage, normalized.languageGuess, rec.meta?.lang);
  if (values.nsfw_sexual) values.nsfw_sexual = combineNsfw(values.nsfw_sexual, rec.meta?.over18);
  return values;
}
