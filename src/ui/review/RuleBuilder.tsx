import { isGroup } from '../../filters/evaluate';
import { DEFAULT_MIN_CONFIDENCE, PSEUDO_ATTRIBUTES } from '../../shared/constants';
import type { AttributeDef, Condition, ConditionOperator, RuleGroup } from '../../shared/types';

interface FieldDef {
  id: string;
  label: string;
  kind: 'boolean' | 'enum' | 'multi_enum' | 'number';
  options: string[];
}

export function fieldDefs(attrs: AttributeDef[], topics: string[]): FieldDef[] {
  const fields: FieldDef[] = attrs
    .filter((a) => a.enabled)
    .map((a) => ({
      id: a.id,
      label: a.label,
      kind: a.type,
      options: a.id === 'topic' ? topics : (a.options ?? []),
    }));
  fields.push({ id: PSEUDO_ATTRIBUTES[0].id, label: PSEUDO_ATTRIBUTES[0].label, kind: 'number', options: [] });
  fields.push({ id: PSEUDO_ATTRIBUTES[1].id, label: PSEUDO_ATTRIBUTES[1].label, kind: 'boolean', options: [] });
  return fields;
}

const OPERATORS: Record<FieldDef['kind'], { op: ConditionOperator; label: string }[]> = {
  boolean: [{ op: 'is', label: 'is' }],
  enum: [
    { op: 'is', label: 'is' },
    { op: 'is_not', label: 'is not' },
    { op: 'in', label: 'is one of' },
    { op: 'not_in', label: 'is none of' },
  ],
  multi_enum: [
    { op: 'contains_any', label: 'includes any of' },
    { op: 'not_in', label: 'includes none of' },
    { op: 'is', label: 'includes' },
  ],
  number: [
    { op: 'gte', label: '≥' },
    { op: 'lte', label: '≤' },
  ],
};

const isListOp = (op: ConditionOperator) => op === 'in' || op === 'not_in' || op === 'contains_any';

export function defaultCondition(field: FieldDef): Condition {
  const op = OPERATORS[field.kind][0]!.op;
  return { attribute: field.id, operator: op, value: defaultValue(field, op) };
}

function defaultValue(field: FieldDef, op: ConditionOperator): Condition['value'] {
  if (field.kind === 'boolean') return true;
  if (field.kind === 'number') return 0;
  if (isListOp(op)) return [];
  return field.options[0] ?? '';
}

interface Props {
  group: RuleGroup;
  fields: FieldDef[];
  onChange: (g: RuleGroup) => void;
  onRemove?: () => void;
  depth?: number;
}

export function RuleGroupEditor({ group, fields, onChange, onRemove, depth = 0 }: Props) {
  const setChild = (i: number, child: RuleGroup | Condition) =>
    onChange({ ...group, children: group.children.map((c, j) => (j === i ? child : c)) });
  const removeChild = (i: number) => onChange({ ...group, children: group.children.filter((_, j) => j !== i) });
  return (
    <div class={`rule-group depth-${depth % 2}`}>
      <div class="row">
        <span>Hide when</span>
        <select value={group.op} onChange={(e) => onChange({ ...group, op: e.currentTarget.value as RuleGroup['op'] })}>
          <option value="any">any</option>
          <option value="all">all</option>
        </select>
        <span>of these match:</span>
        <span class="spacer" />
        {onRemove && (
          <button class="danger small" onClick={onRemove}>
            Remove group
          </button>
        )}
      </div>
      <div class="rule-children">
        {group.children.map((child, i) =>
          isGroup(child) ? (
            <RuleGroupEditor
              key={i}
              group={child}
              fields={fields}
              depth={depth + 1}
              onChange={(g) => setChild(i, g)}
              onRemove={() => removeChild(i)}
            />
          ) : (
            <ConditionEditor key={i} cond={child} fields={fields} onChange={(c) => setChild(i, c)} onRemove={() => removeChild(i)} />
          ),
        )}
        {group.children.length === 0 && <div class="muted small">No conditions: this group matches nothing.</div>}
      </div>
      <div class="row">
        <button class="small" onClick={() => onChange({ ...group, children: [...group.children, defaultCondition(fields[0]!)] })}>
          + condition
        </button>
        <button class="small" onClick={() => onChange({ ...group, children: [...group.children, { op: 'all', children: [] }] })}>
          + group
        </button>
      </div>
    </div>
  );
}

function ConditionEditor(props: {
  cond: Condition;
  fields: FieldDef[];
  onChange: (c: Condition) => void;
  onRemove: () => void;
}) {
  const { cond, fields, onChange } = props;
  const field = fields.find((f) => f.id === cond.attribute) ?? {
    id: cond.attribute,
    label: `${cond.attribute} (unknown)`,
    kind: 'enum' as const,
    options: [],
  };
  const ops = OPERATORS[field.kind];
  return (
    <div class="row condition">
      <select
        value={cond.attribute}
        onChange={(e) => {
          const f = fields.find((x) => x.id === e.currentTarget.value);
          if (f) onChange({ ...defaultCondition(f), minConfidence: cond.minConfidence });
        }}
      >
        {!fields.some((f) => f.id === cond.attribute) && <option value={cond.attribute}>{field.label}</option>}
        {fields.map((f) => (
          <option value={f.id} key={f.id}>
            {f.label}
          </option>
        ))}
      </select>
      <select
        value={cond.operator}
        onChange={(e) => {
          const op = e.currentTarget.value as ConditionOperator;
          const keep = isListOp(op) === isListOp(cond.operator);
          onChange({ ...cond, operator: op, value: keep ? cond.value : defaultValue(field, op) });
        }}
      >
        {ops.map((o) => (
          <option value={o.op} key={o.op}>
            {o.label}
          </option>
        ))}
      </select>
      <ValueEditor field={field} cond={cond} onChange={onChange} />
      {field.kind !== 'number' && cond.attribute !== 'over18_flag' && (
        <label class="small muted" title="Below this confidence the condition is false">
          min conf.
          <input
            type="number"
            min="0"
            max="1"
            step="0.05"
            style="width: 64px"
            value={cond.minConfidence ?? DEFAULT_MIN_CONFIDENCE}
            onInput={(e) => onChange({ ...cond, minConfidence: Number(e.currentTarget.value) })}
          />
        </label>
      )}
      <button class="danger small" onClick={props.onRemove} title="Remove condition">
        ✕
      </button>
    </div>
  );
}

function ValueEditor({ field, cond, onChange }: { field: FieldDef; cond: Condition; onChange: (c: Condition) => void }) {
  if (field.kind === 'boolean') {
    return (
      <select value={String(cond.value)} onChange={(e) => onChange({ ...cond, value: e.currentTarget.value === 'true' })}>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  if (field.kind === 'number') {
    return (
      <input type="number" value={Number(cond.value)} style="width: 120px" onInput={(e) => onChange({ ...cond, value: Number(e.currentTarget.value) })} />
    );
  }
  if (isListOp(cond.operator)) {
    const selected = Array.isArray(cond.value) ? cond.value.map(String) : [String(cond.value)];
    if (field.options.length > 0 && field.options.length <= 60) {
      return (
        <details class="multi">
          <summary>{selected.length ? selected.join(', ') : 'choose…'}</summary>
          <div class="multi-options">
            {field.options.map((o) => (
              <label key={o} class="small">
                <input
                  type="checkbox"
                  checked={selected.includes(o)}
                  onChange={(e) =>
                    onChange({
                      ...cond,
                      value: e.currentTarget.checked ? [...selected, o] : selected.filter((x) => x !== o),
                    })
                  }
                />
                {o}
              </label>
            ))}
          </div>
        </details>
      );
    }
    return (
      <input
        placeholder="comma-separated, e.g. en, de"
        value={selected.join(', ')}
        onChange={(e) =>
          onChange({
            ...cond,
            value: e.currentTarget.value
              .split(',')
              .map((s) => s.trim().toLowerCase())
              .filter(Boolean),
          })
        }
      />
    );
  }
  if (field.options.length > 0 && field.options.length <= 60) {
    return (
      <select value={String(cond.value)} onChange={(e) => onChange({ ...cond, value: e.currentTarget.value })}>
        {field.options.map((o) => (
          <option value={o} key={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  return <input value={String(cond.value)} style="width: 100px" onChange={(e) => onChange({ ...cond, value: e.currentTarget.value.trim().toLowerCase() })} />;
}
