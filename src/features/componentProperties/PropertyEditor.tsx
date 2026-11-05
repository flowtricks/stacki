import { ErrorToast } from '../../ui/ErrorToast';
import PropertyReadOnlyFields from './PropertyReadOnlyFields';
import { PropertyConditions, PropertyDeclarationInfo } from './PropertyDeclarationInfo';
import { TrashIcon } from '../../ui/Icons';
import { PropertyOptions } from './PropertyOptions';
import type { PropertyOptionChange } from './PropertyOptions';
import { PropertyType } from './PropertyType';
import { PropertyDefault, propertyDefaultText } from './PropertyDefault';
import { PropertyDefaultNote, PropertyKindSettings, PropertyTooltip } from './PropertySettings';
import { literalOptions } from '../../../shared/properties/propertyOptions';
export { literalOptions };
import { useRef, useState } from 'react';
import Popup from '../../ui/Popup';
import { assert } from '../../../shared/core/assert';
import type { ComponentProperty, PropertyChange, PropertyOptionRename } from '../../../shared/properties/propertyEditing';
import { PROPERTY_LIMITS } from '../../../shared/properties/propertyEditing';
import { listPropsOf, type ListProp } from '../../editor/listProps';
import { SETTING_PROP_TYPES } from '../../editor/optionsBinding';
import { fieldNameProblem, listFieldsOfType, listTypeText, type ItemFieldDeclaration } from '../../editor/listPropType';
import { ItemFieldsEditor, ListDefaultField, PropertyFlagsFields } from '../props/propBindings';
import { propertyKind } from './propertyKinds';

interface PropertyEditorProps {
  readonly property: ComponentProperty;
  readonly originalName: string;
  readonly frontmatter: string;
  readonly access: 'editable' | 'readonly' | 'saving';
  readonly onClose: () => void;
  readonly onSave: (change: PropertyChange) => Promise<void>;
  readonly onCommit: (change: PropertyChange) => Promise<boolean>;
}
// Types loose enough that a list setting's own type only says more.
const LOOSE_TYPES = new Set(['', 'unknown', 'any', 'object', 'Record<string, unknown>']);

/**
 * The property with its type set to the list setting its component's loop
 * reads from it (`"filter": propFilters` makes `filters` a Filter), when its
 * type says no more than `unknown`. Saving writes it; nothing changes unsaved.
 */
export function withListSettingType(property: ComponentProperty, listProps: ReadonlyMap<string, ListProp>): ComponentProperty {
  if (!LOOSE_TYPES.has(property.type.trim())) {
    return property;
  }
  const listProp = listProps.get(property.name);
  return listProp === undefined ? property : { ...property, type: SETTING_PROP_TYPES[listProp.setting] };
}

export function PropertyEditor(props: PropertyEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const draft = usePropertyEditorDraft(props);
  return (
    <Popup mode="popover" portal={false} className="property-editor" ref={editorRef} onClose={props.onClose} dismissible={props.access !== 'saving'}>
      {({ close }) => (
        <>
          <header>
            <div className="property-editor-title">
              <strong>{props.originalName ? 'Property settings' : 'New property'}</strong>
              <PropertyDeclarationInfo property={props.property} />
            </div>
            <button aria-label="Close property settings" disabled={props.access === 'saving'} onClick={close}>
              ×
            </button>
          </header>
          <PropertyConditions property={props.property} />
          {props.property.editing?.kind === 'override' && <p className="property-help">{props.property.editing.reason}</p>}
          {props.access === 'readonly' ? (
            <PropertyReadOnlyFields property={draft.property} />
          ) : (
            <PropertyEditorFields
              property={draft.property}
              originalName={props.originalName}
              frontmatter={props.frontmatter}
              access={props.access}
              onSave={props.onSave}
              update={draft.update}
              error={draft.error}
              submit={draft.submit}
              changeOptions={draft.changeOptions}
            />
          )}
        </>
      )}
    </Popup>
  );
}

function usePropertyEditorDraft(props: PropertyEditorProps) {
  const [property, setProperty] = useState(() => withListSettingType(props.property, listPropsOf(props.frontmatter)));
  const [optionRenames, setOptionRenames] = useState<readonly PropertyOptionRename[]>([]);
  const [error, setError] = useState('');
  const update = <Key extends keyof ComponentProperty>(key: Key, value: ComponentProperty[Key]) => {
    setProperty((previous) => ({ ...previous, [key]: value }));
    if (key === 'type') {
      // Free-form type edits have no reliable old-to-new option identity.
      setOptionRenames([]);
    }
    setError('');
  };
  const submit = (): void => {
    if (!/^[A-Za-z_$][\w$]*$/.test(property.name)) {
      setError('Use a name such as title, imageUrl, or isVisible.');
      return;
    }
    const change: PropertyChange =
      optionRenames.length > 0
        ? {
            kind: 'save',
            originalName: props.originalName,
            property,
            optionRenames,
          }
        : { kind: 'save', originalName: props.originalName, property };
    void props.onSave(change);
  };
  const changeOptions = (change: PropertyOptionChange): void => {
    const previous = property;
    const next = changePropertyOptions(previous, change.type, change.kind === 'draft' ? change.rename : undefined);
    const nextRenames = changePropertyOptionRenames(optionRenames, change);
    setProperty(next);
    setOptionRenames(nextRenames);
    setError('');
    if (change.kind === 'reorder' && props.originalName && nextRenames.length === 0) {
      void props
        .onCommit({
          kind: 'options',
          name: props.originalName,
          type: change.type,
        })
        .then((saved) => {
          if (!saved) {
            setProperty((current) => (current.type === change.type ? { ...current, type: previous.type } : current));
          }
        });
    }
  };
  return { property, error, update, submit, changeOptions };
}

interface PropertyEditorFieldsProps extends PropertyControls {
  readonly originalName: string;
  readonly frontmatter: string;
  readonly access: 'editable' | 'saving';
  readonly onSave: PropertyEditorProps['onSave'];
  readonly error: string;
  readonly submit: () => void;
  readonly changeOptions: (change: PropertyOptionChange) => void;
}
function PropertyEditorFields({ property, originalName, frontmatter, access, onSave, update, error, submit, changeOptions }: PropertyEditorFieldsProps) {
  const inherited = property.editing?.kind === 'override';
  const listFields = usePropertyListFields(property, frontmatter);
  return (
    <fieldset disabled={access === 'saving'}>
      <PropertyIdentity property={property} originalName={originalName} inherited={inherited} update={update} />
      <PropertyType
        property={property}
        frontmatter={frontmatter}
        onChange={(change) => {
          // Picking the kind it already is changes nothing, and keeps pending option renames.
          if (change.type !== property.type) {
            update('type', change.type);
          }
          if (change.description !== property.description) {
            update('description', change.description);
          }
          if (change.defaultValue !== property.defaultValue) {
            update('defaultValue', change.defaultValue);
          }
        }}
      />
      <PropertyOptions type={property.type} disabled={access === 'saving'} onChange={changeOptions} />
      <PropertyKindSettings key={`${property.type} settings`} property={property} onChange={(description) => update('description', description)} />
      {listFields !== undefined && <PropertyItemFields property={property} frontmatter={frontmatter} fields={listFields} update={update} />}
      {/* The same Required and Readonly the Settings panel's Property settings has (PropertySections.tsx). */}
      <PropertyFlagsFields
        required={property.required}
        readonly={property.readonly}
        onChange={(flags) => {
          if (flags.required !== property.required) {
            update('required', flags.required);
          }
          if (flags.readonly !== property.readonly) {
            update('readonly', flags.readonly);
          }
        }}
      />
      {listFields === undefined ? (
        <PropertyDefault key={property.type} property={property} frontmatter={frontmatter} onChange={(value) => update('defaultValue', value)} />
      ) : (
        // A list's default items are edited in the field an instance edits the list in, with its `{}` toggle.
        <ListDefaultField fields={listFields.fields} code={property.defaultValue} projectPath={undefined} onChange={(code) => update('defaultValue', code)} />
      )}
      <PropertyDefaultNote property={property} />
      <PropertyTooltip property={property} onChange={(description) => update('description', description)} />
      {error && <ErrorToast message={error} />}
      <PropertyActions originalName={originalName} removable={!inherited} onSave={onSave} submit={submit} />
    </fieldset>
  );
}

function PropertyActions({
  originalName,
  removable,
  onSave,
  submit,
}: {
  readonly originalName: string;
  readonly removable: boolean;
  readonly onSave: PropertyEditorProps['onSave'];
  readonly submit: () => void;
}) {
  return (
    <div className="property-actions">
      {originalName && removable && (
        <button
          className="danger"
          aria-label={`Delete ${originalName}`}
          title="Delete property"
          onClick={() => void onSave({ kind: 'remove', name: originalName })}
        >
          <TrashIcon size={14} />
        </button>
      )}
      <button className="primary" onClick={submit}>
        Save property
      </button>
    </div>
  );
}

interface PropertyControls {
  readonly property: ComponentProperty;
  readonly update: <Key extends keyof ComponentProperty>(key: Key, value: ComponentProperty[Key]) => void;
}
function PropertyIdentity({
  property,
  originalName,
  inherited,
  update,
}: PropertyControls & {
  readonly originalName: string;
  readonly inherited: boolean;
}) {
  return (
    <>
      <label>
        Name
        <input
          value={property.name}
          maxLength={PROPERTY_LIMITS.nameCharsMax}
          autoFocus={!inherited}
          disabled={inherited}
          onChange={(event) => update('name', event.target.value)}
        />
      </label>
      {originalName && originalName !== property.name && (
        <p className="property-help">Renaming updates this component’s prop references and its instances across the website.</p>
      )}
    </>
  );
}
/** A List's item fields as the editor shows them, and the type they were last read from or written as. */
interface ListFieldsDraft {
  readonly type: string;
  readonly fields: readonly ItemFieldDeclaration[];
}

// A List's item fields, read from its type (listFieldsOfType). While a name is
// being typed the fields can be invalid, and the type is only written once they
// are; the draft keeps what is on screen meanwhile. A type changed elsewhere —
// the Code type, the Kind — is read again.
function usePropertyListFields(
  property: ComponentProperty,
  frontmatter: string,
): (ListFieldsDraft & { readonly set: (draft: ListFieldsDraft) => void }) | undefined {
  const [draft, setDraft] = useState<ListFieldsDraft | undefined>(undefined);
  if (propertyKind(property) !== 'list') {
    return undefined;
  }
  if (draft !== undefined && draft.type === property.type) {
    return { ...draft, set: setDraft };
  }
  const fields = listFieldsOfType(property.type, frontmatter);
  return fields === undefined ? undefined : { type: property.type, fields, set: setDraft };
}

// The fields each item of a List has, edited with the Settings panel's own
// editor; the type is written as that form writes it (listTypeText).
function PropertyItemFields({
  property,
  frontmatter,
  fields,
  update,
}: PropertyControls & { readonly frontmatter: string; readonly fields: NonNullable<ReturnType<typeof usePropertyListFields>> }) {
  return (
    <ItemFieldsEditor
      fields={fields.fields}
      itemsText={property.defaultValue.trim() === '' ? '[]' : property.defaultValue}
      onChange={(shape) => {
        const valid = shape.fields.every((field) => fieldNameProblem(field.name) === undefined);
        const type = valid ? listTypeText(frontmatter, shape.fields) : property.type;
        fields.set({ type, fields: shape.fields });
        if (type !== property.type) {
          update('type', type);
        }
        if (shape.itemsText !== property.defaultValue) {
          update('defaultValue', shape.itemsText);
        }
      }}
    />
  );
}

function changePropertyOptions(property: ComponentProperty, type: string, rename?: PropertyOptionRename): ComponentProperty {
  if (rename && property.defaultValue.trim()) {
    const current = propertyDefaultText(property.defaultValue);
    const same = property.defaultValue.trim() === rename.from || (current !== undefined && current === propertyDefaultText(rename.from));
    if (same) {
      return { ...property, type, defaultValue: rename.to };
    }
  }
  return { ...property, type };
}

function changePropertyOptionRenames(current: readonly PropertyOptionRename[], change: PropertyOptionChange): readonly PropertyOptionRename[] {
  const options = literalOptions(change.type);
  assert(options !== undefined, 'Edited property options remain a literal union');
  const retained = current.filter((rename) => options.includes(rename.to));
  const rename = change.kind === 'draft' ? change.rename : undefined;
  if (!rename) {
    return retained;
  }
  const previous = retained.find((item) => item.to === rename.from);
  const from = previous?.from ?? rename.from;
  const withoutPrevious = retained.filter((rename) => rename !== previous);
  if (from === rename.to) {
    return withoutPrevious;
  }
  assert(withoutPrevious.length < PROPERTY_LIMITS.fieldsMax, 'Option rename count is bounded');
  return [...withoutPrevious, { from, to: rename.to }];
}
