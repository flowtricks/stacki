import PropertyReadOnlyFields from './PropertyReadOnlyFields';
import { PropertyConditions, PropertyDeclarationInfo } from './PropertyDeclarationInfo';
import { TrashIcon } from '../ui/Icons';
import { PropertyOptions } from './PropertyOptions';
import type { PropertyOptionChange } from './PropertyOptions';
import { PropertyType } from './PropertyType';
import { PropertyDefault, propertyDefaultText } from './PropertyDefault';
import { literalOptions } from '../propertyOptions';
export { literalOptions };
import { useRef, useState } from 'react';
import useDismiss from '../ui/useDismiss';
import { assert } from '../../shared/assert';
import type {
  ComponentProperty,
  PropertyChange,
  PropertyOptionRename,
} from '../../shared/component-properties';
import { PROPERTY_LIMITS } from '../../shared/component-properties';

interface PropertyEditorProps {
  readonly property: ComponentProperty;
  readonly originalName: string;
  readonly frontmatter: string;
  readonly access: 'editable' | 'readonly' | 'saving';
  readonly onClose: () => void;
  readonly onSave: (change: PropertyChange) => Promise<void>;
  readonly onCommit: (change: PropertyChange) => Promise<boolean>;
}
export function PropertyEditor(props: PropertyEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  useDismiss(editorRef, props.access !== 'saving', props.onClose);
  const draft = usePropertyEditorDraft(props);
  return (
    <div className="property-editor" ref={editorRef}>
      <header>
        <div className="property-editor-title">
          <strong>{props.originalName ? 'Property settings' : 'New property'}</strong>
          <PropertyDeclarationInfo property={props.property} />
        </div>
        <button
          aria-label="Close property settings"
          disabled={props.access === 'saving'}
          onClick={props.onClose}
        >
          ×
        </button>
      </header>
      <PropertyConditions property={props.property} />
      {props.property.editing?.kind === 'override' && (
        <p className="property-help">{props.property.editing.reason}</p>
      )}
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
    </div>
  );
}

function usePropertyEditorDraft(props: PropertyEditorProps) {
  const [property, setProperty] = useState(props.property);
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
    const next = changePropertyOptions(
      previous,
      change.type,
      change.kind === 'draft' ? change.rename : undefined
    );
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
            setProperty((current) =>
              current.type === change.type ? { ...current, type: previous.type } : current
            );
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
function PropertyEditorFields({
  property,
  originalName,
  frontmatter,
  access,
  onSave,
  update,
  error,
  submit,
  changeOptions,
}: PropertyEditorFieldsProps) {
  const inherited = property.editing?.kind === 'override';
  return (
    <fieldset disabled={access === 'saving'}>
      <PropertyIdentity
        property={property}
        originalName={originalName}
        inherited={inherited}
        update={update}
      />
      <PropertyType type={property.type} onChange={(type) => update('type', type)} />
      <PropertyOptions
        type={property.type}
        disabled={access === 'saving'}
        onChange={changeOptions}
      />
      <PropertyFlags property={property} update={update} />
      <PropertyDefault
        key={property.type}
        property={property}
        frontmatter={frontmatter}
        onChange={(value) => update('defaultValue', value)}
      />
      <label>
        Tooltip
        <textarea
          value={property.description}
          rows={5}
          maxLength={PROPERTY_LIMITS.textCharsMax}
          placeholder="Describe how to use this property…"
          onChange={(event) => update('description', event.target.value)}
        />
      </label>
      {error && (
        <p role="alert" className="property-error">
          {error}
        </p>
      )}
      <PropertyActions
        originalName={originalName}
        removable={!inherited}
        onSave={onSave}
        submit={submit}
      />
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
  readonly update: <Key extends keyof ComponentProperty>(
    key: Key,
    value: ComponentProperty[Key]
  ) => void;
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
        <p className="property-help">
          Renaming updates this component’s prop references and its instances across the website.
        </p>
      )}
    </>
  );
}
function PropertyFlags({ property, update }: PropertyControls) {
  return (
    <div className="property-flags">
      <label>
        <input
          type="checkbox"
          checked={property.required}
          onChange={(event) => update('required', event.target.checked)}
        />
        Required
      </label>
      <label>
        <input
          type="checkbox"
          checked={property.readonly}
          onChange={(event) => update('readonly', event.target.checked)}
        />
        Readonly
      </label>
    </div>
  );
}

function changePropertyOptions(
  property: ComponentProperty,
  type: string,
  rename?: PropertyOptionRename
): ComponentProperty {
  if (rename && property.defaultValue.trim()) {
    const current = propertyDefaultText(property.defaultValue);
    const same =
      property.defaultValue.trim() === rename.from ||
      (current !== undefined && current === propertyDefaultText(rename.from));
    if (same) {
      return { ...property, type, defaultValue: rename.to };
    }
  }
  return { ...property, type };
}

function changePropertyOptionRenames(
  current: readonly PropertyOptionRename[],
  change: PropertyOptionChange
): readonly PropertyOptionRename[] {
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
