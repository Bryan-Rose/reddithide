// HTTP API and concurrency, against a real listening server and in-memory SQLite.
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getKv, getRecord, openDb, clearAll, clearKv, tx } from '../src/server/db';
import { createApp } from '../src/server/http';
import { pump } from '../src/server/pipeline';
import { getSettings, saveSettings } from '../src/server/settings';
import type { ProviderProfile } from '../src/shared/types';

const TOKEN = 'x'.repeat(32);
const server = createApp(TOKEN);
let base = '';

const request = (path: string, init: RequestInit = {}, token = TOKEN) =>
  fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });
const post = (path: string, body?: unknown, token?: string) =>
  request(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }, token);
const rpc = async (method: string, params?: unknown) => {
  const res = await post(`/api/rpc/${method}`, params);
  return (await res.json()) as { ok: boolean; result?: any; error?: string };
};
const seen = (name: string, posts: { id: string; title: string }[] = [], sighting = true) => ({
  names: [{ name, displayName: name, sighting, posts }],
});

beforeAll(async () => {
  openDb(':memory:');
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});
beforeEach(() => {
  clearAll();
  clearKv();
});

// Never called: `tsc` fails here if `tx` starts accepting async callbacks.
const _txRejectsAsync = () => {
  // @ts-expect-error an await inside a transaction would let another request in
  tx(async () => {});
};

describe('auth', () => {
  it('leaves only /healthz open', async () => {
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
    for (const path of ['/api/blockset', '/nope']) {
      expect((await fetch(base + path)).status).toBe(401);
      expect((await request(path, {}, 'y'.repeat(32))).status).toBe(401);
    }
    expect((await post('/api/seen', seen('cats'), 'short')).status).toBe(401);
    expect(getRecord('cats')).toBeUndefined();
  });
  it('answers 404 for an unknown path once authorized', async () => {
    expect((await request('/nope')).status).toBe(404);
  });
});

describe('POST /api/seen', () => {
  it('stores the post fields and never the url', async () => {
    const body = {
      url: 'https://www.reddit.com/r/private/',
      names: [
        {
          name: 'Cats',
          displayName: 'Cats',
          sighting: true,
          posts: [{ id: 't3_1', title: 'Hi', lang: 'en', originalTitle: 'hallo', browserLang: 'de' }],
        },
      ],
    };
    expect((await post('/api/seen', body)).status).toBe(200);
    const rec = getRecord('cats')!;
    expect(rec.samples!.items![0]).toMatchObject({ originalTitle: 'hallo', browserLang: 'de' });
    expect(JSON.stringify(rec)).not.toContain('reddit.com');
  });
  it('rejects bad input with a 400', async () => {
    expect((await post('/api/seen', { names: [{ name: 1 }] })).status).toBe(400);
    expect((await post('/api/seen')).status).toBe(400);
    const res = await request('/api/seen', { method: 'POST', body: '{not json' });
    expect(res.status).toBe(400);
  });
  it('rejects a body over the size limit', async () => {
    const res = await post('/api/seen', { names: [], pad: 'x'.repeat(1024 * 1024) });
    expect(res.status).toBe(413);
  });
  it('keeps the cap of 200 names', async () => {
    const names = Array.from({ length: 201 }, (_, i) => ({
      name: `sub${i}`,
      displayName: `sub${i}`,
      sighting: true,
    }));
    await post('/api/seen', { names });
    expect(getRecord('sub199')).toBeDefined();
    expect(getRecord('sub200')).toBeUndefined();
  });
});

describe('POST /api/meta', () => {
  it('merges metadata', async () => {
    const body = { name: 'Python', displayName: 'Python', meta: { publicDescription: 'Snakes? No.' } };
    expect((await post('/api/meta', body)).status).toBe(200);
    expect(getRecord('python')!.meta!.publicDescription).toBe('Snakes? No.');
  });
});

describe('GET /api/blockset', () => {
  it('answers 304 for a matching ETag, and changes it only with the content', async () => {
    const first = await request('/api/blockset');
    const etag = first.headers.get('etag')!;
    expect(await first.json()).toMatchObject({ type: 'blockSet', names: [] });
    const unchanged = await request('/api/blockset', { headers: { 'if-none-match': etag } });
    expect(unchanged.status).toBe(304);

    await rpc('setManual', { names: ['ew'], list: 'block' });
    await vi.waitFor(async () => {
      const res = await request('/api/blockset', { headers: { 'if-none-match': etag } });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { names: string[] }).names).toEqual(['ew']);
    });
  });
});

describe('POST /api/rpc', () => {
  it('returns results and validates params', async () => {
    await post('/api/seen', seen('cats'));
    expect(await rpc('listSubreddits')).toMatchObject({ ok: true, result: [{ name: 'cats' }] });
    expect(await rpc('getStatus')).toMatchObject({ ok: true, result: { counts: { total: 1 } } });
    const bad = await post('/api/rpc/setManual', { names: 'cats', list: 'block' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ ok: false });
  });
  it('rejects unknown methods, including inherited property names', async () => {
    for (const method of ['nope', 'constructor', 'checkRedditPermission']) {
      expect((await post(`/api/rpc/${method}`)).status).toBe(404);
    }
  });
  it('saves settings, and null removes an optional one', async () => {
    await rpc('saveSettings', { fallbackProfileId: 'p', topics: ['a'] });
    expect(await rpc('getSettings')).toMatchObject({ result: { fallbackProfileId: 'p', topics: ['a'] } });
    await rpc('saveSettings', { fallbackProfileId: null });
    expect((await rpc('getSettings')).result.fallbackProfileId).toBeUndefined();
  });
  it('refuses settings keys it does not know', async () => {
    expect((await post('/api/rpc/saveSettings', { blockSet: {} })).status).toBe(400);
    expect(getKv('blockSet')).toBeUndefined();
  });
  it('clearAllData keeps settings, and resetAll removes them', async () => {
    await post('/api/seen', seen('cats'));
    await rpc('saveSettings', { topics: ['a'] });
    await rpc('clearAllData');
    expect(getRecord('cats')).toBeUndefined();
    expect(getSettings().topics).toEqual(['a']);
    await rpc('resetAll');
    expect(getSettings().topics).toContain('news');
  });
});

describe('concurrency', () => {
  it('counts every simultaneous seen request for one subreddit', async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => post('/api/seen', seen('cats', [{ id: `${i}`, title: `T${i}` }]))),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const rec = getRecord('cats')!;
    expect(rec.seenCount).toBe(25);
    expect(rec.samples!.items).toHaveLength(25);
  });

  it('keeps every simultaneous setManual change', async () => {
    const names = Array.from({ length: 25 }, (_, i) => `sub${i}`);
    await Promise.all(names.map((n) => rpc('setManual', { names: [n], list: 'block' })));
    expect(getSettings().manualBlock).toEqual([...names].sort());
  });

  describe('with a classification in flight', () => {
    const profile: ProviderProfile = {
      id: 'p',
      name: 'Local',
      kind: 'openai-compatible',
      baseUrl: 'http://llm.test/v1',
      model: 'm',
      structuredOutput: 'native',
      temperature: 0,
      maxConcurrency: 1,
      requestsPerMinute: 0,
      timeoutMs: 1000,
    };
    const answer = {
      summary: 'Cats',
      attributes: {
        topic: { value: ['animals'], confidence: 0.9, reason: 'x' },
        nsfw_sexual: { value: false, confidence: 0.9, reason: 'x' },
        gross: { value: false, confidence: 0.9, reason: 'x' },
      },
      language_guess: { value: 'und', confidence: 0.1, reason: 'x' },
    };
    const realFetch = fetch;
    const llmReply = () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }), {
        status: 200,
      });
    afterEach(() => vi.unstubAllGlobals());

    it('runs a reclassify requested while the subreddit is being classified', async () => {
      const replies: ((r: Response) => void)[] = [];
      const llm = vi.fn(() => new Promise<Response>((r) => replies.push(r)));
      vi.stubGlobal('fetch', (url: string, init: RequestInit) =>
        url.startsWith('http://llm.test') ? llm() : realFetch(url, init),
      );
      saveSettings({ profiles: [profile], defaultProfileId: 'p' });
      const posts = [1, 2, 3].map((i) => ({ id: `${i}`, title: `T${i}` }));
      await post('/api/seen', seen('cats', posts));
      pump();
      await vi.waitFor(() => expect(llm).toHaveBeenCalledTimes(1));

      expect((await rpc('reclassify', { names: ['cats'] })).result).toEqual({ queued: 1 });
      replies[0]!(llmReply());
      await vi.waitFor(() => expect(llm).toHaveBeenCalledTimes(2));
      expect(getRecord('cats')!.pendingReclassify).toBeDefined();

      replies[1]!(llmReply());
      await vi.waitFor(() => expect(getRecord('cats')!.pipelineState).toBe('classified'));
      expect(getRecord('cats')!.pendingReclassify).toBeUndefined();
      expect(getRecord('cats')!.classificationHistory).toHaveLength(1);
    });

    const refusal = () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '', refusal: 'No.' } }] }), {
        status: 200,
      });
    const badOutput = () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'not json' } }] }), { status: 200 });

    // Invalid output is retried once before the job gives up, so it takes two replies.
    it.each([
      ['a refusal', [refusal]],
      ['invalid output', [badOutput, badOutput]],
    ])('keeps a reclassify requested before %s', async (_, failures) => {
      const replies: ((r: Response) => void)[] = [];
      const llm = vi.fn(() => new Promise<Response>((r) => replies.push(r)));
      vi.stubGlobal('fetch', (url: string, init: RequestInit) =>
        url.startsWith('http://llm.test') ? llm() : realFetch(url, init),
      );
      saveSettings({ profiles: [profile], defaultProfileId: 'p' });
      const posts = [1, 2, 3].map((i) => ({ id: `${i}`, title: `T${i}` }));
      await post('/api/seen', seen('cats', posts));
      pump();
      await vi.waitFor(() => expect(llm).toHaveBeenCalledTimes(1));
      await rpc('reclassify', { names: ['cats'] });

      for (const [i, failure] of failures.entries()) {
        await vi.waitFor(() => expect(llm).toHaveBeenCalledTimes(i + 1));
        replies[i]!(failure());
      }
      await vi.waitFor(() => expect(llm).toHaveBeenCalledTimes(failures.length + 1));

      replies[failures.length]!(llmReply());
      await vi.waitFor(() => expect(getRecord('cats')!.pipelineState).toBe('classified'));
      expect(getRecord('cats')!.pendingReclassify).toBeUndefined();
    });

    it('keeps a seen update that arrives meanwhile, and uses language evidence', async () => {
      let finish = (_: Response) => {};
      const llm = vi.fn(() => new Promise<Response>((r) => (finish = r)));
      vi.stubGlobal('fetch', (url: string, init: RequestInit) =>
        url.startsWith('http://llm.test') ? llm() : realFetch(url, init),
      );
      saveSettings({ profiles: [profile], defaultProfileId: 'p' });
      const posts = [1, 2, 3].map((i) => ({ id: `${i}`, title: `T${i}`, browserLang: 'fr' }));
      await post('/api/seen', seen('cats', posts));
      pump();
      await vi.waitFor(() => expect(llm).toHaveBeenCalled());

      await post('/api/seen', seen('cats', [{ id: '4', title: 'Late' }]));
      finish(llmReply());

      await vi.waitFor(() => expect(getRecord('cats')!.pipelineState).toBe('classified'));
      const rec = getRecord('cats')!;
      expect(rec.seenCount).toBe(2);
      expect(rec.samples!.titles[0]).toBe('Late');
      expect(rec.languageEvidence!.firefox).toEqual({ code: 'fr', count: 3, total: 3 });
      expect(rec.classification!.values.language!.value).toBe('fr');
      const usage = await rpc('usageSummary');
      expect(usage.result).toMatchObject([{ profileId: 'p', ok: true }]);
    });
  });
});
