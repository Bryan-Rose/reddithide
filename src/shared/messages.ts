import browser from './browser';
import type {
  AttributeValue,
  ProviderProfile,
  QueueCounts,
  RuleGroup,
  RuntimeStatus,
  SubredditRecord,
  SubredditRow,
  UsageRow,
} from './types';

// ---- Content script → background ----

export interface SeenPost {
  id: string;
  title: string;
  lang?: string;
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
    result: { counts: QueueCounts; runtime: RuntimeStatus; rubricVersion: string; paused: boolean };
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

export async function rpc<M extends RpcMethod>(
  method: M,
  ...args: RpcMethods[M]['params'] extends void ? [] : [RpcMethods[M]['params']]
): Promise<RpcMethods[M]['result']> {
  const req: RpcRequest<M> = { type: 'rpc', method, params: args[0] as RpcMethods[M]['params'] };
  const res = (await browser.runtime.sendMessage(req)) as RpcResponse<M> | undefined;
  if (!res) throw new Error('No response from background');
  if (!res.ok) throw new Error(res.error);
  return res.result;
}
