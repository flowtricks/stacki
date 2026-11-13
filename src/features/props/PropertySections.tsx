// The sections a component prop's settings are made of, shared by the two
// places a prop is made or edited: the Settings panel's "Property settings"
// pop-up (NewPropForm.tsx, opened from a field's bind dot) and the Properties
// panel's property editor (PropertyEditor.tsx), whose fields a picker row's
// settings also draw (PropertySettingsDialog.tsx). Each host keeps its own chrome
// — its title, its buttons, its own state — and draws these sections from it,
// so an option offered in one place is the same control in the other.
//
// - Required: whether the member is written without `?`. TypeScript's
//   `readonly` does nothing for an Astro prop, so it is not offered; a member
//   that has it keeps it as written.
// - Code type: the TypeScript written for the prop, in the highlighted field a
//   default's code is edited in, behind the host's `{}` toggle.
// - Item fields: a List's fields, a name and a kind each, with an icon per kind
//   (the Kind dropdown's own, Dropdown option icons). A List or a Group among
//   them holds fields of its own, drawn as an indented block on a quiet fill,
//   down to LIMITS.listFieldDepthMax levels.
// - The default items: the very field an instance of the component edits the
//   list with (PropField), with its `{}` toggle between the list and its code.

import { useRef, type ReactNode } from 'react';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { ENGLISH_TRANSLATE } from '../../../shared/properties/i18n/englishTranslator';
import type { MessageKey, Translator } from '../../../shared/properties/i18n/messageRef';
import {
  BracesIcon,
  CalendarIcon,
  DropletIcon,
  FieldNumberIcon,
  FieldSwitchIcon,
  MailIcon,
  PaperclipIcon,
  ParagraphIcon,
  PhoneCallIcon,
  PlusIcon,
  TextIcon,
  TrashIcon,
} from '../../ui/Icons';
import { BoldIcon } from '../../ui/richTextIcons';
import { ElementDivIcon, ElementImageIcon, ElementLinkIcon, ElementListDefaultIcon, ElementSelectIcon, ElementVideoIcon } from '../../ui/ElementIcons';
import Dropdown, { type DropdownOption } from '../../ui/Dropdown';
import ExprInput from '../../ui/ExprInput';
import { assert } from '../../../shared/core/assert';
import { PROPERTY_LIMITS } from '../../../shared/properties/propertyEditing';
import {
  fieldNameProblem,
  fieldsOf,
  fieldsProblem,
  ITEM_FIELD_KINDS,
  ITEM_FIELD_LIMITS,
  itemFieldTitle,
  type ItemFieldDeclaration,
  type ItemFieldKind,
} from '../../editor/itemFields';
import type { Attr } from '../../../shared/page/pageNode';
import { arrayItems, arrayText, type Item } from './arrayValue';
import { addedField, fieldAtPath, optionsAtPath, removedFieldAt, renamedFieldAt, retypedFieldAt, type FieldPath, type ListShape } from './itemFieldEdits';
import { shapeMembersOf } from './listItemShape';
import ListField from './ListField';
import PropField from './PropField';
import type { FieldDefinition } from './propRules';
import './loopSettings.css';

export type { ListShape };

/** How a change arrived: typing, which waits for a pause to save, or a pick, a toggle or a list edit, which saves at once. */
export type EditPace = 'typing' | 'at-once';

/** The two TypeScript modifiers a prop's member can carry. */
export interface PropertyFlags {
  readonly required: boolean;
  readonly readonly: boolean;
}

/** Required (no `?`), as a checkbox. `readonly` is carried through as it was read. */
export function PropertyFlagsFields(props: PropertyFlags & { readonly onChange: (flags: PropertyFlags) => void }) {
  const translate = useTranslate();
  const { required, readonly, onChange } = props;
  return (
    <div className="property-flags" role="group" aria-label={translate('props.sections.flags')}>
      <label>
        <input
          type="checkbox"
          aria-label={translate('props.sections.required')}
          checked={required}
          onChange={(event) => onChange({ required: event.target.checked, readonly })}
        />
        {translate('props.sections.required')}
      </label>
    </div>
  );
}

/**
 * The `{}` button that switches a section between its controls and the code
 * type, the same toggle a default's value and its code use (PropertyDefault.tsx).
 */
export function CodeTypeToggle(props: { readonly open: boolean; readonly onToggle: () => void }) {
  const translate = useTranslate();
  const action = props.open ? translate('props.sections.useControls') : translate('props.sections.editCodeType');
  return (
    <button
      type="button"
      className={`prop-expr-toggle property-code-toggle${props.open ? ' on' : ''}`}
      aria-pressed={props.open}
      aria-label={action}
      title={action}
      onClick={props.onToggle}
    >
      <BracesIcon size={12} />
    </button>
  );
}

/** The TypeScript written for the prop, in the highlighted code field. */
export function CodeTypeEditor(props: { readonly type: string; readonly placeholder: string; readonly onChange: (type: string) => void }) {
  const translate = useTranslate();
  return (
    <ExprInput
      ariaLabel={translate('props.sections.codeType')}
      className="property-code"
      language="typescript"
      value={props.type}
      syncValue={props.type}
      placeholder={props.placeholder}
      onChange={(type) => {
        // An editor has no maxLength, so the bound the input held is held here.
        if (type.length <= PROPERTY_LIMITS.textCharsMax) {
          props.onChange(type);
        }
      }}
    />
  );
}

/** The code type as a section of its own: its label with the `{}` toggle, and the field when it is on. */
export function CodeTypeField(props: {
  readonly type: string;
  readonly placeholder: string;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onChange: (type: string) => void;
}) {
  const translate = useTranslate();
  return (
    <>
      <div className="property-code-heading">
        <span>{translate('props.sections.codeType')}</span>
        <CodeTypeToggle open={props.open} onToggle={props.onToggle} />
      </div>
      {props.open && <CodeTypeEditor type={props.type} placeholder={props.placeholder} onChange={props.onChange} />}
    </>
  );
}

// The icon of each kind: the Kind dropdown's for the kinds it shares, the CMS
// field-type list's for the rest, so a kind looks the same wherever it is chosen.
const ITEM_KIND_ICONS: Readonly<Record<ItemFieldKind, ReactNode>> = {
  text: <TextIcon size={14} />,
  longText: <ParagraphIcon size={14} />,
  richText: <BoldIcon size={14} />,
  number: <FieldNumberIcon size={14} />,
  switch: <FieldSwitchIcon size={14} />,
  image: <ElementImageIcon size={14} />,
  video: <ElementVideoIcon size={14} />,
  file: <PaperclipIcon size={14} />,
  link: <ElementLinkIcon size={14} />,
  email: <MailIcon size={14} />,
  phone: <PhoneCallIcon size={14} />,
  color: <DropletIcon size={14} />,
  date: <CalendarIcon size={14} />,
  option: <ElementSelectIcon size={14} />,
  list: <ElementListDefaultIcon size={14} />,
  group: <ElementDivIcon size={14} />,
};

// The menu is grouped so sixteen kinds scan as five short lists.
const ITEM_KIND_GROUPS: Readonly<Record<ItemFieldKind, MessageKey>> = {
  text: 'props.itemKinds.group.text',
  longText: 'props.itemKinds.group.text',
  richText: 'props.itemKinds.group.text',
  number: 'props.itemKinds.group.values',
  switch: 'props.itemKinds.group.values',
  color: 'props.itemKinds.group.values',
  date: 'props.itemKinds.group.values',
  option: 'props.itemKinds.group.values',
  image: 'props.itemKinds.group.media',
  video: 'props.itemKinds.group.media',
  file: 'props.itemKinds.group.media',
  link: 'props.itemKinds.group.contact',
  email: 'props.itemKinds.group.contact',
  phone: 'props.itemKinds.group.contact',
  list: 'props.itemKinds.group.structure',
  group: 'props.itemKinds.group.structure',
};

/** The kind menu's options in the language `translate` speaks; the constants below are the English ones (tests, search). */
export function itemKindOptions(kinds: readonly ItemFieldKind[], translate: Translator = ENGLISH_TRANSLATE): readonly DropdownOption<ItemFieldKind>[] {
  return kinds.map((kind) => ({ value: kind, label: itemFieldTitle(kind, translate), group: translate(ITEM_KIND_GROUPS[kind]), icon: ITEM_KIND_ICONS[kind] }));
}

/** What the type dropdown lists: every kind, and on the last level of fields only the kinds that hold one value, since a list or group there has no room for fields. */
export const ITEM_KIND_OPTIONS = itemKindOptions(ITEM_FIELD_KINDS);
const PLAIN_KINDS = ITEM_FIELD_KINDS.filter((kind) => kind !== 'list' && kind !== 'group');
export const ITEM_KIND_OPTIONS_PLAIN = itemKindOptions(PLAIN_KINDS);

// The field's trigger is narrow, and its longest title needs room beside the icon and the chevron.
const ITEM_FIELD_MENU_WIDTH_PX_MIN = 148;

/** What the Item fields editor tells its host: the new fields and default items, and whether it was a pick or typing. */
type ShapeChange = (shape: ListShape, pace: EditPace) => void;

/**
 * The fields each item of a list has: a name and a kind per row, + to add one.
 * Renaming a field keeps what the default items hold in it; changing its kind
 * or removing it clears that field in them, since a text cannot be a switch.
 * A List or a Group row has fields of its own beneath it, edited the same way.
 */
export function ItemFieldsEditor(props: ListShape & { readonly onChange: ShapeChange }) {
  const translate = useTranslate();
  const { fields, itemsText, onChange } = props;
  // A name part-way through being typed can be no name at all, and an item cannot
  // be written under one. The items keep the last real name until the row has
  // another, so clearing a name to retype it keeps what they hold.
  const heldKeys = useRef(new Map<string, string>());
  const problem = fieldsProblem(fields, 1, translate);
  return (
    <div className="new-prop-settings property-item-fields" role="group" aria-label={translate('props.sections.itemFields')}>
      <div className="loop-bind-title">{translate('props.sections.itemFields')}</div>
      <ItemFieldRows shape={{ fields, itemsText }} parent={[]} heldKeys={heldKeys.current} onChange={onChange} />
      {problem !== undefined && <div className="new-prop-note">{problem}</div>}
    </div>
  );
}

interface RowsProps {
  readonly shape: ListShape;
  /** The field these rows belong to, [] for the item's own fields. */
  readonly parent: FieldPath;
  readonly heldKeys: Map<string, string>;
  readonly onChange: ShapeChange;
}

// The rows of one level of fields, and the + that adds a field to it. A List or
// a Group row draws the next level beneath itself, so this draws itself.
function ItemFieldRows({ shape, parent, heldKeys, onChange }: RowsProps) {
  const translate = useTranslate();
  assert(parent.length < ITEM_FIELD_LIMITS.depthMax, 'ItemFieldRows: the fields nest within their bound');
  const owner = parent.length === 0 ? undefined : fieldAtPath(shape.fields, parent);
  const siblings = owner === undefined ? shape.fields : fieldsOf(owner);
  return (
    <>
      {siblings.map((field, index) => (
        <ItemFieldRow
          key={index}
          field={field}
          path={[...parent, index]}
          siblingCount={siblings.length}
          shape={shape}
          heldKeys={heldKeys}
          onChange={onChange}
        />
      ))}
      <button
        type="button"
        className="loop-bind-button new-prop-add"
        disabled={siblings.length >= ITEM_FIELD_LIMITS.fieldsPerLevelMax}
        onClick={() => onChange(addedField(shape, parent), 'at-once')}
      >
        <PlusIcon size={11} /> {translate('props.sections.addField')}
      </button>
    </>
  );
}

function ItemFieldRow(props: Omit<RowsProps, 'parent'> & { readonly field: ItemFieldDeclaration; readonly path: FieldPath; readonly siblingCount: number }) {
  const translate = useTranslate();
  const { field, path, siblingCount, shape, heldKeys, onChange } = props;
  const heldAt = path.join('.');
  const rename = (name: string): void => {
    const key = fieldNameProblem(field.name) === undefined ? field.name : (heldKeys.get(heldAt) ?? field.name);
    if (fieldNameProblem(name) === undefined) {
      heldKeys.delete(heldAt);
    } else {
      heldKeys.set(heldAt, key);
    }
    onChange(renamedFieldAt(shape, path, name, key), 'typing');
  };
  const remove = (): void => {
    // Rows move up, so what was held by position no longer matches.
    heldKeys.clear();
    onChange(removedFieldAt(shape, path), 'at-once');
  };
  return (
    <>
      <div className="new-prop-list-field">
        <input
          className="new-prop-input"
          aria-label={translate('props.sections.fieldName')}
          placeholder={translate('props.newProp.form.attributeNameHint')}
          spellCheck={false}
          value={field.name}
          onChange={(event) => rename(event.target.value.replace(/[^\w$]/g, ''))}
        />
        <Dropdown
          ariaLabel={translate('props.sections.fieldType')}
          value={field.kind}
          options={itemKindOptions(path.length < ITEM_FIELD_LIMITS.depthMax ? ITEM_FIELD_KINDS : PLAIN_KINDS, translate)}
          livePreview={false}
          menuWidthMin={ITEM_FIELD_MENU_WIDTH_PX_MIN}
          onChange={(kind) => onChange(retypedFieldAt(shape, path, kind), 'at-once')}
        />
        <button
          type="button"
          className="loop-settings-remove"
          aria-label={translate('props.sections.removeField')}
          title={translate('ui.remove')}
          disabled={siblingCount <= 1}
          onClick={remove}
        >
          <TrashIcon size={12} />
        </button>
      </div>
      {field.kind === 'option' && <OptionChoices field={field} onChange={(options) => onChange(optionsAtPath(shape, path, options), 'at-once')} />}
      {(field.kind === 'list' || field.kind === 'group') && (
        <div className="property-nested-fields" role="group" aria-label={translate('props.sections.fieldsOf', { name: field.name })}>
          <div className="property-nested-title">
            {field.kind === 'list' ? translate('props.sections.eachItemHas', { name: field.name }) : translate('props.sections.groupHas', { name: field.name })}
          </div>
          <ItemFieldRows shape={shape} parent={path} heldKeys={heldKeys} onChange={onChange} />
        </div>
      )}
    </>
  );
}

// The words an Option field offers, edited with the list of words the Properties panel's Options use.
function OptionChoices(props: { readonly field: Extract<ItemFieldDeclaration, { kind: 'option' }>; readonly onChange: (options: readonly string[]) => void }) {
  const translate = useTranslate();
  const items: readonly Item[] = props.field.options.map((option) => ({ text: option, quote: '"' }));
  return (
    <div className="property-nested-fields property-option-choices" role="group" aria-label={translate('props.sections.optionsOf', { name: props.field.name })}>
      <div className="property-nested-title">{translate('props.newProp.form.options')}</div>
      <ListField
        value={arrayText(items)}
        itemsMin={2}
        itemsMax={ITEM_FIELD_LIMITS.optionsMax}
        valueCharsMax={ITEM_FIELD_LIMITS.optionsMax * ITEM_FIELD_LIMITS.optionCharsMax}
        onChange={(text) => props.onChange(optionWords(text))}
      />
    </div>
  );
}

// The words of a list of words, as typed.
function optionWords(text: string): readonly string[] {
  return (arrayItems(text) ?? []).map((item) => item.text ?? '').slice(0, ITEM_FIELD_LIMITS.optionsMax);
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
  readonly onChange: (code: string, pace: EditPace) => void;
}) {
  const translate = useTranslate();
  const field = listDefaultField(props.fields, translate);
  // Keyed by the shape, so a field's rows are redrawn when the fields above change.
  const shapeKey = JSON.stringify(props.fields);
  return (
    <div className="property-default property-list-default" role="group" aria-label={translate('props.sections.defaultItems')}>
      <PropField
        key={shapeKey}
        nodeKey="default-items"
        field={field}
        value={defaultAttr(props.code)}
        assetContext={props.projectPath === undefined ? undefined : { projectPath: props.projectPath }}
        onChange={(next, immediate) => props.onChange(defaultCodeOf(next), immediate === true ? 'at-once' : 'typing')}
      />
    </div>
  );
}

/** The instance field a list default is edited in: a list of items of these fields, never required. */
export function listDefaultField(fields: readonly ItemFieldDeclaration[], translate: Translator = ENGLISH_TRANSLATE): FieldDefinition {
  assert(fields.length <= ITEM_FIELD_LIMITS.fieldsPerLevelMax, 'listDefaultField: the fields are bounded');
  return {
    name: translate('props.sections.defaultItems'),
    type: 'code',
    optional: true,
    shape: shapeMembersOf(fields),
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
