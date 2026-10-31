import { useEffect, useMemo, useState } from 'preact/hooks';
import { rpc } from '../../shared/rpc';
import type { FilterList, RuleGroup, Settings } from '../../shared/types';
import { uuid } from '../../shared/util';
import { fieldDefs, RuleGroupEditor } from './RuleBuilder';

interface Preview {
  count: number;
  names: string[];
  reasons: Record<string, string>;
}

export function FilterLists({
  settings,
  save,
}: {
  settings: Settings;
  save: (p: Partial<Settings>) => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState(settings.activeFilterListId);
  const selected = settings.filterLists.find((f) => f.id === selectedId) ?? settings.filterLists[0]!;
  const [draft, setDraft] = useState<RuleGroup>(selected.rule);
  const [name, setName] = useState(selected.name);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fields = useMemo(
    () => fieldDefs(settings.attributes, settings.topics),
    [settings.attributes, settings.topics],
  );

  useEffect(() => {
    setDraft(selected.rule);
    setName(selected.name);
    setConfirmDelete(false);
  }, [selected.id]);

  // Live preview, debounced.
  useEffect(() => {
    const t = setTimeout(() => void rpc('previewRule', { rule: draft }).then(setPreview), 250);
    return () => clearTimeout(t);
  }, [draft]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(selected.rule) || name !== selected.name;
  const saveList = () =>
    save({
      filterLists: settings.filterLists.map((f) =>
        f.id === selected.id ? { ...f, name: name.trim() || f.name, rule: draft } : f,
      ),
    });
  const create = async () => {
    const list: FilterList = {
      id: uuid(),
      name: `List ${settings.filterLists.length + 1}`,
      rule: { op: 'any', children: [] },
    };
    await save({ filterLists: [...settings.filterLists, list] });
    setSelectedId(list.id);
  };
  const remove = async () => {
    const remaining = settings.filterLists.filter((f) => f.id !== selected.id);
    await save({
      filterLists: remaining,
      activeFilterListId:
        settings.activeFilterListId === selected.id ? remaining[0]!.id : settings.activeFilterListId,
    });
    setSelectedId(remaining[0]!.id);
  };

  return (
    <div class="filter-layout">
      <div class="stack">
        <div class="row">
          <select value={selected.id} onChange={(e) => setSelectedId(e.currentTarget.value)}>
            {settings.filterLists.map((f) => (
              <option value={f.id} key={f.id}>
                {f.name}
                {f.id === settings.activeFilterListId ? ' (active)' : ''}
              </option>
            ))}
          </select>
          <button onClick={create}>New list</button>
          {settings.activeFilterListId !== selected.id && (
            <button onClick={() => save({ activeFilterListId: selected.id })}>Make active</button>
          )}
          <span class="spacer" />
          {settings.filterLists.length > 1 &&
            (confirmDelete ? (
              <button class="danger" onClick={remove}>
                Really delete
              </button>
            ) : (
              <button class="danger" onClick={() => setConfirmDelete(true)}>
                Delete list
              </button>
            ))}
        </div>
        <label>
          Name
          <input value={name} onInput={(e) => setName(e.currentTarget.value)} />
        </label>
        <RuleGroupEditor group={draft} fields={fields} onChange={setDraft} />
        <div class="row">
          <button class="primary" disabled={!dirty} onClick={saveList}>
            Save list
          </button>
          {dirty && (
            <button
              onClick={() => {
                setDraft(selected.rule);
                setName(selected.name);
              }}
            >
              Discard changes
            </button>
          )}
          {dirty && <span class="muted small">Unsaved changes. Hiding uses the saved rule.</span>}
        </div>
        <ManualLists settings={settings} />
      </div>
      <div class="stack preview">
        <strong>
          Preview: {preview ? preview.count : '…'} subreddit{preview?.count === 1 ? '' : 's'} match
        </strong>
        <div class="muted small">Rule matches only; manual block/allow lists are applied on top.</div>
        <div class="preview-list">
          {preview?.names.map((n) => (
            <div key={n} class="small">
              <strong>r/{n}</strong> <span class="muted">{preview.reasons[n]}</span>
            </div>
          ))}
          {preview && preview.count > preview.names.length && (
            <div class="muted small">…and {preview.count - preview.names.length} more</div>
          )}
        </div>
      </div>
    </div>
  );
}

function ManualLists({ settings }: { settings: Settings }) {
  const [input, setInput] = useState('');
  const names = input
    .split(/[\s,]+/)
    .map((s) => s.replace(/^\/?r\//i, '').toLowerCase())
    .filter((s) => /^[a-z0-9_]{2,32}$/.test(s));
  return (
    <div class="card stack small">
      <strong>Manual lists</strong>
      <div class="muted">Always-allow wins over always-block and over the rule.</div>
      <div class="row">
        <input placeholder="subreddit names" value={input} onInput={(e) => setInput(e.currentTarget.value)} />
        <button
          disabled={!names.length}
          onClick={() => void rpc('setManual', { names, list: 'block' }).then(() => setInput(''))}
        >
          Always block
        </button>
        <button
          disabled={!names.length}
          onClick={() => void rpc('setManual', { names, list: 'allow' }).then(() => setInput(''))}
        >
          Always allow
        </button>
      </div>
      {(['manualBlock', 'manualAllow'] as const).map((key) => (
        <div key={key}>
          <span class="muted">{key === 'manualBlock' ? 'Blocked:' : 'Allowed:'} </span>
          {settings[key].length === 0 && <span class="muted">none</span>}
          {settings[key].map((n) => (
            <span class="chip" key={n}>
              r/{n}{' '}
              <button
                class="link"
                title="Remove"
                onClick={() => void rpc('setManual', { names: [n], list: 'none' })}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
