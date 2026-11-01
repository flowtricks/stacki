// The loop's Sort and Limit items: sort keys as rows, Random order, and the
// Show and Skip a limit takes (LoopSettings.tsx).

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import Dropdown, { type DropdownOption } from '../../ui/Dropdown';
import { ChevronDownIcon, RepeatIcon } from '../../ui/Icons';
import { LOOP_QUERY_LIMITS, sortOrderFor, type LoopSort } from '../../editor/loopQuery';
import { type CatalogField } from './loopCatalog';
import { fieldNamed, orderLabels, sortParts, wholeNumberOf } from './loopSettingsModel';
import { EditorRow, ListRow, SectionHeader, fieldIcon } from './LoopRows';
import type { SectionProps } from './LoopFilters';
import { SettingDot, type BindingContext } from './LoopBinding';
import { LinkedSetting } from './LoopLinked';

// The Field menu's entry for a shuffle, beside the fields; never a field name
// (those are checked names, and this one starts with underscores).
const RANDOM_FIELD = '__random';
const LIMIT_DEFAULT = 6;

// ---------------------------------------------------------------------------
// Sort.
// ---------------------------------------------------------------------------

type SortSectionProps = SectionProps & {
  readonly randomOrder: 'available' | 'unavailable';
  readonly binding?: BindingContext | undefined;
  /** The section's label, when it says more than its title (a page's own value). */
  readonly label?: ReactNode;
};

/** Sort, or, once linked to a property, its purple bar with the sort as its default. */
export function SortSection(props: SortSectionProps) {
  const { binding } = props;
  return binding?.settings.sort.kind === 'prop' ? (
    <LinkedSetting
      setting="sort"
      binding={binding}
      editor={<SortEditor {...props} binding={undefined} />}
    />
  ) : (
    <SortEditor {...props} />
  );
}

function SortEditor(props: SortSectionProps) {
  const { query, fields } = props;
  const [open, setOpen] = useState<number | undefined>(undefined);
  const sortable = (fields ?? []).filter((field) => sortOrderFor(field.kind) !== undefined);
  const first = sortable[0];
  const addable =
    !query.random && query.sorts.length < LOOP_QUERY_LIMITS.sortsMax && first !== undefined;
  const add = (): void => {
    const order = first === undefined ? undefined : sortOrderFor(first.kind);
    if (first === undefined || order === undefined) {
      return;
    }
    props.onChange({
      ...query,
      sorts: [...query.sorts, { field: first.path, direction: 'ascending', order }],
    });
    setOpen(query.sorts.length);
  };
  const replace = (index: number, sort: LoopSort | undefined): void => {
    const sorts =
      sort === undefined
        ? query.sorts.filter((_, at) => at !== index)
        : query.sorts.map((existing, at) => (at === index ? sort : existing));
    props.onChange({ ...query, sorts });
  };
  const fieldOptions = [
    ...sortable.map((field) => ({
      value: field.path,
      label: field.title,
      icon: fieldIcon(field.kind),
    })),
    // A shuffle runs in JS after the fetch, so a query kept in another file's
    // string cannot hold one.
    ...(props.randomOrder === 'available'
      ? [{ value: RANDOM_FIELD, label: 'Random order', icon: <RepeatIcon size={13} /> }]
      : []),
  ];
  return (
    <div className="loop-settings-section">
      <SectionHeader
        title="Sort"
        label={props.label}
        dot={<SettingDot setting="sort" binding={props.binding} />}
        addable={addable}
        onAdd={add}
      />
      {(query.random || query.sorts.length > 0) && (
        <div className="loop-settings-list">
          {query.random && (
            <RandomRow onRemove={() => props.onChange({ ...query, random: false })} />
          )}
          {!query.random &&
            query.sorts.map((sort, index) => (
              <SortChip
                key={`${index}:${sort.field}`}
                sort={sort}
                fields={fields}
                fieldOptions={fieldOptions}
                open={open === index}
                onToggle={() => setOpen(open === index ? undefined : index)}
                onRandom={() => props.onChange({ ...query, random: true, sorts: [] })}
                onChange={(next) => replace(index, next)}
              />
            ))}
        </div>
      )}
    </div>
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
  readonly fields: readonly CatalogField[] | undefined;
  readonly fieldOptions: readonly DropdownOption<string>[];
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onRandom: () => void;
  readonly onChange: (sort: LoopSort | undefined) => void;
}) {
  const { sort } = props;
  const labels = orderLabels(sort.order);
  const changeField = (path: string): void => {
    if (path === RANDOM_FIELD) {
      props.onRandom();
      return;
    }
    const field = fieldNamed(props.fields, path);
    const order = field === undefined ? undefined : sortOrderFor(field.kind);
    if (order !== undefined) {
      props.onChange({ field: path, direction: sort.direction, order });
    }
  };
  return (
    <>
      <ListRow
        parts={sortParts(sort, props.fields)}
        open={props.open}
        removeLabel="Remove sort"
        editor={
          <div className="loop-settings-editor">
            <EditorRow label="Field">
              <Dropdown<string>
                livePreview={false}
                value={sort.field}
                ariaLabel="Sort field"
                options={
                  props.fieldOptions.some((option) => option.value === sort.field)
                    ? props.fieldOptions
                    : [...props.fieldOptions, { value: sort.field, label: sort.field }]
                }
                onChange={changeField}
              />
            </EditorRow>
            <EditorRow label="Order">
              <Dropdown<'ascending' | 'descending'>
                livePreview={false}
                value={sort.direction}
                ariaLabel="Order"
                options={[
                  { value: 'ascending', label: labels.ascending },
                  { value: 'descending', label: labels.descending },
                ]}
                onChange={(direction) => props.onChange({ ...sort, direction })}
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

// ---------------------------------------------------------------------------
// Limit.
// ---------------------------------------------------------------------------

export function LimitSection(
  props: Omit<SectionProps, 'fields'> & { readonly binding?: BindingContext | undefined },
) {
  const { query } = props;
  // A linked Show or Skip keeps the section open: its row is the purple bar.
  const linked =
    props.binding?.settings.limit.kind === 'prop' || props.binding?.settings.offset.kind === 'prop';
  const on = linked || query.limit !== undefined || query.offset > 0;
  const toggle = (): void => {
    props.onChange(
      on ? { ...query, limit: undefined, offset: 0 } : { ...query, limit: LIMIT_DEFAULT },
    );
  };
  return (
    <div className="loop-settings-section">
      <div className="loop-settings-header">
        <span className="prop-label">Limit items</span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Limit items"
          className={`cms-toggle ${on ? 'on' : ''}`}
          onClick={toggle}
        >
          <span className="cms-toggle-knob" />
        </button>
      </div>
      {on && (
        <div className="loop-settings-editor">
          <LimitRow
            setting="limit"
            binding={props.binding}
            row={(dot) => (
              <NumberRow
                label="Show"
                dot={dot}
                value={query.limit}
                placeholder="All"
                bounds={{ min: 1, max: LOOP_QUERY_LIMITS.limitMax }}
                onCommit={(limit) => props.onChange({ ...query, limit })}
              />
            )}
          />
          <LimitRow
            setting="offset"
            binding={props.binding}
            row={(dot) => (
              <NumberRow
                label="Skip"
                dot={dot}
                value={query.offset}
                placeholder="0"
                bounds={{ min: 0, max: LOOP_QUERY_LIMITS.offsetMax }}
                onCommit={(offset) => props.onChange({ ...query, offset: offset ?? 0 })}
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
  readonly row: (dot: ReactNode) => ReactNode;
}) {
  const { binding } = props;
  return binding?.settings[props.setting].kind === 'prop' ? (
    <LinkedSetting setting={props.setting} binding={binding} editor={props.row(undefined)} />
  ) : (
    props.row(<SettingDot setting={props.setting} binding={binding} />)
  );
}

// The up and down buttons beside a number, shown while it is pointed at.
function Steppers(props: {
  readonly onStep: (direction: 1 | -1, size: { readonly large: boolean }) => void;
}) {
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
          <ChevronDownIcon
            size={11}
            style={direction > 0 ? { transform: 'rotate(180deg)' } : undefined}
          />
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
    const next = Math.min(
      props.bounds.max,
      Math.max(props.bounds.min, current + direction * (size.large ? 10 : 1)),
    );
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
