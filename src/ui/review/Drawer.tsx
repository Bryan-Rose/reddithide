import { useEffect, useState } from 'preact/hooks';
import { rpc } from '../../shared/messages';
import { subredditUrl } from '../../shared/names';
import type { AttributeDef, AttributeValue, Settings, SubredditRecord } from '../../shared/types';
import { formatAgo, formatNumber, formatValue } from '../common/format';

export function Drawer({
  name,
  settings,
  onClose,
}: {
  name: string;
  settings: Settings;
  onClose: () => void;
}) {
  const [rec, setRec] = useState<SubredditRecord | null>(null);
  const [profileId, setProfileId] = useState(settings.defaultProfileId ?? '');
  const [note, setNote] = useState('');
  const reload = () => void rpc('getSubreddit', { name }).then(setRec);
  useEffect(() => {
    reload();
    const id = setInterval(reload, 3000);
    return () => clearInterval(id);
  }, [name]);

  if (!rec) return <aside class="drawer">Loading…</aside>;
  const m = rec.meta;
  const c = rec.classification;
  const blocked = settings.manualBlock.includes(name);
  const allowed = settings.manualAllow.includes(name);

  return (
    <aside class="drawer stack">
      <div class="row">
        <h2 style="margin:0">
          <a href={subredditUrl(rec.displayName)} target="_blank" rel="noreferrer noopener">
            r/{rec.displayName}
          </a>
        </h2>
        <span class="spacer" />
        <button onClick={onClose}>Close</button>
      </div>
      <div class="muted small">
        {rec.pipelineState} · seen {rec.seenCount}× · first {formatAgo(rec.firstSeenAt)} · last{' '}
        {formatAgo(rec.lastSeenAt)}
      </div>
      {rec.lastError && (
        <div class="banner error small">
          {rec.lastError.stage}: {rec.lastError.message}
        </div>
      )}
      {c?.summary && <div>{c.summary}</div>}

      <div class="row">
        <select value={profileId} onChange={(e) => setProfileId(e.currentTarget.value)}>
          {settings.profiles.map((p) => (
            <option value={p.id} key={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          disabled={!settings.profiles.length}
          onClick={() =>
            void rpc('reclassify', { names: [name], profileId: profileId || undefined }).then(() =>
              setNote('Queued.'),
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
      {note && <div class="muted small">{note}</div>}

      <h3>Attributes</h3>
      <table class="kv">
        <tbody>
          {settings.attributes
            .filter((a) => a.enabled)
            .map((a) => (
              <AttributeRow key={a.id} attr={a} rec={rec} settings={settings} onChanged={reload} />
            ))}
        </tbody>
      </table>
      {c && (
        <div class="muted small">
          {c.model} · rubric {c.rubricVersion} · {formatAgo(c.classifiedAt)}
          {c.usage ? ` · ${c.usage.inputTokens ?? 0} in / ${c.usage.outputTokens ?? 0} out tokens` : ''}
        </div>
      )}

      <h3>Metadata</h3>
      <table class="kv small">
        <tbody>
          <KV k="Source" v={m?.source} />
          <KV k="Title" v={m?.title} />
          <KV k="Description" v={m?.publicDescription} />
          <KV k="Reddit over18" v={m?.over18 === undefined ? 'unknown' : String(m.over18)} />
          <KV k="Quarantined" v={m?.quarantined === undefined ? undefined : String(m.quarantined)} />
          <KV k="Weekly visitors" v={formatNumber(m?.weeklyActiveUsers)} />
          <KV k="Subscribers" v={formatNumber(m?.subscribers)} />
          <KV
            k="Detected language"
            v={
              rec.detectedLanguage
                ? `${rec.detectedLanguage.code} (${rec.detectedLanguage.percentage}%, ${rec.detectedLanguage.reliable ? 'reliable' : 'unreliable'}, ${rec.detectedLanguage.source})`
                : undefined
            }
          />
        </tbody>
      </table>

      <h3>Sample titles ({rec.samples?.titles.length ?? 0})</h3>
      <ul class="titles small">
        {(rec.samples?.items ?? []).map((i) => (
          <li key={i.id}>
            {i.title} {i.lang && <span class="muted">[{i.lang}]</span>}
          </li>
        ))}
      </ul>

      {(rec.classificationHistory?.length ?? 0) > 0 && (
        <>
          <h3>History</h3>
          {rec.classificationHistory!.map((h, i) => (
            <div class="small" key={i}>
              <span class="muted">
                {new Date(h.classifiedAt).toLocaleString()} · {h.model} · {h.rubricVersion}
              </span>
              <div>
                {Object.entries(h.values).map(([k, v]) => (
                  <span class="chip" key={k}>
                    {k}: {formatValue(v.value)}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </>
      )}
    </aside>
  );
}

function KV({ k, v }: { k: string; v: string | undefined }) {
  if (!v) return null;
  return (
    <tr>
      <th>{k}</th>
      <td>{v}</td>
    </tr>
  );
}

function AttributeRow(props: {
  attr: AttributeDef;
  rec: SubredditRecord;
  settings: Settings;
  onChanged: () => void;
}) {
  const { attr, rec, settings } = props;
  const v = rec.classification?.values[attr.id];
  const override = rec.overrides?.[attr.id];
  const options = attr.id === 'topic' ? settings.topics : (attr.options ?? []);
  const setOverride = (value: AttributeValue | null) =>
    void rpc('setOverride', { name: rec.name, attribute: attr.id, value }).then(props.onChanged);

  let editor;
  if (attr.type === 'boolean') {
    editor = (
      <select
        value={override === undefined ? '' : String(override)}
        onChange={(e) => setOverride(e.currentTarget.value === '' ? null : e.currentTarget.value === 'true')}
      >
        <option value="">no override</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  } else if (attr.type === 'enum' && options.length <= 60) {
    editor = (
      <select
        value={override === undefined ? '' : String(override)}
        onChange={(e) => setOverride(e.currentTarget.value || null)}
      >
        <option value="">no override</option>
        {options.map((o) => (
          <option value={o} key={o}>
            {o}
          </option>
        ))}
      </select>
    );
  } else {
    editor = (
      <input
        placeholder={attr.type === 'multi_enum' ? 'override, comma-separated' : 'override'}
        value={override === undefined ? '' : formatValue(override)}
        style="width: 160px"
        onChange={(e) => {
          const t = e.currentTarget.value.trim();
          if (!t) return setOverride(null);
          const list = t
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
          setOverride(attr.type === 'multi_enum' ? list : list[0]!);
        }}
      />
    );
  }

  return (
    <tr>
      <th>{attr.label}</th>
      <td>
        {v ? (
          <>
            <strong>{formatValue(v.value)}</strong>{' '}
            <span class="muted small">({v.confidence.toFixed(2)})</span>
            {v.rawValue !== undefined && v.rawValue !== v.value && (
              <span class="muted small"> model said {formatValue(v.rawValue)}</span>
            )}
            <div class="muted small">{v.reason}</div>
          </>
        ) : (
          <span class="muted">—</span>
        )}
        {override !== undefined && <div class="small">Override: {formatValue(override)}</div>}
      </td>
      <td>{editor}</td>
    </tr>
  );
}
