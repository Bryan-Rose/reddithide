// RPC handlers. Called by the HTTP layer after it has validated the params.
import { classifyRecord } from '../classify/classifier';
import { computeBlockSet } from '../filters/evaluate';
import { getConnector } from '../providers';
import { ProviderError } from '../providers/types';
import type { ServerRpcMethod, ServerRpcMethods, TestResult } from '../shared/messages';
import { BLOCKSET_KEY, RUNTIME_KEY } from '../shared/settings';
import type { QueueCounts, SubredditRecord, SubredditRow } from '../shared/types';
import { errorMessage } from '../shared/util';
import { publishBlockSet, scheduleBlockSet } from './blockset';
import {
  clearAll,
  clearKv,
  deleteKv,
  deleteRecords,
  getAllRecords,
  getAllUsage,
  getRecord,
  updateRecord,
} from './db';
import { outdatedNames, pump, queueReclassify } from './pipeline';
import { clearErrors, getRuntime } from './runtime';
import { getRubricVersion, getSettings, saveSettings } from './settings';

type Handlers = {
  [M in ServerRpcMethod]: (
    params: ServerRpcMethods[M]['params'],
  ) => ServerRpcMethods[M]['result'] | Promise<ServerRpcMethods[M]['result']>;
};

export function toRow(r: SubredditRecord): SubredditRow {
  return {
    name: r.name,
    displayName: r.displayName,
    firstSeenAt: r.firstSeenAt,
    lastSeenAt: r.lastSeenAt,
    seenCount: r.seenCount,
    pipelineState: r.pipelineState,
    summary: r.classification?.summary,
    values: r.classification?.values,
    overrides: r.overrides,
    over18: r.meta?.over18,
    detectedLanguage: (r.languageEvidence?.firefox ?? r.languageEvidence?.reddit)?.code,
    subscribers: r.meta?.subscribers ?? r.meta?.weeklyActiveUsers,
    model: r.classification?.model,
    rubricVersion: r.classification?.rubricVersion,
    sampleCount: r.samples?.titles.length ?? 0,
    lastError: r.lastError?.message,
  };
}

export function countStates(records: SubredditRecord[], rubric: string): QueueCounts {
  const c: QueueCounts = {
    discovered: 0,
    waitingSamples: 0,
    waitingLlm: 0,
    classified: 0,
    refused: 0,
    failed: 0,
    skipped: 0,
    outdatedRubric: 0,
    total: records.length,
  };
  for (const r of records) {
    switch (r.pipelineState) {
      case 'discovered':
        c.discovered++;
        break;
      case 'meta_done':
        c.waitingSamples++;
        break;
      case 'samples_done':
      case 'language_done':
        c.waitingLlm++;
        break;
      case 'classified':
        c.classified++;
        if (r.classification?.rubricVersion !== rubric) c.outdatedRubric++;
        break;
      default:
        c[r.pipelineState]++;
    }
  }
  return c;
}

/** Hard-coded sample for the options page "Test" button (SPEC §6.2). */
export const TEST_RECORD: SubredditRecord = {
  name: 'askhistorians',
  displayName: 'AskHistorians',
  firstSeenAt: 0,
  lastSeenAt: 0,
  seenCount: 1,
  pipelineState: 'language_done',
  attempts: 0,
  meta: {
    fetchedAt: 0,
    source: 'dom',
    status: 'ok',
    publicDescription:
      'The Portal for Public History. Please read the rules before participating, as we remove all comments which break the rules.',
    over18: false,
  },
  samples: {
    fetchedAt: 0,
    source: 'dom',
    titles: [
      'How did medieval peasants keep track of time without clocks?',
      'Why did the Roman Republic fall when it did?',
      'What did sailors in the Age of Sail actually eat on long voyages?',
      'How accurate is the popular image of Vikings wearing horned helmets?',
      'Were there any successful slave revolts in the ancient world besides Haiti?',
    ],
  },
};

const handlers: Handlers = {
  async getStatus() {
    const rubricVersion = await getRubricVersion();
    return {
      counts: countStates(getAllRecords(), rubricVersion),
      runtime: getRuntime(),
      rubricVersion,
      paused: getSettings().queue.paused,
    };
  },

  listSubreddits() {
    return getAllRecords().map(toRow);
  },

  getSubreddit({ name }) {
    return getRecord(name) ?? null;
  },

  async reclassify({ names, profileId }) {
    const list = names === 'outdated' ? await outdatedNames() : names;
    return { queued: queueReclassify(list, profileId) };
  },

  setOverride({ name, attribute, value }) {
    updateRecord(name, (cur) => {
      if (!cur) return undefined;
      const overrides = { ...cur.overrides };
      if (value === null) delete overrides[attribute];
      else overrides[attribute] = value;
      return { ...cur, overrides: Object.keys(overrides).length ? overrides : undefined };
    });
    scheduleBlockSet(0);
  },

  // No `await` here: reading and saving in one step is what keeps simultaneous changes from losing one.
  setManual({ names, list }) {
    const s = getSettings();
    const drop = new Set(names);
    const manualBlock = s.manualBlock.filter((n) => !drop.has(n));
    const manualAllow = s.manualAllow.filter((n) => !drop.has(n));
    if (list === 'block') manualBlock.push(...names);
    if (list === 'allow') manualAllow.push(...names);
    saveSettings({ manualBlock: manualBlock.sort(), manualAllow: manualAllow.sort() });
  },

  deleteSubreddits({ names }) {
    deleteRecords(names);
    scheduleBlockSet(0);
  },

  setPaused({ paused }) {
    saveSettings({ queue: { ...getSettings().queue, paused } });
    if (!paused) {
      clearErrors(['auth']);
      pump();
    }
  },

  async testProfile({ profile }): Promise<TestResult> {
    const settings = getSettings();
    const started = performance.now();
    try {
      const outcome = await classifyRecord(TEST_RECORD, profile, {
        attributes: settings.attributes,
        topics: settings.topics,
        rubricVersion: await getRubricVersion(),
        retryDelaysMs: [],
      });
      const latencyMs = Math.round(performance.now() - started);
      if (outcome.kind === 'ok') {
        return {
          ok: true,
          latencyMs,
          rawText: outcome.rawText,
          parsed: { summary: outcome.result.summary, values: outcome.result.values },
        };
      }
      if (outcome.kind === 'refused')
        return { ok: false, refused: true, latencyMs, rawText: outcome.rawText, error: outcome.text };
      return { ok: false, latencyMs, rawText: outcome.rawText, error: `Invalid output: ${outcome.message}` };
    } catch (e) {
      return {
        ok: false,
        latencyMs: Math.round(performance.now() - started),
        error: errorMessage(e),
        hint: e instanceof ProviderError ? e.hint : undefined,
      };
    }
  },

  async listModels({ profile }) {
    try {
      return { models: await getConnector(profile.kind).listModels(profile) };
    } catch (e) {
      const hint = e instanceof ProviderError && e.hint ? `\n${e.hint}` : '';
      return { models: [], error: errorMessage(e) + hint };
    }
  },

  previewRule({ rule }) {
    const { names, reasons } = computeBlockSet(getAllRecords(), rule, [], []);
    return { count: names.length, names: names.slice(0, 500), reasons };
  },

  usageSummary() {
    return getAllUsage();
  },

  dismissErrors() {
    clearErrors();
  },

  clearAllData() {
    clearAll();
    deleteKv(BLOCKSET_KEY, RUNTIME_KEY);
    publishBlockSet();
  },

  getSettings() {
    return getSettings();
  },

  saveSettings(patch) {
    saveSettings(patch);
  },

  resetAll() {
    clearAll();
    clearKv();
    publishBlockSet();
  },

  kick() {
    pump();
  },
};

export function handleRpc<M extends ServerRpcMethod>(
  method: M,
  params: ServerRpcMethods[M]['params'],
): Promise<ServerRpcMethods[M]['result']> {
  return Promise.resolve((handlers[method] as (p: unknown) => ServerRpcMethods[M]['result'])(params));
}
