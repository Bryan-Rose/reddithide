import { describe, expect, it } from 'vitest';
import { computeBlockSet, evaluateCondition, evaluateGroup, resolveValue } from '../src/filters/evaluate';
import type {
  AttributeResult,
  AttributeValue,
  Condition,
  RuleGroup,
  SubredditRecord,
} from '../src/shared/types';

type Rec = Pick<SubredditRecord, 'name' | 'overrides' | 'classification' | 'meta'>;

function rec(name: string, values: Record<string, [AttributeValue, number?]>, extra: Partial<Rec> = {}): Rec {
  const v: Record<string, AttributeResult> = {};
  for (const [k, [value, confidence]] of Object.entries(values))
    v[k] = { value, confidence: confidence ?? 0.9, reason: '' };
  return {
    name,
    classification: {
      classifiedAt: 0,
      profileId: 'p',
      providerKind: 'anthropic',
      model: 'm',
      rubricVersion: 'r',
      values: v,
      summary: '',
    },
    ...extra,
  };
}

const cond = (
  attribute: string,
  operator: Condition['operator'],
  value: Condition['value'],
  minConfidence?: number,
): Condition => ({
  attribute,
  operator,
  value,
  minConfidence,
});

describe('resolveValue', () => {
  it('prefers overrides with confidence 1', () => {
    const r = rec('a', { gross: [false, 0.9] }, { overrides: { gross: true } });
    expect(resolveValue(r, 'gross')).toEqual({ value: true, confidence: 1 });
  });
  it('falls back to classification, then pseudo attributes', () => {
    const r = rec(
      'a',
      { gross: [true, 0.7] },
      { meta: { fetchedAt: 0, source: 'dom', status: 'ok', over18: true, subscribers: 500 } },
    );
    expect(resolveValue(r, 'gross')).toEqual({ value: true, confidence: 0.7 });
    expect(resolveValue(r, 'over18_flag')).toEqual({ value: true, confidence: 1 });
    expect(resolveValue(r, 'subscribers')).toEqual({ value: 500, confidence: 1 });
  });
  it('uses weekly visitors when subscribers are unknown', () => {
    const r = rec('a', {}, { meta: { fetchedAt: 0, source: 'dom', status: 'ok', weeklyActiveUsers: 42 } });
    expect(resolveValue(r, 'subscribers')?.value).toBe(42);
  });
  it('returns undefined when unknown', () => {
    expect(resolveValue(rec('a', {}), 'gross')).toBeUndefined();
    expect(resolveValue({ name: 'x' } as Rec, 'gross')).toBeUndefined();
  });
});

describe('evaluateCondition', () => {
  const r = rec('a', {
    gross: [true],
    nsfw_sexual: [false],
    language: ['de', 0.95],
    topic: [['gaming', 'memes']],
  });

  it('boolean is', () => {
    expect(evaluateCondition(r, cond('gross', 'is', true))).toBe('gross');
    expect(evaluateCondition(r, cond('gross', 'is', false))).toBeNull();
    expect(evaluateCondition(r, cond('nsfw_sexual', 'is', false))).toBe('not nsfw_sexual');
  });
  it('enum is / is_not', () => {
    expect(evaluateCondition(r, cond('language', 'is', 'de'))).toBe('language: de');
    expect(evaluateCondition(r, cond('language', 'is', 'DE'))).toBe('language: de');
    expect(evaluateCondition(r, cond('language', 'is_not', 'en'))).toBe('language: de');
    expect(evaluateCondition(r, cond('language', 'is_not', 'de'))).toBeNull();
  });
  it('in / not_in for scalars', () => {
    expect(evaluateCondition(r, cond('language', 'in', ['fr', 'de']))).toBe('language: de');
    expect(evaluateCondition(r, cond('language', 'not_in', ['en']))).toBe('language: de');
    expect(evaluateCondition(r, cond('language', 'not_in', ['de', 'en']))).toBeNull();
  });
  it('contains_any / not_in / is for arrays', () => {
    expect(evaluateCondition(r, cond('topic', 'contains_any', ['crypto', 'memes']))).toBe('topic: memes');
    expect(evaluateCondition(r, cond('topic', 'contains_any', ['crypto']))).toBeNull();
    expect(evaluateCondition(r, cond('topic', 'not_in', ['crypto']))).toBe('topic: gaming, memes');
    expect(evaluateCondition(r, cond('topic', 'not_in', ['gaming']))).toBeNull();
    expect(evaluateCondition(r, cond('topic', 'is', 'gaming'))).toBe('topic: gaming, memes');
    expect(evaluateCondition(r, cond('topic', 'is_not', 'gaming'))).toBeNull();
  });
  it('gte / lte on numbers', () => {
    const big = rec('b', {}, { meta: { fetchedAt: 0, source: 'dom', status: 'ok', subscribers: 1000 } });
    expect(evaluateCondition(big, cond('subscribers', 'gte', 1000))).toBe('subscribers ≥ 1000');
    expect(evaluateCondition(big, cond('subscribers', 'lte', 999))).toBeNull();
    expect(evaluateCondition(r, cond('gross', 'gte', 1))).toBeNull(); // missing / non-numeric
  });
  it('is false below minConfidence (default 0.6)', () => {
    const low = rec('c', { gross: [true, 0.5] });
    expect(evaluateCondition(low, cond('gross', 'is', true))).toBeNull();
    expect(evaluateCondition(low, cond('gross', 'is', true, 0.4))).toBe('gross');
    // A negative operator is also false when the value is uncertain.
    const lowLang = rec('d', { language: ['und', 0] });
    expect(evaluateCondition(lowLang, cond('language', 'not_in', ['en']))).toBeNull();
  });
  it('is false when the attribute is missing', () => {
    expect(evaluateCondition(r, cond('political', 'is', true))).toBeNull();
    expect(evaluateCondition(r, cond('political', 'is_not', true))).toBeNull();
  });
  it('boolean values given as strings still compare', () => {
    expect(evaluateCondition(r, cond('gross', 'is', 'true' as unknown as boolean))).toBe('gross');
  });
});

describe('evaluateGroup', () => {
  const r = rec('a', { gross: [true], language: ['en'], topic: [['crypto']] });
  const anyRule: RuleGroup = {
    op: 'any',
    children: [
      cond('language', 'not_in', ['en']),
      cond('gross', 'is', true),
      cond('topic', 'contains_any', ['crypto', 'sports']),
    ],
  };
  it('any collects reasons from all true children', () => {
    expect(evaluateGroup(r, anyRule)).toEqual({ match: true, reasons: ['gross', 'topic: crypto'] });
  });
  it('all needs every child', () => {
    expect(
      evaluateGroup(r, { op: 'all', children: [cond('gross', 'is', true), cond('language', 'is', 'en')] })
        .match,
    ).toBe(true);
    expect(
      evaluateGroup(r, { op: 'all', children: [cond('gross', 'is', true), cond('language', 'is', 'de')] }),
    ).toEqual({
      match: false,
      reasons: [],
    });
  });
  it('nests groups', () => {
    const nested: RuleGroup = {
      op: 'any',
      children: [
        { op: 'all', children: [cond('gross', 'is', true), cond('language', 'is', 'de')] },
        { op: 'all', children: [cond('topic', 'contains_any', ['crypto']), cond('language', 'is', 'en')] },
      ],
    };
    expect(evaluateGroup(r, nested)).toEqual({ match: true, reasons: ['topic: crypto', 'language: en'] });
  });
  it('empty groups never match', () => {
    expect(evaluateGroup(r, { op: 'any', children: [] }).match).toBe(false);
    expect(evaluateGroup(r, { op: 'all', children: [] }).match).toBe(false);
  });
  it('unclassified records match nothing', () => {
    expect(evaluateGroup({ name: 'x' } as Rec, anyRule).match).toBe(false);
  });
});

describe('computeBlockSet', () => {
  const records = [
    rec('gross1', { gross: [true] }),
    rec('nice', { gross: [false] }),
    rec('allowedgross', { gross: [true] }),
  ];
  const rule: RuleGroup = { op: 'any', children: [cond('gross', 'is', true)] };
  it('(matches ∪ manualBlock) − manualAllow', () => {
    const bs = computeBlockSet(records, rule, ['manualone', 'gross1'], ['allowedgross', 'manualone']);
    expect(bs.names).toEqual(['gross1']);
    expect(bs.reasons.gross1).toBe('manual, gross');
  });
  it('manual block works for unknown subreddits', () => {
    expect(computeBlockSet([], rule, ['zzz'], []).reasons).toEqual({ zzz: 'manual' });
  });
});
