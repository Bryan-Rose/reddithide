// State-driven, persistent pipeline (SPEC §5.2). The queue *is* the database: each pump looks at
// records by pipelineState, so nothing is lost when the server restarts.
import { buildLanguageEvidence } from '../classify/parse';
import { classifyRecord } from '../classify/classifier';
import { ProviderError } from '../providers/types';
import { HISTORY_LIMIT, MAX_ATTEMPTS, RECLASSIFY_AFTER_MS } from '../shared/constants';
import type { PipelineState, ProviderProfile, Settings, SubredditRecord } from '../shared/types';
import { errorMessage } from '../shared/util';
import { scheduleBlockSet } from './blockset';
import { addUsage, getByState, getKv, setKv, updateMany, updateRecord } from './db';
import { Limiter } from './limiter';
import { backoffUntil, clearErrors, reportError, setBackoff } from './runtime';
import { getRubricVersion, getSettings, onSettingsChanged, saveSettings } from './settings';

const MAINTENANCE_KEY = 'lastMaintenanceAt';
const DAY = 24 * 3600 * 1000;

// ---- Local enrichment stages ----

/**
 * A local stage moves a record from `from` to `to`. Stages run in order on every pump. `run` is
 * synchronous and returns only the fields it changed, so a stage can't overwrite a newer `seen`
 * update with an older copy of the record.
 */
export interface LocalStage {
  name: string;
  from: PipelineState;
  to: PipelineState;
  ready(rec: SubredditRecord, settings: Settings, now: number): boolean;
  run(rec: SubredditRecord): Partial<SubredditRecord>;
}

/** Metadata comes from the DOM (subreddit header, search results) and is merged on ingest. */
const domMetaStage: LocalStage = {
  name: 'meta',
  from: 'discovered',
  to: 'meta_done',
  ready: () => true,
  run: () => ({}),
};

/** Waits until enough post titles have been seen in feeds, or the wait time has passed. */
export function samplesReady(rec: SubredditRecord, settings: Settings, now: number): boolean {
  if (rec.pendingReclassify) return true;
  const n = rec.samples?.titles.length ?? 0;
  if (n >= settings.enrichment.minSamples) return true;
  if (n >= 1 && rec.meta?.publicDescription) return true;
  return n >= 1 && now - rec.firstSeenAt >= settings.enrichment.maxWaitHours * 3600_000;
}

const domSamplesStage: LocalStage = {
  name: 'samples',
  from: 'meta_done',
  to: 'samples_done',
  ready: samplesReady,
  run: () => ({}),
};

const languageStage: LocalStage = {
  name: 'language',
  from: 'samples_done',
  to: 'language_done',
  ready: () => true,
  run: (rec) => ({ languageEvidence: buildLanguageEvidence(rec.samples?.items) }),
};

export const LOCAL_STAGES: LocalStage[] = [domMetaStage, domSamplesStage, languageStage];

// ---- Pump ----

const limiter = new Limiter();
const inFlight = new Set<string>();
const activeByProfile = new Map<string, number>();
const consecutive429 = new Map<string, number>();
let pumpTimer: ReturnType<typeof setTimeout> | null = null;

export function schedulePump(delayMs = 2000): void {
  if (pumpTimer) return;
  pumpTimer = setTimeout(() => {
    pumpTimer = null;
    pump();
  }, delayMs);
}

onSettingsChanged((keys) => {
  if (keys.includes('queue') || keys.includes('profiles') || keys.includes('defaultProfileId')) {
    if (keys.includes('profiles')) clearErrors(['no_profile']);
    pump();
  }
});

export function priority(a: SubredditRecord, b: SubredditRecord): number {
  return b.seenCount - a.seenCount || b.lastSeenAt - a.lastSeenAt;
}

export function pump(): void {
  try {
    pumpOnce();
  } catch (e) {
    console.error('[RedditHide] pump failed', e);
  }
}

function pumpOnce(): void {
  const settings = getSettings();
  if (settings.queue.paused) return;
  const now = Date.now();

  for (const stage of LOCAL_STAGES) {
    const recs = getByState(stage.from)
      .filter((r) => (r.retryAfter ?? 0) <= now)
      .sort(priority);
    for (const rec of recs) {
      if (!stage.ready(rec, settings, now)) continue;
      try {
        updateRecord(rec.name, (cur) => {
          if (!cur || cur.pipelineState !== stage.from) return undefined;
          return { ...cur, ...stage.run(cur), pipelineState: stage.to };
        });
      } catch (e) {
        recordFailure(rec.name, stage.name, errorMessage(e), now);
      }
    }
  }

  const candidates = getByState('language_done')
    .filter((r) => !inFlight.has(r.name) && (r.retryAfter ?? 0) <= now)
    .sort(priority);
  for (const rec of candidates) {
    const profile = pickProfile(rec, settings);
    if (!profile) {
      reportError('no_profile', 'No LLM provider is configured. Add one on the options page.');
      return;
    }
    if (backoffUntil(profile.id) > now) continue;
    const active = activeByProfile.get(profile.id) ?? 0;
    if (active >= Math.max(1, profile.maxConcurrency)) continue;
    activeByProfile.set(profile.id, active + 1);
    inFlight.add(rec.name);
    void classifyJob(rec, profile)
      .catch((e) => console.error('[RedditHide] classify job failed', e))
      .finally(() => {
        inFlight.delete(rec.name);
        activeByProfile.set(profile.id, (activeByProfile.get(profile.id) ?? 1) - 1);
        pump();
      });
  }
}

function pickProfile(rec: SubredditRecord, settings: Settings): ProviderProfile | undefined {
  const wanted = rec.pendingReclassify?.profileId ?? settings.defaultProfileId;
  return settings.profiles.find((p) => p.id === wanted) ?? settings.profiles[0];
}

function recordFailure(name: string, stage: string, message: string, now: number, retryInMs = 60_000) {
  updateRecord(name, (cur) => {
    if (!cur) return undefined;
    const attempts = cur.attempts + 1;
    const failed = attempts >= MAX_ATTEMPTS;
    return {
      ...cur,
      attempts,
      lastError: { at: now, stage, message },
      pipelineState: failed ? 'failed' : cur.pipelineState,
      retryAfter: failed ? undefined : now + retryInMs,
      ...(failed ? { pendingAt: undefined, pendingReclassify: undefined } : {}),
    };
  });
}

// ---- Classification job ----

async function classifyJob(rec: SubredditRecord, profile: ProviderProfile): Promise<void> {
  const settings = getSettings();
  const rubricVersion = await getRubricVersion();
  const now = Date.now();
  try {
    const outcome = await classifyRecord(rec, profile, {
      attributes: settings.attributes,
      topics: settings.topics,
      rubricVersion,
      gate: (fn) => limiter.run(profile.id, profile, fn),
      onUsage: (usage, ok) => {
        addUsage({
          at: Date.now(),
          profileId: profile.id,
          model: profile.model,
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          ok,
        });
      },
    });
    consecutive429.delete(profile.id);

    if (outcome.kind === 'ok') {
      updateRecord(rec.name, (cur) => {
        if (!cur) return undefined;
        const history = cur.classification
          ? [cur.classification, ...(cur.classificationHistory ?? [])].slice(0, HISTORY_LIMIT)
          : cur.classificationHistory;
        return {
          ...cur,
          classification: outcome.result,
          classificationHistory: history,
          pipelineState: 'classified',
          attempts: 0,
          lastError: undefined,
          retryAfter: undefined,
          pendingAt: undefined,
          pendingReclassify: undefined,
        };
      });
      scheduleBlockSet();
      return;
    }

    if (outcome.kind === 'refused') {
      const fallback = settings.fallbackProfileId;
      const useFallback = !!fallback && fallback !== profile.id && !rec.pendingReclassify?.isFallback;
      updateRecord(rec.name, (cur) => {
        if (!cur) return undefined;
        const lastError = {
          at: now,
          stage: 'classify',
          message: `Refused by ${profile.name}: ${outcome.text.slice(0, 300)}`,
        };
        if (useFallback) {
          return {
            ...cur,
            lastError,
            pipelineState: 'language_done',
            pendingAt: now,
            pendingReclassify: { requestedAt: now, profileId: fallback, isFallback: true },
          };
        }
        return {
          ...cur,
          lastError,
          pipelineState: 'refused',
          pendingAt: undefined,
          pendingReclassify: undefined,
        };
      });
      return;
    }

    updateRecord(
      rec.name,
      (cur) =>
        cur && {
          ...cur,
          pipelineState: 'failed',
          lastError: {
            at: now,
            stage: 'classify',
            message: `Invalid output from ${profile.name}: ${outcome.message}`,
          },
          pendingAt: undefined,
          pendingReclassify: undefined,
        },
    );
  } catch (e) {
    handleProviderError(rec, profile, e, now);
  }
}

function handleProviderError(rec: SubredditRecord, profile: ProviderProfile, e: unknown, now: number) {
  if (!(e instanceof ProviderError)) {
    recordFailure(rec.name, 'classify', errorMessage(e), now);
    return;
  }
  const withHint = e.hint ? `${e.message}\n${e.hint}` : e.message;
  switch (e.kind) {
    case 'auth': {
      saveSettings({ queue: { ...getSettings().queue, paused: true } });
      reportError('auth', `${profile.name}: authentication failed. Queue paused.\n${withHint}`, profile.id);
      return;
    }
    case 'rate_limit': {
      const n = (consecutive429.get(profile.id) ?? 0) + 1;
      consecutive429.set(profile.id, n);
      const backoff = e.retryAfterMs ?? Math.min(30_000 * 2 ** (n - 1), 600_000);
      setBackoff(profile.id, now + backoff);
      reportError(
        'rate_limit',
        `${profile.name} is rate limiting requests; waiting ${Math.round(backoff / 1000)} s.`,
        profile.id,
      );
      return;
    }
    case 'bad_request':
      if (e.hint) reportError('provider_hint', `${profile.name}: ${e.hint}`, profile.id);
      recordFailure(rec.name, 'classify', withHint, now);
      return;
    default:
      if (e.hint) reportError('provider_hint', `${profile.name}: ${e.hint}`, profile.id);
      recordFailure(rec.name, 'classify', withHint, now, 5 * 60_000);
  }
}

// ---- Re-classification ----

export function queueReclassify(names: string[], profileId?: string): number {
  const now = Date.now();
  let queued = 0;
  updateMany(names, (cur) => {
    if (!cur) return undefined;
    queued++;
    return {
      ...cur,
      pipelineState: 'samples_done',
      attempts: 0,
      lastError: undefined,
      retryAfter: undefined,
      pendingAt: now,
      pendingReclassify: { requestedAt: now, profileId },
    };
  });
  pump();
  return queued;
}

/** Records classified with an older rubric (offered for re-run, never automatic). */
export async function outdatedNames(): Promise<string[]> {
  const rubric = await getRubricVersion();
  return getByState('classified')
    .filter((r) => r.classification?.rubricVersion !== rubric)
    .map((r) => r.name);
}

/** Daily: queue classifications older than 180 days. */
function maintenance(now: number): void {
  if (now - (getKv<number>(MAINTENANCE_KEY) ?? 0) <= DAY) return;
  setKv(MAINTENANCE_KEY, now);
  const stale = getByState('classified').filter(
    (r) => r.classification && now - r.classification.classifiedAt > RECLASSIFY_AFTER_MS,
  );
  if (stale.length) queueReclassify(stale.map((r) => r.name));
}

/** Runs from the one-minute timer. */
export function tick(now = Date.now()): void {
  pump();
  try {
    maintenance(now);
  } catch (e) {
    console.error('[RedditHide] maintenance failed', e);
  }
}
