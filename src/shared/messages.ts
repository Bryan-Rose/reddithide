import type {
  AttributeValue,
  ProviderProfile,
  QueueCounts,
  RuleGroup,
  RuntimeStatus,
  Settings,
  SubredditRecord,
  SubredditRow,
  UsageRow,
} from './types';

// ---- Content script → background ----

export interface SeenPost {
  id: string;
  title: string;
  lang?: string;
  /** Original wording from the post's link (SPEC §5.1). */
  originalTitle?: string;
  /** Firefox's language result on the original wording (SPEC §5.3). */
  browserLang?: string;
}

export interface SeenName {
  name: string;
  displayName: string;
  /** True the first time this subreddit appears in the current page view; bumps seenCount. */
  sighting: boolean;
  posts?: SeenPost[];
  /** Subreddit-level NSFW flag when the page exposes it (search results do). */
  over18?: boolean;
  quarantined?: boolean;
}

export interface SeenMessage {
  type: 'seen';
  names: SeenName[];
  url: string;
}

export interface DomSubredditMeta {
  title?: string;
  publicDescription?: string;
  weeklyActiveUsers?: number;
}

export interface SubredditMetaMessage {
  type: 'subredditMeta';
  name: string;
  displayName: string;
  meta: DomSubredditMeta;
}

export interface PageStatsMessage {
  type: 'pageStats';
  hidden: number;
}

export type ContentToBackground = SeenMessage | SubredditMetaMessage | PageStatsMessage;

/** Body of POST /api/seen: the `seen` message without its page URL (SPEC §5.3). */
export type SeenBatch = Pick<SeenMessage, 'names'>;
/** Body of POST /api/meta. */
export type MetaBatch = Omit<SubredditMetaMessage, 'type'>;

// ---- Popup → content script ----

export interface GetPageStats {
  type: 'getPageStats';
}

export interface PageStats {
  hidden: number;
  /** Subreddits whose page the tab is on (empty on feeds). */
  pageSubreddits: string[];
}

// ---- UI → background RPC ----

export interface TestResult {
  ok: boolean;
  latencyMs: number;
  rawText?: string;
  parsed?: unknown;
  refused?: boolean;
  error?: string;
  hint?: string;
}

export interface RpcMethods {
  getStatus: {
    params: void;
    result: {
      counts: QueueCounts;
      runtime: RuntimeStatus;
      rubricVersion: string;
      paused: boolean;
      /** Changes whenever stored data may have changed. */
      revision: string;
    };
  };
  listSubreddits: { params: void; result: SubredditRow[] };
  getSubreddit: { params: { name: string }; result: SubredditRecord | null };
  reclassify: { params: { names: string[] | 'outdated'; profileId?: string }; result: { queued: number } };
  setOverride: { params: { name: string; attribute: string; value: AttributeValue | null }; result: void };
  setManual: { params: { names: string[]; list: 'block' | 'allow' | 'none' }; result: void };
  deleteSubreddits: { params: { names: string[] }; result: void };
  setPaused: { params: { paused: boolean }; result: void };
  testProfile: { params: { profile: ProviderProfile }; result: TestResult };
  listModels: { params: { profile: ProviderProfile }; result: { models: string[]; error?: string } };
  previewRule: {
    params: { rule: RuleGroup };
    result: { count: number; names: string[]; reasons: Record<string, string> };
  };
  usageSummary: { params: void; result: UsageRow[] };
  dismissErrors: { params: void; result: void };
  checkRedditPermission: { params: void; result: { granted: boolean } };
  clearAllData: { params: void; result: void };
  kick: { params: void; result: void };
}

export type RpcMethod = keyof RpcMethods;

export interface RpcRequest<M extends RpcMethod = RpcMethod> {
  type: 'rpc';
  method: M;
  params: RpcMethods[M]['params'];
}

export type RpcResponse<M extends RpcMethod> =
  { ok: true; result: RpcMethods[M]['result'] } | { ok: false; error: string };

/** `null` removes an optional setting, because JSON has no `undefined`. */
export type SettingsPatch = Partial<Omit<Settings, 'defaultProfileId' | 'fallbackProfileId'>> & {
  defaultProfileId?: string | null;
  fallbackProfileId?: string | null;
};

/** The server's RPC: the permission check stays in the extension, and settings move here. */
export type ServerRpcMethods = Omit<RpcMethods, 'checkRedditPermission'> & {
  getSettings: { params: void; result: Settings };
  saveSettings: { params: SettingsPatch; result: void };
  /** clearAllData plus settings, providers and API keys. */
  resetAll: { params: void; result: void };
};

export type ServerRpcMethod = keyof ServerRpcMethods;
