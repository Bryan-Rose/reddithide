// Zod schemas for everything the server accepts. The server receives scraped page data (SPEC §5.4).
// Unknown keys are dropped, so a stray `url` on a `seen` batch never reaches the code.
import { z } from 'zod';
import type {
  MetaBatch,
  SeenBatch,
  ServerRpcMethod,
  ServerRpcMethods,
  SettingsPatch,
} from '../shared/messages';
import type { AttributeDef, Condition, FilterList, ProviderProfile, RuleGroup } from '../shared/types';

const NAME_MAX = 200;
const LANG_MAX = 20;

const name = z.string().max(NAME_MAX);

export const seenSchema: z.ZodType<SeenBatch> = z.object({
  names: z.array(
    z.object({
      name,
      displayName: name,
      sighting: z.boolean(),
      posts: z
        .array(
          z.object({
            id: name,
            title: z.string(),
            lang: z.string().max(LANG_MAX).optional(),
            originalTitle: z.string().optional(),
            browserLang: z.string().max(LANG_MAX).optional(),
          }),
        )
        .optional(),
      over18: z.boolean().optional(),
      quarantined: z.boolean().optional(),
    }),
  ),
});

export const metaSchema: z.ZodType<MetaBatch> = z.object({
  name,
  displayName: name,
  meta: z.object({
    title: z.string().optional(),
    publicDescription: z.string().optional(),
    weeklyActiveUsers: z.number().optional(),
  }),
});

const attributeValue = z.union([z.boolean(), z.string(), z.array(z.string())]);

const condition: z.ZodType<Condition> = z.object({
  attribute: z.string(),
  operator: z.enum(['is', 'is_not', 'in', 'not_in', 'contains_any', 'gte', 'lte']),
  value: z.union([attributeValue, z.number()]),
  minConfidence: z.number().optional(),
});

const ruleGroup: z.ZodType<RuleGroup> = z.lazy(() =>
  z.object({ op: z.enum(['any', 'all']), children: z.array(z.union([ruleGroup, condition])) }),
);

const filterList: z.ZodType<FilterList> = z.object({ id: z.string(), name: z.string(), rule: ruleGroup });

const profile: z.ZodType<ProviderProfile> = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['anthropic', 'openai-compatible']),
  baseUrl: z.string(),
  apiKey: z.string().optional(),
  model: z.string(),
  structuredOutput: z.enum(['native', 'json_object', 'prompt_only']),
  temperature: z.number(),
  maxConcurrency: z.number(),
  requestsPerMinute: z.number(),
  timeoutMs: z.number(),
  extraHeaders: z.record(z.string(), z.string()).optional(),
  priceInputPerMTok: z.number().optional(),
  priceOutputPerMTok: z.number().optional(),
});

const attribute: z.ZodType<AttributeDef> = z.object({
  id: z.string(),
  label: z.string(),
  type: z.enum(['boolean', 'enum', 'multi_enum']),
  options: z.array(z.string()).optional(),
  maxSelections: z.number().optional(),
  definition: z.string(),
  source: z.enum(['llm', 'language_builtin']),
  enabled: z.boolean(),
});

// Strict, because each key becomes a row in a table that also holds the block set.
const settingsPatch: z.ZodType<SettingsPatch> = z.strictObject({
  attributes: z.array(attribute).optional(),
  topics: z.array(z.string()).optional(),
  profiles: z.array(profile).optional(),
  defaultProfileId: z.string().nullable().optional(),
  fallbackProfileId: z.string().nullable().optional(),
  filterLists: z.array(filterList).optional(),
  activeFilterListId: z.string().optional(),
  manualBlock: z.array(z.string()).optional(),
  manualAllow: z.array(z.string()).optional(),
  behavior: z
    .object({
      enabled: z.boolean(),
      hideMode: z.enum(['remove', 'collapse']),
      hideUnclassified: z.boolean(),
      exemptOwnSubredditPage: z.boolean(),
    })
    .optional(),
  enrichment: z.object({ minSamples: z.number(), maxWaitHours: z.number() }).optional(),
  queue: z.object({ paused: z.boolean(), redditMinIntervalMs: z.number() }).optional(),
});

const names = z.array(z.string());

export const rpcParams: { [M in ServerRpcMethod]: z.ZodType<ServerRpcMethods[M]['params']> } = {
  getStatus: z.void(),
  listSubreddits: z.void(),
  getSubreddit: z.object({ name: z.string() }),
  reclassify: z.object({
    names: z.union([names, z.literal('outdated')]),
    profileId: z.string().optional(),
  }),
  setOverride: z.object({ name: z.string(), attribute: z.string(), value: attributeValue.nullable() }),
  setManual: z.object({ names, list: z.enum(['block', 'allow', 'none']) }),
  deleteSubreddits: z.object({ names }),
  setPaused: z.object({ paused: z.boolean() }),
  testProfile: z.object({ profile }),
  listModels: z.object({ profile }),
  previewRule: z.object({ rule: ruleGroup }),
  usageSummary: z.void(),
  dismissErrors: z.void(),
  clearAllData: z.void(),
  kick: z.void(),
  getSettings: z.void(),
  saveSettings: settingsPatch,
  resetAll: z.void(),
};
