// State-driven, persistent pipeline (SPEC §5.2). The queue *is* the database: each pump looks at
// records by pipelineState, so nothing is lost when the event page unloads.
import { classifyRecord } from '../classify/classifier';
import { ProviderError } from '../providers/types';
import { HISTORY_LIMIT, MAX_ATTEMPTS, RECLASSIFY_AFTER_MS } from '../shared/constants';
import { saveSettings } from '../shared/settings';
import type { PipelineState, ProviderProfile, Settings, SubredditRecord } from '../shared/types';
import { errorMessage } from '../shared/util';
import { addUsage, getByState, updateMany, updateRecord } from './db';
import { detectLanguage } from './language';
import { Limiter } from './limiter';
import { backoffUntil, reportError, setBackoff } from './runtime';
import { getRubricVersion, getSettings } from './state';

// ---- Local enrichment stages ----

/**
 * A local stage moves a record from `from` to `to`. Stages run in order on every pump.
 *
 * Reddit JSON enrichment (about.json, top.json) is not built yet: unauthenticated .json requests
 * are blocked (HTTP 403 "blocked by network security", checked 2026-10-16). To add it later,
 * replace `domMetaStage` with a stage that fetches about.json (and can end in 'skipped' for
 * private/banned subreddits), and add a samples stage that fetches top.json before `domSamplesStage`.
 * Both need a global reddit.com rate limiter honoring settings.queue.redditMinIntervalMs.
 */
export interface LocalStage {
  name: string;
  from: PipelineState;
  to: PipelineState;
  ready(rec: SubredditRecord, settings: Settings, now: number): boolean;
  run(rec: SubredditRecord): Promise<SubredditRecord>;
}

/** Metadata comes from the DOM (subreddit header, search results) and is merged on ingest. */
const domMetaStage: LocalStage = {
  name: 'meta',
  from: 'discovered',
  to: 'meta_done',
  ready: () => true,
  run: async (rec) => rec,
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
  run: async (rec) => rec,
};

const languageStage: LocalStage = {
  name: 'language',
  from: 'samples_done',
  to: 'language_done',
  ready: () => true,
  run: async (rec) => ({ ...rec, detectedLanguage: await detectLanguage(rec) }),
};

export const LOCAL_STAGES: LocalStage[] = [domMetaStage, domSamplesStage, languageStage];

// ---- Pump ----

const limiter = new Limiter();
const inFlight = new Set<string>();
const activeByProfile = new Map<string, number>();
const consecutive429 = new Map<string, number>();
let pumping = false;
let pumpAgain = false;
let onClassified: () => void = () => {};

export function setOnClassified(fn: () => void): void {
  onClassified = fn;
}

export function priority(a: SubredditRecord, b: SubredditRecord): number {
  return b.seenCount - a.seenCount || b.lastSeenAt - a.lastSeenAt;
}

export function pump(): void {
  if (pumping) {
    pumpAgain = true;
    return;
  }
  pumping = true;
  void (async () => {
    try {
      do {
        pumpAgain = false;
        await pumpOnce();
      } while (pumpAgain);
    } catch (e) {
      console.error('[RedditHide] pump failed', e);
    } finally {
      pumping = false;
    }
  })();
}

async function pumpOnce(): Promise<void> {
  const settings = await getSettings();
  if (settings.queue.paused) return;
  const now = Date.now();

  for (const stage of LOCAL_STAGES) {
    const recs = (await getByState(stage.from)).filter((r) => (r.retryAfter ?? 0) <= now).sort(priority);
    for (const rec of recs) {
      if (!stage.ready(rec, settings, now)) continue;
      try {
        const next = await stage.run(rec);
        await updateRecord(rec.name, (cur) => {
          if (!cur || cur.pipelineState !== stage.from) return undefined;
          return { ...cur, ...pickStageFields(next), pipelineState: stage.to };
        });
      } catch (e) {
        await recordFailure(rec.name, stage.name, errorMessage(e), now);
      }
    }
  }

  const candidates = (await getByState('language_done'))
    .filter((r) => !inFlight.has(r.name) && (r.retryAfter ?? 0) <= now)
    .sort(priority);
  for (const rec of candidates) {
    const profile = pickProfile(rec, settings);
    if (!profile) {
      await reportError('no_profile', 'No LLM provider is configured. Add one on the options page.');
      return;
    }
    if ((await backoffUntil(profile.id)) > now) continue;
    const active = activeByProfile.get(profile.id) ?? 0;
    if (active >= Math.max(1, profile.maxConcurrency)) continue;
    activeByProfile.set(profile.id, active + 1);
    inFlight.add(rec.name);
    void classifyJob(rec, profile).finally(() => {
      inFlight.delete(rec.name);
      activeByProfile.set(profile.id, (activeByProfile.get(profile.id) ?? 1) - 1);
      pump();
    });
  }
}

/** Fields a local stage may set. */
function pickStageFields(rec: SubredditRecord): Partial<SubredditRecord> {
  return { detectedLanguage: rec.detectedLanguage, meta: rec.meta, samples: rec.samples };
}

function pickProfile(rec: SubredditRecord, settings: Settings): ProviderProfile | undefined {
  const wanted = rec.pendingReclassify?.profileId ?? settings.defaultProfileId;
  return settings.profiles.find((p) => p.id === wanted) ?? settings.profiles[0];
}

async function recordFailure(name: string, stage: string, message: string, now: number, retryInMs = 60_000) {
  await updateRecord(name, (cur) => {
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
  const settings = await getSettings();
  const rubricVersion = await getRubricVersion();
  const now = Date.now();
  try {
    const outcome = await classifyRecord(rec, profile, {
      attributes: settings.attributes,
      topics: settings.topics,
      rubricVersion,
      gate: (fn) => limiter.run(profile.id, profile, fn),
      onUsage: (usage, ok) => {
        void addUsage({
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
      await updateRecord(rec.name, (cur) => {
        if (!cur) return undefined;
        const history = cur.classification
          ? [cur.classification, ...(cur.classificationHistory ?? [])].slice(0, HISTORY_LIMIT)
          : cur.classificationHistory;
        return {
          ...cur,
          detectedLanguage: rec.detectedLanguage,
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
      onClassified();
      return;
    }

    if (outcome.kind === 'refused') {
      const fallback = settings.fallbackProfileId;
      const useFallback = !!fallback && fallback !== profile.id && !rec.pendingReclassify?.isFallback;
      await updateRecord(rec.name, (cur) => {
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

    await updateRecord(
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
    await handleProviderError(rec, profile, e, now);
  }
}

async function handleProviderError(rec: SubredditRecord, profile: ProviderProfile, e: unknown, now: number) {
  if (!(e instanceof ProviderError)) {
    await recordFailure(rec.name, 'classify', errorMessage(e), now);
    return;
  }
  const withHint = e.hint ? `${e.message}\n${e.hint}` : e.message;
  switch (e.kind) {
    case 'auth': {
      const settings = await getSettings();
      await saveSettings({ queue: { ...settings.queue, paused: true } });
      await reportError(
        'auth',
        `${profile.name}: authentication failed. Queue paused.\n${withHint}`,
        profile.id,
      );
      return;
    }
    case 'rate_limit': {
      const n = (consecutive429.get(profile.id) ?? 0) + 1;
      consecutive429.set(profile.id, n);
      const backoff = e.retryAfterMs ?? Math.min(30_000 * 2 ** (n - 1), 600_000);
      await setBackoff(profile.id, now + backoff);
      await reportError(
        'rate_limit',
        `${profile.name} is rate limiting requests; waiting ${Math.round(backoff / 1000)} s.`,
        profile.id,
      );
      return;
    }
    case 'bad_request':
      if (e.hint) await reportError('provider_hint', `${profile.name}: ${e.hint}`, profile.id);
      await recordFailure(rec.name, 'classify', withHint, now);
      return;
    default:
      if (e.hint) await reportError('provider_hint', `${profile.name}: ${e.hint}`, profile.id);
      await recordFailure(rec.name, 'classify', withHint, now, 5 * 60_000);
  }
}

// ---- Re-classification ----

export async function queueReclassify(names: string[], profileId?: string): Promise<number> {
  const now = Date.now();
  let queued = 0;
  await updateMany(names, (cur) => {
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
  return (await getByState('classified'))
    .filter((r) => r.classification?.rubricVersion !== rubric)
    .map((r) => r.name);
}

/** Daily: queue classifications older than 180 days. */
export async function maintenance(now = Date.now()): Promise<void> {
  const stale = (await getByState('classified')).filter(
    (r) => r.classification && now - r.classification.classifiedAt > RECLASSIFY_AFTER_MS,
  );
  if (stale.length) await queueReclassify(stale.map((r) => r.name));
}
