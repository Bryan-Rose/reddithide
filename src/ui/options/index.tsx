import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { computeRubricVersion } from '../../classify/rubric';
import browser from '../../shared/browser';
import { isLocalUrl, PROVIDER_PRESETS, type ProviderPreset } from '../../shared/constants';
import type { TestResult } from '../../shared/messages';
import { rpc } from '../../shared/rpc';
import { defaultSettings } from '../../shared/settings';
import type { AttributeDef, ProviderProfile, Settings } from '../../shared/types';
import { maskKey, originPattern, uuid } from '../../shared/util';
import { useSettings } from '../common/hooks';

type Save = (patch: Partial<Settings>) => Promise<void>;
type Tab = 'providers' | 'attributes' | 'behavior' | 'data';

function Options() {
  const [settings, save] = useSettings();
  const [tab, setTab] = useState<Tab>('providers');
  if (!settings) return <div class="page muted">Loading…</div>;
  return (
    <div class="page">
      <h1>RedditHide options</h1>
      <div class="tabs">
        {(['providers', 'attributes', 'behavior', 'data'] as Tab[]).map((t) => (
          <button class={tab === t ? 'active' : ''} onClick={() => setTab(t)} key={t}>
            {
              {
                providers: 'Providers',
                attributes: 'Attributes & topics',
                behavior: 'Behavior',
                data: 'Data',
              }[t]
            }
          </button>
        ))}
        <span class="spacer" />
        <button
          class="link"
          onClick={() => void browser.tabs.create({ url: browser.runtime.getURL('review.html') })}
        >
          Open review page →
        </button>
      </div>
      {tab === 'providers' && <Providers settings={settings} save={save} />}
      {tab === 'attributes' && <Attributes settings={settings} save={save} />}
      {tab === 'behavior' && <BehaviorTab settings={settings} save={save} />}
      {tab === 'data' && <DataTab />}
    </div>
  );
}

// ---------------- Providers ----------------

function profileFromPreset(p: ProviderPreset): ProviderProfile {
  const local = !!p.local || isLocalUrl(p.baseUrl);
  return {
    id: uuid(),
    name: p.label === 'Custom' ? 'Custom provider' : p.label,
    kind: p.kind,
    baseUrl: p.baseUrl,
    model: p.suggestedModel ?? '',
    structuredOutput: p.structuredOutput,
    temperature: 0,
    maxConcurrency: local ? 1 : 2,
    requestsPerMinute: 30,
    timeoutMs: local ? 180000 : 60000,
  };
}

/** Starts a permission request for the profile's origin. Call synchronously from a click handler. */
function requestOrigin(profile: ProviderProfile): Promise<boolean> {
  const pattern = originPattern(profile.baseUrl);
  if (!pattern) return Promise.resolve(false);
  return browser.permissions.request({ origins: [pattern] });
}

function Providers({ settings, save }: { settings: Settings; save: Save }) {
  const [editing, setEditing] = useState<ProviderProfile | null>(null);
  const [presetIdx, setPresetIdx] = useState(0);

  const upsert = async (p: ProviderProfile) => {
    const exists = settings.profiles.some((x) => x.id === p.id);
    const profiles = exists
      ? settings.profiles.map((x) => (x.id === p.id ? p : x))
      : [...settings.profiles, p];
    await save({ profiles, defaultProfileId: settings.defaultProfileId ?? p.id });
  };
  const remove = async (id: string) => {
    await save({
      profiles: settings.profiles.filter((p) => p.id !== id),
      defaultProfileId: settings.defaultProfileId === id ? undefined : settings.defaultProfileId,
      fallbackProfileId: settings.fallbackProfileId === id ? undefined : settings.fallbackProfileId,
    });
    setEditing(null);
  };

  return (
    <div class="stack">
      <div class="banner warn small">
        API keys are stored unencrypted in this browser profile's extension storage. Use keys with spending
        limits. Only public subreddit data (names, descriptions, post titles) is sent to providers.
      </div>
      <div class="row">
        <select value={presetIdx} onChange={(e) => setPresetIdx(Number(e.currentTarget.value))}>
          {PROVIDER_PRESETS.map((p, i) => (
            <option value={i} key={p.label}>
              {p.label}
            </option>
          ))}
        </select>
        <button class="primary" onClick={() => setEditing(profileFromPreset(PROVIDER_PRESETS[presetIdx]!))}>
          Add provider
        </button>
      </div>

      {settings.profiles.length === 0 && !editing && (
        <div class="muted">No providers yet. Classification waits until you add one.</div>
      )}
      <table class="list">
        <tbody>
          {settings.profiles.map((p) => (
            <tr key={p.id}>
              <td>
                <strong>{p.name}</strong>
                <div class="muted small">
                  {p.kind} · {p.model || '(no model)'} · {p.baseUrl}{' '}
                  {p.apiKey ? `· key ${maskKey(p.apiKey)}` : ''}
                </div>
              </td>
              <td class="nowrap">
                <label class="small">
                  <input
                    type="radio"
                    name="default"
                    checked={settings.defaultProfileId === p.id}
                    onChange={() => save({ defaultProfileId: p.id })}
                  />
                  default
                </label>{' '}
                <label class="small">
                  <input
                    type="checkbox"
                    checked={settings.fallbackProfileId === p.id}
                    onChange={(e) => save({ fallbackProfileId: e.currentTarget.checked ? p.id : undefined })}
                  />
                  fallback on refusal
                </label>
              </td>
              <td class="nowrap">
                <button onClick={() => setEditing({ ...p })}>Edit</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {editing && (
        <ProfileEditor
          key={editing.id}
          initial={editing}
          isNew={!settings.profiles.some((p) => p.id === editing.id)}
          onSave={async (p) => {
            await upsert(p);
            setEditing(null);
          }}
          onCancel={() => setEditing(null)}
          onDelete={() => remove(editing.id)}
        />
      )}
    </div>
  );
}

function ProfileEditor(props: {
  initial: ProviderProfile;
  isNew: boolean;
  onSave: (p: ProviderProfile) => Promise<void>;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const [p, setP] = useState<ProviderProfile>(props.initial);
  const [headersText, setHeadersText] = useState(
    p.extraHeaders ? JSON.stringify(p.extraHeaders, null, 2) : '',
  );
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [test, setTest] = useState<TestResult | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const set = <K extends keyof ProviderProfile>(k: K, v: ProviderProfile[K]) =>
    setP((old) => ({ ...old, [k]: v }));

  const build = (): ProviderProfile | null => {
    let extraHeaders: Record<string, string> | undefined;
    if (headersText.trim()) {
      try {
        extraHeaders = JSON.parse(headersText) as Record<string, string>;
      } catch {
        setNote('Extra headers must be a JSON object, e.g. {"HTTP-Referer": "https://example.com"}');
        return null;
      }
    }
    if (!originPattern(p.baseUrl)) {
      setNote('Base URL must start with http:// or https://');
      return null;
    }
    return {
      ...p,
      baseUrl: p.baseUrl.trim().replace(/\/+$/, ''),
      apiKey: p.apiKey?.trim() || undefined,
      extraHeaders,
    };
  };

  // Each handler starts the permission request before any await: it needs the click's user gesture.
  const onSave = () => {
    const profile = build();
    if (!profile) return;
    const perm = requestOrigin(profile);
    void perm.then(async (granted) => {
      if (!granted)
        setNote(`Permission for ${originPattern(profile.baseUrl)} was not granted; requests will fail.`);
      await props.onSave(profile);
    });
  };
  const onTest = () => {
    const profile = build();
    if (!profile) return;
    const perm = requestOrigin(profile);
    setBusy('test');
    setTest(null);
    void perm
      .then(() => rpc('testProfile', { profile }))
      .then(setTest)
      .catch((e) => setNote(String(e)))
      .finally(() => setBusy(''));
  };
  const onList = () => {
    const profile = build();
    if (!profile) return;
    const perm = requestOrigin(profile);
    setBusy('models');
    void perm
      .then(() => rpc('listModels', { profile }))
      .then((r) => {
        setModels(r.models);
        setNote(r.error ? `List models failed: ${r.error}` : `${r.models.length} models found.`);
      })
      .finally(() => setBusy(''));
  };

  return (
    <div class="card stack">
      <h3>{props.isNew ? 'New provider' : `Edit ${props.initial.name}`}</h3>
      <div class="grid-form">
        <label>Name</label>
        <input value={p.name} onInput={(e) => set('name', e.currentTarget.value)} />
        <label>Kind</label>
        <select
          value={p.kind}
          onChange={(e) => set('kind', e.currentTarget.value as ProviderProfile['kind'])}
        >
          <option value="anthropic">Anthropic</option>
          <option value="openai-compatible">OpenAI-compatible</option>
        </select>
        <label>Base URL</label>
        <input
          value={p.baseUrl}
          placeholder="https://…"
          onInput={(e) => set('baseUrl', e.currentTarget.value)}
        />
        <label>API key</label>
        <input
          type="password"
          autocomplete="off"
          value={p.apiKey ?? ''}
          placeholder={isLocalUrl(p.baseUrl) ? 'not needed for local servers' : ''}
          onInput={(e) => set('apiKey', e.currentTarget.value)}
        />
        <label>Model</label>
        <div class="row">
          <input
            list="models"
            value={p.model}
            onInput={(e) => set('model', e.currentTarget.value)}
            style="flex:1"
          />
          <datalist id="models">
            {models.map((m) => (
              <option value={m} key={m} />
            ))}
          </datalist>
          <button onClick={onList} disabled={busy === 'models'}>
            {busy === 'models' ? 'Listing…' : 'List models'}
          </button>
        </div>
        <label>Structured output</label>
        <select
          value={p.structuredOutput}
          onChange={(e) =>
            set('structuredOutput', e.currentTarget.value as ProviderProfile['structuredOutput'])
          }
        >
          <option value="native">native (JSON schema)</option>
          <option value="json_object">json_object</option>
          <option value="prompt_only">prompt only</option>
        </select>
        <label>Temperature</label>
        <input
          type="number"
          step="0.1"
          min="0"
          max="2"
          value={p.temperature}
          onInput={(e) => set('temperature', Number(e.currentTarget.value))}
        />
        <label>Max concurrency</label>
        <input
          type="number"
          min="1"
          max="16"
          value={p.maxConcurrency}
          onInput={(e) => set('maxConcurrency', Number(e.currentTarget.value))}
        />
        <label>Requests / minute</label>
        <input
          type="number"
          min="1"
          value={p.requestsPerMinute}
          onInput={(e) => set('requestsPerMinute', Number(e.currentTarget.value))}
        />
        <label>Timeout (ms)</label>
        <input
          type="number"
          min="1000"
          step="1000"
          value={p.timeoutMs}
          onInput={(e) => set('timeoutMs', Number(e.currentTarget.value))}
        />
        <label>Extra headers (JSON)</label>
        <textarea
          value={headersText}
          placeholder='{"HTTP-Referer": "…", "X-Title": "RedditHide"}'
          onInput={(e) => setHeadersText(e.currentTarget.value)}
        />
        <label>Price in / out ($ per M tokens)</label>
        <div class="row">
          <input
            type="number"
            step="0.01"
            min="0"
            value={p.priceInputPerMTok ?? ''}
            onInput={(e) =>
              set(
                'priceInputPerMTok',
                e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value),
              )
            }
          />
          <input
            type="number"
            step="0.01"
            min="0"
            value={p.priceOutputPerMTok ?? ''}
            onInput={(e) =>
              set(
                'priceOutputPerMTok',
                e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value),
              )
            }
          />
        </div>
      </div>
      {isLocalUrl(p.baseUrl) && (
        <div class="banner info small">
          Local servers must allow the extension's origin. For Ollama, start it with{' '}
          <code>OLLAMA_ORIGINS="moz-extension://*"</code>.
        </div>
      )}
      {note && <div class="banner info small">{note}</div>}
      <div class="row">
        <button class="primary" onClick={onSave}>
          Save
        </button>
        <button onClick={onTest} disabled={busy === 'test'}>
          {busy === 'test' ? 'Testing…' : 'Test'}
        </button>
        <button onClick={props.onCancel}>Cancel</button>
        <span class="spacer" />
        {!props.isNew &&
          (confirmDelete ? (
            <button class="danger" onClick={props.onDelete}>
              Really delete
            </button>
          ) : (
            <button class="danger" onClick={() => setConfirmDelete(true)}>
              Delete
            </button>
          ))}
      </div>
      {test && <TestOutput result={test} />}
    </div>
  );
}

function TestOutput({ result }: { result: TestResult }) {
  return (
    <div class="stack small">
      <div class={`banner ${result.ok ? 'info' : 'error'}`}>
        {result.ok ? 'Success' : result.refused ? 'Refused' : 'Failed'} in {result.latencyMs} ms
        {result.error ? `: ${result.error}` : ''}
        {result.hint ? `\n${result.hint}` : ''}
      </div>
      {result.parsed !== undefined && (
        <>
          <strong>Parsed result</strong>
          <pre>{JSON.stringify(result.parsed, null, 2)}</pre>
        </>
      )}
      {result.rawText !== undefined && (
        <>
          <strong>Raw response</strong>
          <pre>{result.rawText || '(empty)'}</pre>
        </>
      )}
    </div>
  );
}

// ---------------- Attributes & topics ----------------

const BUILTIN_IDS = new Set(['topic', 'language', 'nsfw_sexual', 'gross']);

function Attributes({ settings, save }: { settings: Settings; save: Save }) {
  const [attrs, setAttrs] = useState<AttributeDef[]>(settings.attributes);
  const [topicsText, setTopicsText] = useState(settings.topics.join(', '));
  const [savedVersion, setSavedVersion] = useState('');
  const [draftVersion, setDraftVersion] = useState('');
  const [note, setNote] = useState('');

  const topics = topicsText
    .split(/[,\n]/)
    .map((t) => t.trim().toLowerCase().replace(/\s+/g, '_'))
    .filter(Boolean);

  useEffect(() => {
    void computeRubricVersion(settings.attributes, settings.topics).then(setSavedVersion);
  }, [settings.attributes, settings.topics]);
  useEffect(() => {
    void computeRubricVersion(attrs, topics).then(setDraftVersion);
  }, [attrs, topicsText]);

  const update = (i: number, patch: Partial<AttributeDef>) =>
    setAttrs((old) => old.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  const move = (i: number, d: number) =>
    setAttrs((old) => {
      const next = [...old];
      const [a] = next.splice(i, 1);
      next.splice(Math.max(0, Math.min(next.length, i + d)), 0, a!);
      return next;
    });
  const add = () =>
    setAttrs((old) => [
      ...old,
      { id: '', label: '', type: 'boolean', definition: '', source: 'llm', enabled: true },
    ]);

  const onSave = async () => {
    const ids = new Set<string>();
    for (const a of attrs) {
      if (!/^[a-z][a-z0-9_]*$/.test(a.id)) return setNote(`Attribute id "${a.id}" must be snake_case.`);
      if (ids.has(a.id)) return setNote(`Duplicate attribute id "${a.id}".`);
      ids.add(a.id);
      if (a.source === 'llm' && !a.definition.trim())
        return setNote(`Attribute "${a.id}" needs a definition.`);
      if (a.type !== 'boolean' && a.id !== 'topic' && !(a.options ?? []).length)
        return setNote(`Attribute "${a.id}" needs a list of options.`);
    }
    if (!topics.includes('other')) topics.push('other');
    await save({ attributes: attrs.map((a) => ({ ...a, label: a.label || a.id })), topics });
    setTopicsText(topics.join(', '));
    setNote(
      'Saved. Subreddits classified with the previous rubric are offered for re-classification on the review page.',
    );
  };
  const reset = () => {
    const d = defaultSettings();
    setAttrs(d.attributes);
    setTopicsText(d.topics.join(', '));
  };

  return (
    <div class="stack">
      <div class="small muted">
        Current rubric version: <code>{savedVersion}</code>
        {draftVersion && draftVersion !== savedVersion && (
          <>
            {' '}
            → unsaved changes will make it <code>{draftVersion}</code>
          </>
        )}
      </div>
      {attrs.map((a, i) => (
        <div class={`card stack ${a.enabled ? '' : 'disabled'}`} key={i}>
          <div class="row">
            <input
              placeholder="id (snake_case)"
              value={a.id}
              disabled={BUILTIN_IDS.has(a.id) && settings.attributes.some((x) => x.id === a.id)}
              onInput={(e) => update(i, { id: e.currentTarget.value })}
              style="width: 160px"
            />
            <input
              placeholder="Label"
              value={a.label}
              onInput={(e) => update(i, { label: e.currentTarget.value })}
            />
            <select
              value={a.type}
              disabled={a.source === 'language_builtin' || a.id === 'topic'}
              onChange={(e) => update(i, { type: e.currentTarget.value as AttributeDef['type'] })}
            >
              <option value="boolean">yes/no</option>
              <option value="enum">one of</option>
              <option value="multi_enum">several of</option>
            </select>
            {a.type === 'multi_enum' && (
              <label class="small">
                max
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={a.maxSelections ?? 3}
                  onInput={(e) => update(i, { maxSelections: Number(e.currentTarget.value) })}
                  style="width: 56px"
                />
              </label>
            )}
            <label class="small">
              <input
                type="checkbox"
                checked={a.enabled}
                onChange={(e) => update(i, { enabled: e.currentTarget.checked })}
              />
              enabled
            </label>
            <span class="spacer" />
            <button onClick={() => move(i, -1)} disabled={i === 0} title="Move up">
              ↑
            </button>
            <button onClick={() => move(i, 1)} disabled={i === attrs.length - 1} title="Move down">
              ↓
            </button>
            {a.source !== 'language_builtin' && (
              <button class="danger" onClick={() => setAttrs((old) => old.filter((_, j) => j !== i))}>
                Remove
              </button>
            )}
          </div>
          {a.source === 'language_builtin' ? (
            <div class="small muted">
              Detected locally (Reddit's post-language tags, then browser language detection), with the
              model's guess as a fallback. Values are ISO 639-1 codes, "mixed" or "und".
            </div>
          ) : (
            <>
              <textarea
                placeholder="Plain-English rubric sent to the model, e.g. 'True if the community is mostly about current political disputes.'"
                value={a.definition}
                onInput={(e) => update(i, { definition: e.currentTarget.value })}
              />
              {a.type !== 'boolean' && a.id !== 'topic' && (
                <input
                  placeholder="Options, comma-separated"
                  value={(a.options ?? []).join(', ')}
                  onInput={(e) =>
                    update(i, {
                      options: e.currentTarget.value
                        .split(',')
                        .map((s) => s.trim().toLowerCase().replace(/\s+/g, '_'))
                        .filter(Boolean),
                    })
                  }
                />
              )}
              {a.id === 'topic' && <div class="small muted">Options come from the topic list below.</div>}
            </>
          )}
        </div>
      ))}
      <div class="row">
        <button onClick={add}>Add attribute</button>
        <span class="muted small">Ideas: political, rage_bait, spoilers_heavy</span>
      </div>
      <h3>Topics</h3>
      <textarea
        value={topicsText}
        onInput={(e) => setTopicsText(e.currentTarget.value)}
        style="min-height: 100px"
      />
      {note && <div class="banner info small">{note}</div>}
      <div class="row">
        <button class="primary" onClick={onSave}>
          Save attributes & topics
        </button>
        <button onClick={reset}>Reset to defaults</button>
      </div>
    </div>
  );
}

// ---------------- Behavior ----------------

function BehaviorTab({ settings, save }: { settings: Settings; save: Save }) {
  const b = settings.behavior;
  const en = settings.enrichment;
  return (
    <div class="stack">
      <div class="grid-form">
        <label>Hiding</label>
        <label>
          <input
            type="checkbox"
            checked={b.enabled}
            onChange={(e) => save({ behavior: { ...b, enabled: e.currentTarget.checked } })}
          />
          enabled
        </label>
        <label>Hide mode</label>
        <select
          value={b.hideMode}
          onChange={(e) => save({ behavior: { ...b, hideMode: e.currentTarget.value as typeof b.hideMode } })}
        >
          <option value="collapse">collapse to a one-line placeholder</option>
          <option value="remove">remove completely</option>
        </select>
        <label>Unclassified subreddits</label>
        <label>
          <input
            type="checkbox"
            checked={b.hideUnclassified}
            onChange={(e) => save({ behavior: { ...b, hideUnclassified: e.currentTarget.checked } })}
          />
          hide until classified
        </label>
        <label>Subreddit pages</label>
        <label>
          <input
            type="checkbox"
            checked={b.exemptOwnSubredditPage}
            onChange={(e) => save({ behavior: { ...b, exemptOwnSubredditPage: e.currentTarget.checked } })}
          />
          never hide posts on /r/name when I browse to that subreddit
        </label>
      </div>
      <h3>When to classify</h3>
      <p class="small muted">
        Post titles are collected from the feeds you browse. A subreddit is classified once enough titles have
        been seen, or after a waiting time. Visiting the subreddit (or clicking Reclassify) classifies it
        right away.
      </p>
      <div class="grid-form">
        <label>Titles needed</label>
        <input
          type="number"
          min="1"
          max="25"
          value={en.minSamples}
          onChange={(e) => save({ enrichment: { ...en, minSamples: Number(e.currentTarget.value) } })}
        />
        <label>…or wait (hours)</label>
        <input
          type="number"
          min="0"
          value={en.maxWaitHours}
          onChange={(e) => save({ enrichment: { ...en, maxWaitHours: Number(e.currentTarget.value) } })}
        />
        <label>Reddit request interval (ms)</label>
        <input
          type="number"
          min="1000"
          step="500"
          value={settings.queue.redditMinIntervalMs}
          onChange={(e) =>
            save({ queue: { ...settings.queue, redditMinIntervalMs: Number(e.currentTarget.value) } })
          }
        />
      </div>
      <p class="small muted">
        The request interval applies to direct reddit.com requests, which aren't made yet: Reddit currently
        blocks its .json endpoints for extensions.
      </p>
    </div>
  );
}

// ---------------- Data ----------------

function DataTab() {
  const [confirm, setConfirm] = useState<'' | 'data' | 'all'>('');
  const [note, setNote] = useState('');
  const clearData = async () => {
    await rpc('clearAllData');
    setConfirm('');
    setNote('Subreddit data and usage cleared.');
  };
  const resetAll = async () => {
    await rpc('clearAllData');
    await browser.storage.local.clear();
    setConfirm('');
    setNote('Everything was reset, including providers and API keys.');
  };
  return (
    <div class="stack">
      <p class="muted small">Backup export and import arrive in a later milestone.</p>
      <div class="row">
        {confirm === 'data' ? (
          <>
            <button class="danger" onClick={clearData}>
              Yes, delete all subreddit data
            </button>
            <button onClick={() => setConfirm('')}>Cancel</button>
          </>
        ) : (
          <button class="danger" onClick={() => setConfirm('data')}>
            Clear subreddit data…
          </button>
        )}
        <span class="muted small">
          Recorded subreddits, classifications and usage. Settings and providers are kept.
        </span>
      </div>
      <div class="row">
        {confirm === 'all' ? (
          <>
            <button class="danger" onClick={resetAll}>
              Yes, reset everything
            </button>
            <button onClick={() => setConfirm('')}>Cancel</button>
          </>
        ) : (
          <button class="danger" onClick={() => setConfirm('all')}>
            Reset everything…
          </button>
        )}
        <span class="muted small">Also removes settings, filter lists, providers and API keys.</span>
      </div>
      {note && <div class="banner info small">{note}</div>}
    </div>
  );
}

render(<Options />, document.getElementById('app')!);
