import { render } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { RpcMethods } from '../../shared/messages';
import type { PipelineState, Settings, SubredditRow, UsageRow } from '../../shared/types';
import { rpc } from '../common/backend';
import { effective, formatValue } from '../common/format';
import { usePoll, useSettings } from '../common/hooks';
import { Drawer } from './Drawer';
import { FilterLists } from './FilterLists';
import { Table } from './Table';

type Tab = 'subreddits' | 'filters' | 'usage';
type Status = RpcMethods['getStatus']['result'];

const STATES: PipelineState[] = [
  'discovered',
  'meta_done',
  'samples_done',
  'language_done',
  'classified',
  'refused',
  'failed',
  'skipped',
];

function Review() {
  const [settings, save] = useSettings();
  const [tab, setTab] = useState<Tab>('subreddits');
  const [status, setStatus] = useState<Status | null>(null);
  usePoll(() => void rpc('getStatus').then(setStatus), 5000);
  if (!settings) return <div class="pad muted">Loading…</div>;
  return (
    <div class="review">
      <header class="row">
        <h1 style="margin:0">RedditHide</h1>
        <div class="tabs" style="margin:0; border:none">
          <button class={tab === 'subreddits' ? 'active' : ''} onClick={() => setTab('subreddits')}>
            Subreddits {status ? `(${status.counts.total})` : ''}
          </button>
          <button class={tab === 'filters' ? 'active' : ''} onClick={() => setTab('filters')}>
            Filter lists
          </button>
          <button class={tab === 'usage' ? 'active' : ''} onClick={() => setTab('usage')}>
            Usage
          </button>
        </div>
        <span class="spacer" />
        <a href="options.html" target="_blank">
          Options →
        </a>
      </header>
      {status && status.counts.outdatedRubric > 0 && (
        <div class="banner warn row">
          {status.counts.outdatedRubric} subreddit{status.counts.outdatedRubric === 1 ? ' was' : 's were'}{' '}
          classified with an older rubric. Re-run them?
          <button onClick={() => void rpc('reclassify', { names: 'outdated' })}>Re-run</button>
        </div>
      )}
      {status && status.paused && (
        <div class="banner warn row">
          The queue is paused.
          <button onClick={() => void rpc('setPaused', { paused: false })}>Resume</button>
        </div>
      )}
      {tab === 'subreddits' && <Subreddits settings={settings} revision={status?.revision} />}
      {tab === 'filters' && <FilterLists settings={settings} save={save} />}
      {tab === 'usage' && <Usage settings={settings} />}
    </div>
  );
}

function Subreddits({ settings, revision }: { settings: Settings; revision: string | undefined }) {
  const [rows, setRows] = useState<SubredditRow[]>([]);
  const [query, setQuery] = useState('');
  const [state, setState] = useState<'' | PipelineState>('');
  const [attrFilter, setAttrFilter] = useState('');
  const [attrValue, setAttrValue] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [bulkProfile, setBulkProfile] = useState(settings.defaultProfileId ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [note, setNote] = useState('');

  // The whole table is several MB at 10k subreddits, so it's fetched only when something changed.
  useEffect(() => {
    if (revision) void rpc('listSubreddits').then(setRows);
  }, [revision]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const av = attrValue.trim().toLowerCase();
    return rows.filter((r) => {
      if (state && r.pipelineState !== state) return false;
      if (q && !r.name.includes(q) && !(r.summary ?? '').toLowerCase().includes(q)) return false;
      if (attrFilter) {
        const v = effective(attrFilter, r.values, r.overrides);
        if (!v) return false;
        if (av && !formatValue(v.value).toLowerCase().split(', ').includes(av)) return false;
      }
      return true;
    });
  }, [rows, query, state, attrFilter, attrValue]);

  const names = [...selected];
  const bulk = async (fn: () => Promise<unknown>, msg: string) => {
    await fn();
    setNote(msg);
    setConfirmDelete(false);
  };

  return (
    <div class={`subreddits ${open ? 'with-drawer' : ''}`}>
      <div class="main stack">
        <div class="row toolbar">
          <input
            placeholder="Search name or summary"
            value={query}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          <select value={state} onChange={(e) => setState(e.currentTarget.value as PipelineState | '')}>
            <option value="">all states</option>
            {STATES.map((s) => (
              <option value={s} key={s}>
                {s}
              </option>
            ))}
          </select>
          <select value={attrFilter} onChange={(e) => setAttrFilter(e.currentTarget.value)}>
            <option value="">any attribute</option>
            {settings.attributes
              .filter((a) => a.enabled)
              .map((a) => (
                <option value={a.id} key={a.id}>
                  {a.label}
                </option>
              ))}
          </select>
          {attrFilter && (
            <input
              placeholder="value (e.g. true, en, gaming)"
              value={attrValue}
              onInput={(e) => setAttrValue(e.currentTarget.value)}
            />
          )}
          <span class="muted small">
            {filtered.length} shown{selected.size ? ` · ${selected.size} selected` : ''}
          </span>
        </div>
        {selected.size > 0 && (
          <div class="row toolbar">
            <select value={bulkProfile} onChange={(e) => setBulkProfile(e.currentTarget.value)}>
              {settings.profiles.map((p) => (
                <option value={p.id} key={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              disabled={!settings.profiles.length}
              onClick={() =>
                bulk(
                  () => rpc('reclassify', { names, profileId: bulkProfile || undefined }),
                  `Queued ${names.length} for classification.`,
                )
              }
            >
              Reclassify
            </button>
            <button
              onClick={() =>
                bulk(() => rpc('setManual', { names, list: 'block' }), `Blocked ${names.length}.`)
              }
            >
              Always block
            </button>
            <button
              onClick={() =>
                bulk(() => rpc('setManual', { names, list: 'allow' }), `Allowed ${names.length}.`)
              }
            >
              Always allow
            </button>
            <button
              onClick={() =>
                bulk(
                  () => rpc('setManual', { names, list: 'none' }),
                  `Cleared manual lists for ${names.length}.`,
                )
              }
            >
              Clear manual
            </button>
            {confirmDelete ? (
              <button
                class="danger"
                onClick={() =>
                  bulk(async () => {
                    await rpc('deleteSubreddits', { names });
                    setSelected(new Set());
                    setRows((rs) => rs.filter((r) => !selected.has(r.name)));
                  }, `Deleted ${names.length}.`)
                }
              >
                Really delete {names.length}
              </button>
            ) : (
              <button class="danger" onClick={() => setConfirmDelete(true)}>
                Delete
              </button>
            )}
            <button class="link" onClick={() => setSelected(new Set())}>
              Clear selection
            </button>
          </div>
        )}
        {note && <div class="muted small">{note}</div>}
        <Table
          rows={filtered}
          attrs={settings.attributes}
          selected={selected}
          onSelect={setSelected}
          onOpen={setOpen}
          openName={open}
        />
      </div>
      {open && <Drawer key={open} name={open} settings={settings} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Usage({ settings }: { settings: Settings }) {
  const [usage, setUsage] = useState<UsageRow[]>([]);
  usePoll(() => void rpc('usageSummary').then(setUsage), 10000);
  const byProfile = new Map<
    string,
    { calls: number; failed: number; inT: number; outT: number; model: string }
  >();
  for (const u of usage) {
    const s = byProfile.get(u.profileId) ?? { calls: 0, failed: 0, inT: 0, outT: 0, model: u.model };
    s.calls++;
    if (!u.ok) s.failed++;
    s.inT += u.inputTokens;
    s.outT += u.outputTokens;
    byProfile.set(u.profileId, s);
  }
  return (
    <table class="usage">
      <thead>
        <tr>
          <th>Profile</th>
          <th>Calls</th>
          <th>Failed</th>
          <th>Input tokens</th>
          <th>Output tokens</th>
          <th>Est. cost</th>
        </tr>
      </thead>
      <tbody>
        {[...byProfile].map(([id, s]) => {
          const p = settings.profiles.find((x) => x.id === id);
          const cost =
            p?.priceInputPerMTok !== undefined && p.priceOutputPerMTok !== undefined
              ? `$${((s.inT * p.priceInputPerMTok + s.outT * p.priceOutputPerMTok) / 1e6).toFixed(4)}`
              : '—';
          return (
            <tr key={id}>
              <td>{p?.name ?? `${id.slice(0, 8)} (deleted)`}</td>
              <td>{s.calls}</td>
              <td>{s.failed}</td>
              <td>{s.inT}</td>
              <td>{s.outT}</td>
              <td>{cost}</td>
            </tr>
          );
        })}
        {byProfile.size === 0 && (
          <tr>
            <td colSpan={6} class="muted">
              No LLM calls yet.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

render(<Review />, document.getElementById('app')!);
