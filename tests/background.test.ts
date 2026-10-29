import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/shared/browser', () => ({
  default: {
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(), remove: vi.fn() },
      onChanged: { addListener: vi.fn() },
    },
    i18n: { detectLanguage: vi.fn() },
    action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
  },
}));

const { clearAll, getRecord } = await import('../src/background/db');
const { ingestMeta, ingestSeen } = await import('../src/background/ingest');
const { samplesReady, priority } = await import('../src/background/pipeline');
const { buildBlockSet } = await import('../src/background/blockset');
const { Limiter } = await import('../src/background/limiter');
const { countStates } = await import('../src/background/router');
const { defaultSettings } = await import('../src/shared/settings');
import type { SubredditRecord } from '../src/shared/types';

beforeEach(async () => {
  await clearAll();
});

describe('ingestSeen', () => {
  it('creates records and counts sightings once per page view', async () => {
    await ingestSeen(
      { type: 'seen', url: '', names: [{ name: 'Cats', displayName: 'Cats', sighting: true }] },
      1000,
    );
    await ingestSeen(
      {
        type: 'seen',
        url: '',
        names: [{ name: 'cats', displayName: 'Cats', sighting: false, posts: [{ id: 't3_1', title: 'A' }] }],
      },
      2000,
    );
    await ingestSeen(
      { type: 'seen', url: '', names: [{ name: 'cats', displayName: 'Cats', sighting: true }] },
      3000,
    );
    const r = (await getRecord('cats'))!;
    expect(r.seenCount).toBe(2);
    expect(r.firstSeenAt).toBe(1000);
    expect(r.lastSeenAt).toBe(3000);
    expect(r.pipelineState).toBe('discovered');
    expect(r.samples?.titles).toEqual(['A']);
  });

  it('dedupes titles by post id, newest first, capped at 25', async () => {
    const posts = Array.from({ length: 30 }, (_, i) => ({ id: `t3_${i}`, title: `T${i}`, lang: 'en' }));
    await ingestSeen({
      type: 'seen',
      url: '',
      names: [{ name: 'x1', displayName: 'x1', sighting: true, posts: posts.slice(0, 10) }],
    });
    await ingestSeen({
      type: 'seen',
      url: '',
      names: [{ name: 'x1', displayName: 'x1', sighting: false, posts }],
    });
    const r = (await getRecord('x1'))!;
    expect(r.samples!.titles).toHaveLength(25);
    expect(r.samples!.titles[0]).toBe('T10');
    expect(new Set(r.samples!.items!.map((i) => i.id)).size).toBe(25);
  });

  it('ignores invalid and user-profile names', async () => {
    await ingestSeen({
      type: 'seen',
      url: '',
      names: [
        { name: 'u_someone', displayName: 'u_someone', sighting: true },
        { name: 'bad name!', displayName: 'x', sighting: true },
      ],
    });
    expect(await getRecord('u_someone')).toBeUndefined();
  });

  it('records the nsfw flag from search results', async () => {
    await ingestSeen({
      type: 'seen',
      url: '',
      names: [{ name: 'spicy', displayName: 'spicy', sighting: true, over18: true }],
    });
    expect((await getRecord('spicy'))!.meta).toMatchObject({ over18: true, source: 'dom' });
  });
});

describe('ingestMeta', () => {
  it('merges subreddit header metadata', async () => {
    await ingestMeta({
      type: 'subredditMeta',
      name: 'Python',
      displayName: 'Python',
      meta: { publicDescription: 'Snakes? No.', weeklyActiveUsers: 5 },
    });
    const r = (await getRecord('python'))!;
    expect(r.meta).toMatchObject({ publicDescription: 'Snakes? No.', weeklyActiveUsers: 5 });
    expect(r.seenCount).toBe(1);
  });
});

describe('samplesReady', () => {
  const s = defaultSettings();
  const base = { firstSeenAt: 0, samples: { titles: ['a'] } } as unknown as SubredditRecord;
  it('waits for enough titles', () => {
    expect(samplesReady(base, s, 1000)).toBe(false);
    expect(samplesReady({ ...base, samples: { titles: ['a', 'b', 'c'] } } as SubredditRecord, s, 1000)).toBe(
      true,
    );
  });
  it('or for the wait time with at least one title', () => {
    expect(samplesReady(base, s, 7 * 3600_000)).toBe(true);
    expect(samplesReady({ ...base, samples: undefined }, s, 7 * 3600_000)).toBe(false);
  });
  it('is immediate when the user asked or the description is known', () => {
    expect(samplesReady({ ...base, pendingReclassify: { requestedAt: 0 } }, s, 0)).toBe(true);
    expect(samplesReady({ ...base, meta: { publicDescription: 'x' } } as SubredditRecord, s, 0)).toBe(true);
  });
});

describe('priority', () => {
  it('orders by seenCount then lastSeenAt', () => {
    const a = { seenCount: 5, lastSeenAt: 1 } as SubredditRecord;
    const b = { seenCount: 5, lastSeenAt: 2 } as SubredditRecord;
    const c = { seenCount: 9, lastSeenAt: 0 } as SubredditRecord;
    expect([a, b, c].sort(priority)).toEqual([c, b, a]);
  });
});

describe('buildBlockSet', () => {
  const classified = (name: string, gross: boolean): SubredditRecord => ({
    name,
    displayName: name,
    firstSeenAt: 0,
    lastSeenAt: 0,
    seenCount: 1,
    pipelineState: 'classified',
    attempts: 0,
    classification: {
      classifiedAt: 0,
      profileId: 'p',
      providerKind: 'anthropic',
      model: 'm',
      rubricVersion: 'r',
      summary: '',
      values: { gross: { value: gross, confidence: 0.9, reason: '' } },
    },
  });
  it('uses the active list and adds okNames only with hideUnclassified', () => {
    const s = defaultSettings();
    s.filterLists[0]!.rule = { op: 'any', children: [{ attribute: 'gross', operator: 'is', value: true }] };
    const recs = [classified('ew', true), classified('fine', false)];
    const bs = buildBlockSet(recs, s, 5);
    expect(bs).toMatchObject({ type: 'blockSet', names: ['ew'], reasons: { ew: 'gross' }, updatedAt: 5 });
    expect(bs.okNames).toBeUndefined();
    s.behavior.hideUnclassified = true;
    s.manualAllow = ['other'];
    expect(buildBlockSet(recs, s).okNames).toEqual(['fine', 'other']);
  });
});

describe('countStates', () => {
  it('groups states and counts outdated rubrics', () => {
    const recs = [
      { pipelineState: 'discovered' },
      { pipelineState: 'meta_done' },
      { pipelineState: 'samples_done' },
      { pipelineState: 'language_done' },
      { pipelineState: 'classified', classification: { rubricVersion: 'old' } },
      { pipelineState: 'classified', classification: { rubricVersion: 'new' } },
      { pipelineState: 'failed' },
    ] as SubredditRecord[];
    expect(countStates(recs, 'new')).toMatchObject({
      discovered: 1,
      waitingSamples: 1,
      waitingLlm: 2,
      classified: 2,
      outdatedRubric: 1,
      failed: 1,
      total: 7,
    });
  });
});

describe('Limiter', () => {
  it('caps concurrency per profile', async () => {
    const limiter = new Limiter();
    let active = 0;
    let peak = 0;
    const task = () =>
      limiter.run('p', { maxConcurrency: 2, requestsPerMinute: 0 }, async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      });
    await Promise.all([task(), task(), task(), task(), task()]);
    expect(peak).toBe(2);
  });
  it('spaces requests by RPM', async () => {
    const limiter = new Limiter();
    const starts: number[] = [];
    const t0 = Date.now();
    await Promise.all(
      [1, 2, 3].map(() =>
        limiter.run(
          'q',
          { maxConcurrency: 5, requestsPerMinute: 1200 },
          async () => void starts.push(Date.now() - t0),
        ),
      ),
    );
    starts.sort((a, b) => a - b);
    expect(starts[2]! - starts[0]!).toBeGreaterThanOrEqual(90); // 50 ms spacing
  });
});
