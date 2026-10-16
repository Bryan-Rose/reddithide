// OpenAI-compatible chat completions connector (SPEC §6.5): OpenAI, OpenRouter, Moonshot, DeepSeek,
// Groq, Ollama, LM Studio, llama.cpp server, vLLM, ...
import type { ProviderProfile } from '../shared/types';
import {
  joinUrl,
  parseJsonLenient,
  providerFetch,
  type ClassifyRequest,
  type ClassifyResponse,
  type Connector,
} from './types';

function headers(profile: ProviderProfile): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {}),
    ...profile.extraHeaders,
  };
}

interface ChatCompletionResponse {
  choices?: {
    message?: { content?: string | null; refusal?: string | null };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function buildOpenAiBody(profile: ProviderProfile, req: ClassifyRequest): Record<string, unknown> {
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: req.system },
    { role: 'user', content: req.user },
  ];
  if (req.retry) {
    messages.push({ role: 'assistant', content: req.retry.previousOutput || '(no output)' });
    messages.push({ role: 'user', content: req.retry.feedback });
  }
  const body: Record<string, unknown> = { model: profile.model, temperature: profile.temperature, messages };
  if (profile.structuredOutput === 'native') {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: req.schemaName, schema: req.schema, strict: true },
    };
  } else if (profile.structuredOutput === 'json_object') {
    body.response_format = { type: 'json_object' };
  }
  return body;
}

export const openAiCompatibleConnector: Connector = {
  async classify(profile, req, signal): Promise<ClassifyResponse> {
    const res = await providerFetch(
      profile,
      joinUrl(profile.baseUrl, '/chat/completions'),
      { method: 'POST', headers: headers(profile), body: JSON.stringify(buildOpenAiBody(profile, req)) },
      signal,
    );
    const data = (await res.json()) as ChatCompletionResponse;
    const choice = data.choices?.[0];
    const rawText = choice?.message?.content ?? '';
    const usage = { inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens };
    const refusal = choice?.message?.refusal;
    if (refusal || choice?.finish_reason === 'content_filter') {
      return {
        json: undefined,
        rawText,
        usage,
        refused: true,
        refusalText: refusal || 'Blocked by the provider content filter (finish_reason: content_filter)',
      };
    }
    return { json: parseJsonLenient(rawText), rawText, usage, refused: false };
  },

  async listModels(profile): Promise<string[]> {
    const res = await providerFetch(profile, joinUrl(profile.baseUrl, '/models'), { headers: headers(profile) });
    const data = (await res.json()) as { data?: { id: string }[]; models?: { name?: string; id?: string }[] };
    const list = data.data ?? data.models ?? [];
    return list.map((m) => ('id' in m && m.id ? m.id : ((m as { name?: string }).name ?? ''))).filter(Boolean).sort();
  },
};
