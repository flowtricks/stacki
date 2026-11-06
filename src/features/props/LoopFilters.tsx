// The loop's Filters: each condition as a row, edited in a pop-up as Field,
// When and Value, with menus for what a field's kind allows (LoopSettings.tsx).

import { useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import Dropdown from '../../ui/Dropdown';
import {
  astroConditionCode,
  groqConditionCode,
  LOOP_QUERY_LIMITS,
  operatorsFor,
  type LoopCondition,
  type LoopFieldKind,
  type LoopOperator,
  type LoopQuery,
  type LoopSourceKind,
} from '../../editor/loopQuery';
import { CodeIcon } from '../../ui/Icons';
import { type CatalogField, type LoopCatalog } from './loopCatalog';
import { conditionOf, conditionParts, customFilterProblem, draftFor, draftOf, fieldNamed, operatorLabel, type ConditionDraft } from './loopSettingsModel';
import { CodeBox, EditorRow, ListRow, SectionHeader } from './LoopRows';
import { useCollectionSample, useReferenceChoices } from './loopSettingsData';
import { FieldPicker } from './LoopFieldPicker';
import { SettingDot, type BindingContext, type DraftEditor } from './LoopBinding';
import { LinkedSetting } from './LoopLinked';
import { moved, staysPut } from './LoopItems';
import useListReorder from '../../ui/useListReorder';
// ---------------------------------------------------------------------------
// Filters.
// ---------------------------------------------------------------------------

export interface SectionProps {
  readonly query: LoopQuery;
  readonly fields: readonly CatalogField[] | undefined;
  /** Where a kept list's items hold their fields (`fields`); absent for a collection's own `data`. */
  readonly itemPath?: readonly string[] | undefined;
  readonly onChange: (query: LoopQuery) => void;
}

// The Field menu's entry for custom code, beside the fields; never a field
// name (those are checked names, and this one starts with underscores).
const CUSTOM_FIELD = '__custom';

/** A filter as code, to start a custom one from: what the writer would write for it. */
function conditionCodeOf(condition: LoopCondition, query: LoopQuery, itemPath: readonly string[] | undefined): string {
  if (condition.kind === 'custom') {
    return condition.code;
  }
  if (query.source.kind === 'sanity') {
    return groqConditionCode(condition);
  }
  const name = query.parameter.kind === 'entry' ? query.parameter.name : 'entry';
  const base = itemPath !== undefined ? [name, ...itemPath].join('.') : query.parameter.kind === 'entry' ? `${name}.data` : 'data';
  return astroConditionCode(condition, base);
}

type FilterSectionProps = SectionProps & {
  readonly catalog: LoopCatalog | undefined;
  readonly projectPath: string | undefined;
  readonly operatorSet: OperatorSet;
  readonly binding?: BindingContext | undefined;
  /** The section's label, when it says more than its title (a page's own value). */
  readonly label?: ReactNode;
  /** The `{}` that shows the filters as code. */
  readonly toggle?: ReactNode;
};

/** Filters, or, once linked to a property, its purple bar with the filters as its default. */
export function FilterSection(props: FilterSectionProps) {
  const { binding } = props;
  return binding?.settings.filter.kind === 'prop' ? (
    <LinkedSetting setting="filter" binding={binding} editor={<FilterEditor {...props} binding={undefined} />} draft={filterDraft(props)} />
  ) : (
    <FilterEditor {...props} />
  );
}

// The filters as a new property's default: the same editor over a draft.
function filterDraft(props: FilterSectionProps): DraftEditor {
  return {
    query: props.query,
    render: (query, onChange) => <FilterEditor {...props} query={query} binding={undefined} label={undefined} toggle={undefined} onChange={onChange} />,
  };
}

function FilterEditor(props: FilterSectionProps) {
  const { query, fields } = props;
  // One item, read once for the section: every Field picker shows its values.
  const sample = useCollectionSample(props.projectPath, props.catalog, query.source);
  const context: ChoiceContext = { ...props, sample };
  const [open, setOpen] = useState<number | 'new' | undefined>(undefined);
  const filterable = (fields ?? []).filter((field) => operatorsFor(field.kind).length > 0);
  const full = query.conditions.length >= LOOP_QUERY_LIMITS.conditionsMax;
  // Filters drag into the order they read in; a drop back in place writes nothing.
  const reorder = useListReorder({
    count: query.conditions.length,
    onMove: (source, target) => {
      if (staysPut(source, target)) {
        return;
      }
      setOpen(undefined);
      props.onChange({ ...query, conditions: moved(query.conditions, source, target) });
    },
  });
  const replace = (index: number, condition: LoopCondition | undefined): void => {
    const conditions =
      condition === undefined
        ? query.conditions.filter((_, at) => at !== index)
        : query.conditions.map((existing, at) => (at === index ? condition : existing));
    props.onChange({ ...query, conditions });
  };
  return (
    <div className="loop-settings-section">
      <SectionHeader
        title="Filters"
        label={props.label}
        dot={<SettingDot setting="filter" binding={props.binding} draft={filterDraft(props)} />}
        toggle={props.toggle}
        addable={!full && (filterable.length > 0 || props.operatorSet === 'code')}
        extra={query.conditions.length > 1 ? <MatchMenu query={query} onChange={props.onChange} /> : undefined}
        onAdd={() => setOpen('new')}
      />
      {(query.conditions.length > 0 || open === 'new') && (
        <div className="loop-settings-list">
          {query.conditions.map((condition, index) => (
            <div
              key={`${index}:${condition.kind === 'custom' ? condition.code : condition.field}`}
              {...reorder.rowProps(index)}
              className={`loop-settings-sortable ${reorder.rowClass(index)}`}
            >
              <FilterChip
                condition={condition}
                fields={fields}
                itemPath={props.itemPath}
                context={context}
                open={open === index}
                onToggle={() => setOpen(open === index ? undefined : index)}
                onChange={(next) => replace(index, next)}
              />
            </div>
          ))}
          {open === 'new' && (
            <NewFilterRow
              first={filterable[0]}
              fields={filterable}
              context={context}
              onCommit={(condition) => {
                // Stays open on the filter just added: a first valid value
                // (a switch's "is on") is a start, not the last word.
                props.onChange({ ...query, conditions: [...query.conditions, condition] });
                setOpen(query.conditions.length);
              }}
              onClose={() => setOpen(undefined)}
            />
          )}
        </div>
      )}
    </div>
  );
}

// "Match all" or "Match any", beside the add button once there are two filters.
function MatchMenu(props: { readonly query: LoopQuery; readonly onChange: (query: LoopQuery) => void }) {
  return (
    <Dropdown<'all' | 'any'>
      livePreview={false}
      value={props.query.match}
      ariaLabel="Match"
      className="loop-settings-match"
      menuWidthMin={140}
      options={[
        { value: 'all', label: 'Match all' },
        { value: 'any', label: 'Match any' },
      ]}
      onChange={(match) => props.onChange({ ...props.query, match })}
    />
  );
}

// A filter being added: a row with its editor open, written once it is valid.
function NewFilterRow(props: {
  readonly first: CatalogField | undefined;
  readonly fields: readonly CatalogField[];
  readonly context: ChoiceContext;
  readonly onCommit: (condition: LoopCondition) => void;
  readonly onClose: () => void;
}) {
  // With no field to filter by, custom code is the only filter there is.
  const [custom, setCustom] = useState(props.first === undefined);
  // The field picked in the code editor's Field menu, to start the field editor on.
  const [picked, setPicked] = useState<CatalogField | undefined>(undefined);
  const first = picked ?? props.first;
  return (
    <ListRow
      parts={{ lead: custom || first === undefined ? 'Custom code' : first.title, rest: 'New filter' }}
      open={true}
      removeLabel="Discard filter"
      editor={
        custom || first === undefined ? (
          <CustomConditionEditor
            code=""
            fields={props.fields}
            context={props.context}
            onField={(path) => {
              setPicked(fieldNamed(props.fields, path));
              setCustom(false);
            }}
            onCommit={props.onCommit}
          />
        ) : (
          <ConditionEditor
            key={first.path}
            draft={draftFor(first)}
            fields={props.fields}
            context={props.context}
            onCustom={() => setCustom(true)}
            onCommit={props.onCommit}
          />
        )
      }
      onToggle={props.onClose}
      onRemove={props.onClose}
    />
  );
}

// A filter as code: the Field menu (to go back to a field), and the code box.
function CustomConditionEditor(props: {
  readonly code: string;
  readonly fields: readonly CatalogField[];
  readonly context: ChoiceContext;
  /** Back to a field's editor, on the field picked; absent where there are no fields. */
  readonly onField: ((path: string) => void) | undefined;
  readonly onCommit: (condition: LoopCondition) => void;
}) {
  const source = props.context.query.source.kind;
  return (
    <div className="loop-settings-editor">
      <EditorRow label="Field">
        <FieldMenu
          value={CUSTOM_FIELD}
          fields={props.fields}
          custom={true}
          sample={props.context.sample}
          onChange={(path) => (path === CUSTOM_FIELD ? undefined : props.onField?.(path))}
        />
      </EditorRow>
      <CodeBox
        value={props.code}
        label="Filter code"
        placeholder={customFilterPlaceholder(source)}
        check={(code) => customFilterProblem(code, source)}
        onCommit={(code) => props.onCommit({ kind: 'custom', code })}
      />
    </div>
  );
}

// What a custom filter reads its fields from, as an example of the source's own code.
function customFilterPlaceholder(source: LoopSourceKind): string {
  switch (source) {
    case 'astro':
      return 'data.title.startsWith("Pastor")';
    case 'sanity':
      return 'count(serviceTimes) > 1';
    case 'list':
      return 'item.title.startsWith("Pastor")';
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

// The fields a filter can name, as a tree of what an item holds with each
// value beside it, and, where the list is code, custom code above it.
function FieldMenu(props: {
  readonly value: string;
  readonly fields: readonly CatalogField[];
  readonly custom: boolean;
  readonly sample: unknown;
  readonly onChange: (path: string) => void;
}) {
  return (
    <FieldPicker
      value={props.value}
      fields={props.fields}
      sample={props.sample}
      extras={props.custom ? [{ value: CUSTOM_FIELD, label: 'Custom code', icon: <CodeIcon size={13} /> }] : []}
      usable={(field) => operatorsFor(field.kind).length > 0}
      onChange={props.onChange}
    />
  );
}

export interface ChoiceContext {
  readonly catalog: LoopCatalog | undefined;
  readonly projectPath: string | undefined;
  readonly query: LoopQuery;
  readonly operatorSet: OperatorSet;
  /** One item of the collection, whose values the Field picker shows. */
  readonly sample?: unknown;
}

// Settings stored as data (a builder's options object) compare with values
// only; "in the past" needs the date the page is built, which data can't say.
export type OperatorSet = 'code' | 'data';

function operatorsIn(kind: LoopFieldKind, set: OperatorSet): readonly LoopOperator[] {
  const operators = operatorsFor(kind);
  return set === 'code' ? operators : operators.filter((operator) => operator !== 'inPast' && operator !== 'inFuture');
}

function FilterChip(props: {
  readonly condition: LoopCondition;
  readonly fields: readonly CatalogField[] | undefined;
  readonly itemPath: readonly string[] | undefined;
  readonly context: ChoiceContext;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onChange: (condition: LoopCondition | undefined) => void;
}) {
  const { condition, fields } = props;
  const field = condition.kind === 'test' ? fieldNamed(fields, condition.field) : undefined;
  const choices = useReferenceChoices(props.context, field);
  const filterable = (fields ?? []).filter((candidate) => operatorsFor(candidate.kind).length > 0);
  const codeAllowed = props.context.operatorSet === 'code';
  // The editor shown: the filter's own kind, until the Field menu switches it.
  // Switching writes nothing; the filter changes once the other editor makes
  // a valid one. Turned into code, a filter starts as the code it already is.
  const [shown, setShown] = useState<'code' | 'field' | undefined>(undefined);
  // The field picked in the code editor's Field menu, to start the field editor on.
  const [picked, setPicked] = useState<CatalogField | undefined>(undefined);
  // A filter on a field the collection does not list can only be shown as code.
  const mode = shown ?? (condition.kind === 'custom' || field === undefined ? 'code' : 'field');
  const commit = (next: LoopCondition): void => {
    setShown(undefined);
    setPicked(undefined);
    props.onChange(next);
  };
  const editor = (): ReactNode => {
    const first = picked ?? field ?? filterable[0];
    if (mode === 'code') {
      return codeAllowed ? (
        <CustomConditionEditor
          code={conditionCodeOf(condition, props.context.query, props.itemPath)}
          fields={filterable}
          context={props.context}
          onField={
            first === undefined
              ? undefined
              : (path) => {
                  setPicked(fieldNamed(filterable, path));
                  setShown('field');
                }
          }
          onCommit={commit}
        />
      ) : undefined;
    }
    if (first === undefined) {
      return undefined;
    }
    return (
      <ConditionEditor
        key={first.path}
        draft={condition.kind === 'test' && picked === undefined ? draftOf(condition) : draftFor(first)}
        fields={filterable}
        context={props.context}
        onCustom={codeAllowed ? () => setShown('code') : undefined}
        onCommit={commit}
      />
    );
  };
  return (
    <>
      <ListRow
        dragThrough={true}
        parts={conditionParts(condition, fields, choices)}
        open={props.open}
        locked={condition.kind === 'custom' && !codeAllowed}
        removeLabel="Remove filter"
        editor={editor()}
        onToggle={props.onToggle}
        onRemove={() => props.onChange(undefined)}
      />
    </>
  );
}

// Field, When and Value. Menus write at once; typed values write when the
// field is left or Enter is pressed, and only once they are valid.
function ConditionEditor(props: {
  readonly draft: ConditionDraft;
  readonly fields: readonly CatalogField[];
  readonly context: ChoiceContext;
  /** Where the list is code, the Field menu offers custom code. */
  readonly onCustom?: (() => void) | undefined;
  readonly onCommit: (condition: LoopCondition) => void;
}) {
  const [draft, setDraft] = useState(props.draft);
  const field = fieldNamed(props.fields, draft.field);
  const kind: LoopFieldKind = field?.kind ?? 'other';
  const choices = useReferenceChoices(props.context, field);
  const commit = (next: ConditionDraft): void => {
    setDraft(next);
    const condition = conditionOf(next, kind);
    if (condition !== undefined) {
      props.onCommit(condition);
    }
  };
  const changeField = (path: string): void => {
    if (path === CUSTOM_FIELD) {
      props.onCustom?.();
      return;
    }
    const picked = fieldNamed(props.fields, path);
    if (picked !== undefined) {
      commit(draftFor(picked));
    }
  };
  return (
    <div className="loop-settings-editor">
      <EditorRow label="Field">
        <FieldMenu value={draft.field} fields={props.fields} custom={props.onCustom !== undefined} sample={props.context.sample} onChange={changeField} />
      </EditorRow>
      <EditorRow label="When">
        <Dropdown
          livePreview={false}
          value={draft.operator}
          ariaLabel="When"
          options={operatorsIn(kind, props.context.operatorSet).map((operator) => ({ value: operator, label: operatorLabel(operator) }))}
          onChange={(operator) => commit({ ...draft, operator })}
        />
      </EditorRow>
      <ValueRow
        draft={draft}
        kind={kind}
        field={field}
        choices={choices}
        onChange={(value) => setDraft({ ...draft, value })}
        onCommit={(value) => commit({ ...draft, value })}
      />
    </div>
  );
}

function ValueRow(props: {
  readonly draft: ConditionDraft;
  readonly kind: LoopFieldKind;
  readonly field: CatalogField | undefined;
  readonly choices: readonly { readonly title: string; readonly value: string }[];
  readonly onChange: (value: string) => void;
  readonly onCommit: (value: string) => void;
}) {
  const { draft, kind } = props;
  const operator = draft.operator;
  const valueless =
    conditionOf({ ...draft, value: '' }, kind)?.kind === 'test' && ['isSet', 'isEmpty', 'isTrue', 'isFalse', 'inPast', 'inFuture'].includes(operator);
  if (valueless) {
    return undefined;
  }
  const options = [...(props.field?.options ?? []), ...props.choices];
  const usesChoices = (operator === 'is' || operator === 'isNot' || operator === 'has') && options.length > 0;
  const enter = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      props.onCommit(event.currentTarget.value);
    }
  };
  let control: ReactNode;
  if (usesChoices) {
    control = (
      <Dropdown<string>
        livePreview={false}
        value={draft.value}
        ariaLabel="Value"
        placeholder="Choose…"
        searchable={options.length > 10}
        options={options.map((option) => ({ value: option.value, label: option.title }))}
        onChange={props.onCommit}
      />
    );
  } else if (operator === 'before' || operator === 'after') {
    control = <input type="date" value={draft.value} onChange={(event) => props.onCommit(event.target.value)} />;
  } else {
    const numeric = kind === 'number' || operator === 'greater' || operator === 'less' || operator === 'atLeast' || operator === 'atMost';
    control = (
      <input
        type={numeric ? 'number' : 'text'}
        value={draft.value}
        placeholder={numeric ? '0' : 'Value'}
        maxLength={LOOP_QUERY_LIMITS.valueCharsMax}
        spellCheck={false}
        onChange={(event) => props.onChange(event.target.value)}
        onBlur={(event) => props.onCommit(event.target.value)}
        onKeyDown={enter}
      />
    );
  }
  return <EditorRow label="Value">{control}</EditorRow>;
}
