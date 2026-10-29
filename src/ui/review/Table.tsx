import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { subredditUrl } from '../../shared/names';
import type { AttributeDef, SubredditRow } from '../../shared/types';
import { effective, formatAgo, formatNumber, formatValue } from '../common/format';

const ROW_HEIGHT = 34;
const OVERSCAN = 10;

interface Column {
  key: string;
  label: string;
  width: number;
  render: (r: SubredditRow) => ComponentChildren;
  sort: (r: SubredditRow) => string | number;
}

export function buildColumns(attrs: AttributeDef[]): Column[] {
  const cols: Column[] = [
    {
      key: 'name',
      label: 'Subreddit',
      width: 180,
      render: (r) => (
        <a
          href={subredditUrl(r.displayName)}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(e) => e.stopPropagation()}
        >
          r/{r.displayName}
        </a>
      ),
      sort: (r) => r.name,
    },
    {
      key: 'summary',
      label: 'Summary',
      width: 260,
      render: (r) => r.summary ?? '',
      sort: (r) => r.summary ?? '',
    },
  ];
  for (const a of attrs.filter((x) => x.enabled)) {
    cols.push({
      key: `attr:${a.id}`,
      label: a.label,
      width: a.type === 'multi_enum' ? 200 : 100,
      render: (r) => {
        const v = effective(a.id, r.values, r.overrides);
        if (!v) return '';
        const low = v.confidence < 0.6;
        return (
          <span
            class={`chip ${v.value === true ? 'on' : ''} ${low ? 'low' : ''}`}
            title={`confidence ${v.confidence.toFixed(2)}`}
          >
            {formatValue(v.value)}
            {v.overridden ? ' ✎' : ''}
          </span>
        );
      },
      sort: (r) => formatValue(effective(a.id, r.values, r.overrides)?.value),
    });
  }
  cols.push(
    {
      key: 'over18',
      label: 'over18',
      width: 70,
      render: (r) => (r.over18 === undefined ? '' : String(r.over18)),
      sort: (r) => String(r.over18 ?? ''),
    },
    {
      key: 'lang',
      label: 'Detected',
      width: 80,
      render: (r) => r.detectedLanguage ?? '',
      sort: (r) => r.detectedLanguage ?? '',
    },
    {
      key: 'subs',
      label: 'Visitors',
      width: 80,
      render: (r) => formatNumber(r.subscribers),
      sort: (r) => r.subscribers ?? -1,
    },
    { key: 'titles', label: 'Titles', width: 60, render: (r) => r.sampleCount, sort: (r) => r.sampleCount },
    { key: 'seen', label: 'Seen', width: 60, render: (r) => r.seenCount, sort: (r) => r.seenCount },
    {
      key: 'last',
      label: 'Last seen',
      width: 90,
      render: (r) => formatAgo(r.lastSeenAt),
      sort: (r) => r.lastSeenAt,
    },
    {
      key: 'state',
      label: 'State',
      width: 110,
      render: (r) => <span title={r.lastError}>{r.pipelineState}</span>,
      sort: (r) => r.pipelineState,
    },
    { key: 'model', label: 'Model', width: 150, render: (r) => r.model ?? '', sort: (r) => r.model ?? '' },
  );
  return cols;
}

export function Table(props: {
  rows: SubredditRow[];
  attrs: AttributeDef[];
  selected: Set<string>;
  onSelect: (s: Set<string>) => void;
  onOpen: (name: string) => void;
  openName: string | null;
}) {
  const { rows, selected } = props;
  const columns = useMemo(() => buildColumns(props.attrs), [props.attrs]);
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: 'seen', dir: -1 });
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const measure = () => scroller.current && setHeight(scroller.current.clientHeight);
    measure();
    addEventListener('resize', measure);
    return () => removeEventListener('resize', measure);
  }, []);

  const sorted = useMemo(() => {
    const col = columns.find((c) => c.key === sort.key) ?? columns[0]!;
    return [...rows].sort((a, b) => {
      const x = col.sort(a);
      const y = col.sort(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }, [rows, sort, columns]);

  const totalWidth = 36 + columns.reduce((s, c) => s + c.width, 0);
  const template = `36px ${columns.map((c) => `${c.width}px`).join(' ')}`;
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(sorted.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
  const allSelected = sorted.length > 0 && sorted.every((r) => selected.has(r.name));

  const toggle = (name: string) => {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    props.onSelect(next);
  };

  return (
    <div
      class="table-scroller"
      ref={scroller}
      onScroll={(e) => {
        setScrollTop(e.currentTarget.scrollTop);
        setHeight(e.currentTarget.clientHeight);
      }}
    >
      <div style={{ width: `${totalWidth}px` }}>
        <div class="trow thead" style={{ gridTemplateColumns: template }}>
          <div>
            <input
              type="checkbox"
              checked={allSelected}
              onChange={() => props.onSelect(allSelected ? new Set() : new Set(sorted.map((r) => r.name)))}
            />
          </div>
          {columns.map((c) => (
            <div
              key={c.key}
              class="sortable"
              onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key ? (-s.dir as 1 | -1) : 1 }))}
            >
              {c.label}
              {sort.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
            </div>
          ))}
        </div>
        <div style={{ height: `${sorted.length * ROW_HEIGHT}px`, position: 'relative' }}>
          {sorted.slice(start, end).map((r, i) => (
            <div
              key={r.name}
              class={`trow ${props.openName === r.name ? 'open' : ''}`}
              style={{
                gridTemplateColumns: template,
                position: 'absolute',
                top: `${(start + i) * ROW_HEIGHT}px`,
                height: `${ROW_HEIGHT}px`,
              }}
              onClick={() => props.onOpen(r.name)}
            >
              <div onClick={(e) => e.stopPropagation()}>
                <input type="checkbox" checked={selected.has(r.name)} onChange={() => toggle(r.name)} />
              </div>
              {columns.map((c) => (
                <div key={c.key} class="cell">
                  {c.render(r)}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
      {sorted.length === 0 && <div class="muted pad">No subreddits match.</div>}
    </div>
  );
}
