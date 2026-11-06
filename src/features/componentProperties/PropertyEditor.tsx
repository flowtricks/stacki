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
import { useRef, useState, type ReactNode } from 'react';
import Popup from '../../ui/Popup';
import { assert } from '../../../shared/core/assert';
import type { ComponentProperties, ComponentProperty, PropertyChange, PropertyOptionRename } from '../../../shared/properties/propertyEditing';
import { PROPERTY_LIMITS } from '../../../shared/properties/propertyEditing';
import { listPropsOf, type ListProp } from '../../editor/listProps';
import { SETTING_PROP_TYPES } from '../../editor/optionsBinding';
import { fieldNameProblem, listFieldsOfType, listTypeText, type ItemFieldDeclaration } from '../../editor/listPropType';
import { ItemFieldsEditor, ListDefaultField, PropertyFlagsFields, type EditPace } from '../props/propBindings';
import { propertyProblem, usePropertyAutosave, type PropertySaveHost } from './propertyAutosave';
import { propertyKind } from './propertyKinds';

interface PropertyEditorProps {
  readonly property: ComponentProperty;
  readonly originalName: string;
  readonly frontmatter: string;
  readonly access: 'editable' | 'readonly' | 'saving';
  readonly onClose: () => void;
  /** Creates a new prop, or deletes this one; both close the form. */
  readonly onSave: (change: PropertyChange) => Promise<void>;
  /** Where an existing prop's edits save themselves. */
  readonly saveHost: PropertySaveHost;
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

/** Whether a property can be edited here, or only read: its declaration may be one only source can change. */
export function propertyIsEditable(property: ComponentProperty, data: Pick<ComponentProperties, 'advanced'>): boolean {
  return property.editing ? property.editing.kind !== 'restricted' : !data.advanced;
}

export function PropertyEditor(props: PropertyEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const draft = usePropertyEditorDraft(props);
  return (
    <Popup
      mode="popover"
      portal={false}
      className="property-editor"
      ref={editorRef}
      onClose={() => {
        draft.close();
        props.onClose();
      }}
      dismissible={props.access !== 'saving'}
    >
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
              form={draft}
              creating={props.originalName === ''}
              frontmatter={props.frontmatter}
              access={props.access}
              projectPath={undefined}
              actions={
                <PropertyActions
                  name={props.originalName === '' ? '' : draft.savedName}
                  removable={props.property.editing?.kind !== 'override'}
                  onRemove={(name) => {
                    draft.discard();
                    void props.onSave({ kind: 'remove', name });
                  }}
                  submit={draft.submit}
                />
              }
            />
          )}
        </>
      )}
    </Popup>
  );
}

/**
 * The same fields, for a host with its own chrome: a picker row's settings
 * (PropertySettingsDialog.tsx). They save themselves, so there are no buttons.
 */
export function PropertySettingsFields(props: {
  readonly property: ComponentProperty;
  readonly frontmatter: string;
  readonly projectPath: string | undefined;
  readonly saveHost: PropertySaveHost;
}) {
  const { property, frontmatter, projectPath, saveHost } = props;
  const draft = usePropertyEditorDraft({ property, originalName: property.name, frontmatter, onSave: async () => undefined, saveHost });
  return <PropertyEditorFields form={draft} creating={false} frontmatter={frontmatter} access="editable" projectPath={projectPath} actions={undefined} />;
}

function usePropertyEditorDraft(props: Pick<PropertyEditorProps, 'property' | 'originalName' | 'frontmatter' | 'onSave' | 'saveHost'>) {
  // The list setting's own type is written with the first save, not on opening.
  const [initial] = useState(() => ({ property: withListSettingType(props.property, listPropsOf(props.frontmatter)), optionRenames: [] }));
  const autosave = usePropertyAutosave(initial, props.originalName === '' ? undefined : props.saveHost);
  const { change, report } = autosave;
  const property = autosave.draft.property;
  const edit = (pace: EditPace, next: (current: ComponentProperty) => ComponentProperty): void => {
    change(pace, (current) => ({ ...current, property: next(current.property) }));
  };
  const update = <Key extends keyof ComponentProperty>(key: Key, value: ComponentProperty[Key], pace: EditPace = 'typing') => {
    change(pace, (current) => ({
      property: { ...current.property, [key]: value },
      // Free-form type edits have no reliable old-to-new option identity.
      optionRenames: key === 'type' ? [] : current.optionRenames,
    }));
  };
  // A new prop is written by its Save button; an existing one has none.
  const submit = (): void => {
    const problem = propertyProblem(property);
    if (problem !== undefined) {
      report({ error: problem, notice: '' });
      return;
    }
    void props.onSave({ kind: 'save', originalName: props.originalName, property });
  };
  const changeOptions = (optionChange: PropertyOptionChange): void => {
    const rename = optionChange.kind === 'draft' ? optionChange.rename : undefined;
    // Typing an option's words is typing; adding, removing and moving one is not.
    change(rename === undefined ? 'at-once' : 'typing', (current) => ({
      property: changePropertyOptions(current.property, optionChange.type, rename),
      optionRenames: changePropertyOptionRenames(current.optionRenames, optionChange),
    }));
  };
  return { ...autosave, property, edit, update, submit, changeOptions };
}

type PropertyForm = ReturnType<typeof usePropertyEditorDraft>;

interface PropertyEditorFieldsProps {
  readonly form: PropertyForm;
  /** A new prop saves from its button, and reports a problem as a toast; an existing one saves itself. */
  readonly creating: boolean;
  readonly frontmatter: string;
  readonly access: 'editable' | 'saving';
  /** The project, for the asset picker of a list's image fields. */
  readonly projectPath: string | undefined;
  /** The host's buttons, closing the form. */
  readonly actions: ReactNode;
}
function PropertyEditorFields({ form, creating, frontmatter, access, projectPath, actions }: PropertyEditorFieldsProps) {
  const { property, update, error, notice } = form;
  const inherited = property.editing?.kind === 'override';
  const listFields = usePropertyListFields(property, frontmatter);
  return (
    <fieldset disabled={access === 'saving'}>
      <PropertyIdentity form={form} creating={creating} inherited={inherited} />
      <PropertyType
        property={property}
        frontmatter={frontmatter}
        onChange={(change, pace) => {
          // Picking the kind it already is changes nothing, and keeps pending option renames.
          if (change.type === property.type) {
            form.edit(pace, (current) => ({ ...current, ...change }));
          } else {
            form.change(pace, (current) => ({ property: { ...current.property, ...change }, optionRenames: [] }));
          }
        }}
      />
      <PropertyOptions type={property.type} disabled={access === 'saving'} onChange={form.changeOptions} />
      <PropertyKindSettings key={`${property.type} settings`} property={property} onChange={(description) => update('description', description)} />
      {listFields !== undefined && <PropertyItemFields form={form} frontmatter={frontmatter} fields={listFields} />}
      {/* The same Required and Readonly the Settings panel's Property settings has (PropertySections.tsx). */}
      <PropertyFlagsFields
        required={property.required}
        readonly={property.readonly}
        onChange={(flags) => form.edit('at-once', (current) => ({ ...current, ...flags }))}
      />
      {listFields === undefined ? (
        <PropertyDefault key={property.type} property={property} frontmatter={frontmatter} onChange={(value, pace) => update('defaultValue', value, pace)} />
      ) : (
        // A list's default items are edited in the field an instance edits the list in, with its `{}` toggle.
        <ListDefaultField
          fields={listFields.fields}
          code={property.defaultValue}
          projectPath={projectPath}
          onChange={(code, pace) => update('defaultValue', code, pace)}
        />
      )}
      <PropertyDefaultNote property={property} />
      <PropertyTooltip property={property} onChange={(description) => update('description', description)} />
      {creating
        ? error && <ErrorToast message={error} />
        : error && (
            <p className="property-error" role="alert">
              {error}
            </p>
          )}
      {notice && (
        <p className="property-help" role="status">
          {notice}
        </p>
      )}
      {actions}
    </fieldset>
  );
}

// What closes the form: Delete for a prop that has one to lose, and Save for a
// new one, which has nothing on disk yet. An existing prop saves itself.
function PropertyActions({
  name,
  removable,
  onRemove,
  submit,
}: {
  readonly name: string;
  readonly removable: boolean;
  readonly onRemove: (name: string) => void;
  readonly submit: () => void;
}) {
  if (name === '') {
    return (
      <div className="property-actions">
        <span />
        <button className="primary" onClick={submit}>
          Save property
        </button>
      </div>
    );
  }
  if (!removable) {
    return undefined;
  }
  return (
    <div className="property-actions">
      <button className="danger" aria-label={`Delete ${name}`} title="Delete property" onClick={() => onRemove(name)}>
        <TrashIcon size={14} />
      </button>
    </div>
  );
}

function PropertyIdentity({ form, creating, inherited }: { readonly form: PropertyForm; readonly creating: boolean; readonly inherited: boolean }) {
  return (
    <>
      <label>
        Name
        <input
          value={form.nameText}
          maxLength={PROPERTY_LIMITS.nameCharsMax}
          autoFocus={!inherited}
          disabled={inherited}
          onChange={(event) => form.setName(event.target.value)}
          onBlur={form.commitName}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              form.commitName();
            }
          }}
        />
      </label>
      {!creating && form.savedName !== form.nameText && (
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
// editor; the type is written as that form writes it (listTypeText). A name
// being typed can be no name yet, and the default items already follow it, so
// the form is held until the field reads as one again.
function PropertyItemFields({
  form,
  frontmatter,
  fields,
}: {
  readonly form: PropertyForm;
  readonly frontmatter: string;
  readonly fields: NonNullable<ReturnType<typeof usePropertyListFields>>;
}) {
  const { property } = form;
  return (
    <ItemFieldsEditor
      fields={fields.fields}
      itemsText={property.defaultValue.trim() === '' ? '[]' : property.defaultValue}
      onChange={(shape, pace) => {
        const valid = shape.fields.every((field) => fieldNameProblem(field.name) === undefined);
        const type = valid ? listTypeText(frontmatter, shape.fields) : property.type;
        fields.set({ type, fields: shape.fields });
        form.hold(valid ? 'free' : 'held');
        form.edit(pace, (current) => ({ ...current, type, defaultValue: shape.itemsText }));
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
