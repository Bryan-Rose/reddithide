import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import browser from '../../shared/browser';
import { rpc, type PageStats, type RpcMethods } from '../../shared/messages';
import type { SubredditRecord } from '../../shared/types';
import { effective, formatValue } from '../common/format';
import { usePoll, useSettings } from '../common/hooks';

type Status = RpcMethods['getStatus']['result'];

const REDDIT_ORIGINS = ['*://*.reddit.com/*'];

async function activeTabStats(): Promise<PageStats | null> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return null;
  try {
    return (await browser.tabs.sendMessage(tab.id, { type: 'getPageStats' })) as PageStats;
  } catch {
    return null; // not a reddit tab, or the content script isn't loaded
  }
}

function Popup() {
  const [settings, save] = useSettings();
  const [status, setStatus] = useState<Status | null>(null);
  const [stats, setStats] = useState<PageStats | null>(null);
  const [record, setRecord] = useState<SubredditRecord | null>(null);
  const [message, setMessage] = useState('');

  usePoll(() => {
    void rpc('getStatus')
      .then(setStatus)
      .catch((e) => setMessage(String(e)));
    void activeTabStats().then(setStats);
  }, 2000);

  const pageSub = stats?.pageSubreddits[0];
  useEffect(() => {
    if (!pageSub) return setRecord(null);
    void rpc('getSubreddit', { name: pageSub }).then(setRecord);
  }, [pageSub, status?.counts.classified]);

  if (!settings || !status) return <div class="pad muted">Loading…</div>;

  const behavior = settings.behavior;
  const c = status.counts;
  const grant = () => {
    // Must run synchronously in the click handler (user gesture).
    void browser.permissions.request({ origins: REDDIT_ORIGINS }).then(() => rpc('checkRedditPermission'));
  };
  const openPage = (page: string) => {
    void browser.tabs.create({ url: browser.runtime.getURL(page) });
    window.close();
  };

  return (
    <div class="pad stack">
      <div class="row">
        <strong>RedditHide</strong>
        <span class="spacer" />
        <label class="switch">
          <input
            type="checkbox"
            checked={behavior.enabled}
            onChange={(e) => save({ behavior: { ...behavior, enabled: e.currentTarget.checked } })}
          />
          {behavior.enabled ? 'On' : 'Off'}
        </label>
      </div>

      {!status.runtime.redditPermission && (
        <div class="banner error">
          RedditHide needs access to reddit.com.{' '}
          <button class="primary" onClick={grant}>
            Grant access to reddit.com
          </button>
        </div>
      )}
      {status.runtime.errors
        .filter((e) => e.kind !== 'reddit_permission')
        .map((e) => (
          <div
            class={`banner ${e.kind === 'rate_limit' || e.kind === 'provider_hint' ? 'warn' : 'error'}`}
            key={e.at}
          >
            {e.message}
          </div>
        ))}
      {status.runtime.errors.length > 0 && (
        <button class="link small" onClick={() => void rpc('dismissErrors')}>
          Dismiss messages
        </button>
      )}

      <div class="row">
        <label>
          Filter list
          <select
            value={settings.activeFilterListId}
            onChange={(e) => save({ activeFilterListId: e.currentTarget.value })}
          >
            {settings.filterLists.map((f) => (
              <option value={f.id} key={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <span class="spacer" />
        <span title="Posts hidden on this page">
          Hidden here: <strong>{stats ? stats.hidden : '–'}</strong>
        </span>
      </div>

      <div class="card small">
        <div class="row">
          <strong>Queue</strong>
          <span class="spacer" />
          <button onClick={() => void rpc('setPaused', { paused: !status.paused })}>
            {status.paused ? 'Resume' : 'Pause'}
          </button>
        </div>
        <div class="counts">
          <span>Discovered</span>
          <b>{c.discovered}</b>
          <span>Waiting for post titles</span>
          <b>{c.waitingSamples}</b>
          <span>Waiting for LLM</span>
          <b>{c.waitingLlm}</b>
          <span>Classified</span>
          <b>{c.classified}</b>
          <span>Refused</span>
          <b>{c.refused}</b>
          <span>Failed</span>
          <b>{c.failed}</b>
        </div>
        {status.paused && <div class="muted">Paused.</div>}
      </div>

      {pageSub && (
        <SubredditPanel name={pageSub} record={record} settings={settings} onMessage={setMessage} />
      )}

      {message && <div class="banner info small">{message}</div>}

      <div class="row">
        <button onClick={() => openPage('review.html')}>Review subreddits</button>
        <button onClick={() => void browser.runtime.openOptionsPage().then(() => window.close())}>
          Options
        </button>
      </div>
    </div>
  );
}

function SubredditPanel(props: {
  name: string;
  record: SubredditRecord | null;
  settings: NonNullable<ReturnType<typeof useSettings>[0]>;
  onMessage: (m: string) => void;
}) {
  const { name, record, settings } = props;
  const blocked = settings.manualBlock.includes(name);
  const allowed = settings.manualAllow.includes(name);
  const attrs = settings.attributes.filter((a) => a.enabled);
  return (
    <div class="card small stack">
      <div class="row">
        <strong>r/{record?.displayName ?? name}</strong>
        <span class="spacer" />
        <span class="muted">{record?.pipelineState ?? 'not recorded yet'}</span>
      </div>
      {record?.classification?.summary && <div>{record.classification.summary}</div>}
      {record?.classification && (
        <div>
          {attrs.map((a) => {
            const v = effective(a.id, record.classification?.values, record.overrides);
            if (!v) return null;
            return (
              <span
                class={`chip ${v.value === true ? 'on' : ''}`}
                key={a.id}
                title={`confidence ${v.confidence.toFixed(2)}`}
              >
                {a.label}: {formatValue(v.value)}
                {v.overridden ? ' ✎' : ''}
              </span>
            );
          })}
        </div>
      )}
      <div class="row">
        <button
          onClick={() =>
            void rpc('reclassify', { names: [name] }).then(() =>
              props.onMessage(`Queued r/${name} for classification.`),
            )
          }
        >
          Reclassify
        </button>
        <button
          class={blocked ? 'primary' : ''}
          onClick={() => void rpc('setManual', { names: [name], list: blocked ? 'none' : 'block' })}
        >
          {blocked ? 'Blocked ✓' : 'Always block'}
        </button>
        <button
          class={allowed ? 'primary' : ''}
          onClick={() => void rpc('setManual', { names: [name], list: allowed ? 'none' : 'allow' })}
        >
          {allowed ? 'Allowed ✓' : 'Always allow'}
        </button>
      </div>
    </div>
  );
}

render(<Popup />, document.getElementById('app')!);
