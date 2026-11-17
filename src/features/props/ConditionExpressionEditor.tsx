// The Condition section of a template if / else if: its test as the visual
// conditions editor the Value conditions dialog uses (groups of "all / any"
// conditions, a name from the data picker, an operator that fits the name's
// type, a value), written back as plain JavaScript into the node's test, and
// the `{}` that swaps it for the raw expression.
//
// An expression the controls can say exactly opens as controls; anything else
// opens as code with a note and is never rewritten by them. Each edit writes
// only the test text, through the node's own setter (one undo step, as any
// property edit); hovering and opening write nothing. Rows still being chosen
// stay in the draft and are left out of what is written.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { BranchIcon, ChevronDownIcon } from '../../ui/Icons';
import { FieldTypeIcon } from './FieldTypeIcon';
import Dropdown from '../../ui/Dropdown';
import { CodeInline } from '../../ui/CodeBlock';
import { emitConditionExpression, expressionQuoteOf, readConditionExpression, takesValue } from '../../editor/conditionExpression';
import { CONDITIONAL_LIMITS } from '../../editor/conditionalValue';
import { scopeChips, scopeCompletions } from '../../editor/dataSuggest';
import { FieldDataPicker } from './BindingEditors';
import { ConditionField } from './propBindings';
import { AddConditionButton, AddGroupRow, ConditionLine, GroupHeading } from './ConditionalValue';
import { ConditionCodeNote, ConditionCodeToggle } from './ConditionCodeToggle';
import { decideConditionView, type ConditionView } from './conditionViewDecision';
import { dataPickerPosition } from './dataPickerPosition';
import type { FieldPosition } from './bindingTypes';
import type { RichContext } from './RichContent';
import {
  draftOfExpression,
  expressionOfDraft,
  operatorsFor,
  rowWithSubject,
  valueTypeOf,
  withGroup,
  withGroupAdded,
  withGroupRemoved,
  withRow,
  withRowAdded,
  withRowRemoved,
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

const readable = (source: string): boolean => readConditionExpression(source) !== undefined;

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
      <ConditionCodeNote decision={decision} />
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
  const typeOf: TypeOfSubject = useMemo(() => (subject) => valueTypeOf(bindContext, subject), [bindContext]);
  const quote = expressionQuoteOf(test, bindContext?.frontmatter ?? '');
  const [draft, setDraft] = useState<ConditionExpressionDraft>(() => draftOfExpression(readConditionExpression(test) ?? { groups: [] }, typeOf));
  // What this editor last wrote: a test that differs came from elsewhere (undo, an edit in code), and replaces the draft.
  const written = useRef(test.trim());
  useEffect(() => {
    if (test.trim() === written.current) {
      return;
    }
    written.current = test.trim();
    const model = readConditionExpression(test);
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
            typeOf={props.typeOf}
            onChange={(next) => onChange((current) => withRow(current, rowIndex, next))}
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
  readonly typeOf: TypeOfSubject;
  readonly onChange: (row: ConditionRowDraft) => void;
  readonly onRemove: () => void;
}) {
  const translate = useTranslate();
  const { row } = props;
  const type: ConditionValueType = row.subject === undefined ? { kind: 'unknown', options: [] } : props.typeOf(row.subject);
  return (
    <ConditionLine
      onRemove={props.onRemove}
      subject={
        <SubjectPicker
          subject={row.subject}
          kind={row.subject === undefined ? undefined : ICON_TYPES[type.kind]}
          bindContext={props.bindContext}
          onPick={(path) => props.onChange(rowWithSubject(row, path, props.typeOf(path)))}
        />
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
      values={takesValue(row.operator) ? <ValueInput row={row} type={type} onChange={props.onChange} /> : undefined}
    />
  );
}

// The name: the data picker the Show when field opens, as the subject's dropdown.
function SubjectPicker(props: {
  readonly subject: string | undefined;
  readonly kind: string | undefined;
  readonly bindContext: RichContext | undefined;
  readonly onPick: (path: string) => void;
}) {
  const translate = useTranslate();
  const [position, setPosition] = useState<FieldPosition | undefined>(undefined);
  const ref = useRef<HTMLButtonElement>(null);
  const label: ReactNode = props.subject === undefined ? translate('props.condition.chooseData') : <CodeInline text={props.subject} language="javascript" />;
  return (
    <>
      <button
        type="button"
        ref={ref}
        className="dd-trigger conditional-subject"
        aria-label={translate('props.conditional.property')}
        aria-haspopup="dialog"
        onClick={() => {
          const rect = ref.current?.getBoundingClientRect();
          if (position === undefined && rect !== undefined) {
            setPosition(dataPickerPosition(rect));
          } else {
            setPosition(undefined);
          }
        }}
      >
        {props.kind !== undefined && (
          <span className="dd-icon">
            <FieldTypeIcon type={props.kind} name={props.subject ?? ''} />
          </span>
        )}
        <span className="dd-label">{label}</span>
        <span className="dd-chevron">
          <ChevronDownIcon size={11} />
        </span>
      </button>
      {position !== undefined && (
        <FieldDataPicker
          pos={position}
          bindContext={props.bindContext}
          current={props.subject}
          onPick={(path) => {
            setPosition(undefined);
            props.onPick(path);
          }}
          onClose={() => setPosition(undefined)}
        />
      )}
    </>
  );
}

// The value: a choice for an enum, otherwise typed (a number where the name holds one).
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
