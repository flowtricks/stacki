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
//
// Required, Readonly, the Code type, a List's item fields and its default
// items are the Properties panel's own sections (PropertySections.tsx), so a
// prop offers the same options wherever it is made. A List's default items are
// the instance's list field, `{}` toggle and all: code the list cannot show is
// written as typed (PropDeclaration.defaultExpression).

import { useState } from 'react';
import { CloseIcon, PlusIcon, TrashIcon } from '../../ui/Icons';
import AutoTextarea from '../../ui/AutoTextarea';
import AssetField from '../../ui/AssetField';
import Dropdown from '../../ui/Dropdown';
import { assert } from '../../../shared/core/assert';
import ListField from './ListField';
import { CodeTypeField, ItemFieldsEditor, ListDefaultField, PropertyFlagsFields, type PropertyFlags } from './PropertySections';
import { arrayItems, arrayText, itemsHoldCode } from './arrayValue';
import { LIST_STARTER_FIELDS, listSettingsProblem, type ItemFieldDeclaration } from '../../editor/listPropType';
import { imageDefaultOf } from '../../editor/imagePropDefault';
import { itemValuesOf } from './listItemShape';
import {
  attributeDefaultsProblem,
  DECLARATION_LIMITS,
  defaultCode,
  numberSettingsProblem,
  optionsProblem,
  switchSettingsProblem,
  typeText,
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
      {/* The same Required, Readonly and Code type the Properties panel edits (PropertySections.tsx). */}
      <PropertyFlagsFields required={form.flags.required} readonly={form.flags.readonly} onChange={form.setFlags} />
      <div className="new-prop-code-type">
        <CodeTypeField
          type={form.codeType}
          placeholder={form.kindType}
          open={form.codeOpen}
          onToggle={() => form.setCodeOpen(!form.codeOpen)}
          onChange={form.setCodeType}
        />
      </div>
      {kind === 'list' ? (
        // The field an instance edits the list in, with its `{}` toggle to the code.
        <ListDefaultField fields={form.listFields} code={form.listItems} projectPath={props.host.projectPath} onChange={form.setListItems} />
      ) : (
        <div className="loop-property-default">
          <div className="loop-bind-title">{`Default ${KIND_TITLES[kind]}`}</div>
          <DefaultEditor form={form} host={props.host} />
        </div>
      )}
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
  const [listFields, setListFields] = useState<readonly ItemFieldDeclaration[]>(() => (seed.itemFields?.length ? seed.itemFields : LIST_STARTER_FIELDS));
  const [listItems, setListItems] = useState(() => (seed.fit === 'list' && arrayItems(seed.value) !== undefined ? seed.value.trim() : '[]'));
  // An image field that already shows a file or a URL starts from it.
  const [image, setImage] = useState(() => (seed.fit === 'image' && imageDefaultOf(seed.value).ok ? seed.value.trim() : ''));
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const [created, setCreated] = useState(false);
  const [flags, setFlags] = useState<PropertyFlags>({ required: false, readonly: false });
  const [codeType, setCodeType] = useState('');
  const [codeOpen, setCodeOpen] = useState(false);
  const key = name.trim();
  const nameProblem = propNameProblem(key, host);
  // The default items as items when the list can show them; as code, written as typed, when not.
  // A field bound to data reads as an item but is code: as a value it would be quoted into words.
  const parsedItems = arrayItems(listItems);
  const listAsItems = parsedItems !== undefined && !itemsHoldCode(parsedItems) ? parsedItems : undefined;
  const list = { fields: listFields, items: itemValuesOf(listAsItems ?? []) };
  const listExpression = kind === 'list' && listAsItems === undefined ? listItems : '';
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
    typing: { required: flags.required, readonly: flags.readonly, codeType },
    defaultExpression: listExpression,
  };
  // Without the component's frontmatter here, a list's item type is shown inline.
  const kindTyped = typeText(declaration);
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
    flags,
    setFlags: edit(setFlags),
    codeType,
    setCodeType: edit(setCodeType),
    codeOpen,
    setCodeOpen,
    // What the kind writes, shown in an empty Code type box.
    kindType: kindTyped.ok ? kindTyped.value : '',
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
      return (
        <ItemFieldsEditor
          fields={form.listFields}
          itemsText={form.listItems}
          onChange={(shape) => {
            form.setListFields(shape.fields);
            form.setListItems(shape.itemsText);
          }}
        />
      );
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
        <Dropdown
          ariaLabel="Default"
          value={form.defaultText}
          options={[{ value: '', label: 'None' }, ...form.options.map((option) => ({ value: option, label: option }))]}
          livePreview={false}
          onChange={form.setDefaultText}
        />
      );
    case 'attributes':
      return <AttributeDefaultsEditor defaults={form.attributes} onChange={form.setAttributes} />;
    case 'list':
      // A list's default is the instance's list field (ListDefaultField), drawn by the form itself.
      return undefined;
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
