import { useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import { ErrorToast } from '../../ui/ErrorToast';
import PropertyReadOnlyFields from './PropertyReadOnlyFields';
import { PropertyConditions, PropertyDeclarationInfo } from './PropertyDeclarationInfo';
import { TrashIcon } from '../../ui/Icons';
import { PropertyOptions } from './PropertyOptions';
import { PropertyShareNotice, shareRenameFiles } from './PropertyShareNotice';
import type { PropertyOptionChange } from './PropertyOptions';
import { PropertyType, opensOnCode, type CodeMode } from './PropertyType';
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
import { fieldsProblem, type ItemFieldDeclaration } from '../../editor/itemFields';
import { listFieldsOfType, listTypeText } from '../../editor/listPropType';
import { ItemFieldsEditor, ListDefaultField, PropertyFlagsFields, type EditPace } from '../props/propBindings';
import { propertyProblem, usePropertyAutosave, type PropertySaveHost } from './propertyAutosave';
import { propertyKind } from './propertyKinds';

interface PropertyEditorProps {
  readonly property: ComponentProperty;
  readonly originalName: string;
  readonly frontmatter: string;
  readonly access: 'editable' | 'readonly' | 'saving';
  readonly onClose: () => void;
  /**
   * Creates a new prop, or deletes this one, and says whether it was done. A
   * deletion closes the form; a creation goes on to `after`: the form stays
   * open on the new prop, which saves itself from then on, or it closes.
   */
  readonly onSave: (change: PropertyChange, after: 'edit' | 'close') => Promise<boolean>;
  /** Where an existing prop's edits save themselves. */
  readonly saveHost: PropertySaveHost;
  /** Opens a project file, named project-relative: a shared prop's declaration and users. */
  readonly onOpenFile?: ((path: string) => void) | undefined;
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
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
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
        // A new prop with a name that can be written is created as the form closes, as an existing one saves.
        if (props.originalName === '' && draft.ready()) {
          draft.submit('close');
        }
        props.onClose();
      }}
      dismissible={props.access !== 'saving'}
    >
      {({ close }) => (
        <>
          <header>
            <div className="property-editor-title">
              <strong>{draft.exists ? translate('componentProps.dialog.title') : translate('componentProps.editor.newProperty')}</strong>
              <PropertyDeclarationInfo property={props.property} />
            </div>
            <button aria-label={translate('componentProps.dialog.close')} disabled={props.access === 'saving'} onClick={close}>
              ×
            </button>
          </header>
          <PropertyConditions property={props.property} />
          <PropertyShareNotice property={props.property} onOpenFile={props.onOpenFile} />
          {props.property.editing?.kind === 'override' && (
            <p className="property-help">{translateDescribed({ message: props.property.editing.reason, messageRef: props.property.editing.reasonRef })}</p>
          )}
          {props.access === 'readonly' ? (
            <PropertyReadOnlyFields property={draft.property} />
          ) : (
            <PropertyEditorFields
              form={draft}
              creating={!draft.exists}
              frontmatter={props.frontmatter}
              access={props.access}
              projectPath={undefined}
              actions={
                <PropertyActions
                  name={draft.exists ? draft.savedName : ''}
                  // A shared prop is deleted from its type's file, in source.
                  removable={props.property.editing?.kind !== 'override' && props.property.shared === undefined}
                  onRemove={(name) => {
                    draft.discard();
                    void props.onSave({ kind: 'remove', name }, 'close');
                  }}
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
  const draft = usePropertyEditorDraft({ property, originalName: property.name, frontmatter, onSave: async () => false, saveHost });
  // An existing prop has nothing to create.
  assert(property.name !== '', 'PropertySettingsFields: the prop exists');
  return <PropertyEditorFields form={draft} creating={false} frontmatter={frontmatter} access="editable" projectPath={projectPath} actions={undefined} />;
}

function usePropertyEditorDraft(props: Pick<PropertyEditorProps, 'property' | 'originalName' | 'frontmatter' | 'onSave' | 'saveHost'>) {
  const translate = useTranslate();
  // The list setting's own type is written with the first save, not on opening.
  const [initial] = useState(() => ({ property: withListSettingType(props.property, listPropsOf(props.frontmatter)), optionRenames: [] }));
  // A new prop saves nothing itself until it exists (submit, below).
  const [exists, setExists] = useState(props.originalName !== '');
  const autosave = usePropertyAutosave(initial, exists ? props.saveHost : undefined);
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
  // A new prop is created once its name is committed and can be written (or as
  // the form closes); after that it is an existing prop, which saves itself.
  // There is no Save button.
  // Enter and the blur after it would both create it; the first one does.
  const creating = useRef<'new' | 'sending' | 'created'>(props.originalName === '' ? 'new' : 'created');
  const ready = (): boolean => creating.current === 'new' && property.name.trim() !== '' && propertyProblem(property, translate) === undefined;
  const submit = (after: 'edit' | 'close'): void => {
    assert(props.originalName === '', 'submit: only a new prop is created');
    if (creating.current !== 'new') {
      return;
    }
    const problem = propertyProblem(property, translate);
    if (problem !== undefined) {
      report({ error: problem, notice: '' });
      return;
    }
    creating.current = 'sending';
    const sent = property;
    void props.onSave({ kind: 'save', originalName: '', property: sent }, after).then((done) => {
      if (!done) {
        // A refused create can be tried again.
        creating.current = 'new';
        return;
      }
      creating.current = 'created';
      if (after === 'edit') {
        // The form stays where it is, so nothing typed meanwhile is lost; it saves itself from here.
        setExists(true);
        autosave.adopt({ ...sent, editing: { kind: 'editable' } }, props.saveHost);
      }
    });
  };
  const changeOptions = (optionChange: PropertyOptionChange): void => {
    const rename = optionChange.kind === 'draft' ? optionChange.rename : undefined;
    // Typing an option's words is typing; adding, removing and moving one is not.
    change(rename === undefined ? 'at-once' : 'typing', (current) => ({
      property: changePropertyOptions(current.property, optionChange.type, rename),
      optionRenames: changePropertyOptionRenames(current.optionRenames, optionChange),
    }));
  };
  return { ...autosave, property, exists, edit, update, ready, submit, changeOptions };
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
  const code = usePropertyCodeMode(property);
  return (
    <fieldset disabled={access === 'saving'}>
      <PropertyIdentity form={form} creating={creating} inherited={inherited} />
      <PropertyType
        property={property}
        frontmatter={frontmatter}
        code={code.mode}
        optionsHoldCode={code.optionsHoldCode}
        onChange={(change, pace) => {
          // Picking the kind it already is changes nothing, and keeps pending option renames.
          if (change.type === property.type) {
            form.edit(pace, (current) => ({ ...current, ...change }));
          } else {
            form.change(pace, (current) => ({ property: { ...current.property, ...change }, optionRenames: [] }));
          }
        }}
      />
      {code.optionsHoldCode && (
        <PropertyOptions
          type={property.type}
          disabled={access === 'saving'}
          code={code.mode}
          onChange={form.changeOptions}
          onTypeChange={(type) => form.change('typing', (current) => ({ property: { ...current.property, type }, optionRenames: [] }))}
        />
      )}
      <PropertyKindSettings key={`${property.type} settings`} property={property} onChange={(description) => update('description', description)} />
      {listFields !== undefined && <PropertyItemFields form={form} frontmatter={frontmatter} fields={listFields} />}
      {/* The same Required the Settings panel's Property settings has (PropertySections.tsx); readonly is kept as read. */}
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

// The one `{}` switch between the type's controls and its code. It sits beside
// Options for a prop that has them, else beside Kind; while the code is open it
// stays where it was opened, so typing a union that stops being options does
// not move the field from under the cursor.
function usePropertyCodeMode(property: ComponentProperty): { readonly mode: CodeMode; readonly optionsHoldCode: boolean } {
  const [state, setState] = useState(() => ({ open: opensOnCode(property), place: placeOf(property.type) }));
  const optionsHoldCode = state.open ? state.place === 'options' : placeOf(property.type) === 'options';
  return {
    mode: { open: state.open, setOpen: (open) => setState({ open, place: placeOf(property.type) }) },
    optionsHoldCode,
  };
}

function placeOf(type: string): 'kind' | 'options' {
  return literalOptions(type) === undefined ? 'kind' : 'options';
}

// Delete, for a prop that has one to lose. Nothing here saves: an existing prop
// saves itself, and a new one is created when its name is committed.
function PropertyActions({ name, removable, onRemove }: { readonly name: string; readonly removable: boolean; readonly onRemove: (name: string) => void }) {
  const translate = useTranslate();
  if (name === '' || !removable) {
    return undefined;
  }
  return (
    <div className="property-actions">
      <button
        className="danger"
        aria-label={translate('componentProps.editor.deleteNamed', { name })}
        title={translate('componentProps.editor.delete')}
        onClick={() => onRemove(name)}
      >
        <TrashIcon size={14} />
      </button>
    </div>
  );
}

function PropertyIdentity({ form, creating, inherited }: { readonly form: PropertyForm; readonly creating: boolean; readonly inherited: boolean }) {
  const translate = useTranslate();
  return (
    <>
      <label>
        {translate('componentProps.editor.name')}
        <input
          value={form.nameText}
          maxLength={PROPERTY_LIMITS.nameCharsMax}
          autoFocus={!inherited}
          disabled={inherited}
          onChange={(event) => form.setName(event.target.value)}
          onBlur={() => commit(form, { creating })}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit(form, { creating });
            }
          }}
        />
      </label>
      {form.nameError !== '' && (
        <p className="property-error" role="alert">
          {form.nameError}
        </p>
      )}
      {!creating && form.nameError === '' && form.savedName !== form.nameText && <RenameHelp property={form.property} />}
    </>
  );
}
// Committing the name: a new prop is created with it, when it can be written;
// an existing one renames.
function commit(form: PropertyForm, { creating }: { readonly creating: boolean }): void {
  if (!creating) {
    form.commitName();
    return;
  }
  if (form.property.name.trim() === '') {
    return;
  }
  form.submit('edit');
}

// What a rename rewrites. A shared prop's reaches every file its type does, so they are listed before it is applied.
function RenameHelp({ property }: { readonly property: ComponentProperty }) {
  const translate = useTranslate();
  const share = property.shared;
  if (share === undefined) {
    return <p className="property-help">{translate('componentProps.editor.renameHelp')}</p>;
  }
  return (
    <div className="property-help" role="status">
      {translate('componentProps.editor.renameShared', { typeName: share.typeName })}
      <ul className="property-rename-files">
        {shareRenameFiles(share).map((file) => (
          <li key={file}>{file}</li>
        ))}
      </ul>
    </div>
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
        const valid = fieldsProblem(shape.fields) === undefined;
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
