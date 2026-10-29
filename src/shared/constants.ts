import type {
  AttributeDef,
  Behavior,
  EnrichmentSettings,
  FilterList,
  ProviderKind,
  QueueSettings,
  StructuredOutputMode,
} from './types';

export const DB_NAME = 'reddithide';
export const DB_VERSION = 1;
export const BACKUP_SCHEMA_VERSION = 1;

export const DEFAULT_TOPICS = [
  'news',
  'politics',
  'gaming',
  'sports',
  'technology',
  'programming',
  'science',
  'history',
  'education',
  'finance',
  'crypto',
  'business',
  'careers',
  'entertainment',
  'movies_tv',
  'music',
  'books',
  'anime_manga',
  'art',
  'photography',
  'humor',
  'memes',
  'animals',
  'nature',
  'food',
  'travel',
  'cars',
  'diy_crafts',
  'home_garden',
  'fashion_beauty',
  'fitness',
  'health_medical',
  'relationships',
  'parenting',
  'lgbtq',
  'religion',
  'local_regional',
  'support_advice',
  'q_and_a',
  'shopping_deals',
  'adult',
  'other',
];

/** ISO 639-1 codes, plus the two special values the language attribute allows. */
export const LANGUAGE_CODES = (
  'aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en ' +
  'eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ' +
  'ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ' +
  'ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st ' +
  'su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu'
).split(' ');
export const LANGUAGE_OPTIONS = [...LANGUAGE_CODES, 'mixed', 'und'];

export const DEFAULT_ATTRIBUTES: AttributeDef[] = [
  {
    id: 'topic',
    label: 'Topic',
    type: 'multi_enum',
    maxSelections: 3,
    definition:
      "The main subject(s) of the community, chosen from the list. Use 'other' only if nothing fits.",
    source: 'llm',
    enabled: true,
  },
  {
    id: 'language',
    label: 'Language',
    type: 'enum',
    options: LANGUAGE_OPTIONS,
    definition:
      "The main language of the community's posts, as an ISO 639-1 code. 'mixed' if several languages are common; 'und' if unknown.",
    source: 'language_builtin',
    enabled: true,
  },
  {
    id: 'nsfw_sexual',
    label: 'NSFW (sexual)',
    type: 'boolean',
    definition:
      "True if the community's main purpose is sexual or pornographic content, or it regularly features nudity or sexual material.",
    source: 'llm',
    enabled: true,
  },
  {
    id: 'gross',
    label: 'Gross',
    type: 'boolean',
    definition:
      'True if the community regularly features content most people find physically disgusting: gore, injuries, medical procedures, pimple/cyst popping, bodily fluids, parasites, rotting matter, extreme insects, or similar.',
    source: 'llm',
    enabled: true,
  },
];

export const DEFAULT_BEHAVIOR: Behavior = {
  enabled: true,
  hideMode: 'collapse',
  hideUnclassified: false,
  exemptOwnSubredditPage: true,
};

export const DEFAULT_ENRICHMENT: EnrichmentSettings = { minSamples: 3, maxWaitHours: 6 };
export const DEFAULT_QUEUE: QueueSettings = { paused: false, redditMinIntervalMs: 2000 };

export const DEFAULT_FILTER_LIST: FilterList = {
  id: 'default',
  name: 'Default',
  rule: { op: 'any', children: [] },
};

export const DEFAULT_MIN_CONFIDENCE = 0.6;
export const NSFW_CONFIDENCE_ALONE = 0.8;
export const LANGUAGE_MIN_PERCENTAGE = 70;
export const HISTORY_LIMIT = 5;
export const MAX_SAMPLE_TITLES = 25;
export const RECLASSIFY_AFTER_MS = 180 * 24 * 3600 * 1000;
export const MAX_ATTEMPTS = 3;

/** Pseudo-attributes usable in filter conditions (§8). */
export const PSEUDO_ATTRIBUTES = [
  { id: 'subscribers', label: 'Subscribers (number)' },
  { id: 'over18_flag', label: "Reddit's over18 flag" },
] as const;

export interface ProviderPreset {
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  structuredOutput: StructuredOutputMode;
  suggestedModel?: string;
  local?: boolean;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    label: 'Anthropic',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    structuredOutput: 'native',
    suggestedModel: 'claude-haiku-5-5',
  },
  {
    label: 'OpenAI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    structuredOutput: 'native',
  },
  {
    label: 'OpenRouter',
    kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    structuredOutput: 'native',
  },
  {
    label: 'Moonshot (Kimi)',
    kind: 'openai-compatible',
    baseUrl: 'https://api.moonshot.ai/v1',
    structuredOutput: 'json_object',
  },
  {
    label: 'DeepSeek',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    structuredOutput: 'json_object',
  },
  {
    label: 'Groq',
    kind: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    structuredOutput: 'json_object',
  },
  {
    label: 'Ollama (local)',
    kind: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    structuredOutput: 'native',
    local: true,
  },
  {
    label: 'LM Studio (local)',
    kind: 'openai-compatible',
    baseUrl: 'http://localhost:1234/v1',
    structuredOutput: 'native',
    local: true,
  },
  { label: 'Custom', kind: 'openai-compatible', baseUrl: '', structuredOutput: 'json_object' },
];

export function isLocalUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return false;
  }
}
