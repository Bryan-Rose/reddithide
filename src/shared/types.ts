// Core data model (SPEC §4, §6.1, §7.1, §8, §9).

export type AttributeValue = boolean | string | string[];

export type PipelineState =
  | 'discovered'
  | 'meta_done'
  | 'samples_done'
  | 'language_done'
  | 'classified'
  | 'refused'
  | 'failed'
  | 'skipped'; // skipped = private/banned/not_found

export type MetaStatus = 'ok' | 'private' | 'banned' | 'quarantined' | 'not_found' | 'error';

export interface SubredditMeta {
  fetchedAt: number;
  /** Where the metadata came from. 'dom' = subreddit header / search results on new Reddit. */
  source: 'dom' | 'reddit_json';
  status: MetaStatus;
  title?: string;
  publicDescription?: string;
  sidebar?: string; // truncated to 4000 chars
  over18?: boolean;
  quarantined?: boolean;
  lang?: string; // Reddit's own field; unreliable
  subscribers?: number;
  weeklyActiveUsers?: number;
  subredditType?: string;
  createdUtc?: number;
}

export interface SampleItem {
  id: string; // post id, e.g. t3_abc
  title: string;
  /** Reddit's `post-language` attribute when seen in the DOM. */
  lang?: string;
  seenAt: number;
}

export interface SubredditSamples {
  fetchedAt: number;
  source: 'dom' | 'reddit_json';
  titles: string[]; // up to 25, most recent first
  items?: SampleItem[];
}

export interface DetectedLanguage {
  code: string; // ISO 639-1, or "und"
  percentage: number;
  reliable: boolean;
  source: 'browser.i18n' | 'reddit_post_language';
}

export interface AttributeResult {
  value: AttributeValue;
  confidence: number;
  reason: string;
  /** The model's own answer when a combination rule changed the final value (e.g. nsfw_sexual, §7.4). */
  rawValue?: AttributeValue;
}

export interface ClassificationResult {
  classifiedAt: number;
  profileId: string;
  providerKind: ProviderKind;
  model: string;
  rubricVersion: string;
  values: Record<string, AttributeResult>;
  summary: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface PendingReclassify {
  requestedAt: number;
  profileId?: string;
  /** True when this is the single retry on the fallback profile after a refusal. */
  isFallback?: boolean;
}

export interface SubredditRecord {
  name: string; // lowercased, no r/ prefix
  displayName: string;
  firstSeenAt: number;
  lastSeenAt: number;
  seenCount: number;

  meta?: SubredditMeta;
  samples?: SubredditSamples;
  detectedLanguage?: DetectedLanguage;

  classification?: ClassificationResult;
  classificationHistory?: ClassificationResult[]; // last 5
  overrides?: Record<string, AttributeValue>;
  pipelineState: PipelineState;
  lastError?: { at: number; stage: string; message: string };
  attempts: number;

  /** Sparse-indexed: present only while a reclassification is queued. */
  pendingAt?: number;
  pendingReclassify?: PendingReclassify;
  /** Earliest time the pipeline may retry this record after a transient error. */
  retryAfter?: number;
}

/** Slim row sent to the review table (no samples or history). */
export interface SubredditRow {
  name: string;
  displayName: string;
  firstSeenAt: number;
  lastSeenAt: number;
  seenCount: number;
  pipelineState: PipelineState;
  summary?: string;
  values?: Record<string, AttributeResult>;
  overrides?: Record<string, AttributeValue>;
  over18?: boolean;
  detectedLanguage?: string;
  subscribers?: number;
  model?: string;
  rubricVersion?: string;
  sampleCount: number;
  lastError?: string;
}

export interface UsageRow {
  id?: number;
  at: number;
  profileId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  ok: boolean;
}

// ---- Providers (§6) ----

export type ProviderKind = 'anthropic' | 'openai-compatible';
export type StructuredOutputMode = 'native' | 'json_object' | 'prompt_only';

export interface ProviderProfile {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey?: string;
  model: string;
  structuredOutput: StructuredOutputMode;
  temperature: number;
  maxConcurrency: number;
  requestsPerMinute: number;
  timeoutMs: number;
  extraHeaders?: Record<string, string>;
  priceInputPerMTok?: number;
  priceOutputPerMTok?: number;
}

// ---- Attributes (§7.1) ----

export interface AttributeDef {
  id: string;
  label: string;
  type: 'boolean' | 'enum' | 'multi_enum';
  options?: string[];
  maxSelections?: number;
  definition: string;
  source: 'llm' | 'language_builtin';
  enabled: boolean;
}

// ---- Filters (§8) ----

export type ConditionOperator = 'is' | 'is_not' | 'in' | 'not_in' | 'contains_any' | 'gte' | 'lte';

export interface Condition {
  attribute: string;
  operator: ConditionOperator;
  value: AttributeValue | number;
  minConfidence?: number;
}

export interface RuleGroup {
  op: 'any' | 'all';
  children: (RuleGroup | Condition)[];
}

export interface FilterList {
  id: string;
  name: string;
  rule: RuleGroup;
}

// ---- Behavior (§9) ----

export interface Behavior {
  enabled: boolean;
  hideMode: 'remove' | 'collapse';
  hideUnclassified: boolean;
  exemptOwnSubredditPage: boolean;
}

export interface EnrichmentSettings {
  /** Classify once this many distinct post titles have been seen for a subreddit. */
  minSamples: number;
  /** ...or once this many hours have passed since first seen (with at least one title). */
  maxWaitHours: number;
}

export interface QueueSettings {
  paused: boolean;
  redditMinIntervalMs: number;
}

export interface Settings {
  attributes: AttributeDef[];
  topics: string[];
  profiles: ProviderProfile[];
  defaultProfileId?: string;
  fallbackProfileId?: string;
  filterLists: FilterList[];
  activeFilterListId: string;
  manualBlock: string[];
  manualAllow: string[];
  behavior: Behavior;
  enrichment: EnrichmentSettings;
  queue: QueueSettings;
}

/** What the background publishes for content scripts (SPEC §8 `blockSet` message). */
export interface BlockSet {
  type: 'blockSet';
  names: string[];
  reasons: Record<string, string>;
  behavior: Behavior;
  /** Only when hideUnclassified: names known to be fine (classified and not blocked, or manually allowed). */
  okNames?: string[];
  updatedAt: number;
}

export type RuntimeErrorKind =
  'auth' | 'reddit_permission' | 'reddit_blocked' | 'rate_limit' | 'provider_hint' | 'no_profile' | 'other';

export interface RuntimeError {
  kind: RuntimeErrorKind;
  message: string;
  profileId?: string;
  at: number;
}

export interface RuntimeStatus {
  errors: RuntimeError[];
  /** Per-profile "do not call before" timestamps (rate limit backoff). */
  backoffUntil: Record<string, number>;
  redditPermission: boolean;
}

export interface QueueCounts {
  discovered: number;
  waitingSamples: number;
  waitingLlm: number;
  classified: number;
  refused: number;
  failed: number;
  skipped: number;
  outdatedRubric: number;
  total: number;
}
