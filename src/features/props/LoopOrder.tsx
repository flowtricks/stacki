// The loop's Sort and Limit items: sort keys as rows, Random order, and the
// Show and Skip a limit takes (LoopSettings.tsx).

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import Dropdown from '../../ui/Dropdown';
import { ChevronDownIcon, CodeIcon, RepeatIcon } from '../../ui/Icons';
import {
  astroComparatorCode,
  LOOP_QUERY_LIMITS,
  sortOrderFor,
  sortOrdersFor,
  type LoopQuery,
  type LoopSort,
  type LoopSortOrder,
  type LoopSourceKind,
} from '../../editor/loopQuery';
import { type CatalogField, type LoopCatalog } from './loopCatalog';
import { FieldPicker, type FieldExtra } from './LoopFieldPicker';
import { useCollectionSample } from './loopSettingsData';
import { customSortProblem, fieldNamed, limitReset, orderLabels, sortParts, sortReset, wholeNumberOf } from './loopSettingsModel';
import { AppliedLabel, CodeBox, EditorRow, ListRow, SectionHeader } from './LoopRows';
import type { SectionProps } from './LoopFilters';
import { SettingDot, type BindingContext, type DraftEditor } from './LoopBinding';
import { moved, staysPut } from './LoopItems';
import useListReorder from '../../ui/useListReorder';
import { LinkedSetting } from './LoopLinked';

// The Field menu's entry for a shuffle, beside the fields; never a field name
// (those are checked names, and this one starts with underscores).
const RANDOM_FIELD = '__random';
// And for custom code, which, like a shuffle, runs in JS after the items are read.
const CUSTOM_FIELD = '__custom';
const LIMIT_DEFAULT = 6;

// ---------------------------------------------------------------------------
// Sort.
// ---------------------------------------------------------------------------

type SortSectionProps = SectionProps & {
  readonly randomOrder: 'available' | 'unavailable';
  /** Where an item is read from, so the Field picker can show its values. */
  readonly catalog?: LoopCatalog | undefined;
  readonly projectPath?: string | undefined;
  readonly binding?: BindingContext | undefined;
  /** The section's label, when it says more than its title (a page's own value). */
  readonly label?: ReactNode;
  /** The `{}` that shows the sort as code. */
  readonly toggle?: ReactNode;
};

/** Sort, or, once linked to a property, its purple bar with the sort as its default. */
export function SortSection(props: SortSectionProps) {
  const { binding } = props;
  return binding?.settings.sort.kind === 'prop' ? (
    <LinkedSetting setting="sort" binding={binding} editor={<SortEditor {...props} binding={undefined} />} draft={sortDraft(props)} />
  ) : (
    <SortEditor {...props} />
  );
}

// The sort as a new property's default: the same editor over a draft.
function sortDraft(props: SortSectionProps): DraftEditor {
  return {
    query: props.query,
    render: (query, onChange) => <SortEditor {...props} query={query} binding={undefined} label={undefined} toggle={undefined} onChange={onChange} />,
  };
}

function SortEditor(props: SortSectionProps) {
  const { query, fields } = props;
  const [open, setOpen] = useState<number | undefined>(undefined);
  const source = query.source.kind;
  const sortable = (fields ?? []).filter((field) => sortOrderFor(field.kind, source) !== undefined);
  const first = sortable[0];
  const custom = query.customSort;
  // With no field to sort by, a list that is code can still be sorted by code.
  const codeAllowed = props.randomOrder === 'available';
  const addable = !query.random && custom === undefined && query.sorts.length < LOOP_QUERY_LIMITS.sortsMax && (first !== undefined || codeAllowed);
  // The sorts as code that orders the same way; a custom sort starts from it.
  const toCustom = (): void => {
    const itemPath = source === 'sanity' ? [] : (props.itemPath ?? ['data']);
    const seed = query.sorts.length > 0 ? astroComparatorCode(query.sorts, itemPath) : '(a, b) => 0';
    setOpen(undefined);
    props.onChange({ ...query, sorts: [], random: false, customSort: seed });
  };
  const add = (): void => {
    if (first === undefined) {
      toCustom();
      setOpen(0);
      return;
    }
    const order = sortOrderFor(first.kind, source);
    if (order === undefined) {
      return;
    }
    props.onChange({ ...query, sorts: [...query.sorts, { field: first.path, direction: 'ascending', order }] });
    setOpen(query.sorts.length);
  };
  const reorder = useListReorder({
    count: query.sorts.length,
    onMove: (source, target) => {
      // A drop back in its own place changes nothing, so writes nothing.
      if (staysPut(source, target)) {
        return;
      }
      setOpen(undefined);
      props.onChange({ ...query, sorts: moved(query.sorts, source, target) });
    },
  });
  const replace = (index: number, sort: LoopSort | undefined): void => {
    const sorts = sort === undefined ? query.sorts.filter((_, at) => at !== index) : query.sorts.map((existing, at) => (at === index ? sort : existing));
    props.onChange({ ...query, sorts });
  };
  // A shuffle and custom code run in JS after the fetch, so a query kept in
  // another file's string cannot hold either.
  const extras: readonly FieldExtra[] = codeAllowed
    ? [
        { value: RANDOM_FIELD, label: 'Random order', icon: <RepeatIcon size={13} /> },
        { value: CUSTOM_FIELD, label: 'Custom code', icon: <CodeIcon size={13} /> },
      ]
    : [];
  // One item, read once for the section: every Field picker shows its values.
  const sample = useCollectionSample(props.projectPath, props.catalog, query.source);
  return (
    <div className="loop-settings-section">
      <SectionHeader
        title="Sort"
        label={props.label}
        dot={<SettingDot setting="sort" binding={props.binding} draft={sortDraft(props)} />}
        toggle={props.toggle}
        reset={{ applied: query.random || query.sorts.length > 0 || custom !== undefined, onReset: () => props.onChange(sortReset(query)) }}
        addable={addable}
        onAdd={add}
      />
      {(query.random || query.sorts.length > 0 || custom !== undefined) && (
        <div className="loop-settings-list">
          {query.random && <RandomRow onRemove={() => props.onChange({ ...query, random: false })} />}
          {custom !== undefined && (
            <CustomSortRow
              code={custom}
              source={source}
              open={open === 0}
              onToggle={() => setOpen(open === 0 ? undefined : 0)}
              onChange={(customSort) => props.onChange({ ...query, customSort })}
            />
          )}
          {!query.random &&
            query.sorts.map((sort, index) => (
              // The first sort decides the order, the next breaks its ties, so
              // their order matters: a row drags to a new place.
              <div key={`${index}:${sort.field}`} {...reorder.rowProps(index)} className={`loop-settings-sortable ${reorder.rowClass(index)}`}>
                <SortChip
                  sort={sort}
                  source={source}
                  fields={fields}
                  extras={extras}
                  sample={sample}
                  open={open === index}
                  onToggle={() => setOpen(open === index ? undefined : index)}
                  onRandom={() => props.onChange({ ...query, random: true, sorts: [] })}
                  onCustom={toCustom}
                  onChange={(next) => replace(index, next)}
                />
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

// A sort as code: the comparator, edited in a code box; removing it returns
// the list to its source's own order.
function CustomSortRow(props: {
  readonly code: string;
  readonly source: LoopSourceKind;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onChange: (code: string | undefined) => void;
}) {
  const firstLine = props.code.split('\n')[0] ?? props.code;
  return (
    <ListRow
      parts={{ lead: 'Custom code', rest: firstLine }}
      open={props.open}
      removeLabel="Remove sort"
      editor={
        <div className="loop-settings-editor">
          <CodeBox
            value={props.code}
            label="Sort code"
            placeholder={props.source === 'list' ? '(a, b) => a.order - b.order' : '(a, b) => a.data.order - b.data.order'}
            check={customSortProblem}
            onCommit={props.onChange}
          />
        </div>
      }
      onToggle={props.onToggle}
      onRemove={() => props.onChange(undefined)}
    />
  );
}

// A shuffle has nothing to edit, only a way out.
function RandomRow(props: { readonly onRemove: () => void }) {
  return (
    <ListRow
      parts={{ lead: 'Random order', rest: 'shuffled when the page is built' }}
      open={false}
      locked={true}
      removeLabel="Remove sort"
      onToggle={() => undefined}
      onRemove={props.onRemove}
    />
  );
}

function SortChip(props: {
  readonly sort: LoopSort;
  readonly source: LoopSourceKind;
  readonly fields: readonly CatalogField[] | undefined;
  readonly extras: readonly FieldExtra[];
  readonly sample: unknown;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onRandom: () => void;
  readonly onCustom: () => void;
  readonly onChange: (sort: LoopSort | undefined) => void;
}) {
  const { sort } = props;
  const changeField = (path: string): void => {
    if (path === RANDOM_FIELD) {
      props.onRandom();
      return;
    }
    if (path === CUSTOM_FIELD) {
      props.onCustom();
      return;
    }
    const field = fieldNamed(props.fields, path);
    const orders = field === undefined ? [] : sortOrdersFor(field.kind, props.source);
    // A field that sorts the same way keeps the order; another takes its own default.
    const order = orders.includes(sort.order) ? sort.order : orders[0];
    if (order !== undefined) {
      props.onChange({ field: path, direction: sort.direction, order });
    }
  };
  const field = fieldNamed(props.fields, sort.field);
  const offered = field === undefined ? [] : sortOrdersFor(field.kind, props.source);
  // A sort read from code keeps its order even when the field's kind no longer offers it.
  const orders: readonly LoopSortOrder[] = offered.includes(sort.order) ? offered : [sort.order, ...offered];
  const orderOptions = orders.flatMap((order) => {
    const labels = orderLabels(order);
    return [
      { value: orderKey(order, 'ascending'), label: labels.ascending },
      { value: orderKey(order, 'descending'), label: labels.descending },
    ];
  });
  return (
    <>
      <ListRow
        dragThrough={true}
        parts={sortParts(sort, props.fields)}
        open={props.open}
        removeLabel="Remove sort"
        editor={
          <div className="loop-settings-editor">
            <EditorRow label="Field">
              <FieldPicker
                value={sort.field}
                fields={props.fields ?? []}
                sample={props.sample}
                extras={props.extras}
                usable={(field) => sortOrdersFor(field.kind, props.source).length > 0}
                onChange={changeField}
              />
            </EditorRow>
            <EditorRow label="Order">
              <Dropdown<OrderKey>
                livePreview={false}
                value={orderKey(sort.order, sort.direction)}
                ariaLabel="Order"
                options={orderOptions}
                onChange={(key) => props.onChange({ ...sort, ...orderOf(key, orders) })}
              />
            </EditorRow>
          </div>
        }
        onToggle={props.onToggle}
        onRemove={() => props.onChange(undefined)}
      />
    </>
  );
}

// The Order menu lists each way the field sorts, in both directions, as one choice.
type OrderKey = `${LoopSortOrder}:${LoopSort['direction']}`;

function orderKey(order: LoopSortOrder, direction: LoopSort['direction']): OrderKey {
  return `${order}:${direction}`;
}

function orderOf(key: OrderKey, orders: readonly LoopSortOrder[]): Pick<LoopSort, 'order' | 'direction'> {
  const found = orders.find((order) => key === orderKey(order, 'ascending') || key === orderKey(order, 'descending'));
  // Every key the menu offers names one of the orders it was built from.
  assert(found !== undefined, 'An order choice names an offered order');
  return { order: found, direction: key.endsWith(':descending') ? 'descending' : 'ascending' };
}

// ---------------------------------------------------------------------------
// Limit.
// ---------------------------------------------------------------------------

export function LimitSection(props: Omit<SectionProps, 'fields'> & { readonly binding?: BindingContext | undefined; readonly toggle?: ReactNode }) {
  const { query } = props;
  // A linked Show or Skip keeps the section open: its row is the purple bar.
  const linked = props.binding?.settings.limit.kind === 'prop' || props.binding?.settings.offset.kind === 'prop';
  const on = linked || query.limit !== undefined || query.offset > 0;
  const toggle = (): void => {
    props.onChange(on ? limitReset(query) : { ...query, limit: LIMIT_DEFAULT });
  };
  return (
    <div className="loop-settings-section">
      <div className="loop-settings-header">
        <span className="loop-settings-label">
          <AppliedLabel
            title="Limit items"
            reset={{ applied: query.limit !== undefined || query.offset > 0, onReset: () => props.onChange(limitReset(query)) }}
          />
          {props.toggle}
        </span>
        <button type="button" role="switch" aria-checked={on} aria-label="Limit items" className={`cms-toggle ${on ? 'on' : ''}`} onClick={toggle}>
          <span className="cms-toggle-knob" />
        </button>
      </div>
      {on && (
        <div className="loop-settings-editor">
          <LimitRow
            setting="limit"
            binding={props.binding}
            query={query}
            onChange={props.onChange}
            row={(dot, value, onChange) => (
              <NumberRow
                label="Show"
                dot={dot}
                value={value.limit}
                placeholder="All"
                bounds={{ min: 1, max: LOOP_QUERY_LIMITS.limitMax }}
                onCommit={(limit) => onChange({ ...value, limit })}
              />
            )}
          />
          <LimitRow
            setting="offset"
            binding={props.binding}
            query={query}
            onChange={props.onChange}
            row={(dot, value, onChange) => (
              <NumberRow
                label="Skip"
                dot={dot}
                value={value.offset}
                placeholder="0"
                bounds={{ min: 0, max: LOOP_QUERY_LIMITS.offsetMax }}
                onCommit={(offset) => onChange({ ...value, offset: offset ?? 0 })}
              />
            )}
          />
        </div>
      )}
    </div>
  );
}

// Show or Skip: its number field with the dot, or, once linked, its purple
// bar, whose Property settings edit the default with the same number field.
function LimitRow(props: {
  readonly setting: 'limit' | 'offset';
  readonly binding: BindingContext | undefined;
  readonly query: LoopQuery;
  readonly onChange: (query: LoopQuery) => void;
  readonly row: (dot: ReactNode, query: LoopQuery, onChange: (query: LoopQuery) => void) => ReactNode;
}) {
  const { binding } = props;
  // A new property's default is edited with the same number field, over a draft.
  const draft: DraftEditor = { query: props.query, render: (query, onChange) => props.row(undefined, query, onChange) };
  return binding?.settings[props.setting].kind === 'prop' ? (
    <LinkedSetting setting={props.setting} binding={binding} editor={props.row(undefined, props.query, props.onChange)} draft={draft} />
  ) : (
    props.row(<SettingDot setting={props.setting} binding={binding} draft={draft} />, props.query, props.onChange)
  );
}

// The up and down buttons beside a number, shown while it is pointed at.
function Steppers(props: { readonly onStep: (direction: 1 | -1, size: { readonly large: boolean }) => void }) {
  return (
    <span className="num-steppers">
      {([1, -1] as const).map((direction) => (
        <button
          key={direction}
          type="button"
          tabIndex={-1}
          aria-label={direction > 0 ? 'Increase' : 'Decrease'}
          title={`${direction > 0 ? 'Increase' : 'Decrease'} — ⇧ by 10`}
          onClick={(event) => props.onStep(direction, { large: event.shiftKey })}
        >
          <ChevronDownIcon size={11} style={direction > 0 ? { transform: 'rotate(180deg)' } : undefined} />
        </button>
      ))}
    </span>
  );
}

// A whole number, written when the field is left; empty means "no limit".
function NumberRow(props: {
  readonly label: string;
  readonly dot: ReactNode;
  readonly value: number | undefined;
  readonly placeholder: string;
  readonly bounds: { readonly min: number; readonly max: number };
  readonly onCommit: (value: number | undefined) => void;
}) {
  const [draft, setDraft] = useState(props.value === undefined ? '' : String(props.value));
  const committed = useRef(props.value);
  useEffect(() => {
    committed.current = props.value;
    setDraft(props.value === undefined ? '' : String(props.value));
  }, [props.value]);
  const commit = (): void => {
    const value = draft.trim() === '' ? undefined : wholeNumberOf(draft, props.bounds);
    if (draft.trim() !== '' && value === undefined) {
      setDraft(committed.current === undefined ? '' : String(committed.current));
      return;
    }
    if (value !== committed.current) {
      props.onCommit(value);
    }
  };
  // A step writes at once, from the value shown: ±1, or ±10 with Shift,
  // held inside the bounds, as the props panel's number fields step.
  const step = (direction: 1 | -1, size: { readonly large: boolean }): void => {
    const current = wholeNumberOf(draft, props.bounds) ?? committed.current ?? props.bounds.min;
    const next = Math.min(props.bounds.max, Math.max(props.bounds.min, current + direction * (size.large ? 10 : 1)));
    assert(Number.isSafeInteger(next), 'A stepped value is whole');
    setDraft(String(next));
    if (next !== committed.current) {
      props.onCommit(next);
    }
  };
  return (
    <EditorRow label={props.label} dot={props.dot}>
      {/* Text, not type=number: the native spinner can't be styled. The
          steppers are the props panel's own (.num-field, styles.css). */}
      <div className="num-field">
        <input
          type="text"
          inputMode="numeric"
          value={draft}
          placeholder={props.placeholder}
          aria-label={props.label}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commit();
            } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              event.preventDefault();
              step(event.key === 'ArrowUp' ? 1 : -1, { large: event.shiftKey });
            }
          }}
        />
        <Steppers onStep={step} />
      </div>
    </EditorRow>
  );
}
