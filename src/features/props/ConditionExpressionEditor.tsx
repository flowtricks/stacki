// The Condition section of a template if / else if: its test as the visual
// conditions editor the Value conditions dialog uses (groups of "all / any"
// conditions, a name from the component's props, the values its frontmatter
// computes under Computed in code, or any data in scope, an operator that fits
// the name's type, a value or chips of values), written back as plain
// JavaScript into the node's test, and the `{}` that swaps it for the code.
//
// Every test opens as controls (the rich reading, conditionExpressionRich.ts):
// a part the rows cannot draw is a locked Computed row holding its code, never
// the whole test as code. Only code that cannot be delimited (a regular
// expression) opens as code, highlighted, with nothing said about it. Each edit
// writes only the test text, through the node's own setter (one undo step, as
// any property edit); opening and hovering write nothing, so an untouched test
// keeps its bytes. Rows still being chosen stay in the draft and are left out
// of what is written.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { BranchIcon, CodeIcon } from '../../ui/Icons';
import { FieldTypeIcon } from './FieldTypeIcon';
import Dropdown, { type DropdownOption } from '../../ui/Dropdown';
import MultiSelect from '../../ui/MultiSelect';
import { emitConditionExpression, expressionQuoteOf, takesValue, takesValues, type ExpressionLiteral } from '../../editor/conditionExpression';
import { readRichConditionExpression } from '../../editor/conditionExpressionRich';
import { CONDITIONAL_LIMITS } from '../../editor/conditionalValue';
import { scopeChips, scopeCompletions } from '../../editor/dataSuggest';
import { FieldDataPicker } from './BindingEditors';
import { ConditionField } from './propBindings';
import { AddConditionButton, AddGroupRow, ConditionLine, GroupHeading, LockedConditionLine, PlainerSuggestion, useConditionCatalog } from './ConditionalValue';
import { ConditionCodeToggle } from './ConditionCodeToggle';
import { decideConditionView, type ConditionView } from './conditionViewDecision';
import { dataPickerPosition } from './dataPickerPosition';
import { conditionWords, type ConditionProp } from './conditionalModel';
import type { FieldPosition } from './bindingTypes';
import type { RichContext } from './RichContent';
import type { Translator } from '../../../shared/properties/i18n/messageRef';
import {
  draftOfExpression,
  expressionOfDraft,
  operatorsFor,
  plainerRow,
  rowWithSubject,
  rowsOfEditedCode,
  typeOfSubjectIn,
  valueTypeOf,
  withGroup,
  withGroupAdded,
  withGroupRemoved,
  withRow,
  withRowAdded,
  withRowRemoved,
  withRowReplaced,
  type ConditionExpressionDraft,
  type ConditionRowDraft,
  type ConditionValueType,
  type TypeOfSubject,
} from './conditionExpressionModel';
import './conditionalValue.css';

export interface ConditionExpressionFieldProps {
  /** The node's test, as written. */
  readonly test: string;
  readonly bindContext: RichContext | undefined;
  /** Writes the test: one undo step. */
  readonly onSetText: (value: string) => void;
}

// A value's kind as the field type its icon is drawn for (FieldTypeIcon.tsx), as the Value conditions dialog draws its names.
const ICON_TYPES: Readonly<Record<ConditionValueType['kind'], string>> = {
  string: 'string',
  number: 'number',
  boolean: 'boolean',
  enum: 'enum',
  array: 'string',
  object: 'string',
  date: 'string',
  unknown: 'string',
};

// The subject menu's last entry, which opens the data picker for any name in scope; no name can be spelled this way.
const MORE_DATA = '\u0000more-data';

// The menu is as wide as its longest name, so no prop is cut short (the Value conditions dialog's width).
const MENU_WIDTH_PX_MIN = 200;

const readable = (source: string): boolean => readRichConditionExpression(source) !== undefined;

/** The label row with its `{}`, then the controls or the code. */
export function ConditionExpressionField(props: ConditionExpressionFieldProps) {
  const translate = useTranslate();
  const [chosen, setChosen] = useState<ConditionView | undefined>(undefined);
  const decision = decideConditionView({ source: props.test, readable, chosen });
  return (
    <div className="props-field condition-expression-field" style={{ marginTop: 8 }}>
      <label onClick={(event) => event.preventDefault()}>
        <span className="prop-label">
          <BranchIcon size={12} className="prop-label-icon" />
          {translate('props.sources.showWhen')}
        </span>
        <ConditionCodeToggle decision={decision} onChoose={setChosen} />
      </label>
      {decision.view === 'visual' ? <VisualConditions {...props} /> : <CodeCondition {...props} />}
    </div>
  );
}

function CodeCondition(props: ConditionExpressionFieldProps) {
  const { bindContext } = props;
  const scope = scopeCompletions(bindContext ?? {});
  const names = new Set(scope.map((completion) => completion.label.split('.')[0] ?? ''));
  return <ConditionField test={props.test} scope={scope} chipsOf={(text) => scopeChips(text, names)} bindContext={bindContext} onSetText={props.onSetText} />;
}

function VisualConditions(props: ConditionExpressionFieldProps) {
  const { bindContext, test } = props;
  const catalog = useConditionCatalog(bindContext, 'template');
  const typeOf: TypeOfSubject = useMemo(() => typeOfSubjectIn(catalog, (subject) => valueTypeOf(bindContext, subject)), [bindContext, catalog]);
  const quote = expressionQuoteOf(test, bindContext?.frontmatter ?? '');
  const [draft, setDraft] = useState<ConditionExpressionDraft>(() => draftOfExpression(readRichConditionExpression(test) ?? { groups: [] }, typeOf));
  // What this editor last wrote: a test that differs came from elsewhere (undo, an edit in code), and replaces the draft.
  const written = useRef(test.trim());
  useEffect(() => {
    if (test.trim() === written.current) {
      return;
    }
    written.current = test.trim();
    const model = readRichConditionExpression(test);
    if (model !== undefined) {
      setDraft(draftOfExpression(model, typeOf));
    }
  }, [test, typeOf]);
  const change = (next: ConditionExpressionDraft): void => {
    setDraft(next);
    const model = expressionOfDraft(next, typeOf);
    if (model.groups.length === 0) {
      return; // Nothing finished yet: an empty test would break the file.
    }
    const code = emitConditionExpression(model, { quote });
    if (code !== written.current) {
      written.current = code;
      props.onSetText(code);
    }
  };
  return (
    <div className="conditional-editor condition-expression">
      {draft.groups.map((group, groupIndex) => (
        <GroupView
          key={groupIndex}
          groupIndex={groupIndex}
          group={group}
          bindContext={bindContext}
          catalog={catalog}
          typeOf={typeOf}
          onChange={(update) => change(withGroup(draft, groupIndex, update))}
          onRemove={() => change(withGroupRemoved(draft, groupIndex))}
        />
      ))}
      <AddGroupRow disabled={draft.groups.length >= CONDITIONAL_LIMITS.groupsMax} onAdd={() => change(withGroupAdded(draft))} />
    </div>
  );
}

function GroupView(props: {
  readonly groupIndex: number;
  readonly group: ConditionExpressionDraft['groups'][number];
  readonly bindContext: RichContext | undefined;
  readonly catalog: readonly ConditionProp[];
  readonly typeOf: TypeOfSubject;
  readonly onChange: (update: (group: ConditionExpressionDraft['groups'][number]) => ConditionExpressionDraft['groups'][number]) => void;
  readonly onRemove: () => void;
}) {
  const translate = useTranslate();
  const { group, onChange } = props;
  return (
    <>
      {props.groupIndex > 0 && <div className="conditional-or">{translate('props.conditional.or')}</div>}
      <div className="conditional-group" role="group" aria-label={translate('props.conditional.group', { number: props.groupIndex + 1 })}>
        <GroupHeading match={group.match} onMatch={(match) => onChange((current) => ({ ...current, match }))} onRemove={props.onRemove} />
        {group.conditions.map((row, rowIndex) => (
          <RowView
            key={rowIndex}
            row={row}
            bindContext={props.bindContext}
            catalog={props.catalog}
            typeOf={props.typeOf}
            onChange={(next) => onChange((current) => withRow(current, rowIndex, next))}
            onCodeEdited={(code) => onChange((current) => withRowReplaced(current, rowIndex, rowsOfEditedCode(code, props.typeOf)))}
            onRemove={() => {
              // A group's last condition takes the group with it, as in the Value conditions editor.
              if (group.conditions.length === 1) {
                props.onRemove();
              } else {
                onChange((current) => withRowRemoved(current, rowIndex));
              }
            }}
          />
        ))}
        <AddConditionButton
          disabled={group.conditions.length >= CONDITIONAL_LIMITS.conditionsPerGroupMax}
          onAdd={() => onChange((current) => withRowAdded(current))}
        />
      </div>
    </>
  );
}

function RowView(props: {
  readonly row: ConditionRowDraft;
  readonly bindContext: RichContext | undefined;
  readonly catalog: readonly ConditionProp[];
  readonly typeOf: TypeOfSubject;
  readonly onChange: (row: ConditionRowDraft) => void;
  /** A locked part's code was edited: the rows it now reads as replace it. */
  readonly onCodeEdited: (code: string) => void;
  readonly onRemove: () => void;
}) {
  const translate = useTranslate();
  const { row, catalog } = props;
  if (row.code !== undefined) {
    return <LockedConditionLine code={row.code} onRemove={props.onRemove} onCommit={props.onCodeEdited} />;
  }
  const type: ConditionValueType = row.subject === undefined ? { kind: 'unknown', options: [] } : props.typeOf(row.subject);
  const plainer = plainerRow(row, catalog);
  const entry = catalog.find((candidate) => candidate.name === row.subject);
  return (
    <ConditionLine
      onRemove={props.onRemove}
      subject={
        <SubjectMenu
          subject={row.subject}
          type={type}
          catalog={catalog}
          bindContext={props.bindContext}
          onPick={(path) => props.onChange(rowWithSubject(row, path, props.typeOf(path)))}
        />
      }
      offer={
        plainer === undefined || entry?.computed === undefined ? undefined : (
          <PlainerSuggestion
            why={computedWords(entry, catalog, translate)}
            words={rowWords(plainer, catalog, translate)}
            onSwitch={() => props.onChange(plainer)}
          />
        )
      }
      operator={
        <Dropdown
          ariaLabel={translate('props.conditional.operator.label')}
          className="conditional-operator"
          value={row.operator}
          options={operatorsFor(type.kind, row.operator, translate)}
          onChange={(operator) => props.onChange({ ...row, operator })}
        />
      }
      values={<RowValues row={row} type={type} onChange={props.onChange} />}
    />
  );
}

// The name: the component's props with their type icons, then the values its frontmatter computes under Computed in
// code (each with its definition as the tooltip), then any other data in scope through the data picker.
function SubjectMenu(props: {
  readonly subject: string | undefined;
  readonly type: ConditionValueType;
  readonly catalog: readonly ConditionProp[];
  readonly bindContext: RichContext | undefined;
  readonly onPick: (path: string) => void;
}) {
  const translate = useTranslate();
  const [position, setPosition] = useState<FieldPosition | undefined>(undefined);
  const anchor = useRef<HTMLSpanElement>(null);
  const { catalog, subject } = props;
  const listed = subject === undefined || catalog.some((entry) => entry.name === subject);
  const options: DropdownOption[] = [
    ...catalog
      .filter((entry) => entry.computed === undefined)
      .map((entry) => ({ value: entry.name, label: entry.label, icon: <FieldTypeIcon type={ICON_TYPES[typeOfEntryKind(entry)]} name={entry.name} /> })),
    ...(listed || subject === undefined ? [] : [{ value: subject, label: subject, icon: <FieldTypeIcon type={ICON_TYPES[props.type.kind]} name={subject} /> }]),
    ...catalog
      .filter((entry) => entry.computed !== undefined)
      .map((entry) => ({
        value: entry.name,
        label: entry.label,
        group: translate('props.conditional.computedGroup'),
        icon: <CodeIcon size={14} />,
        title: computedTitle(entry, catalog, translate),
      })),
    { value: MORE_DATA, label: translate('props.condition.chooseData'), group: translate('props.sources.binding'), icon: <BranchIcon size={12} /> },
  ];
  return (
    <span ref={anchor} className="conditional-subject-anchor">
      <Dropdown
        ariaLabel={translate('props.conditional.property')}
        className="conditional-subject"
        value={subject ?? ''}
        placeholder={translate('props.condition.chooseData')}
        menuWidthMin={MENU_WIDTH_PX_MIN}
        options={options}
        onChange={(picked) => {
          if (picked !== MORE_DATA) {
            props.onPick(picked);
            return;
          }
          const rect = anchor.current?.getBoundingClientRect();
          if (rect !== undefined) {
            setPosition(dataPickerPosition(rect));
          }
        }}
      />
      {position !== undefined && (
        <FieldDataPicker
          pos={position}
          bindContext={props.bindContext}
          current={subject}
          onPick={(path) => {
            setPosition(undefined);
            props.onPick(path);
          }}
          onClose={() => setPosition(undefined)}
        />
      )}
    </span>
  );
}

function typeOfEntryKind(entry: ConditionProp): ConditionValueType['kind'] {
  switch (entry.kind) {
    case 'option':
      return 'enum';
    case 'switch':
      return 'boolean';
    case 'text':
      return 'string';
    case 'number':
      return 'number';
    default: {
      const exhaustive: never = entry.kind;
      return exhaustive;
    }
  }
}

// The value: chips for Is any of, a choice for an enum, otherwise typed (a number where the name holds one); none for a test of the name itself.
function RowValues(props: { readonly row: ConditionRowDraft; readonly type: ConditionValueType; readonly onChange: (row: ConditionRowDraft) => void }) {
  if (takesValues(props.row.operator)) {
    return <ValueChips {...props} />;
  }
  if (takesValue(props.row.operator)) {
    return <ValueInput {...props} />;
  }
  return undefined;
}

// A literal as one string the chips can hold and compare, and back: its kind leads.
const literalKey = (literal: ExpressionLiteral): string => `${literal.kind}:${String(literal.value)}`;

function ValueChips(props: { readonly row: ConditionRowDraft; readonly type: ConditionValueType; readonly onChange: (row: ConditionRowDraft) => void }) {
  const translate = useTranslate();
  const { row, type } = props;
  const values = row.values ?? [];
  const byKey = new Map(values.map((value) => [literalKey(value), value]));
  // A choice's values read as the Value conditions dialog shows them (main is Main); anything else as typed.
  const words = (text: string): string => (type.kind === 'enum' ? titledWord(text) : text);
  const options = type.options.map((option) => ({ value: literalKey({ kind: 'string', value: option }), label: words(option) }));
  const literalOfTyped = (text: string): ExpressionLiteral | undefined => {
    const typed = text.trim();
    if (typed === '') {
      return undefined;
    }
    return type.kind === 'number' && /^-?\d+(?:\.\d+)?$/.test(typed) ? { kind: 'number', value: Number(typed) } : { kind: 'string', value: typed };
  };
  return (
    <MultiSelect
      ariaLabel={translate('props.conditional.values')}
      values={values.map(literalKey)}
      options={options}
      placeholder={type.kind === 'enum' ? translate('ui.choose') : translate('props.conditional.typeValue')}
      valuesMax={CONDITIONAL_LIMITS.valuesPerConditionMax}
      labelOf={(key) => {
        const literal = byKey.get(key);
        return words(literal === undefined ? key.slice(key.indexOf(':') + 1) : String(literal.value));
      }}
      valueOfText={
        type.kind === 'enum'
          ? undefined
          : (text) => {
              const literal = literalOfTyped(text);
              return literal === undefined ? undefined : literalKey(literal);
            }
      }
      onChange={(keys) =>
        props.onChange({
          ...row,
          values: keys.flatMap((key): readonly ExpressionLiteral[] => {
            const known = byKey.get(key);
            if (known !== undefined) {
              return [known];
            }
            const text = key.slice(key.indexOf(':') + 1);
            return key.startsWith('number:') ? [{ kind: 'number', value: Number(text) }] : [{ kind: 'string', value: text }];
          }),
        })
      }
    />
  );
}

function ValueInput(props: { readonly row: ConditionRowDraft; readonly type: ConditionValueType; readonly onChange: (row: ConditionRowDraft) => void }) {
  const translate = useTranslate();
  const { row, type } = props;
  if (type.kind === 'enum' && type.options.length > 0) {
    return (
      <Dropdown
        ariaLabel={translate('props.condition.value')}
        className="conditional-value-pick"
        value={row.text}
        placeholder={translate('props.condition.chooseValue')}
        options={type.options.map((option) => ({ value: option, label: option }))}
        onChange={(text) => props.onChange({ ...row, text })}
      />
    );
  }
  return (
    <input
      className="conditional-value-input"
      aria-label={translate('props.condition.value')}
      placeholder={
        type.kind === 'number' || row.operator === 'lengthEquals' || row.operator === 'lengthGreaterThan'
          ? translate('props.condition.typeNumber')
          : translate('props.condition.typeValue')
      }
      value={row.text}
      onChange={(event) => props.onChange({ ...row, text: event.target.value })}
    />
  );
}

// What a computed value is, in words when its definition is one prop condition, else its code.
function computedWords(entry: ConditionProp, catalog: readonly ConditionProp[], translate: Translator): string {
  const equivalent = entry.computed?.equivalent;
  const definition = equivalent === undefined ? (entry.computed?.code ?? '') : conditionWords(equivalent, catalog, translate);
  return translate('props.conditional.computedWhy', { name: entry.label, definition });
}

// A computed value's menu tooltip: its definition in words and as code.
function computedTitle(entry: ConditionProp, catalog: readonly ConditionProp[], translate: Translator): string {
  const equivalent = entry.computed?.equivalent;
  const code = entry.computed?.code ?? '';
  const words = equivalent === undefined ? code : conditionWords(equivalent, catalog, translate);
  return translate('props.conditional.computedDefinition', { name: entry.label, definition: words, code });
}

// The plainer row in words ("Variant is any of Main, Link"), as the suggestion says it.
function rowWords(row: ConditionRowDraft, catalog: readonly ConditionProp[], translate: Translator): string {
  const entry = catalog.find((candidate) => candidate.name === row.subject);
  const subject = entry?.label ?? row.subject ?? '';
  const word = (value: ExpressionLiteral): string => (value.kind === 'string' && entry?.kind === 'option' ? titledWord(value.value) : String(value.value));
  // A plainer row is one of these six (rowOfValueCondition): a list, one value, or the name itself.
  const values = (row.values ?? []).map(word).join(', ');
  const value = entry?.kind === 'option' ? titledWord(row.text) : row.text;
  if (row.operator === 'isAnyOf') {
    return translate('props.conditional.words.isAnyOf', { subject, values });
  }
  if (row.operator === 'isNoneOf') {
    return translate('props.conditional.words.isNoneOf', { subject, values });
  }
  if (row.operator === 'equals') {
    return translate('props.conditional.words.equals', { subject, value });
  }
  if (row.operator === 'notEquals') {
    return translate('props.conditional.words.notEquals', { subject, value });
  }
  return translate(row.operator === 'isFalse' ? 'props.conditional.words.isFalse' : 'props.conditional.words.isTrue', { subject });
}

function titledWord(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
