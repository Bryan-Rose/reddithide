// Anthropic Messages API connector (SPEC §6.4), raw fetch from the background script.
//
// Deviation from the spec: "native" structured output uses `output_config.format` (JSON-schema
// structured outputs) instead of a forced tool. Forced `tool_choice` returns HTTP 400 on current
// models (Opus 5.5, Sonnet 5.5, Fable 5.1), while structured outputs work across the line-up.
import type { ProviderProfile } from '../shared/types';
import {
  joinUrl,
  parseJsonLenient,
  providerFetch,
  type ClassifyRequest,
  type ClassifyResponse,
  type Connector,
} from './types';

const API_VERSION = '2023-06-01';

/** Models that reject non-default sampling parameters (temperature etc.). */
const NO_SAMPLING = /claude-(fable|mythos)|claude-(opus|sonnet|haiku)-[5-9]|claude-opus-4-[78]/;
/** Models that accept `output_config.effort`. These think by default, so they need more max_tokens. */
const SUPPORTS_EFFORT =
  /claude-(fable|mythos)|claude-(opus|sonnet|haiku)-[5-9]|claude-opus-4-[5-8]|claude-sonnet-4-6/;

export function anthropicHeaders(profile: ProviderProfile): Record<string, string> {
  return {
    'content-type': 'application/json',
    'anthropic-version': API_VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
    ...(profile.apiKey ? { 'x-api-key': profile.apiKey } : {}),
    ...profile.extraHeaders,
  };
}

interface AnthropicMessageResponse {
  content?: { type: string; text?: string }[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function buildAnthropicBody(profile: ProviderProfile, req: ClassifyRequest): Record<string, unknown> {
  const model = profile.model;
  const effort = SUPPORTS_EFFORT.test(model);
  const messages: { role: 'user' | 'assistant'; content: string }[] = [{ role: 'user', content: req.user }];
  if (req.retry) {
    messages.push({ role: 'assistant', content: req.retry.previousOutput || '(no output)' });
    messages.push({ role: 'user', content: req.retry.feedback });
  }
  const body: Record<string, unknown> = {
    model,
    max_tokens: effort ? 4096 : 1024,
    system: req.system,
    messages,
  };
  if (!NO_SAMPLING.test(model)) body.temperature = profile.temperature;
  const outputConfig: Record<string, unknown> = {};
  if (profile.structuredOutput === 'native')
    outputConfig.format = { type: 'json_schema', schema: req.schema };
  if (effort) outputConfig.effort = 'low';
  if (Object.keys(outputConfig).length) body.output_config = outputConfig;
  return body;
}

export const anthropicConnector: Connector = {
  async classify(profile, req, signal): Promise<ClassifyResponse> {
    const res = await providerFetch(
      profile,
      joinUrl(profile.baseUrl, '/v1/messages'),
      {
        method: 'POST',
        headers: anthropicHeaders(profile),
        body: JSON.stringify(buildAnthropicBody(profile, req)),
      },
      signal,
    );
    const data = (await res.json()) as AnthropicMessageResponse;
    const rawText = (data.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
    const usage = { inputTokens: data.usage?.input_tokens, outputTokens: data.usage?.output_tokens };
    if (data.stop_reason === 'refusal') {
      return {
        json: undefined,
        rawText,
        usage,
        refused: true,
        refusalText: rawText || 'Refused (stop_reason: refusal)',
      };
    }
    return { json: parseJsonLenient(rawText), rawText, usage, refused: false };
  },

  async listModels(profile): Promise<string[]> {
    const ids: string[] = [];
    let after: string | undefined;
    for (let page = 0; page < 10; page++) {
      const url = new URL(joinUrl(profile.baseUrl, '/v1/models'));
      url.searchParams.set('limit', '1000');
      if (after) url.searchParams.set('after_id', after);
      const res = await providerFetch(profile, url.toString(), { headers: anthropicHeaders(profile) });
      const data = (await res.json()) as { data?: { id: string }[]; has_more?: boolean; last_id?: string };
      ids.push(...(data.data ?? []).map((m) => m.id));
      if (!data.has_more || !data.last_id) break;
      after = data.last_id;
    }
    return ids;
  },
};
