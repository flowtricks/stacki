// "Property settings" for a new component prop, opened from the binding
// picker's "New … property" row, as a builder asks for one: its name (checked
// as it is typed), its tooltip, its kind where the field allows a choice, the
// kind's own settings, and its default, starting from what the field holds
// now. Nothing is written until Create, and Create declares the prop and binds
// the field to it as one undo step (the host holds the declaration for the
// field's edit; NewPropHost in newPropModel.ts).
//
// A List asks for the fields each item has (a name and a kind each) and,
// optionally, default items, edited in the same list editor an instance uses,
// so the form shows exactly what the Settings panel will. An Image asks for
// its default with the asset card and picker every image field uses; the
// default decides the type (an imported file, or a URL; imagePropDefault.ts).

import { useState } from 'react';
import { CloseIcon, PlusIcon, TrashIcon } from '../../ui/Icons';
import AutoTextarea from '../../ui/AutoTextarea';
import AssetField from '../../ui/AssetField';
import { assert } from '../../../shared/core/assert';
import ListField from './ListField';
import { arrayItems, arrayText, type Item } from './arrayValue';
import {
  fieldNameProblem,
  ITEM_FIELD_KINDS,
  ITEM_FIELD_TITLES,
  LIST_LIMITS,
  listSettingsProblem,
  type ItemFieldDeclaration,
  type ItemFieldKind,
} from '../../editor/listPropType';
import { imageDefaultOf } from '../../editor/imagePropDefault';
import { blankItemOf, itemValuesOf, renamedItemField } from './listItemShape';
import {
  attributeDefaultsProblem,
  DECLARATION_LIMITS,
  defaultCode,
  numberSettingsProblem,
  optionsProblem,
  switchSettingsProblem,
  type AttributeDefault,
  type NewPropKind,
  type PropDeclaration,
} from '../../editor/propDeclaration';
import { SWITCH_LABELS, type NumberSettings, type SwitchSettings } from '../../editor/propDocumentation';
import {
  boundPath,
  FIT_KINDS,
  KIND_TITLES,
  propNameProblem,
  seedName,
  suggestedPropName,
  suggestedRestName,
  type NewPropHost,
  type NewPropSeed,
} from './newPropModel';
import SegSwitch from './SegSwitch';
import './loopSettings.css';

export interface NewPropFormProps {
  readonly host: NewPropHost;
  readonly seed: NewPropSeed;
  readonly onCreated: (path: string, declaration: PropDeclaration) => void;
  readonly onCancel: () => void;
}

export default function NewPropForm(props: NewPropFormProps) {
  const form = useNewPropForm(props);
  const { name, setName, problem, kind, created } = form;
  return (
    <div className="loop-bind-dialog loop-property-settings new-prop-form" role="dialog" aria-label="Property settings">
      <div className="loop-property-head">
        <span className="loop-bind-title">Property settings</span>
        <button type="button" className="loop-settings-remove" aria-label="Close" title="Close" onClick={props.onCancel}>
          <CloseIcon size={12} />
        </button>
      </div>
      <label className="loop-bind-name">
        <span className="loop-settings-editor-label">Name</span>
        <input
          value={name}
          spellCheck={false}
          autoFocus={true}
          aria-label="Name"
          aria-invalid={form.nameProblem !== undefined}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              form.create();
            }
          }}
        />
      </label>
      {form.nameProblem !== undefined && <div className="loop-bind-problem">{form.nameProblem}</div>}
      <label className="loop-bind-name top">
        <span className="loop-settings-editor-label">Tooltip</span>
        <AutoTextarea
          value={form.tooltip}
          aria-label="Tooltip"
          placeholder="Describe how to use this property…"
          onChange={(event) => form.setTooltip(event.target.value)}
        />
      </label>
      {form.kinds.length > 1 && (
        <div className="loop-bind-name">
          <span className="loop-settings-editor-label">Type</span>
          <SegSwitch options={form.kinds.map((value) => ({ value, label: KIND_TITLES[value] }))} current={kind} onPick={form.setKind} />
        </div>
      )}
      <KindSettings form={form} />
      <div className="loop-property-default">
        <div className="loop-bind-title">{kind === 'list' ? 'Default items' : `Default ${KIND_TITLES[kind]}`}</div>
        <DefaultEditor form={form} host={props.host} />
      </div>
      {problem !== undefined && form.nameProblem === undefined && <div className="loop-bind-problem">{problem}</div>}
      <div className="loop-bind-actions">
        <button type="button" className="loop-bind-button" onClick={props.onCancel}>
          Cancel
        </button>
        <button type="button" className="loop-bind-button primary" disabled={problem !== undefined || created} onClick={form.create}>
          Create
        </button>
      </div>
    </div>
  );
}

function useNewPropForm({ host, seed, onCreated }: NewPropFormProps) {
  const kinds = FIT_KINDS[seed.fit];
  const first = kinds[0];
  assert(first !== undefined, 'NewPropForm: a field offers at least one kind');
  const [kind, setKindState] = useState<NewPropKind>(first);
  const [name, setName] = useState(() => (first === 'attributes' ? suggestedRestName(host) : suggestedPropName(seedName(seed), host)));
  const [tooltip, setTooltip] = useState('');
  const [defaultText, setDefaultText] = useState(() => initialDefault(first, seed.value));
  const [options, setOptions] = useState<readonly string[]>(() => [seed.value.trim() === '' ? 'Option 1' : seed.value]);
  const [number, setNumber] = useState<NumberSettings>({ min: undefined, max: undefined, decimals: undefined });
  const [switchLabels, setSwitchLabels] = useState<SwitchSettings>(SWITCH_LABELS);
  const [attributes, setAttributes] = useState<readonly AttributeDefault[]>([]);
  // A list field of a child component starts from its items' fields and the items it holds now.
  const [listFields, setListFields] = useState<readonly ItemFieldDeclaration[]>(() => (seed.itemFields?.length ? seed.itemFields : STARTER_FIELDS));
  const [listItems, setListItems] = useState(() => (seed.fit === 'list' && arrayItems(seed.value) !== undefined ? seed.value.trim() : '[]'));
  // An image field that already shows a file or a URL starts from it.
  const [image, setImage] = useState(() => (seed.fit === 'image' && imageDefaultOf(seed.value).ok ? seed.value.trim() : ''));
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const [created, setCreated] = useState(false);
  const key = name.trim();
  const nameProblem = propNameProblem(key, host);
  const list = { fields: listFields, items: itemValuesOf(arrayItems(listItems) ?? []) };
  const declaration: PropDeclaration = {
    key,
    tooltip,
    kind,
    defaultText,
    options,
    number,
    switch: switchLabels,
    attributes,
    tag: seed.tag ?? '',
    list,
    image,
  };
  const problem = nameProblem ?? settingsProblem(declaration) ?? refusal;
  const setKind = (next: NewPropKind): void => {
    setKindState(next);
    setDefaultText(initialDefault(next, seed.value));
    setRefusal(undefined);
  };
  const create = (): void => {
    if (problem !== undefined || created) {
      return;
    }
    const answer = host.create(declaration);
    if (answer.ok) {
      setCreated(true);
      // An imported image bound where a URL is wanted reads its `.src`.
      const picked = kind === 'image' ? imageDefaultOf(image) : undefined;
      onCreated(boundPath(answer.value, picked?.ok === true ? picked.value.kind : undefined, seed.reference), declaration);
    } else {
      setRefusal(answer.error);
    }
  };
  const edit =
    <T,>(set: (value: T) => void) =>
    (value: T): void => {
      set(value);
      setRefusal(undefined);
    };
  return {
    kinds,
    kind,
    setKind,
    name,
    setName: edit(setName),
    nameProblem: key === '' ? undefined : nameProblem,
    tooltip,
    setTooltip,
    defaultText,
    setDefaultText: edit(setDefaultText),
    options,
    setOptions: edit(setOptions),
    number,
    setNumber: edit(setNumber),
    switchLabels,
    setSwitchLabels: edit(setSwitchLabels),
    attributes,
    setAttributes: edit(setAttributes),
    listFields,
    setListFields: edit(setListFields),
    listItems,
    setListItems: edit(setListItems),
    image,
    setImage: edit(setImage),
    problem: key === '' ? 'Give the property a name.' : problem,
    created,
    create,
  };
}
type FormState = ReturnType<typeof useNewPropForm>;

// A list's items start as a title and a line of text, as a list of values,
// features or steps most often is.
const STARTER_FIELDS: readonly ItemFieldDeclaration[] = [
  { name: 'title', kind: 'text' },
  { name: 'text', kind: 'text' },
];

// What the field holds now, as a default of `kind`: a switch starts off, a
// number only from a number.
function initialDefault(kind: NewPropKind, value: string): string {
  switch (kind) {
    case 'string':
    case 'option':
      return value;
    case 'number':
      return Number.isFinite(Number(value.trim())) && value.trim() !== '' ? value.trim() : '';
    case 'boolean':
      return value === 'true' ? 'true' : 'false';
    case 'attributes':
    case 'list':
    case 'image':
      return '';
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function settingsProblem(declaration: PropDeclaration): string | undefined {
  switch (declaration.kind) {
    case 'number':
      return numberSettingsProblem(declaration.number) ?? defaultProblem(declaration);
    case 'boolean':
      return switchSettingsProblem(declaration.switch);
    case 'option':
      return optionsProblem(declaration.options) ?? defaultProblem(declaration);
    case 'attributes':
      return attributeDefaultsProblem(declaration.attributes);
    case 'list':
      return listSettingsProblem(declaration.list);
    case 'image': {
      const image = imageDefaultOf(declaration.image);
      return image.ok ? undefined : image.error;
    }
    case 'string':
      return undefined;
    default: {
      const exhaustive: never = declaration.kind;
      return exhaustive;
    }
  }
}

function defaultProblem(declaration: PropDeclaration): string | undefined {
  const code = defaultCode(declaration);
  return code.ok ? undefined : code.error;
}

function KindSettings({ form }: { readonly form: FormState }) {
  switch (form.kind) {
    case 'number':
      return <NumberSettingsEditor settings={form.number} onChange={form.setNumber} />;
    case 'boolean':
      return <SwitchSettingsEditor settings={form.switchLabels} onChange={form.setSwitchLabels} />;
    case 'option':
      // The same list editor the Properties panel's Options use (PropertyOptions), over the words themselves.
      return (
        <div className="property-options props-field">
          <span>Options</span>
          <ListField
            value={arrayText(form.options.map((option) => ({ text: option, quote: '"' })))}
            itemsMin={1}
            itemsMax={DECLARATION_LIMITS.optionsMax}
            valueCharsMax={DECLARATION_LIMITS.optionsMax * DECLARATION_LIMITS.optionCharsMax}
            onChange={(text) => form.setOptions(optionWords(text))}
          />
        </div>
      );
    case 'list':
      return <ItemFieldsEditor form={form} />;
    case 'string':
    case 'attributes':
    case 'image':
      return undefined;
    default: {
      const exhaustive: never = form.kind;
      return exhaustive;
    }
  }
}

// The words of the option list's array text.
function optionWords(text: string): readonly string[] {
  return (arrayItems(text) ?? []).filter((item) => item.fields === undefined).map((item) => item.text);
}

function DefaultEditor({ form, host }: { readonly form: FormState; readonly host: NewPropHost }) {
  switch (form.kind) {
    case 'string':
      return <AutoTextarea value={form.defaultText} aria-label="Default" placeholder="None" onChange={(event) => form.setDefaultText(event.target.value)} />;
    case 'number':
      return (
        <input
          className="new-prop-input"
          inputMode="decimal"
          aria-label="Default"
          placeholder="None"
          value={form.defaultText}
          onChange={(event) => form.setDefaultText(event.target.value)}
        />
      );
    case 'boolean':
      return (
        <SegSwitch
          options={[
            { value: 'true', label: form.switchLabels.onLabel || SWITCH_LABELS.onLabel },
            { value: 'false', label: form.switchLabels.offLabel || SWITCH_LABELS.offLabel },
          ]}
          current={form.defaultText}
          onPick={form.setDefaultText}
        />
      );
    case 'option':
      return (
        <select className="new-prop-input" aria-label="Default" value={form.defaultText} onChange={(event) => form.setDefaultText(event.target.value)}>
          <option value="">None</option>
          {form.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    case 'attributes':
      return <AttributeDefaultsEditor defaults={form.attributes} onChange={form.setAttributes} />;
    case 'list':
      return (
        <ListField
          value={form.listItems}
          itemShape={form.listFields}
          projectPath={host.projectPath}
          itemsMax={LIST_LIMITS.itemsMax}
          valueCharsMax={LIST_ITEMS_CHARS_MAX}
          onChange={(text) => form.setListItems(text)}
        />
      );
    case 'image':
      // The path is written relative to the component, as its import reads it.
      return host.projectPath === undefined ? (
        <input
          className="new-prop-input"
          aria-label="Default"
          placeholder="https://… or ../assets/image.png"
          value={form.image}
          onChange={(event) => form.setImage(event.target.value)}
        />
      ) : (
        <AssetField
          value={form.image === '' ? undefined : form.image}
          mediaKind="image"
          projectPath={host.projectPath}
          baseDir={host.fileDirectory}
          pickPresentation="overlay"
          onChange={(value) => form.setImage(value)}
        />
      );
    default: {
      const exhaustive: never = form.kind;
      return exhaustive;
    }
  }
}

// Every item's text, at most: each field of each item at its own bound.
const LIST_ITEMS_CHARS_MAX = LIST_LIMITS.itemsMax * LIST_LIMITS.fieldsMax * (LIST_LIMITS.valueCharsMax + LIST_LIMITS.fieldNameCharsMax);

/**
 * The fields each item of a list has: a name and a kind per row, + to add one.
 * Renaming a field keeps what the default items hold in it; changing its kind
 * or removing it clears that field in them, since a text cannot be a switch.
 */
function ItemFieldsEditor({ form }: { readonly form: FormState }) {
  const fields = form.listFields;
  const items = (): readonly Item[] => arrayItems(form.listItems) ?? [];
  const rename = (index: number, name: string): void => {
    const previous = fields[index];
    assert(previous !== undefined, 'ItemFieldsEditor: the renamed field exists');
    form.setListFields(fields.map((field, at) => (at === index ? { ...field, name } : field)));
    form.setListItems(arrayText(renamedItemField(items(), previous.name, name)));
  };
  const retype = (index: number, kind: ItemFieldKind): void => {
    const previous = fields[index];
    assert(previous !== undefined, 'ItemFieldsEditor: the retyped field exists');
    const next = { ...previous, kind };
    form.setListFields(fields.map((field, at) => (at === index ? next : field)));
    form.setListItems(arrayText(items().map((item) => withField(item, next))));
  };
  const remove = (index: number): void => {
    const removed = fields[index];
    assert(removed !== undefined, 'ItemFieldsEditor: the removed field exists');
    form.setListFields(fields.filter((_, at) => at !== index));
    form.setListItems(
      arrayText(items().map((item) => (item.fields === undefined ? item : { fields: item.fields.filter((field) => field.key !== removed.name) }))),
    );
  };
  const nameProblem = fields.map((field) => fieldNameProblem(field.name)).find((problem) => problem !== undefined);
  return (
    <div className="new-prop-settings">
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
          <select className="new-prop-input" aria-label="Field type" value={field.kind} onChange={(event) => retype(index, kindOf(event.target.value))}>
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
        onClick={() => form.setListFields([...fields, { name: freeFieldName(fields), kind: 'text' }])}
      >
        <PlusIcon size={11} /> Add field
      </button>
    </div>
  );
}

// The item with `field` set back to blank in its new kind.
function withField(item: Item, field: ItemFieldDeclaration): Item {
  if (item.fields === undefined) {
    return item;
  }
  const blank = blankItemOf([field], '"').fields?.[0];
  assert(blank !== undefined, 'withField: a blank item has the field');
  return { fields: item.fields.map((own) => (own.key === field.name ? blank : own)) };
}

function kindOf(value: string): ItemFieldKind {
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

/** Min, Max and Decimals for a number prop; an empty box is None (Auto for decimals). */
export function NumberSettingsEditor(props: { readonly settings: NumberSettings; readonly onChange: (settings: NumberSettings) => void }) {
  const field = (label: string, key: keyof NumberSettings, placeholder: string) => (
    <label className="loop-bind-name">
      <span className="loop-settings-editor-label">{label}</span>
      <input
        className="new-prop-input"
        inputMode="decimal"
        aria-label={label}
        placeholder={placeholder}
        value={props.settings[key] === undefined ? '' : String(props.settings[key])}
        onChange={(event) => {
          const text = event.target.value.trim();
          props.onChange({ ...props.settings, [key]: text === '' ? undefined : Number(text) });
        }}
      />
    </label>
  );
  return (
    <div className="new-prop-settings">
      <div className="loop-bind-title">Number settings</div>
      {field('Min', 'min', 'None')}
      {field('Max', 'max', 'None')}
      {field('Decimals', 'decimals', 'Auto')}
    </div>
  );
}

/** What a switch prop's two sides are called. */
export function SwitchSettingsEditor(props: { readonly settings: SwitchSettings; readonly onChange: (settings: SwitchSettings) => void }) {
  return (
    <div className="new-prop-settings">
      <div className="loop-bind-title">Switch settings</div>
      <label className="loop-bind-name">
        <span className="loop-settings-editor-label">On label</span>
        <input
          className="new-prop-input"
          aria-label="On label"
          value={props.settings.onLabel}
          onChange={(event) => props.onChange({ ...props.settings, onLabel: event.target.value })}
        />
      </label>
      <label className="loop-bind-name">
        <span className="loop-settings-editor-label">Off label</span>
        <input
          className="new-prop-input"
          aria-label="Off label"
          value={props.settings.offLabel}
          onChange={(event) => props.onChange({ ...props.settings, offLabel: event.target.value })}
        />
      </label>
    </div>
  );
}

/** An attributes prop's defaults: `name = value` rows, with + to add one. */
export function AttributeDefaultsEditor(props: {
  readonly defaults: readonly AttributeDefault[];
  readonly onChange: (defaults: readonly AttributeDefault[]) => void;
}) {
  const { defaults, onChange } = props;
  const set = (index: number, entry: AttributeDefault): void => onChange(defaults.map((current, at) => (at === index ? entry : current)));
  return (
    <div className="new-prop-attributes">
      {defaults.map((entry, index) => (
        <div className="new-prop-attribute" key={index}>
          <input
            className="new-prop-input"
            aria-label="Attribute name"
            placeholder="name"
            spellCheck={false}
            value={entry.name}
            onChange={(event) => set(index, { ...entry, name: event.target.value.replace(/[^\w@:.-]/g, '') })}
          />
          <span className="attr-eq">=</span>
          <input
            className="new-prop-input"
            aria-label="Attribute value"
            placeholder="value"
            spellCheck={false}
            value={entry.value}
            onChange={(event) => set(index, { ...entry, value: event.target.value })}
          />
          <button
            type="button"
            className="loop-settings-remove"
            aria-label="Remove attribute"
            title="Remove"
            onClick={() => onChange(defaults.filter((_, at) => at !== index))}
          >
            <TrashIcon size={12} />
          </button>
        </div>
      ))}
      <button type="button" className="loop-bind-button new-prop-add" onClick={() => onChange([...defaults, { name: '', value: '' }])}>
        <PlusIcon size={11} /> Add attribute
      </button>
    </div>
  );
}
