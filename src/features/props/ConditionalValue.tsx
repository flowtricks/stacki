// A field's value made conditional on the component's props: the purple
// "Conditional" chip and the read-only summary under it (If Theme = Dark ↳
// value1 / Else ↳ value3), and the Value conditions editor either one opens.
//
// The editor works on a draft (conditionalModel.ts) and writes once, when it
// closes: the expression the model emits, through the field's own setter, as
// one undo step. Closing half-way writes only the finished conditions; the
// unlink button at the top takes the conditional away and leaves the Else
// value as the field's plain value. A field whose code the model cannot read
// never gets here: it stays the code editor it always was.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { HTMLAttributes, RefCallback, RefObject } from 'react';
import useListReorder from '../../ui/useListReorder';
import { DropLine } from '../../ui/DropLine';
import { assert } from '../../../shared/core/assert';
import type { Attr } from '../../../shared/page/pageNode';
import {
  CONDITIONAL_LIMITS,
  isReferencePath,
  type ConditionalResult,
  type ConditionLiteral,
  type ConditionalValue,
  type GroupMatch,
  type TemplatePart,
} from '../../editor/conditionalValue';
import { templateHoles, type TemplateHole } from '../../editor/bindings';
import { FIELD_UNFOCUSED } from './fieldFocus';
import ExprInput, { type ExprInputAPI } from '../../ui/ExprInput';
import { CodeTokens } from '../../ui/CodeBlock';
import type { CodeLine, CodeToken } from '../../ui/codeHighlight';
import { declarationTokens, styleDeclarations } from './StyleEditor';
import Dropdown from '../../ui/Dropdown';
import MultiSelect from '../../ui/MultiSelect';
import { BranchIcon, CloseIcon, CornerIcon, DragIcon, PlusIcon, TrashIcon, UnlinkIcon } from '../../ui/Icons';
import { BindHandle, FieldDataPicker } from './BindingEditors';
import type { FieldPickerAt, InsertAPI } from './bindingTypes';
import { BindField } from './propBindings';
import {
  appliedAttr,
  writeOptionsFor,
  attrOfResult,
  bodyOfResult,
  resultOfBody,
  resultOfAttr,
  resultWords,
  draftOf,
  conditionProps,
  literalOfInput,
  literalWords,
  operatorsFor,
  propOf,
  summaryLines,
  takesValues,
  withCondition,
  withConditionAdded,
  withConditionRemoved,
  withGroup,
  withGroupAdded,
  withGroupMoved,
  withGroupRemoved,
  withSubject,
  type ConditionDraft,
  type ConditionProp,
  type ConditionalDraft,
  type DraftOperator,
  type GroupDraft,
  type ValueLanguage,
} from './conditionalModel';
import { dataPickerPosition } from './dataPickerPosition';
import { reportCodeCleared } from './codeCleared';
import { FieldTypeIcon } from './FieldTypeIcon';
import { RowPopup } from './LoopRows';
import type { RichContext } from './RichContent';
import './conditionalValue.css';

const EDITOR_HEIGHT_PX_MAX = 640;
// Wide enough for a property, an operator and its values on one line; it slides left over the canvas to fit.
const EDITOR_WIDTH_PX_MIN = 520;
const MENU_WIDTH_PX_MIN = 200;

// An empty branch: the attribute is left out (`undefined`).
const NO_VALUE: ConditionalResult = { kind: 'none', word: 'undefined' };

// A condition's prop kind as the field type its icon is drawn for (FieldTypeIcon.tsx).
const FIELD_TYPES: Readonly<Record<ConditionProp['kind'], string>> = { option: 'enum', switch: 'boolean', text: 'string', number: 'number' };

/** The props a condition can test, read from the bind context of the component being edited. */
export function useConditionCatalog(bindContext: RichContext | undefined): readonly ConditionProp[] {
  const frontmatter = bindContext?.frontmatter ?? '';
  const schema = bindContext?.propsSchema;
  return useMemo(() => conditionProps(frontmatter, schema ?? []), [frontmatter, schema]);
}

/** The chip a conditional value (or a class list) shows as in a row's preview. */
export function ConditionalBadge({ label = 'Conditional' }: { readonly label?: string }) {
  return (
    <span className="conditional-badge" title={label === 'Conditional' ? 'Conditional value' : label}>
      <BranchIcon size={11} />
      {label}
    </span>
  );
}

export interface ConditionalFieldProps {
  readonly model: ConditionalValue;
  /** What the field holds now, so an editor closed without a change writes nothing. */
  readonly value: Attr | undefined;
  readonly bindContext: RichContext | undefined;
  /** Writes the field's new value: one undo step. */
  readonly onApply: (value: Attr | undefined) => void;
  /** What the field's words are written in: a style attribute's declarations are highlighted as the CSS editor does. */
  readonly language: ValueLanguage;
}

/** A conditional field: its chip and its summary, each reopening the editor. */
export function ConditionalField(props: ConditionalFieldProps) {
  const catalog = useConditionCatalog(props.bindContext);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div className="conditional-field" ref={ref}>
      <button type="button" className="conditional-chip" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
        <BranchIcon size={11} />
        Conditional
      </button>
      <button type="button" className="conditional-summary" title="Edit the conditions" onClick={() => setOpen(true)}>
        <ConditionalSummary model={props.model} catalog={catalog} language={props.language} />
      </button>
      {open && (
        <ConditionalEditor
          anchorRef={ref}
          start={undefined}
          model={props.model}
          value={props.value}
          bindContext={props.bindContext}
          language={props.language}
          onApply={props.onApply}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/** The read-only lines of a conditional: each group's conditions and the value it gives, then the Else. */
export function ConditionalSummary(props: { readonly model: ConditionalValue; readonly catalog: readonly ConditionProp[]; readonly language: ValueLanguage }) {
  const { model, catalog } = props;
  const lines = summaryLines(model, catalog);
  return (
    <span className="conditional-lines">
      {lines.map((line, index) => (
        <span key={index} className="conditional-line">
          <span className="conditional-heading">{line.heading}</span>
          {line.bullets.map((bullet, at) => (
            <span key={at} className="conditional-bullet">
              {bullet}
            </span>
          ))}
          <span className="conditional-result">
            <CornerIcon size={11} />
            <ResultWords result={line.value} language={props.language} />
          </span>
        </span>
      ))}
    </span>
  );
}

export function ResultWords({ result, language }: { readonly result: ConditionalResult; readonly language: ValueLanguage }) {
  switch (result.kind) {
    case 'text':
      if (result.text === '') {
        return <span className="conditional-empty">Empty</span>;
      }
      return language === 'css' ? (
        <code className="code-inline conditional-text conditional-css">
          <CodeTokens line={declarationTokens(result.text)} />
        </code>
      ) : (
        <span className="conditional-text">{result.text}</span>
      );
    case 'reference':
      return <span className="loop-bind-chip">{result.path}</span>;
    case 'template':
      return <TemplateWords parts={result.parts} language={language} />;
    case 'none':
      return <span className="conditional-empty">(left out)</span>;
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

// A template's words with its values as purple chips between them. In a
// style attribute the words are highlighted as one line of declarations, a
// value standing in as a number, so `${maxWidth}ch` colours `ch` as a unit.
function TemplateWords({ parts, language }: { readonly parts: readonly TemplatePart[]; readonly language: ValueLanguage }) {
  const runs =
    language === 'css' ? highlightedRuns(parts) : parts.map((part) => (part.kind === 'text' ? { kind: 'text' as const, line: [{ text: part.text }] } : part));
  return (
    <code className={`code-inline conditional-text${language === 'css' ? ' conditional-css' : ''}`} title={resultWords({ kind: 'template', parts })}>
      {runs.map((run, index) =>
        run.kind === 'text' ? (
          <CodeTokens key={index} line={run.line} />
        ) : (
          <span key={index} className="loop-bind-chip">
            {run.path}
          </span>
        ),
      )}
    </code>
  );
}

type Run = { readonly kind: 'text'; readonly line: CodeLine } | { readonly kind: 'reference'; readonly path: string };

// The template tokenized whole (each value a run of zeros as long as its
// name), then cut back into its parts, so a word's colour knows what is
// beside it.
function highlightedRuns(parts: readonly TemplatePart[]): readonly Run[] {
  const stand = parts.map((part) => (part.kind === 'text' ? part.text : '0'.repeat(Math.max(part.path.length, 1))));
  const tokens = declarationTokens(stand.join(''));
  const runs: Run[] = [];
  let start = 0;
  for (const [index, part] of parts.entries()) {
    const length = stand[index]?.length ?? 0;
    if (part.kind === 'reference') {
      runs.push(part);
    } else {
      runs.push({ kind: 'text', line: sliceTokens(tokens, start, start + length) });
    }
    start += length;
  }
  assert(runs.length === parts.length, 'highlightedRuns: one run per part');
  return runs;
}

function sliceTokens(tokens: CodeLine, from: number, to: number): CodeLine {
  const out: CodeToken[] = [];
  let at = 0;
  for (const token of tokens) {
    const end = at + token.text.length;
    const left = Math.max(at, from);
    const right = Math.min(end, to);
    if (left < right) {
      const text = token.text.slice(left - at, right - at);
      out.push(token.style === undefined ? { text } : { text, style: token.style });
    }
    at = end;
  }
  return out;
}

export interface ConditionalEditorProps {
  readonly anchorRef: RefObject<HTMLElement>;
  /** A new conditional's draft; undefined to open on `model`. */
  readonly start: ConditionalDraft | undefined;
  readonly model: ConditionalValue | undefined;
  readonly value: Attr | undefined;
  readonly bindContext: RichContext | undefined;
  readonly language: ValueLanguage;
  readonly onApply: (value: Attr | undefined) => void;
  readonly onClose: () => void;
}

/** The Value conditions pop-up, writing its draft once as it closes. */
export function ConditionalEditor(props: ConditionalEditorProps) {
  const catalog = useConditionCatalog(props.bindContext);
  const [draft, setDraft] = useState<ConditionalDraft>(() => {
    if (props.start !== undefined) {
      return props.start;
    }
    assert(props.model !== undefined, 'ConditionalEditor: opened on a draft or a model');
    return draftOf(props.model);
  });
  // Written once: on closing, or if the field goes away with the editor open
  // (its panel closed under it), so what was chosen is never dropped and
  // never written twice.
  const written = useRef(false);
  const frontmatter = props.bindContext?.frontmatter ?? '';
  const latest = useRef({ draft, value: props.value, onApply: props.onApply, frontmatter });
  latest.current = { draft, value: props.value, onApply: props.onApply, frontmatter };
  const apply = (from: ConditionalDraft): void => {
    if (written.current) {
      return;
    }
    written.current = true;
    const next = appliedAttr(from, latest.current.value, writeOptionsFor(latest.current.value, latest.current.frontmatter));
    if (next.kind === 'write') {
      latest.current.onApply(next.value);
    }
  };
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => () => applyRef.current(latest.current.draft), []);
  // Read once mounted: an anchor rendered beside the editor is attached only then.
  const [anchor, setAnchor] = useState<HTMLElement | undefined>(undefined);
  const { anchorRef } = props;
  useLayoutEffect(() => setAnchor(anchorRef.current ?? undefined), [anchorRef]);
  const close = (): void => {
    apply(draft);
    props.onClose();
  };
  // As the {} toggle goes back to a plain value: the whole value is cleared
  // to an empty input, one undo step, with a notice that offers it back.
  const unlink = (): void => {
    written.current = true;
    const before = latest.current.value;
    const onApply = latest.current.onApply;
    onApply(undefined);
    reportCodeCleared(() => onApply(before));
    props.onClose();
  };
  return (
    <RowPopup anchor={anchor} heightPxMax={EDITOR_HEIGHT_PX_MAX} widthPxMin={EDITOR_WIDTH_PX_MIN} label="Value conditions" onClose={close}>
      <div className="conditional-editor">
        <div className="loop-property-head">
          <span className="loop-bind-title">Value conditions</span>
          <button type="button" className="loop-settings-remove" aria-label="Remove conditional" title="Remove conditional" onClick={unlink}>
            <UnlinkIcon size={12} />
          </button>
        </div>
        <GroupList draft={draft} catalog={catalog} bindContext={props.bindContext} language={props.language} setDraft={setDraft} />
        <div className="conditional-add-group-row">
          <button
            type="button"
            className="conditional-add-group"
            disabled={draft.groups.length >= CONDITIONAL_LIMITS.groupsMax}
            onClick={() => setDraft((current) => withGroupAdded(current, catalog))}
          >
            <PlusIcon size={11} />
            New group
          </button>
        </div>
        <div className="conditional-group conditional-else">
          <div className="conditional-group-head">Else</div>
          <ResultField
            label="Else value"
            result={draft.otherwise}
            bindContext={props.bindContext}
            language={props.language}
            onChange={(otherwise) => setDraft((current) => ({ ...current, otherwise }))}
          />
        </div>
      </div>
    </RowPopup>
  );
}

// The groups in the order they are tried, the first that holds giving the
// value: dragged by the grip each shows on hover, or moved with Alt+↑ and
// Alt+↓ on a focused group, with the shared drop line where one would land.
// A move is part of the draft, so it is written, and undone, with the rest.
function GroupList(props: {
  readonly draft: ConditionalDraft;
  readonly catalog: readonly ConditionProp[];
  readonly bindContext: RichContext | undefined;
  readonly language: ValueLanguage;
  readonly setDraft: (change: (draft: ConditionalDraft) => ConditionalDraft) => void;
}) {
  const { draft, setDraft } = props;
  const count = draft.groups.length;
  const move = (source: number, target: number): void => {
    if (target !== source && target !== source + 1) {
      setDraft((current) => withGroupMoved(current, source, target));
    }
  };
  const reorder = useListReorder({ count, onMove: move });
  const gap = reorder.dragIndex === undefined ? undefined : reorder.dropIndex;
  assert(gap === undefined || gap <= count, 'GroupList: the drop gap is within the list');
  return draft.groups.map((group, groupIndex) => {
    const row = reorder.rowProps(groupIndex);
    return (
      <GroupEditor
        key={groupIndex}
        group={group}
        groupIndex={groupIndex}
        catalog={props.catalog}
        bindContext={props.bindContext}
        language={props.language}
        row={{
          ...row,
          // Only the grip starts a drag: a press in a field is a caret, not a move.
          onPointerDown: (event) => {
            if (event.target instanceof Element && event.target.closest('.conditional-grip') !== null) {
              row.onPointerDown?.(event);
            }
          },
          onKeyDown: (event) => {
            if (!event.altKey || event.target !== event.currentTarget) {
              return;
            }
            if (event.key === 'ArrowUp' && groupIndex > 0) {
              event.preventDefault();
              move(groupIndex, groupIndex - 1);
            } else if (event.key === 'ArrowDown' && groupIndex < count - 1) {
              event.preventDefault();
              move(groupIndex, groupIndex + 2);
            }
          },
        }}
        dragging={reorder.dragIndex === groupIndex}
        gap={gap === groupIndex ? 'before' : gap === count && groupIndex === count - 1 ? 'after' : undefined}
        onChange={(change) => setDraft((current) => withGroup(current, groupIndex, change))}
        onRemove={() => setDraft((current) => withGroupRemoved(current, groupIndex))}
      />
    );
  });
}

const MATCH_OPTIONS: readonly { readonly value: GroupMatch; readonly label: string }[] = [
  { value: 'all', label: 'all' },
  { value: 'any', label: 'any' },
];

function GroupEditor(props: {
  readonly group: GroupDraft;
  readonly groupIndex: number;
  readonly catalog: readonly ConditionProp[];
  readonly bindContext: RichContext | undefined;
  readonly language: ValueLanguage;
  readonly row: HTMLAttributes<HTMLElement> & { readonly ref: RefCallback<HTMLElement> };
  readonly dragging: boolean;
  readonly gap: 'before' | 'after' | undefined;
  readonly onChange: (change: (group: GroupDraft) => GroupDraft) => void;
  readonly onRemove: () => void;
}) {
  const { group, catalog, onChange } = props;
  return (
    <>
      {props.groupIndex > 0 && <div className="conditional-or">or</div>}
      <div
        {...props.row}
        className={`conditional-group${props.dragging ? ' is-dragging' : ''}`}
        role="group"
        tabIndex={0}
        aria-label={`Group ${props.groupIndex + 1}`}
      >
        {props.gap !== undefined && (
          <span className={`conditional-gap is-${props.gap}`}>
            <DropLine />
          </span>
        )}
        <div className="conditional-group-head">
          <button type="button" className="conditional-grip" aria-label={`Drag to reorder group ${props.groupIndex + 1}`} data-drag-through tabIndex={-1}>
            <DragIcon size={12} />
          </button>
          If
          <Dropdown
            ariaLabel="Match"
            className="conditional-match"
            menuClassName="conditional-match-menu"
            value={group.match}
            options={MATCH_OPTIONS}
            onChange={(match) => onChange((current) => ({ ...current, match }))}
          />
          <span className="conditional-phrase">conditions in this group are true</span>
          <button type="button" className="loop-settings-remove" aria-label="Remove group" title="Remove group" onClick={props.onRemove}>
            <TrashIcon size={12} />
          </button>
        </div>
        {group.conditions.map((condition, conditionIndex) => (
          <ConditionRow
            key={conditionIndex}
            condition={condition}
            catalog={catalog}
            onChange={(next) => onChange((current) => withCondition(current, conditionIndex, next))}
            onRemove={() => {
              // A group's last condition takes the group with it: a group with no
              // conditions would always hold, which nobody means by removing one.
              if (group.conditions.length === 1) {
                props.onRemove();
              } else {
                onChange((current) => withConditionRemoved(current, conditionIndex));
              }
            }}
          />
        ))}
        <button
          type="button"
          className="conditional-add"
          disabled={group.conditions.length >= CONDITIONAL_LIMITS.conditionsPerGroupMax}
          onClick={() => onChange((current) => withConditionAdded(current, catalog))}
        >
          <PlusIcon size={11} />
          New condition
        </button>
        <div className="conditional-divider" />
        <ResultField
          label="Value"
          result={group.value}
          bindContext={props.bindContext}
          language={props.language}
          onChange={(value) => onChange((current) => ({ ...current, value }))}
        />
      </div>
    </>
  );
}

export function ConditionRow(props: {
  readonly condition: ConditionDraft;
  readonly catalog: readonly ConditionProp[];
  readonly onChange: (condition: ConditionDraft) => void;
  readonly onRemove: () => void;
}) {
  const { condition, catalog } = props;
  const prop = condition.subject === undefined ? undefined : propOf(catalog, condition.subject);
  // A name the code tests that the component does not declare is still listed, so the menu shows it.
  const subjects = prop === undefined || catalog.some((entry) => entry.name === prop.name) ? catalog : [...catalog, prop];
  const operators = operatorsWith(prop?.kind ?? 'text', condition.operator);
  return (
    <div className="conditional-condition">
      <Dropdown
        ariaLabel="Property"
        className="conditional-subject"
        value={condition.subject ?? ''}
        placeholder="Property"
        // The menu is as wide as its longest name, so no prop is cut short.
        menuWidthMin={MENU_WIDTH_PX_MIN}
        options={subjects.map((entry) => ({ value: entry.name, label: entry.label, icon: <FieldTypeIcon type={FIELD_TYPES[entry.kind]} name={entry.name} /> }))}
        onChange={(subject) => props.onChange(withSubject(condition, catalog, subject))}
      />
      <Dropdown
        ariaLabel="Operator"
        className="conditional-operator"
        value={condition.operator}
        options={operators}
        onChange={(operator) => props.onChange({ ...condition, operator, values: takesValues(operator) ? condition.values : [] })}
      />
      {/* Prop, operator, values and the row's one remove, on one line; the
          values shrink, and their chips wrap inside their own box. */}
      {takesValues(condition.operator) && prop !== undefined ? (
        <ValuesInput condition={condition} prop={prop} onChange={props.onChange} />
      ) : (
        <span className="conditional-values-none" />
      )}
      <button type="button" className="loop-settings-remove" aria-label="Remove condition" title="Remove condition" onClick={props.onRemove}>
        <CloseIcon size={12} />
      </button>
    </div>
  );
}

// The kind's operators, plus the condition's own when code chose one the kind
// does not list (a switch compared with a string), so the menu shows what it is.
function operatorsWith(kind: ConditionProp['kind'], operator: DraftOperator): readonly { readonly value: DraftOperator; readonly label: string }[] {
  const offered = operatorsFor(kind);
  if (offered.some((option) => option.value === operator)) {
    return offered;
  }
  const extra = operatorsFor('text').find((option) => option.value === operator);
  assert(extra !== undefined, 'operatorsWith: every operator has words');
  return [...offered, extra];
}

// The values a comparison holds, in one field (MultiSelect): chips, the
// menu of an option prop's options with the chosen ones checked, and for any
// other prop what is typed (Enter adds it).
function ValuesInput(props: { readonly condition: ConditionDraft; readonly prop: ConditionProp; readonly onChange: (condition: ConditionDraft) => void }) {
  const { condition, prop } = props;
  const options = prop.options.map((option) => ({
    value: literalKey({ kind: 'string', value: option }),
    label: literalWords({ kind: 'string', value: option }, prop.kind),
  }));
  const byKey = new Map(condition.values.map((value) => [literalKey(value), value]));
  return (
    <MultiSelect
      ariaLabel="Values"
      values={condition.values.map(literalKey)}
      options={options}
      placeholder={prop.kind === 'option' ? 'Choose…' : 'Type a value'}
      valuesMax={CONDITIONAL_LIMITS.valuesPerConditionMax}
      labelOf={(key) => {
        const literal = byKey.get(key) ?? literalOfKey(key);
        return literal === undefined ? key : literalWords(literal, prop.kind);
      }}
      valueOfText={
        prop.kind === 'option'
          ? undefined
          : (text) => {
              const literal = literalOfInput(prop.kind, text);
              return literal === undefined ? undefined : literalKey(literal);
            }
      }
      onChange={(keys) =>
        props.onChange({
          ...condition,
          values: keys.flatMap((key) => {
            const literal = byKey.get(key) ?? literalOfKey(key);
            return literal === undefined ? [] : [literal];
          }),
        })
      }
    />
  );
}

// A literal as one string the field can hold and compare, and back: its kind leads.
function literalKey(literal: ConditionLiteral): string {
  return `${literal.kind}:${String(literal.value)}`;
}

function literalOfKey(key: string): ConditionLiteral | undefined {
  if (key.startsWith('string:')) {
    return { kind: 'string', value: key.slice('string:'.length) };
  }
  const value = Number(key.slice('number:'.length));
  return key.startsWith('number:') && Number.isFinite(value) ? { kind: 'number', value } : undefined;
}

// "↳ Value": words with data in them, typed and inserted as any bindable
// field's are (BindField: text with purple chips), or No value, which leaves
// the attribute out.
export function ResultField(props: {
  readonly label: string;
  /** What the empty field says; an empty branch leaves the attribute out. */
  readonly placeholder?: string | undefined;
  readonly result: ConditionalResult;
  readonly bindContext: RichContext | undefined;
  readonly language: ValueLanguage;
  readonly onChange: (result: ConditionalResult) => void;
}) {
  const { result } = props;
  const wrap = useRef<HTMLDivElement>(null);
  const apiRef = useRef<InsertAPI | undefined>(undefined);
  const codeApiRef = useRef<ExprInputAPI | undefined>(undefined);
  // The picker, and the chip it was opened on (to swap that value), if it was.
  const [picker, setPicker] = useState<(FieldPickerAt & { readonly chip: TemplateHole | undefined }) | undefined>(undefined);
  const openOnChip = (hole: TemplateHole | undefined): void => {
    if (hole === undefined) {
      return;
    }
    // Anchored to the chip pressed: the n-th chip drawn is the n-th hole.
    const index = templateHoles(bodyOfResult(result)).findIndex((candidate) => candidate.from === hole.from);
    const chip = wrap.current?.querySelectorAll('.expr-chip').item(index);
    const bounds = (chip ?? wrap.current)?.getBoundingClientRect();
    if (bounds !== undefined) {
      setPicker({ ...dataPickerPosition(bounds), focus: FIELD_UNFOCUSED, chip: hole });
    }
  };
  // An empty field is a branch that leaves the attribute out; shown as the empty input it is.
  const shown = attrOfResult(result) ?? { type: 'string', value: '' };
  return (
    <div className="conditional-value-row">
      <CornerIcon size={12} />
      <span className="conditional-value-label">Value</span>
      <div className="attr-value-field" ref={wrap} aria-label={props.label} role="group">
        {props.language === 'css' ? (
          // Declarations, highlighted as the style attribute's CSS editor
          // highlights them, with each `${name}` drawn as a purple chip.
          <ExprInput
            value={bodyOfResult(result)}
            syncValue={bodyOfResult(result)}
            syntax={styleDeclarations}
            className="conditional-css-input"
            ariaLabel={props.label}
            placeholder={props.placeholder ?? 'Leave out'}
            chipsOf={templateHoles}
            onChipClick={openOnChip}
            apiRef={codeApiRef}
            onChange={(text) => takeBody(text, props.onChange)}
          />
        ) : (
          <BindField
            value={shown.type === 'bare' ? { type: 'string', value: '' } : shown}
            placeholder={props.placeholder ?? 'Leave out'}
            bindContext={props.bindContext}
            apiRef={apiRef}
            onChange={(next) => {
              // Emptied, the branch leaves the attribute out; what the model
              // cannot hold (an escape in a template) is not taken in.
              const read = next === undefined ? NO_VALUE : resultOfAttr(next);
              if (read !== undefined) {
                props.onChange(read);
              }
            }}
          />
        )}
        <BindHandle
          active={picker !== undefined}
          onOpen={(_host, focus) => {
            const bounds = wrap.current?.getBoundingClientRect();
            setPicker(picker !== undefined || bounds === undefined ? undefined : { ...dataPickerPosition(bounds), focus, chip: undefined });
          }}
        />
      </div>
      {picker !== undefined && (
        <FieldDataPicker
          pos={picker}
          bindContext={props.bindContext}
          current={picker.chip?.path ?? (result.kind === 'reference' ? result.path : undefined)}
          seed={{ fit: 'text', label: 'value', value: result.kind === 'text' ? result.text : '' }}
          onBindNew={(path) => {
            setPicker(undefined);
            pickReference(path, props.onChange);
          }}
          onPick={(path) => {
            setPicker(undefined);
            // On a chip: that value is swapped, the words around it left as they are.
            if (picker.chip !== undefined && codeApiRef.current !== undefined && isReferencePath(path)) {
              const next = codeApiRef.current.replaceRange(picker.chip.from, picker.chip.to, `\${${path}}`);
              if (next !== undefined) {
                takeBody(next, props.onChange);
              }
              return;
            }
            // At the caret while the words are being typed, as any bindable field.
            if (picker.focus.kind === 'focused' && props.language === 'css' && codeApiRef.current !== undefined && isReferencePath(path)) {
              const next = codeApiRef.current.insert(`\${${path}}`);
              if (next !== undefined) {
                takeBody(next, props.onChange);
              }
              return;
            }
            if (picker.focus.kind === 'focused' && apiRef.current !== undefined) {
              apiRef.current.insert(path);
              return;
            }
            pickReference(path, props.onChange);
          }}
          onClose={() => setPicker(undefined)}
        />
      )}
    </div>
  );
}

// A code field's text taken in as a branch value, unless the model cannot hold it as it is.
function takeBody(text: string, onChange: (result: ConditionalResult) => void): void {
  const read = text === '' ? NO_VALUE : resultOfBody(text);
  if (read !== undefined) {
    onChange(read);
  }
}

// A branch gives a name in scope; a picked path the model cannot write (an
// index, a call) is left out rather than written as code nobody can edit here.
function pickReference(path: string, onChange: (result: ConditionalResult) => void): void {
  if (isReferencePath(path)) {
    onChange({ kind: 'reference', path });
  }
}
