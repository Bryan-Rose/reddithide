import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyRecord, type ClassifyContext } from '../src/classify/classifier';
import { buildAnthropicBody } from '../src/providers/anthropic';
import { buildOpenAiBody } from '../src/providers/openaiCompatible';
import { parseJsonLenient, parseRetryAfter, ProviderError } from '../src/providers/types';
import { DEFAULT_ATTRIBUTES, DEFAULT_TOPICS } from '../src/shared/constants';
import type { ProviderProfile, SubredditRecord } from '../src/shared/types';

const anthropic: ProviderProfile = {
  id: 'a',
  name: 'Claude',
  kind: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'sk-ant-secret-key-1234',
  model: 'claude-haiku-5-5',
  structuredOutput: 'native',
  temperature: 0,
  maxConcurrency: 2,
  requestsPerMinute: 1000,
  timeoutMs: 1000,
};
const openai: ProviderProfile = {
  ...anthropic,
  id: 'o',
  name: 'Local',
  kind: 'openai-compatible',
  baseUrl: 'http://localhost:11434/v1',
  apiKey: undefined,
  model: 'llama3.2',
};

const rec: SubredditRecord = {
  name: 'cats',
  displayName: 'cats',
  firstSeenAt: 0,
  lastSeenAt: 0,
  seenCount: 1,
  pipelineState: 'language_done',
  attempts: 0,
  samples: { fetchedAt: 0, source: 'dom', titles: ['My cat sleeping', 'Cat tax'] },
  detectedLanguage: { code: 'en', percentage: 98, reliable: true, source: 'browser.i18n' },
};

const ctx: ClassifyContext = {
  attributes: DEFAULT_ATTRIBUTES,
  topics: DEFAULT_TOPICS,
  rubricVersion: 'abc123abc123',
  retryDelaysMs: [1, 1, 1],
};

const good = {
  summary: 'Cat pictures',
  attributes: {
    topic: { value: ['animals'], confidence: 0.95, reason: 'cats' },
    nsfw_sexual: { value: false, confidence: 0.99, reason: 'no' },
    gross: { value: false, confidence: 0.97, reason: 'no' },
  },
};

const anthropicOk = (payload: unknown, extra: Record<string, unknown> = {}) => ({
  content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 100, output_tokens: 20 },
  ...extra,
});
const openaiOk = (content: string, extra: Record<string, unknown> = {}) => ({
  choices: [{ message: { content }, finish_reason: 'stop', ...extra }],
  usage: { prompt_tokens: 80, completion_tokens: 15 },
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function bodyOf(call: number): Record<string, any> {
  return JSON.parse(fetchMock.mock.calls[call]![1].body as string);
}

describe.each([
  ['anthropic', anthropic, (p: unknown) => anthropicOk(p)],
  ['openai-compatible', openai, (p: unknown) => openaiOk(typeof p === 'string' ? p : JSON.stringify(p))],
] as const)('%s connector', (_name, profile, ok) => {
  it('classifies successfully', async () => {
    fetchMock.mockResolvedValueOnce(json(ok(good)));
    const usage: unknown[] = [];
    const out = await classifyRecord(rec, profile, { ...ctx, onUsage: (u, okFlag) => usage.push([u, okFlag]) });
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.result.values.topic!.value).toEqual(['animals']);
    expect(out.result.values.language!.value).toBe('en');
    expect(out.result.rubricVersion).toBe('abc123abc123');
    expect(out.result.model).toBe(profile.model);
    expect(usage).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries once on invalid JSON, sending the error back', async () => {
    fetchMock.mockResolvedValueOnce(json(ok('not json at all'))).mockResolvedValueOnce(json(ok(good)));
    const out = await classifyRecord(rec, profile, ctx);
    expect(out.kind).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const msgs = bodyOf(1).messages as { role: string; content: string }[];
    const last = msgs[msgs.length - 1]!;
    expect(last.role).toBe('user');
    expect(last.content).toMatch(/^Your previous output was invalid: output was not valid JSON/);
    expect(msgs[msgs.length - 2]).toEqual({ role: 'assistant', content: 'not json at all' });
  });

  it('fails after a second invalid output', async () => {
    const bad = { summary: 'x', attributes: { topic: { value: ['animals'], confidence: 1, reason: '' } } };
    fetchMock.mockResolvedValueOnce(json(ok(bad))).mockResolvedValueOnce(json(ok(bad)));
    const out = await classifyRecord(rec, profile, ctx);
    expect(out.kind).toBe('invalid');
    if (out.kind === 'invalid') expect(out.message).toMatch(/nsfw_sexual/);
  });

  it('maps HTTP 401 to an auth error and does not retry', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { message: `invalid x-api-key sk-ant-secret-key-1234` } }, 401));
    const err = await classifyRecord(rec, profile, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe('auth');
    expect(err.message).not.toContain('sk-ant-secret-key-1234');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps HTTP 429 with retry-after', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'slow down' }, 429, { 'retry-after': '12' }));
    const err = await classifyRecord(rec, profile, ctx).catch((e) => e);
    expect(err.kind).toBe('rate_limit');
    expect(err.retryAfterMs).toBe(12000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries 5xx up to 3 times', async () => {
    fetchMock
      .mockResolvedValueOnce(json({}, 500))
      .mockResolvedValueOnce(json({}, 502))
      .mockResolvedValueOnce(json(ok(good)));
    expect((await classifyRecord(rec, profile, ctx)).kind).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('times out, retrying 3 times before giving up', async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const err = await classifyRecord(rec, { ...profile, timeoutMs: 20 }, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe('timeout');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('maps network errors and adds the CORS hint for localhost', async () => {
    fetchMock.mockRejectedValue(new TypeError('NetworkError when attempting to fetch resource.'));
    const err = await classifyRecord(rec, profile, { ...ctx, retryDelaysMs: [] }).catch((e) => e);
    expect(err.kind).toBe('network');
    if (profile.baseUrl.includes('localhost')) expect(err.hint).toMatch(/OLLAMA_ORIGINS/);
  });
});

describe('refusals', () => {
  it('anthropic stop_reason refusal', async () => {
    fetchMock.mockResolvedValueOnce(json(anthropicOk('', { stop_reason: 'refusal', content: [] })));
    const out = await classifyRecord(rec, anthropic, ctx);
    expect(out.kind).toBe('refused');
  });
  it('openai message.refusal', async () => {
    fetchMock.mockResolvedValueOnce(json({ choices: [{ message: { content: null, refusal: 'I cannot help' }, finish_reason: 'stop' }] }));
    const out = await classifyRecord(rec, openai, ctx);
    expect(out).toMatchObject({ kind: 'refused', text: 'I cannot help' });
  });
  it('openai content_filter', async () => {
    fetchMock.mockResolvedValueOnce(json({ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }));
    expect((await classifyRecord(rec, openai, ctx)).kind).toBe('refused');
  });
});

describe('request bodies', () => {
  const req = { system: 'S', user: 'U', schema: { type: 'object' }, schemaName: 'record_classification' };

  it('anthropic native uses structured outputs, low effort, no temperature on current models', () => {
    const b = buildAnthropicBody(anthropic, req);
    expect(b.output_config).toEqual({ format: { type: 'json_schema', schema: { type: 'object' } }, effort: 'low' });
    expect(b.temperature).toBeUndefined();
    expect(b.max_tokens).toBe(4096);
    expect(b.tool_choice).toBeUndefined();
  });
  it('anthropic older models get temperature and no effort', () => {
    const b = buildAnthropicBody({ ...anthropic, model: 'claude-3-5-haiku-latest', structuredOutput: 'prompt_only' }, req);
    expect(b.temperature).toBe(0);
    expect(b.output_config).toBeUndefined();
    expect(b.max_tokens).toBe(1024);
  });
  it('anthropic sends the browser-access header', async () => {
    fetchMock.mockResolvedValueOnce(json(anthropicOk(good)));
    await classifyRecord(rec, anthropic, ctx);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(init.headers['x-api-key']).toBe(anthropic.apiKey);
    expect(init.headers['anthropic-version']).toBe('2023-06-01');
  });
  it('openai response_format per mode', () => {
    expect(buildOpenAiBody(openai, req).response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'record_classification', schema: { type: 'object' }, strict: true },
    });
    expect(buildOpenAiBody({ ...openai, structuredOutput: 'json_object' }, req).response_format).toEqual({ type: 'json_object' });
    expect(buildOpenAiBody({ ...openai, structuredOutput: 'prompt_only' }, req).response_format).toBeUndefined();
  });
  it('prompt modes put the schema in the system prompt', async () => {
    fetchMock.mockResolvedValueOnce(json(openaiOk(JSON.stringify(good))));
    await classifyRecord(rec, { ...openai, structuredOutput: 'json_object' }, ctx);
    expect(bodyOf(0).messages[0].content).toContain('must match this JSON Schema');
  });
  it('asks for a language guess only when detection is not settled', async () => {
    fetchMock.mockResolvedValueOnce(json(openaiOk(JSON.stringify({ ...good, language_guess: { value: 'de', confidence: 0.8, reason: 'x' } }))));
    const out = await classifyRecord({ ...rec, detectedLanguage: undefined }, openai, ctx);
    expect(JSON.stringify(bodyOf(0).response_format)).toContain('language_guess');
    expect(out.kind === 'ok' && out.result.values.language!.value).toBe('de');
  });
  it('openai bearer header only when a key is set', async () => {
    fetchMock.mockResolvedValueOnce(json(openaiOk(JSON.stringify(good))));
    await classifyRecord(rec, { ...openai, apiKey: 'k', extraHeaders: { 'X-Title': 'RedditHide' } }, ctx);
    expect(fetchMock.mock.calls[0]![1].headers).toMatchObject({ authorization: 'Bearer k', 'X-Title': 'RedditHide' });
  });
  it('400 mentioning response_format yields a hint', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { message: 'response_format json_schema is not supported' } }, 400));
    const err = await classifyRecord(rec, openai, ctx).catch((e) => e);
    expect(err.kind).toBe('bad_request');
    expect(err.hint).toMatch(/json_object/);
  });
});

describe('helpers', () => {
  it('parseJsonLenient strips fences and surrounding prose', () => {
    expect(parseJsonLenient('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLenient('Sure! Here it is: {"a": {"b": 2}} Hope this helps')).toEqual({ a: { b: 2 } });
    expect(parseJsonLenient('nope')).toBeUndefined();
  });
  it('parseRetryAfter handles seconds and dates', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(new Date(Date.now() + 10_000).toUTCString())).toBeGreaterThan(8000);
  });
});
