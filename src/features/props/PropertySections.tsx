// The sections a component prop's settings are made of, shared by the two
// places a prop is made or edited: the Settings panel's "Property settings"
// pop-up (NewPropForm.tsx, opened from a field's bind dot) and the Properties
// panel's property editor (PropertyEditor.tsx). Each host keeps its own chrome
// — its title, its buttons, its own state — and draws these sections from it,
// so an option offered in one place is the same control in the other.
//
// - Required and Readonly: whether the member is written without `?`, and
//   with `readonly`.
// - Code type: the TypeScript written for the prop, behind a disclosure.
// - Item fields: a List's fields, a name and a kind each.
// - The default items: the very field an instance of the component edits the
//   list with (PropField), with its `{}` toggle between the list and its code.

import { ChevronDownIcon, ChevronRightIcon, PlusIcon, TrashIcon } from '../../ui/Icons';
import { assert } from '../../../shared/core/assert';
import { PROPERTY_LIMITS } from '../../../shared/properties/propertyEditing';
import {
  fieldNameProblem,
  ITEM_FIELD_KINDS,
  ITEM_FIELD_TITLES,
  itemFieldType,
  LIST_LIMITS,
  type ItemFieldDeclaration,
  type ItemFieldKind,
} from '../../editor/listPropType';
import type { Attr } from '../../../shared/page/pageNode';
import { arrayItems, arrayText, type Item } from './arrayValue';
import { blankItemOf, renamedItemField } from './listItemShape';
import PropField from './PropField';
import type { FieldDefinition } from './propRules';
import './loopSettings.css';

/** The two TypeScript modifiers a prop's member can carry. */
export interface PropertyFlags {
  readonly required: boolean;
  readonly readonly: boolean;
}

/** Required (no `?`) and Readonly (`readonly`), as two checkboxes. */
export function PropertyFlagsFields(props: PropertyFlags & { readonly onChange: (flags: PropertyFlags) => void }) {
  const { required, readonly, onChange } = props;
  return (
    <div className="property-flags" role="group" aria-label="Property flags">
      <label>
        <input type="checkbox" aria-label="Required" checked={required} onChange={(event) => onChange({ required: event.target.checked, readonly })} />
        Required
      </label>
      <label>
        <input type="checkbox" aria-label="Readonly" checked={readonly} onChange={(event) => onChange({ required, readonly: event.target.checked })} />
        Readonly
      </label>
    </div>
  );
}

/** The TypeScript written for the prop, behind a "Code type" disclosure the host opens and shuts. */
export function CodeTypeField(props: {
  readonly type: string;
  readonly placeholder: string;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onChange: (type: string) => void;
}) {
  const action = props.open ? 'Hide the code type' : 'Show the code type';
  return (
    <>
      <button type="button" className="property-code-toggle" aria-expanded={props.open} aria-label={action} title={action} onClick={props.onToggle}>
        {props.open ? <ChevronDownIcon size={10} /> : <ChevronRightIcon size={10} />}
        Code type
      </button>
      {props.open && (
        <input
          aria-label="Code type"
          className="property-code"
          value={props.type}
          placeholder={props.placeholder}
          maxLength={PROPERTY_LIMITS.textCharsMax}
          spellCheck={false}
          onChange={(event) => props.onChange(event.target.value)}
        />
      )}
    </>
  );
}

/** A list's item fields and its default items, which change together: renaming a field renames it in every item. */
export interface ListShape {
  readonly fields: readonly ItemFieldDeclaration[];
  /** The default items as array code, `[{ title: "One" }]`. */
  readonly itemsText: string;
}

/**
 * The fields each item of a list has: a name and a kind per row, + to add one.
 * Renaming a field keeps what the default items hold in it; changing its kind
 * or removing it clears that field in them, since a text cannot be a switch.
 */
export function ItemFieldsEditor(props: ListShape & { readonly onChange: (shape: ListShape) => void }) {
  const { fields, itemsText, onChange } = props;
  const items = (): readonly Item[] => arrayItems(itemsText) ?? [];
  const rename = (index: number, name: string): void => {
    const previous = fields[index];
    assert(previous !== undefined, 'ItemFieldsEditor: the renamed field exists');
    onChange({
      fields: fields.map((field, at) => (at === index ? { ...field, name } : field)),
      itemsText: arrayItems(itemsText) === undefined ? itemsText : arrayText(renamedItemField(items(), previous.name, name)),
    });
  };
  const retype = (index: number, kind: ItemFieldKind): void => {
    const previous = fields[index];
    assert(previous !== undefined, 'ItemFieldsEditor: the retyped field exists');
    const next = { ...previous, kind };
    onChange({
      fields: fields.map((field, at) => (at === index ? next : field)),
      itemsText: arrayItems(itemsText) === undefined ? itemsText : arrayText(items().map((item) => withBlankField(item, next))),
    });
  };
  const remove = (index: number): void => {
    const removed = fields[index];
    assert(removed !== undefined, 'ItemFieldsEditor: the removed field exists');
    onChange({
      fields: fields.filter((_, at) => at !== index),
      itemsText:
        arrayItems(itemsText) === undefined
          ? itemsText
          : arrayText(items().map((item) => (item.fields === undefined ? item : { fields: item.fields.filter((field) => field.key !== removed.name) }))),
    });
  };
  const nameProblem = fields.map((field) => fieldNameProblem(field.name)).find((problem) => problem !== undefined);
  return (
    <div className="new-prop-settings property-item-fields" role="group" aria-label="Item fields">
      <div className="loop-bind-title">Item fields</div>
      {fields.map((field, index) => (
        <div className="new-prop-list-field" key={index}>
          <input
            className="new-prop-input"
            aria-label="Field name"
            placeholder="name"
            spellCheck={false}
            value={field.name}
            onChange={(event) => rename(index, event.target.value.replace(/[^\w$]/g, ''))}
          />
          <select className="new-prop-input" aria-label="Field type" value={field.kind} onChange={(event) => retype(index, itemKindOf(event.target.value))}>
            {ITEM_FIELD_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {ITEM_FIELD_TITLES[kind]}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="loop-settings-remove"
            aria-label="Remove field"
            title="Remove"
            disabled={fields.length <= 1}
            onClick={() => remove(index)}
          >
            <TrashIcon size={12} />
          </button>
        </div>
      ))}
      {nameProblem !== undefined && <div className="new-prop-note">{nameProblem}</div>}
      <button
        type="button"
        className="loop-bind-button new-prop-add"
        disabled={fields.length >= LIST_LIMITS.fieldsMax}
        onClick={() => onChange({ fields: [...fields, { name: freeFieldName(fields), kind: 'text' }], itemsText })}
      >
        <PlusIcon size={11} /> Add field
      </button>
    </div>
  );
}

/**
 * A list's default items, in the field an instance edits the list with: the
 * items as rows of their fields, and its `{}` toggle to the same value as code.
 * Code the list cannot show stays in the code view (PropField says why).
 */
export function ListDefaultField(props: {
  readonly fields: readonly ItemFieldDeclaration[];
  readonly code: string;
  readonly projectPath: string | undefined;
  readonly onChange: (code: string) => void;
}) {
  const field = listDefaultField(props.fields);
  // Keyed by the shape, so a field's rows are redrawn when the fields above change.
  const shapeKey = props.fields.map((entry) => `${entry.name}:${entry.kind}`).join(',');
  return (
    <div className="property-default property-list-default" role="group" aria-label="Default items">
      <PropField
        key={shapeKey}
        nodeKey="default-items"
        field={field}
        value={defaultAttr(props.code)}
        assetContext={props.projectPath === undefined ? undefined : { projectPath: props.projectPath }}
        onChange={(next) => props.onChange(defaultCodeOf(next))}
      />
    </div>
  );
}

/** The instance field a list default is edited in: a list of items of these fields, never required. */
export function listDefaultField(fields: readonly ItemFieldDeclaration[]): FieldDefinition {
  assert(fields.length <= LIST_LIMITS.fieldsMax, 'listDefaultField: the fields are bounded');
  return {
    name: 'Default items',
    type: 'code',
    optional: true,
    shape: fields.map((entry) => ({ name: entry.name, type: itemFieldType(entry.kind) })),
    shapeIsList: true,
  };
}

/** A default's code as the value an instance field holds: none for no default, else the code. */
export function defaultAttr(code: string): Attr | undefined {
  const text = code.trim();
  return text === '' ? undefined : { type: 'expr', value: text };
}

/** The code an instance field's value is written as, for a default: '' for none. */
export function defaultCodeOf(value: Attr | undefined): string {
  if (value === undefined) {
    return '';
  }
  switch (value.type) {
    case 'expr':
      return value.value;
    case 'string':
      return JSON.stringify(value.value);
    case 'bare':
      return 'true';
    case 'spread':
      // A list field writes items or code, never `{...rest}`.
      assert(false, 'defaultCodeOf: a default is not a spread');
      return '';
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

// The item with `field` set back to blank in its new kind.
function withBlankField(item: Item, field: ItemFieldDeclaration): Item {
  if (item.fields === undefined) {
    return item;
  }
  const blank = blankItemOf([field], '"').fields?.[0];
  assert(blank !== undefined, 'withBlankField: a blank item has the field');
  return { fields: item.fields.map((own) => (own.key === field.name ? blank : own)) };
}

function itemKindOf(value: string): ItemFieldKind {
  const kind = ITEM_FIELD_KINDS.find((candidate) => candidate === value);
  assert(kind !== undefined, 'ItemFieldsEditor: the type menu offers only field kinds');
  return kind;
}

// `field`, then `field2`: a name no other field has.
function freeFieldName(fields: readonly ItemFieldDeclaration[]): string {
  for (let suffix = 1; suffix <= LIST_LIMITS.fieldsMax + 1; suffix++) {
    const name = suffix === 1 ? 'field' : `field${suffix}`;
    if (!fields.some((field) => field.name === name)) {
      return name;
    }
  }
  assert(false, 'freeFieldName: a free name is found within the field bound');
  return 'field';
}
