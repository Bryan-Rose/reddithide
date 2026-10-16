// Pure rule evaluator (SPEC §8). No browser APIs; thoroughly unit-tested.
import { DEFAULT_MIN_CONFIDENCE } from '../shared/constants';
import type {
  AttributeValue,
  Condition,
  RuleGroup,
  SubredditRecord,
} from '../shared/types';

export interface ResolvedValue {
  value: AttributeValue | number;
  confidence: number;
}

/** The fields of a record the evaluator reads. Lets callers pass slim rows. */
export type Evaluable = Pick<SubredditRecord, 'overrides' | 'classification' | 'meta'>;

export function isGroup(node: RuleGroup | Condition): node is RuleGroup {
  return (node as RuleGroup).children !== undefined;
}

/** Overrides first (confidence 1), then the classification, then pseudo-attributes. */
export function resolveValue(rec: Evaluable, attribute: string): ResolvedValue | undefined {
  const o = rec.overrides?.[attribute];
  if (o !== undefined) return { value: o, confidence: 1 };
  const c = rec.classification?.values[attribute];
  if (c !== undefined) return { value: c.value, confidence: c.confidence };
  if (attribute === 'subscribers') {
    const n = rec.meta?.subscribers ?? rec.meta?.weeklyActiveUsers;
    return n === undefined ? undefined : { value: n, confidence: 1 };
  }
  if (attribute === 'over18_flag') {
    const f = rec.meta?.over18;
    return f === undefined ? undefined : { value: f, confidence: 1 };
  }
  return undefined;
}

function asList(v: AttributeValue | number): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).toLowerCase());
  return [String(v).toLowerCase()];
}

function scalarEq(a: AttributeValue | number, b: AttributeValue | number): boolean {
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    const toBool = (x: AttributeValue | number) => (typeof x === 'boolean' ? x : String(x).toLowerCase() === 'true');
    return toBool(a) === toBool(b);
  }
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return String(a).toLowerCase() === String(b).toLowerCase();
}

/**
 * Returns the matched value(s) as a human-readable fragment when the condition holds, else null.
 * A missing value or one below minConfidence makes the condition false.
 */
export function evaluateCondition(rec: Evaluable, cond: Condition): string | null {
  const resolved = resolveValue(rec, cond.attribute);
  if (!resolved) return null;
  if (resolved.confidence < (cond.minConfidence ?? DEFAULT_MIN_CONFIDENCE)) return null;
  const actual = resolved.value;
  const expected = cond.value;

  switch (cond.operator) {
    case 'is':
    case 'is_not': {
      const hit = Array.isArray(actual)
        ? asList(actual).includes(String(expected).toLowerCase())
        : scalarEq(actual, expected);
      const holds = cond.operator === 'is' ? hit : !hit;
      if (!holds) return null;
      if (typeof actual === 'boolean') return actual ? cond.attribute : `not ${cond.attribute}`;
      return `${cond.attribute}: ${Array.isArray(actual) ? actual.join(', ') : String(actual)}`;
    }
    case 'in':
    case 'contains_any': {
      const wanted = new Set(asList(expected));
      const matched = asList(actual).filter((v) => wanted.has(v));
      return matched.length ? `${cond.attribute}: ${matched.join(', ')}` : null;
    }
    case 'not_in': {
      const banned = new Set(asList(expected));
      const values = asList(actual);
      if (!values.length || values.some((v) => banned.has(v))) return null;
      return `${cond.attribute}: ${values.join(', ')}`;
    }
    case 'gte':
    case 'lte': {
      if (typeof actual === 'boolean' || Array.isArray(actual)) return null;
      const a = Number(actual);
      const b = Number(expected);
      if (actual === '' || !Number.isFinite(a) || !Number.isFinite(b)) return null;
      const holds = cond.operator === 'gte' ? a >= b : a <= b;
      return holds ? `${cond.attribute} ${cond.operator === 'gte' ? '≥' : '≤'} ${b}` : null;
    }
  }
}

export interface EvalResult {
  match: boolean;
  reasons: string[];
}

/** Empty groups never match, so a new empty list hides nothing. */
export function evaluateGroup(rec: Evaluable, group: RuleGroup): EvalResult {
  if (!group.children.length) return { match: false, reasons: [] };
  const reasons: string[] = [];
  if (group.op === 'any') {
    let any = false;
    for (const child of group.children) {
      const r = evaluateNode(rec, child);
      if (r.match) {
        any = true;
        reasons.push(...r.reasons);
      }
    }
    return { match: any, reasons: any ? dedupe(reasons) : [] };
  }
  for (const child of group.children) {
    const r = evaluateNode(rec, child);
    if (!r.match) return { match: false, reasons: [] };
    reasons.push(...r.reasons);
  }
  return { match: true, reasons: dedupe(reasons) };
}

function evaluateNode(rec: Evaluable, node: RuleGroup | Condition): EvalResult {
  if (isGroup(node)) return evaluateGroup(rec, node);
  const r = evaluateCondition(rec, node);
  return r === null ? { match: false, reasons: [] } : { match: true, reasons: [r] };
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

export interface EffectiveBlockSet {
  names: string[];
  reasons: Record<string, string>;
}

/** (rule matches ∪ manualBlock) − manualAllow. */
export function computeBlockSet(
  records: (Evaluable & { name: string })[],
  rule: RuleGroup,
  manualBlock: string[],
  manualAllow: string[],
): EffectiveBlockSet {
  const allow = new Set(manualAllow);
  const reasons: Record<string, string> = {};
  for (const rec of records) {
    if (allow.has(rec.name)) continue;
    const r = evaluateGroup(rec, rule);
    if (r.match) reasons[rec.name] = r.reasons.join(', ');
  }
  for (const name of manualBlock) {
    if (allow.has(name)) continue;
    reasons[name] = reasons[name] ? `manual, ${reasons[name]}` : 'manual';
  }
  return { names: Object.keys(reasons).sort(), reasons };
}
