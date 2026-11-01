// The loop's Filters: each condition as a row, edited in a pop-up as Field,
// When and Value, with menus for what a field's kind allows (LoopSettings.tsx).

import { useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import Dropdown from '../../ui/Dropdown';
import {
  LOOP_QUERY_LIMITS,
  operatorsFor,
  type LoopCondition,
  type LoopFieldKind,
  type LoopOperator,
  type LoopQuery,
} from '../../editor/loopQuery';
import { type CatalogField, type LoopCatalog } from './loopCatalog';
import {
  conditionOf,
  conditionParts,
  draftFor,
  draftOf,
  fieldNamed,
  operatorLabel,
  type ConditionDraft,
} from './loopSettingsModel';
import { EditorRow, ListRow, SectionHeader, fieldIcon } from './LoopRows';
import { useReferenceChoices } from './loopSettingsData';
// ---------------------------------------------------------------------------
// Filters.
// ---------------------------------------------------------------------------

export interface SectionProps {
  readonly query: LoopQuery;
  readonly fields: readonly CatalogField[] | undefined;
  readonly onChange: (query: LoopQuery) => void;
}

export function FilterSection(
  props: SectionProps & {
    readonly catalog: LoopCatalog | undefined;
    readonly projectPath: string | undefined;
    readonly operatorSet: OperatorSet;
  },
) {
  const { query, fields } = props;
  const [open, setOpen] = useState<number | 'new' | undefined>(undefined);
  const filterable = (fields ?? []).filter((field) => operatorsFor(field.kind).length > 0);
  const full = query.conditions.length >= LOOP_QUERY_LIMITS.conditionsMax;
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
        addable={!full && filterable.length > 0}
        extra={
          query.conditions.length > 1 ? (
            <MatchMenu query={query} onChange={props.onChange} />
          ) : undefined
        }
        onAdd={() => setOpen('new')}
      />
      {(query.conditions.length > 0 || open === 'new') && (
        <div className="loop-settings-list">
          {query.conditions.map((condition, index) => (
            <FilterChip
              key={`${index}:${condition.kind === 'custom' ? condition.code : condition.field}`}
              condition={condition}
              fields={fields}
              context={props}
              open={open === index}
              onToggle={() => setOpen(open === index ? undefined : index)}
              onChange={(next) => replace(index, next)}
            />
          ))}
          {open === 'new' && filterable[0] !== undefined && (
            <NewFilterRow
              first={filterable[0]}
              fields={filterable}
              context={props}
              onCommit={(condition) => {
                props.onChange({ ...query, conditions: [...query.conditions, condition] });
                setOpen(undefined);
              }}
              onClose={() => setOpen(undefined)}
            />
          )}
        </div>
      )}
      {query.conditions.length === 0 && open !== 'new' && (
        <div className="loop-settings-empty">
          {fields === undefined ? 'Loading fields…' : 'Showing every item.'}
        </div>
      )}
    </div>
  );
}

// "Match all" or "Match any", beside the add button once there are two filters.
function MatchMenu(props: {
  readonly query: LoopQuery;
  readonly onChange: (query: LoopQuery) => void;
}) {
  return (
    <Dropdown<'all' | 'any'>
      livePreview={false}
      value={props.query.match}
      ariaLabel="Match"
      className="loop-settings-match"
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
  readonly first: CatalogField;
  readonly fields: readonly CatalogField[];
  readonly context: ChoiceContext;
  readonly onCommit: (condition: LoopCondition) => void;
  readonly onClose: () => void;
}) {
  return (
    <ListRow
      parts={{ lead: props.first.title, rest: 'New filter' }}
      open={true}
      removeLabel="Discard filter"
      editor={
        <ConditionEditor
          draft={draftFor(props.first)}
          fields={props.fields}
          context={props.context}
          onCommit={props.onCommit}
          onRemove={props.onClose}
        />
      }
      onToggle={props.onClose}
      onRemove={props.onClose}
    />
  );
}

export interface ChoiceContext {
  readonly catalog: LoopCatalog | undefined;
  readonly projectPath: string | undefined;
  readonly query: LoopQuery;
  readonly operatorSet: OperatorSet;
}

// Settings stored as data (a builder's options object) compare with values
// only; "in the past" needs the date the page is built, which data can't say.
export type OperatorSet = 'code' | 'data';

function operatorsIn(kind: LoopFieldKind, set: OperatorSet): readonly LoopOperator[] {
  const operators = operatorsFor(kind);
  return set === 'code'
    ? operators
    : operators.filter((operator) => operator !== 'inPast' && operator !== 'inFuture');
}

function FilterChip(props: {
  readonly condition: LoopCondition;
  readonly fields: readonly CatalogField[] | undefined;
  readonly context: ChoiceContext;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onChange: (condition: LoopCondition | undefined) => void;
}) {
  const { condition, fields } = props;
  const field = condition.kind === 'test' ? fieldNamed(fields, condition.field) : undefined;
  const choices = useReferenceChoices(props.context, field);
  return (
    <>
      <ListRow
        parts={conditionParts(condition, fields, choices)}
        open={props.open}
        locked={condition.kind === 'custom'}
        removeLabel="Remove filter"
        editor={
          condition.kind === 'test' && field !== undefined ? (
            <ConditionEditor
              draft={draftOf(condition)}
              fields={(fields ?? []).filter((candidate) => operatorsFor(candidate.kind).length > 0)}
              context={props.context}
              onCommit={(next) => props.onChange(next)}
              onRemove={() => props.onChange(undefined)}
            />
          ) : undefined
        }
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
  readonly onCommit: (condition: LoopCondition) => void;
  readonly onRemove: () => void;
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
    const picked = fieldNamed(props.fields, path);
    if (picked !== undefined) {
      commit(draftFor(picked));
    }
  };
  return (
    <div className="loop-settings-editor">
      <EditorRow label="Field">
        <Dropdown<string>
          livePreview={false}
          value={draft.field}
          ariaLabel="Field"
          searchable={props.fields.length > 10}
          options={props.fields.map((candidate) => ({
            value: candidate.path,
            label: candidate.title,
            icon: fieldIcon(candidate.kind),
          }))}
          onChange={changeField}
        />
      </EditorRow>
      <EditorRow label="When">
        <Dropdown
          livePreview={false}
          value={draft.operator}
          ariaLabel="When"
          options={operatorsIn(kind, props.context.operatorSet).map((operator) => ({
            value: operator,
            label: operatorLabel(operator),
          }))}
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
      <button type="button" className="loop-settings-link danger" onClick={props.onRemove}>
        Remove filter
      </button>
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
    conditionOf({ ...draft, value: '' }, kind)?.kind === 'test' &&
    ['isSet', 'isEmpty', 'isTrue', 'isFalse', 'inPast', 'inFuture'].includes(operator);
  if (valueless) {
    return undefined;
  }
  const options = [...(props.field?.options ?? []), ...props.choices];
  const usesChoices =
    (operator === 'is' || operator === 'isNot' || operator === 'has') && options.length > 0;
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
    control = (
      <input
        type="date"
        value={draft.value}
        onChange={(event) => props.onCommit(event.target.value)}
      />
    );
  } else {
    const numeric =
      kind === 'number' ||
      operator === 'greater' ||
      operator === 'less' ||
      operator === 'atLeast' ||
      operator === 'atMost';
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
