import React from 'react';
import { arrayItems, arrayText, objectFields, objectText } from './arrayValue';
import type { ObjectRow } from './arrayValue';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import ListField from './ListField';
import SegSwitch from './SegSwitch';

// A prop whose value is an object, edited as the fields it holds.
//
// `tags={{ legend: "Ministry Role", options: ["Pastors", "Staff"] }}` is not a
// program, it is a form someone filled in: a line of text and a list. Shown as
// code it is a box of JSON to retype by hand, with the quoting and the commas
// left to the person — which is the one part of it a computer should be doing.
//
// So each key gets the control its value asks for: a box for a word, a number
// field for a number, True/False for a yes-or-no, and for a list, the same rows
// the list control draws anywhere else — drag to reorder, click to edit, the
// bin to drop one.
//
// What it will not show, it does not touch: an object inside an object, a call,
// a name standing for something elsewhere. Those keep the code editor, which is
// one press of `{}` away in either direction (see arrayValue.js).
interface ObjectFieldProps {
  readonly value?: string | undefined;
  readonly onChange: (value: string, immediate: boolean) => void;
}
export default function ObjectField({ value, onChange }: ObjectFieldProps) {
  assert((value?.length ?? 0) <= LIMITS.attrCharsMax, 'ObjectField: value limit exceeded');
  const fields = objectFields(value) || [];
  const change = (index: number, next: ObjectRow, options: { readonly immediate: boolean }): void => {
    assert(index >= 0, 'ObjectField: field index is nonnegative');
    assert(index < fields.length, 'ObjectField: field index exists');
    const text = objectText(fields.map((field, current) => (current === index ? next : field)));
    assert(text.length <= LIMITS.attrCharsMax, 'ObjectField: output limit exceeded');
    onChange(text, options.immediate);
  };
  return (
    <div className="object-field">
      {fields.map((field, index) => (
        <ObjectRowField key={field.key} field={field} onChange={(next, options) => change(index, next, options)} />
      ))}
    </div>
  );
}
interface RowProps {
  readonly field: ObjectRow;
  readonly onChange: (field: ObjectRow, options: { readonly immediate: boolean }) => void;
}
function ObjectRowField(props: RowProps) {
  return (
    <div className="object-field-row">
      <span className="object-field-key" title={props.field.key}>
        {props.field.key}
      </span>
      <ObjectRowControl {...props} />
    </div>
  );
}
function ObjectRowControl({ field, onChange }: RowProps) {
  if (field.kind === 'list') {
    assert(field.items !== undefined, 'ObjectField: list field has items');
    return (
      <ListField
        value={arrayText(field.items)}
        onChange={(text, immediate) => {
          const items = arrayItems(text);
          assert(items !== undefined, 'ObjectField: list editor produces an array literal');
          onChange({ ...field, items }, { immediate: immediate !== false });
        }}
      />
    );
  }
  assert(field.text !== undefined, 'ObjectField: scalar field has text');
  const text = field.text;
  if (field.kind === 'boolean') {
    return (
      <SegSwitch
        options={[
          { value: true, label: 'True' },
          { value: false, label: 'False' },
        ]}
        current={text === 'true'}
        onPick={(next) => onChange({ ...field, text: next ? 'true' : 'false' }, { immediate: true })}
      />
    );
  }
  return (
    <input
      className="object-field-input"
      value={text}
      spellCheck={false}
      maxLength={LIMITS.attrCharsMax}
      inputMode={field.kind === 'number' ? 'decimal' : undefined}
      onChange={(event) => onChange({ ...field, text: event.target.value }, { immediate: false })}
      onBlur={() => {
        // Invalid numeric text must be quoted before it is written back into source.
        const next: ObjectRow = field.kind === 'number' && !/^[-+]?(\d+\.?\d*|\.\d+)$/.test(text.trim()) ? { ...field, kind: 'text', quote: '"' } : field;
        onChange(next, { immediate: true });
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur();
        }
      }}
    />
  );
}
