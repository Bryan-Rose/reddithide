// One classification of one subreddit with one profile (SPEC §6.6, §7). No storage here;
// the pipeline decides what to persist.
import { getConnector } from '../providers';
import { ProviderError, type ClassifyRequest, type ClassifyResponse, type Connector } from '../providers/types';
import type { AttributeDef, ClassificationResult, ProviderProfile, SubredditRecord } from '../shared/types';
import { sleep } from '../shared/util';
import { finalizeValues, languageIsSettled, normalizeClassification } from './parse';
import { buildSystemPrompt, buildUserMessage, RETRY_MESSAGE } from './prompt';
import { buildJsonSchema, buildValidator, SCHEMA_NAME, summarizeZodError } from './schema';

export interface ClassifyContext {
  attributes: AttributeDef[];
  topics: string[];
  rubricVersion: string;
  /** Wraps each HTTP call (per-profile concurrency/RPM limits). */
  gate?: <T>(fn: () => Promise<T>) => Promise<T>;
  onUsage?: (usage: ClassifyResponse['usage'], ok: boolean) => void;
  signal?: AbortSignal;
  /** Override for tests. */
  connector?: Connector;
  /** Delays between transient retries (ms). */
  retryDelaysMs?: number[];
}

export type ClassifyOutcome =
  | { kind: 'ok'; result: ClassificationResult; rawText: string; mappings: string[] }
  | { kind: 'refused'; text: string; rawText: string }
  | { kind: 'invalid'; message: string; rawText: string };

const DEFAULT_RETRY_DELAYS = [2000, 5000, 15000];

export function buildRequest(
  rec: SubredditRecord,
  profile: ProviderProfile,
  ctx: ClassifyContext,
): { req: ClassifyRequest; includeLanguageGuess: boolean } {
  const includeLanguageGuess =
    ctx.attributes.some((a) => a.enabled && a.source === 'language_builtin') && !languageIsSettled(rec.detectedLanguage);
  const schema = buildJsonSchema(ctx.attributes, ctx.topics, includeLanguageGuess);
  const schemaInPrompt = profile.structuredOutput === 'native' ? undefined : schema;
  return {
    includeLanguageGuess,
    req: {
      system: buildSystemPrompt(ctx.attributes, ctx.topics, { includeLanguageGuess, schemaInPrompt }),
      user: buildUserMessage(rec),
      schema,
      schemaName: SCHEMA_NAME,
    },
  };
}

/** Calls the connector, retrying 5xx / network / timeout errors up to 3 times. */
async function callWithRetries(
  connector: Connector,
  profile: ProviderProfile,
  req: ClassifyRequest,
  ctx: ClassifyContext,
): Promise<ClassifyResponse> {
  const delays = ctx.retryDelaysMs ?? DEFAULT_RETRY_DELAYS;
  const gate = ctx.gate ?? (<T>(fn: () => Promise<T>) => fn());
  for (let attempt = 0; ; attempt++) {
    try {
      const signal = ctx.signal ?? new AbortController().signal;
      return await gate(() => connector.classify(profile, req, signal));
    } catch (e) {
      const transient = e instanceof ProviderError && ['server', 'network', 'timeout'].includes(e.kind);
      if (e instanceof ProviderError) ctx.onUsage?.(undefined, false);
      if (!transient || attempt >= delays.length) throw e;
      await sleep((e as ProviderError).retryAfterMs ?? delays[attempt]!);
    }
  }
}

export async function classifyRecord(
  rec: SubredditRecord,
  profile: ProviderProfile,
  ctx: ClassifyContext,
): Promise<ClassifyOutcome> {
  const connector = ctx.connector ?? getConnector(profile.kind);
  const { req: baseReq, includeLanguageGuess } = buildRequest(rec, profile, ctx);
  const validator = buildValidator(ctx.attributes, includeLanguageGuess);
  const usage = { inputTokens: 0, outputTokens: 0 };

  let req = baseReq;
  for (let round = 0; round < 2; round++) {
    const res = await callWithRetries(connector, profile, req, ctx);
    usage.inputTokens += res.usage?.inputTokens ?? 0;
    usage.outputTokens += res.usage?.outputTokens ?? 0;
    ctx.onUsage?.(res.usage, !res.refused);
    if (res.refused) return { kind: 'refused', text: res.refusalText ?? 'Refused', rawText: res.rawText };

    let problem: string;
    const parsed = res.json === undefined ? undefined : validator.safeParse(res.json);
    if (!parsed) {
      problem = 'output was not valid JSON';
    } else if (!parsed.success) {
      problem = summarizeZodError(parsed.error);
    } else {
      const normalized = normalizeClassification(parsed.data, ctx.attributes, ctx.topics);
      if (!normalized.problems.length) {
        if (normalized.mappings.length) console.info('[RedditHide] mapped values for', rec.name, normalized.mappings);
        return {
          kind: 'ok',
          rawText: res.rawText,
          mappings: normalized.mappings,
          result: {
            classifiedAt: Date.now(),
            profileId: profile.id,
            providerKind: profile.kind,
            model: profile.model,
            rubricVersion: ctx.rubricVersion,
            values: finalizeValues(normalized, rec, ctx.attributes),
            summary: normalized.summary,
            usage,
          },
        };
      }
      problem = normalized.problems.join('; ');
    }
    if (round === 1) return { kind: 'invalid', message: problem, rawText: res.rawText };
    req = { ...baseReq, retry: { previousOutput: res.rawText, feedback: RETRY_MESSAGE(problem) } };
  }
  throw new Error('unreachable');
}
