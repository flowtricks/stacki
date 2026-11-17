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
import { createPortal } from 'react-dom';
import { tooltipHost, useDelayedTooltip } from '../../ui/delayedTooltip';
import type { HTMLAttributes, KeyboardEvent, ReactNode, RefCallback, RefObject } from 'react';
import useListReorder from '../../ui/useListReorder';
import { DropLine } from '../../ui/DropLine';
import { assert } from '../../../shared/core/assert';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { Attr } from '../../../shared/page/pageNode';
import {
  CONDITIONAL_LIMITS,
  emitConditionalExpression,
  isPlainResult,
  isReferencePath,
  readConditionalExpression,
  type ConditionalResult,
  type ReadShapes,
  type ValueResult,
  type ConditionLiteral,
  type ConditionalValue,
  type GroupMatch,
  type TemplatePart,
} from '../../editor/conditionalValue';
import { templateHoles, type TemplateHole } from '../../editor/bindings';
import { FIELD_UNFOCUSED } from './fieldFocus';
import ExprInput, { type ExprInputAPI } from '../../ui/ExprInput';
import { isExpression } from './jsCheck';
import { CodeInline, CodeTokens } from '../../ui/CodeBlock';
import type { CodeLine, CodeToken } from '../../ui/codeHighlight';
import { declarationTokens, styleDeclarations } from './StyleEditor';
import Dropdown from '../../ui/Dropdown';
import { ValueChoiceSwitch, type ValueChoice } from './ValueChoices';
import MultiSelect from '../../ui/MultiSelect';
import { BracesIcon, BranchIcon, CloseIcon, CodeIcon, SyncIcon, CornerIcon, DragIcon, PlusIcon, TrashIcon, UnlinkIcon } from '../../ui/Icons';
import { BindHandle, FieldDataPicker } from './BindingEditors';
import type { FieldPickerAt, InsertAPI } from './bindingTypes';
import { BindField } from './propBindings';
import { ConditionCodeBox, ConditionCodeToggle } from './ConditionCodeToggle';
import { appliedCode, CONTROLS_DECISION, decideConditionView, type ConditionView } from './conditionViewDecision';
import {
  appliedAttr,
  appliedStart,
  writeOptionsFor,
  attrOfResult,
  bodyOfResult,
  resultOfBody,
  resultOfAttr,
  resultWords,
  draftOf,
  draftUnchanged,
  conditionProps,
  conditionWords,
  plainerCondition,
  presentedModel,
  literalOfInput,
  literalWords,
  matchOptions,
  modelOf,
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
  type ConditionReach,
  type DraftOperator,
  type GroupDraft,
  type ValueLanguage,
} from './conditionalModel';
import type { Translator } from '../../../shared/properties/i18n/messageRef';
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

const readableIn =
  (shapes: ReadShapes) =>
  (source: string): boolean =>
    readConditionalExpression(source, { shapes }) !== undefined;

// An empty branch: the attribute is left out (`undefined`).
const NO_VALUE: ConditionalResult = { kind: 'none', word: 'undefined' };

// A condition's prop kind as the field type its icon is drawn for (FieldTypeIcon.tsx).
const FIELD_TYPES: Readonly<Record<ConditionProp['kind'], string>> = { option: 'enum', switch: 'boolean', text: 'string', number: 'number' };

/**
 * The props a condition can test, read from the bind context of the component
 * being edited; in the template (`reach: 'template'`) the values its
 * frontmatter computes from them too, listed after them.
 */
export function useConditionCatalog(bindContext: RichContext | undefined, reach: ConditionReach = 'props'): readonly ConditionProp[] {
  const frontmatter = bindContext?.frontmatter ?? '';
  const schema = bindContext?.propsSchema;
  return useMemo(() => conditionProps(frontmatter, schema ?? [], reach), [frontmatter, schema, reach]);
}

/** The chip a conditional value (or a class list) shows as in a row's preview. */
export function ConditionalBadge({ label, tone }: { readonly label?: string; readonly tone?: 'computed' | undefined }) {
  const translate = useTranslate();
  return (
    <span
      className={`conditional-badge${tone === 'computed' ? ' conditional-badge-computed' : ''}`}
      title={label === undefined ? translate('props.conditional.value') : label}
    >
      <BranchIcon size={11} />
      {label ?? translate('props.conditional.chip')}
    </span>
  );
}

/**
 * Code that chooses between values but that the conditions cannot read (a
 * regular expression, a condition inside a template): the Computed pill,
 * read-only, with the code highlighted after it, never bare code as the main
 * control. The `{}` opens it in the code editor, where it is edited as code.
 */
export function ComputedField(props: { readonly code: string; readonly onEditCode: () => void }) {
  const translate = useTranslate();
  return (
    <div className="conditional-field conditional-computed-field">
      <span className="conditional-chip conditional-chip-computed" title={translate('props.conditional.computedTitle')}>
        <BranchIcon size={11} />
        {translate('props.conditional.computed')}
      </span>
      <CodeInline text={props.code} language="typescript" className="conditional-computed-code" />
      <button
        type="button"
        className="prop-expr-toggle conditional-computed-toggle"
        aria-label={translate('props.condition.writeCode')}
        title={translate('props.condition.writeCode')}
        onClick={props.onEditCode}
      >
        <BracesIcon size={12} />
      </button>
    </div>
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
  const translate = useTranslate();
  const catalog = useConditionCatalog(props.bindContext, 'template');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div className="conditional-field" ref={ref}>
      <button type="button" className="conditional-chip" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
        <BranchIcon size={11} />
        {translate('props.conditional.chip')}
      </button>
      <button type="button" className="conditional-summary" title={translate('props.conditional.edit')} onClick={() => setOpen(true)}>
        <ConditionalSummary model={presentedModel(props.model)} catalog={catalog} language={props.language} />
      </button>
      {open && (
        <ConditionalEditor
          anchorRef={ref}
          start={undefined}
          model={props.model}
          value={props.value}
          bindContext={props.bindContext}
          language={props.language}
          shapes="rich"
          onApply={props.onApply}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/** The read-only lines of a conditional: each group's conditions and the value it gives, then the Else. */
export function ConditionalSummary(props: { readonly model: ConditionalValue; readonly catalog: readonly ConditionProp[]; readonly language: ValueLanguage }) {
  const translate = useTranslate();
  const { model, catalog } = props;
  const lines = summaryLines(model, catalog, translate);
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
  if (result.kind === 'fallback') {
    // The first value that is set: each value as it reads, the operator between them muted.
    return (
      <span className="conditional-fallback" title={resultWords(result)}>
        {result.operands.map((operand, index) => (
          <span key={index} className="conditional-fallback-operand">
            {index > 0 && <span className="conditional-fallback-operator">{result.operator}</span>}
            <ValueWords result={operand} language={language} />
          </span>
        ))}
      </span>
    );
  }
  return <ValueWords result={result} language={language} />;
}

function ValueWords({ result, language }: { readonly result: ValueResult; readonly language: ValueLanguage }) {
  const translate = useTranslate();
  switch (result.kind) {
    case 'text':
      if (result.text === '') {
        return <span className="conditional-empty">{translate('props.conditional.empty')}</span>;
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
      return <span className="conditional-empty">{translate('props.conditional.leftOutNote')}</span>;
    case 'lookup':
      // The entry the prop picks: one bound value, named as the code names it.
      return <span className="loop-bind-chip">{`${result.table}[${result.key}]`}</span>;
    case 'computed':
      return <CodeInline text={result.code} language="typescript" className="conditional-computed-code" />;
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
  /**
   * A value picked from a few icon choices rather than typed (a prop's
   * Visibility: Show, Hide, Required): each group's value and the Else are
   * those choices side by side, a choice's value the words the branch gives.
   */
  readonly valueChoices?: readonly ValueChoice[] | undefined;
  /** The editor's title, when it edits something other than an attribute's value. */
  readonly title?: string | undefined;
  /** What the editor reads and takes in: `rich` for an attribute's value (locked code kept), `plain` by default. */
  readonly shapes?: ReadShapes | undefined;
}

/** The Value conditions pop-up, writing its draft once as it closes. */
export function ConditionalEditor(props: ConditionalEditorProps) {
  const translate = useTranslate();
  const shapes = props.shapes ?? 'plain';
  const catalog = useConditionCatalog(props.bindContext, shapes === 'rich' ? 'template' : 'props');
  // The draft it opened on: a group that leaves the value out reads value first
  // (presentedModel), and closing it unchanged writes nothing, whatever its spelling.
  const [opened] = useState<ConditionalDraft>(() => {
    if (props.start !== undefined) {
      return props.start;
    }
    assert(props.model !== undefined, 'ConditionalEditor: opened on a draft or a model');
    return draftOf(props.valueChoices === undefined ? presentedModel(props.model) : props.model);
  });
  const [draft, setDraft] = useState<ConditionalDraft>(opened);
  // Written once: on closing, or if the field goes away with the editor open
  // (its panel closed under it), so what was chosen is never dropped and
  // never written twice.
  const written = useRef(false);
  const frontmatter = props.bindContext?.frontmatter ?? '';
  // The {} swaps the controls for the expression; code the controls cannot show stays code (conditionViewDecision.ts).
  const [view, setView] = useState<ConditionView>('visual');
  const [code, setCode] = useState('');
  const [codeSeed, setCodeSeed] = useState('');
  const latest = useRef({ draft, value: props.value, onApply: props.onApply, frontmatter, view, code });
  latest.current = { draft, value: props.value, onApply: props.onApply, frontmatter, view, code };
  const apply = (from: ConditionalDraft): void => {
    if (written.current) {
      return;
    }
    written.current = true;
    if (latest.current.view === 'code') {
      const typed = appliedCode(latest.current.code, latest.current.value);
      if (typed.kind === 'write') {
        latest.current.onApply(typed.value);
      }
      return;
    }
    if (props.start === undefined && draftUnchanged(from, opened)) {
      return;
    }
    const write = props.start === undefined ? appliedAttr : appliedStart;
    const next = write(from, latest.current.value, writeOptionsFor(latest.current.value, latest.current.frontmatter));
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
  // A group added at the bottom of a long list is scrolled into view, so the new rows are where the eye goes.
  const bodyRef = useRef<HTMLDivElement>(null);
  const revealAdded = useRef(false);
  const groupCount = draft.groups.length;
  useEffect(() => {
    if (!revealAdded.current) {
      return;
    }
    revealAdded.current = false;
    const groups = bodyRef.current?.querySelectorAll('.conditional-group[role="group"]');
    groups?.item(groups.length - 1).scrollIntoView?.({ block: 'nearest' });
  }, [groupCount]);
  const decision = view === 'code' ? decideConditionView({ source: code, readable: readableIn(shapes), chosen: 'code' }) : CONTROLS_DECISION;
  const choose = (next: ConditionView): void => {
    if (next === 'code') {
      const model = modelOf(draft);
      const before = latest.current.value;
      // With no finished group the draft has no expression of its own: the field's own code is what there is to edit.
      const text =
        model.groups.length > 0 ? emitConditionalExpression(model, writeOptionsFor(before, frontmatter)) : before?.type === 'expr' ? before.value : '';
      setCode(text);
      setCodeSeed(text);
      setView('code');
      return;
    }
    const model = readConditionalExpression(code, { shapes });
    if (model !== undefined) {
      setDraft(draftOf(model));
      setView('visual');
    }
  };
  // As the {} toggle goes back to a plain value: the whole value is cleared
  // to an empty input, one undo step, with a notice that offers it back.
  const unlink = (): void => {
    written.current = true;
    const before = latest.current.value;
    const onApply = latest.current.onApply;
    onApply(undefined);
    reportCodeCleared(translate, () => onApply(before));
    props.onClose();
  };
  return (
    <RowPopup
      anchor={anchor}
      heightPxMax={EDITOR_HEIGHT_PX_MAX}
      widthPxMin={EDITOR_WIDTH_PX_MIN}
      label={props.title ?? translate('props.conditional.editorTitle')}
      onClose={close}
    >
      <div className="conditional-editor">
        <div className="loop-property-head">
          <span className="loop-bind-title">{props.title ?? translate('props.conditional.editorTitle')}</span>
          <ConditionCodeToggle decision={decision} onChoose={choose} />
          <button
            type="button"
            className="loop-settings-remove"
            aria-label={translate('props.conditional.remove')}
            title={translate('props.conditional.remove')}
            onClick={unlink}
          >
            <UnlinkIcon size={12} />
          </button>
        </div>
        {view === 'code' ? (
          <>
            <ConditionCodeBox code={code} seed={codeSeed} context={props.bindContext} onChange={setCode} />
          </>
        ) : (
          <div className="conditional-editor-body" ref={bodyRef} tabIndex={-1}>
            <GroupList
              draft={draft}
              catalog={catalog}
              bindContext={props.bindContext}
              language={props.language}
              shapes={shapes}
              valueChoices={props.valueChoices}
              setDraft={setDraft}
            />
            <AddGroupRow
              disabled={draft.groups.length >= CONDITIONAL_LIMITS.groupsMax}
              onAdd={() => {
                setDraft((current) => withGroupAdded(current, catalog));
                revealAdded.current = true;
              }}
            />
            <div className="conditional-group conditional-else">
              <div className="conditional-group-head">{translate('props.conditional.summary.else')}</div>
              {props.valueChoices === undefined ? (
                <ResultField
                  label={translate('props.conditional.elseValue')}
                  result={draft.otherwise}
                  bindContext={props.bindContext}
                  language={props.language}
                  shapes={shapes}
                  onChange={(otherwise) => setDraft((current) => ({ ...current, otherwise }))}
                />
              ) : (
                <ChoiceResult
                  label={translate('props.conditional.elseValue')}
                  result={draft.otherwise}
                  choices={props.valueChoices}
                  onChange={(otherwise) => setDraft((current) => ({ ...current, otherwise }))}
                />
              )}
            </div>
          </div>
        )}
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
  readonly shapes: ReadShapes;
  readonly valueChoices: readonly ValueChoice[] | undefined;
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
        shapes={props.shapes}
        valueChoices={props.valueChoices}
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

function GroupEditor(props: {
  readonly group: GroupDraft;
  readonly groupIndex: number;
  readonly catalog: readonly ConditionProp[];
  readonly bindContext: RichContext | undefined;
  readonly language: ValueLanguage;
  readonly shapes: ReadShapes;
  readonly valueChoices: readonly ValueChoice[] | undefined;
  readonly row: HTMLAttributes<HTMLElement> & { readonly ref: RefCallback<HTMLElement> };
  readonly dragging: boolean;
  readonly gap: 'before' | 'after' | undefined;
  readonly onChange: (change: (group: GroupDraft) => GroupDraft) => void;
  readonly onRemove: () => void;
}) {
  const translate = useTranslate();
  const { group, catalog, onChange } = props;
  return (
    <>
      {props.groupIndex > 0 && <div className="conditional-or">{translate('props.conditional.or')}</div>}
      <div
        {...props.row}
        className={`conditional-group${props.dragging ? ' is-dragging' : ''}`}
        role="group"
        tabIndex={0}
        aria-label={translate('props.conditional.group', { number: props.groupIndex + 1 })}
      >
        {props.gap !== undefined && (
          <span className={`conditional-gap is-${props.gap}`}>
            <DropLine />
          </span>
        )}
        <ConditionGroupBody
          match={group.match}
          conditions={group.conditions}
          catalog={catalog}
          conditionsMax={CONDITIONAL_LIMITS.conditionsPerGroupMax}
          dragGroupLabel={translate('props.conditional.dragGroup', { number: props.groupIndex + 1 })}
          removeLabel={translate('props.conditional.removeGroup')}
          onMatch={(match) => onChange((current) => ({ ...current, match }))}
          onCondition={(conditionIndex, next) => onChange((current) => withCondition(current, conditionIndex, next))}
          onConditionRemove={(conditionIndex) => {
            // A group's last condition takes the group with it: a group with no
            // conditions would always hold, which nobody means by removing one.
            if (group.conditions.length === 1) {
              props.onRemove();
            } else {
              onChange((current) => withConditionRemoved(current, conditionIndex));
            }
          }}
          onConditionAdd={() => onChange((current) => withConditionAdded(current, catalog))}
          onRemove={props.onRemove}
          value={
            props.valueChoices === undefined ? (
              <ResultField
                label={translate('props.conditional.valueLabel')}
                result={group.value}
                bindContext={props.bindContext}
                language={props.language}
                shapes={props.shapes}
                onChange={(value) => onChange((current) => ({ ...current, value }))}
              />
            ) : (
              <ChoiceResult
                label={translate('props.conditional.valueLabel')}
                result={group.value}
                choices={props.valueChoices}
                onChange={(value) => onChange((current) => ({ ...current, value }))}
              />
            )
          }
        />
      </div>
    </>
  );
}

/**
 * One group as every conditions editor lays it out, in one order: "If [all]
 * conditions in this group are true", the condition rows, "+ New condition",
 * a divider, then the "↳ Value" the group gives. Value conditions (an
 * attribute, a Default value, a Tooltip, a Visibility) and the Class list's
 * entries all draw it, so the value always comes after its conditions. With
 * no condition (a class given always) the head says Always instead.
 */
export function ConditionGroupBody(props: {
  readonly match: GroupMatch;
  readonly conditions: readonly ConditionDraft[];
  readonly catalog: readonly ConditionProp[];
  readonly conditionsMax: number;
  /** Present where groups can be dragged: the grip's label. */
  readonly dragGroupLabel?: string | undefined;
  readonly removeLabel: string;
  readonly onMatch: (match: GroupMatch) => void;
  readonly onCondition: (conditionIndex: number, condition: ConditionDraft) => void;
  readonly onConditionRemove: (conditionIndex: number) => void;
  readonly onConditionAdd: () => void;
  readonly onRemove: () => void;
  /** The "↳ Value" row, drawn last. */
  readonly value: ReactNode;
}) {
  assert(props.conditions.length <= props.conditionsMax, 'ConditionGroupBody: the conditions are bounded');
  return (
    <>
      <GroupHeading
        match={props.match}
        always={props.conditions.length === 0}
        onMatch={props.onMatch}
        onRemove={props.onRemove}
        removeLabel={props.removeLabel}
        dragGroupLabel={props.dragGroupLabel}
      />
      {props.conditions.map((condition, conditionIndex) => (
        <ConditionRow
          key={conditionIndex}
          condition={condition}
          catalog={props.catalog}
          onChange={(next) => props.onCondition(conditionIndex, next)}
          onRemove={() => props.onConditionRemove(conditionIndex)}
        />
      ))}
      <AddConditionButton disabled={props.conditions.length >= props.conditionsMax} onAdd={props.onConditionAdd} />
      <div className="conditional-divider" />
      {props.value}
    </>
  );
}

export function ConditionRow(props: {
  readonly condition: ConditionDraft;
  readonly catalog: readonly ConditionProp[];
  readonly onChange: (condition: ConditionDraft) => void;
  readonly onRemove: () => void;
}) {
  const translate = useTranslate();
  const { condition, catalog } = props;
  if (condition.code !== undefined) {
    return <LockedConditionLine code={condition.code} onRemove={props.onRemove} />;
  }
  const prop = condition.subject === undefined ? undefined : propOf(catalog, condition.subject);
  // A name the code tests that the component does not declare is still listed, so the menu shows it.
  const listed = prop === undefined || catalog.some((entry) => entry.name === prop.name) ? catalog : [...catalog, prop];
  // Values the frontmatter computes come after the props, under their own heading, so none passes for a prop.
  const subjects = [...listed.filter((entry) => entry.computed === undefined), ...listed.filter((entry) => entry.computed !== undefined)];
  const operators = operatorsWith(prop?.kind ?? 'text', condition.operator, translate);
  const plainer = plainerCondition(condition, catalog);
  return (
    <ConditionLine
      onRemove={props.onRemove}
      subject={
        <Dropdown
          ariaLabel={translate('props.conditional.property')}
          className="conditional-subject"
          value={condition.subject ?? ''}
          placeholder={translate('props.conditional.property')}
          // The menu is as wide as its longest name, so no prop is cut short.
          menuWidthMin={MENU_WIDTH_PX_MIN}
          options={subjects.map((entry) =>
            entry.computed === undefined
              ? { value: entry.name, label: entry.label, icon: <FieldTypeIcon type={FIELD_TYPES[entry.kind]} name={entry.name} /> }
              : {
                  value: entry.name,
                  label: entry.label,
                  group: translate('props.conditional.computedGroup'),
                  icon: <CodeIcon size={14} />,
                  title: computedTitle(entry, catalog, translate),
                },
          )}
          onChange={(subject) => props.onChange(withSubject(condition, catalog, subject))}
        />
      }
      offer={
        plainer === undefined || prop === undefined ? undefined : (
          <PlainerSuggestion
            why={computedWhy(prop, catalog, translate)}
            words={draftWords(plainer, catalog, translate)}
            onSwitch={() => props.onChange(plainer)}
          />
        )
      }
      operator={
        <Dropdown
          ariaLabel={translate('props.conditional.operator.label')}
          className="conditional-operator"
          value={condition.operator}
          options={operators}
          onChange={(operator) => props.onChange({ ...condition, operator, values: takesValues(operator) ? condition.values : [] })}
        />
      }
      values={takesValues(condition.operator) && prop !== undefined ? <ValuesInput condition={condition} prop={prop} onChange={props.onChange} /> : undefined}
    />
  );
}

/**
 * A test the rows cannot show (`isWritten ? content : true`): the grey Computed
 * chip, then its code highlighted on one line (cut with an ellipsis, the whole
 * code as the tooltip). With `onCommit` (the template if) it is editable: a
 * click on it, or its `{}`, opens that part alone in the code editor; Enter or
 * leaving the field writes it when it is an expression, Escape puts it back,
 * and code that does not parse is marked and never written. Without `onCommit`
 * (the Value conditions dialog) it is locked and can only be removed.
 */
export function LockedConditionLine(props: { readonly code: string; readonly onRemove: () => void; readonly onCommit?: ((code: string) => void) | undefined }) {
  const translate = useTranslate();
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const { onCommit } = props;
  const chip = (
    <span className="conditional-chip conditional-chip-computed">
      <BranchIcon size={11} />
      {translate('props.conditional.computed')}
    </span>
  );
  if (draft !== undefined && onCommit !== undefined) {
    const valid = isExpression(draft);
    const commit = (text: string): void => {
      if (!isExpression(text)) {
        return; // Code that does not parse stays in the field, marked, and is never written.
      }
      setDraft(undefined);
      if (text.trim() !== props.code.trim()) {
        onCommit(text.trim());
      }
    };
    return (
      <ConditionLine
        onRemove={props.onRemove}
        subject={
          <span
            className="conditional-code-condition is-editing"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                setDraft(undefined);
              }
            }}
            onBlur={(event) => {
              if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
                return;
              }
              // Leaving the field writes what parses; what does not is dropped, so a half-typed part never sticks.
              if (isExpression(draft)) {
                commit(draft);
              } else {
                setDraft(undefined);
              }
            }}
          >
            {chip}
            <ExprInput
              value={draft}
              autoFocus
              singleLine
              invalid={!valid}
              language="typescript"
              ariaLabel={translate('props.conditional.computed')}
              onChange={setDraft}
              onCommit={commit}
            />
          </span>
        }
        operator={undefined}
        values={undefined}
      />
    );
  }
  const open = onCommit === undefined ? undefined : () => setDraft(props.code);
  return (
    <ConditionLine
      onRemove={props.onRemove}
      subject={
        <span
          className={`conditional-code-condition${open === undefined ? '' : ' is-editable'}`}
          title={props.code}
          {...(open === undefined
            ? {}
            : {
                role: 'button',
                tabIndex: 0,
                onClick: open,
                onKeyDown: (event: KeyboardEvent<HTMLSpanElement>) => {
                  if (event.key === 'Enter') {
                    open();
                  }
                },
              })}
        >
          {chip}
          <CodeInline text={props.code.replace(/\s+/g, ' ')} language="typescript" className="conditional-code-condition-code" />
          {open !== undefined && (
            <span className="prop-expr-toggle conditional-code-condition-edit" aria-hidden="true">
              <BracesIcon size={12} />
            </span>
          )}
        </span>
      }
      operator={undefined}
      values={undefined}
    />
  );
}

/** "If [all] conditions in this group are true" with the group's remove: the head every conditions editor draws. */
export function GroupHeading(props: {
  readonly match: GroupMatch;
  readonly onMatch: (match: GroupMatch) => void;
  readonly onRemove: () => void;
  /** Present where groups can be dragged: the grip's label. */
  readonly dragGroupLabel?: string | undefined;
  /** The remove's words; a group's by default. */
  readonly removeLabel?: string | undefined;
  /** No condition yet (a class given always): the head says Always. */
  readonly always?: boolean | undefined;
}) {
  const translate = useTranslate();
  const removeLabel = props.removeLabel ?? translate('props.conditional.removeGroup');
  return (
    <div className="conditional-group-head">
      {props.dragGroupLabel !== undefined && (
        <button type="button" className="conditional-grip" aria-label={props.dragGroupLabel} data-drag-through tabIndex={-1}>
          <DragIcon size={12} />
        </button>
      )}
      {props.always === true ? (
        <span className="conditional-phrase">{translate('props.conditional.always')}</span>
      ) : (
        <>
          {translate('props.conditional.if')}
          <Dropdown
            ariaLabel={translate('props.conditional.match')}
            className="conditional-match"
            menuClassName="conditional-match-menu"
            value={props.match}
            options={matchOptions(translate)}
            onChange={props.onMatch}
          />
          <span className="conditional-phrase">{translate('props.conditional.groupPhrase')}</span>
        </>
      )}
      <button type="button" className="loop-settings-remove" aria-label={removeLabel} title={removeLabel} onClick={props.onRemove}>
        <TrashIcon size={12} />
      </button>
    </div>
  );
}

/** One condition's line: the name, the operator, the values and the row's one remove; under it, a plainer way to say it, if there is one. */
export function ConditionLine(props: {
  readonly subject: ReactNode;
  readonly operator: ReactNode;
  readonly values: ReactNode;
  readonly onRemove: () => void;
  readonly offer?: ReactNode;
}) {
  const translate = useTranslate();
  return (
    <>
      <div className="conditional-condition">
        {props.subject}
        {props.operator}
        {/* Prop, operator, values and the row's one remove, on one line; the
          values shrink, and their chips wrap inside their own box. */}
        {props.values ?? <span className="conditional-values-none" />}
        <button
          type="button"
          className="loop-settings-remove"
          aria-label={translate('props.conditional.removeCondition')}
          title={translate('props.conditional.removeCondition')}
          onClick={props.onRemove}
        >
          <CloseIcon size={12} />
        </button>
      </div>
      {props.offer}
    </>
  );
}

/**
 * Under a computed value's row, the prop condition it is provably the same as
 * (its definition is one comparison of a prop with literals), as a quiet
 * suggestion: "Same as: Variant is none of Main, Link" and a Switch that
 * replaces the row with it. Nothing changes until Switch is pressed; the
 * editor writes once, as it closes, so it is one undo step.
 */
export function PlainerSuggestion(props: { readonly why: string; readonly words: string; readonly onSwitch: () => void }) {
  const translate = useTranslate();
  const rowTip = useDelayedTooltip();
  const switchTip = useDelayedTooltip();
  const tip = translate('props.conditional.switchPlainerTip', { condition: props.words });
  return (
    <div className="conditional-plainer" onMouseEnter={rowTip.show} onMouseLeave={rowTip.hide}>
      <BranchIcon size={12} />
      <span className="conditional-plainer-words">{translate('props.conditional.sameAs', { condition: props.words })}</span>
      <button
        type="button"
        className="conditional-plainer-switch"
        aria-label={tip}
        onMouseEnter={(event) => {
          rowTip.hide();
          switchTip.show(event);
        }}
        onMouseLeave={switchTip.hide}
        onClick={props.onSwitch}
      >
        <SyncIcon size={11} />
        {translate('props.conditional.switchPlainer')}
      </button>
      {rowTip.value !== undefined &&
        createPortal(
          <div className="rail-tooltip below" role="tooltip" style={rowTip.value}>
            {props.why}
          </div>,
          tooltipHost(undefined),
        )}
      {switchTip.value !== undefined &&
        createPortal(
          <div className="rail-tooltip below" role="tooltip" style={switchTip.value}>
            {tip}
          </div>,
          tooltipHost(undefined),
        )}
    </div>
  );
}

// Why a suggestion is offered: what the value is computed from, in words.
function computedWhy(entry: ConditionProp, catalog: readonly ConditionProp[], translate: Translator): string {
  const equivalent = entry.computed?.equivalent;
  const definition = equivalent === undefined ? (entry.computed?.code ?? '') : conditionWords(equivalent, catalog, translate);
  return translate('props.conditional.computedWhy', { name: entry.label, definition });
}

// A computed value's menu tooltip: what it is computed from, in words when they say it exactly, and the code.
function computedTitle(entry: ConditionProp, catalog: readonly ConditionProp[], translate: Translator): string {
  const equivalent = entry.computed?.equivalent;
  const code = entry.computed?.code ?? '';
  const words = equivalent === undefined ? code : conditionWords(equivalent, catalog, translate);
  return translate('props.conditional.computedDefinition', { name: entry.label, definition: words, code });
}

// A finished draft condition in words, for the offer of a plainer condition.
function draftWords(condition: ConditionDraft, catalog: readonly ConditionProp[], translate: Translator): string {
  const [finished] = modelOf({ groups: [{ match: 'all', conditions: [condition], value: NO_VALUE }], otherwise: NO_VALUE }).groups;
  const [only] = finished?.conditions ?? [];
  return only === undefined ? '' : conditionWords(only, catalog, translate);
}

/** "+ New condition", left under the conditions it adds to. */
export function AddConditionButton(props: { readonly disabled: boolean; readonly onAdd: () => void }) {
  const translate = useTranslate();
  return (
    <button type="button" className="conditional-add" disabled={props.disabled} onClick={props.onAdd}>
      <PlusIcon size={11} />
      {translate('props.conditional.newCondition')}
    </button>
  );
}

/** "+ New group" on its full-width line. */
export function AddGroupRow(props: { readonly disabled: boolean; readonly onAdd: () => void }) {
  const translate = useTranslate();
  return (
    <div className="conditional-add-group-row">
      <button type="button" className="conditional-add-group" disabled={props.disabled} onClick={props.onAdd}>
        <PlusIcon size={11} />
        {translate('props.conditional.newGroup')}
      </button>
    </div>
  );
}

// The kind's operators, plus the condition's own when code chose one the kind
// does not list (a switch compared with a string), so the menu shows what it is.
function operatorsWith(
  kind: ConditionProp['kind'],
  operator: DraftOperator,
  translate: Translator,
): readonly { readonly value: DraftOperator; readonly label: string }[] {
  const offered = operatorsFor(kind, translate);
  if (offered.some((option) => option.value === operator)) {
    return offered;
  }
  const extra = operatorsFor('text', translate).find((option) => option.value === operator);
  assert(extra !== undefined, 'operatorsWith: every operator has words');
  return [...offered, extra];
}

// The values a comparison holds, in one field (MultiSelect): chips, the
// menu of an option prop's options with the chosen ones checked, and for any
// other prop what is typed (Enter adds it).
function ValuesInput(props: { readonly condition: ConditionDraft; readonly prop: ConditionProp; readonly onChange: (condition: ConditionDraft) => void }) {
  const translate = useTranslate();
  const { condition, prop } = props;
  const options = prop.options.map((option) => ({
    value: literalKey({ kind: 'string', value: option }),
    label: literalWords({ kind: 'string', value: option }, prop.kind),
  }));
  const byKey = new Map(condition.values.map((value) => [literalKey(value), value]));
  return (
    <MultiSelect
      ariaLabel={translate('props.conditional.values')}
      values={condition.values.map(literalKey)}
      options={options}
      placeholder={prop.kind === 'option' ? translate('ui.choose') : translate('props.conditional.typeValue')}
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
  /** What a typed value may be read as: `rich` takes a fallback, a table entry or code as locked code. */
  readonly shapes?: ReadShapes | undefined;
  readonly onChange: (result: ConditionalResult) => void;
}) {
  const translate = useTranslate();
  const { result } = props;
  const shapes = props.shapes ?? 'plain';
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
      <span className="conditional-value-label">{translate('props.conditional.valueLabel')}</span>
      <div className="attr-value-field" ref={wrap} aria-label={props.label} role="group">
        {props.language === 'css' && isPlainResult(result) ? (
          // Declarations, highlighted as the style attribute's CSS editor
          // highlights them, with each `${name}` drawn as a purple chip.
          <ExprInput
            value={bodyOfResult(result)}
            syncValue={bodyOfResult(result)}
            syntax={styleDeclarations}
            className="conditional-css-input"
            ariaLabel={props.label}
            placeholder={props.placeholder ?? translate('props.conditional.leaveOut')}
            chipsOf={templateHoles}
            onChipClick={openOnChip}
            apiRef={codeApiRef}
            onChange={(text) => takeBody(text, props.onChange)}
          />
        ) : (
          <BindField
            value={shown.type === 'bare' ? { type: 'string', value: '' } : shown}
            placeholder={props.placeholder ?? translate('props.conditional.leaveOut')}
            bindContext={props.bindContext}
            apiRef={apiRef}
            onChange={(next) => {
              // Emptied, the branch leaves the attribute out; what the model
              // cannot hold (an escape in a template) is not taken in.
              const read = next === undefined ? NO_VALUE : resultOfAttr(next, { shapes });
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

// "↳ Value [Show | Hide | Required]": a branch value picked from icon choices, laid out as the typed value's row is.
function ChoiceResult(props: {
  readonly label: string;
  readonly result: ConditionalResult;
  readonly choices: readonly ValueChoice[];
  readonly onChange: (result: ConditionalResult) => void;
}) {
  const translate = useTranslate();
  const value = props.result.kind === 'text' ? props.result.text : '';
  return (
    <div className="conditional-value-row">
      <CornerIcon size={12} />
      <span className="conditional-value-label">{translate('props.conditional.valueLabel')}</span>
      <ValueChoiceSwitch
        label={props.label}
        className="conditional-value-choice"
        value={value}
        choices={props.choices}
        onChange={(text) => props.onChange({ kind: 'text', text })}
      />
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
