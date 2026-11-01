// One connected-CMS field, drawn as a component prop field (CmsPropField.tsx):
// text, numbers, switches, choices and slugs are prop fields outright; any other
// kind keeps its own control (RemoteValueEditor.tsx) under the same label row.
// The label turns blue once the field holds something, and carries an asterisk
// when the CMS requires it; its help is the `?` beside it; a broken rule shows
// under the control, red when it blocks publishing and amber when it only warns.
// A field the Studio locks (`readOnly`) shows its value without a control.
import {
  isLocked,
  remoteObject,
  type RemoteOption,
  type RemoteSchemaField,
  type RemoteType,
  type RemoteValue,
} from '../../../shared/properties/cmsRemoteSchema';
import { CmsFieldFrame, CmsPropField, type CmsScalar, type CmsScalarKind } from './CmsPropField';
import { fieldTypeOf } from './remoteFieldTypes';
import { problemsOf } from './remoteValidation';
import { fieldTitle, isEmptyValue } from './remoteValues';
import { RemoteValueEditor, type RemoteEditContext } from './RemoteValueEditor';
import AssetField from '../../ui/AssetField';
import Dropdown from '../../ui/Dropdown';
import { hasOptionImage, OPTION_IMAGE_MENU, OptionImage } from './projectImages';
import { ReferenceIcon, referenceTitle, useReferenceOptions } from './RemoteReferenceInput';
import { typeIcons } from './SanityTypeIcon';

export function RemoteField(props: {
  readonly field: RemoteSchemaField;
  readonly value: RemoteValue | undefined;
  readonly context: RemoteEditContext;
  readonly onChange: (value: RemoteValue | undefined) => void;
}) {
  const { field, value } = props;
  const name = fieldTitle(field);
  const help = field.description;
  const scalar = scalarOf(field.type);
  const { icon: Icon } = fieldTypeOf(field.type);
  return (
    <div className={`remote-cms-field${field.required ? ' is-required' : ''}`} data-kind={field.type.kind}>
      {isLocked(field, value) ? (
        <CmsFieldFrame name={name} help={lockedHelp(field)} icon={<Icon size={12} />} set={!isEmptyValue(value)}>
          <LockedValue type={field.type} value={value} context={props.context} />
        </CmsFieldFrame>
      ) : isImagePath(field.type) ? (
        <CmsFieldFrame name={name} help={help} icon={<Icon size={12} />} set={!isEmptyValue(value)}>
          <ImagePathField value={value} context={props.context} onChange={props.onChange} />
        </CmsFieldFrame>
      ) : titledOptions(field.type) ? (
        <CmsFieldFrame name={name} help={help} icon={<Icon size={12} />} set={!isEmptyValue(value)}>
          <TitledChoice label={name} options={titledOptions(field.type) ?? []} value={value} onChange={props.onChange} />
        </CmsFieldFrame>
      ) : scalar ? (
        <CmsPropField
          name={name}
          help={help}
          kind={scalar.kind}
          options={scalar.options}
          value={scalar.read(value)}
          onChange={(next) => props.onChange(scalar.write(next))}
        />
      ) : (
        <CmsFieldFrame name={name} help={help} icon={<Icon size={12} />} set={!isEmptyValue(value)}>
          <RemoteValueEditor type={field.type} label={name} value={value} context={props.context} onChange={props.onChange} />
        </CmsFieldFrame>
      )}
      {/* Required is the label's asterisk; Publish still waits for it (remoteValidation.ts). */}
      {problemsOf(field, value)
        .filter((problem) => problem.message !== 'Required')
        .map((problem) => (
          <span key={problem.message} className={`remote-cms-problem is-${problem.level}`}>
            {problem.message}
          </span>
        ))}
    </div>
  );
}

// Why the field takes no edit, after what it is for.
function lockedHelp(field: RemoteSchemaField): string {
  const why = field.readOnly === 'when-set' ? 'Set once: the Studio locks it after it is chosen.' : 'Read-only in the Studio.';
  return field.description === '' ? why : `${field.description} ${why}`;
}

// A locked field's value as it reads: a reference by its document, a simple
// value as text, anything larger as its own control with every input disabled.
function LockedValue(props: { readonly type: RemoteType; readonly value: RemoteValue | undefined; readonly context: RemoteEditContext }) {
  const { type, value } = props;
  if (type.kind === 'reference') {
    return <LockedReference to={type.to} value={value} context={props.context} />;
  }
  const scalar = scalarOf(type);
  if (scalar !== undefined) {
    const read = scalar.read(value);
    const option = type.kind === 'string' ? type.options.find((entry) => entry.value === read) : undefined;
    const text = option?.title ?? (typeof read === 'boolean' ? (read ? 'Yes' : 'No') : String(read ?? ''));
    return <div className="remote-cms-locked">{text === '' ? <span className="remote-cms-locked-empty">Empty</span> : text}</div>;
  }
  return (
    <fieldset className="remote-cms-locked-control" disabled>
      <RemoteValueEditor type={type} label="" value={value} context={props.context} onChange={() => undefined} />
    </fieldset>
  );
}

function LockedReference(props: { readonly to: readonly string[]; readonly value: RemoteValue | undefined; readonly context: RemoteEditContext }) {
  const options = useReferenceOptions(props.context, props.to);
  const id = remoteObject(props.value)?.['_ref'];
  const option = options.find((entry) => entry.id === id);
  return (
    <div className="remote-cms-locked">
      {option && <ReferenceIcon option={option} sanity={typeIcons(props.context.connectionId).get(option.type)} placeholder={false} />}
      {referenceTitle(props.value, options)}
    </div>
  );
}

// A choice whose options have titles of their own (a reference by id, a
// schema's `{ title, value }` list) shows the titles; a plain list shows its values.
function titledOptions(type: RemoteType): readonly RemoteOption[] | undefined {
  if (type.kind !== 'string') {
    return undefined;
  }
  return type.options.some((option) => option.title !== option.value) ? type.options : undefined;
}

function TitledChoice(props: {
  readonly label: string;
  readonly options: readonly RemoteOption[];
  readonly value: RemoteValue | undefined;
  readonly onChange: (value: RemoteValue | undefined) => void;
}) {
  const current = typeof props.value === 'string' ? props.value : '';
  // A value the list does not hold (a removed record) still shows, as itself.
  const known = props.options.some((option) => option.value === current);
  const pictures = hasOptionImage(props.options);
  const options = [
    { value: '', label: 'None' },
    ...(known || current === '' ? [] : [{ value: current, label: current, dim: true }]),
    ...props.options.map((option) => ({
      value: option.value,
      label: option.title,
      icon: <OptionImage file={option.imageFile} placeholder={pictures} />,
    })),
  ];
  return (
    <Dropdown
      value={current}
      // Choosing is a click: hovering a choice must not save it.
      livePreview={false}
      ariaLabel={props.label}
      placeholder={`Choose ${props.label.toLowerCase()}…`}
      searchable={props.options.length > 8}
      searchPlaceholder="Search…"
      menuClassName={pictures ? OPTION_IMAGE_MENU : ''}
      options={options}
      onChange={(next) => props.onChange(next === '' ? undefined : next)}
    />
  );
}

function isImagePath(type: RemoteType): boolean {
  return type.kind === 'string' && type.asset === 'image';
}

// A project image named by its path (an Astro `image()`): a preview, and a
// button that asks the Assets panel for another, as local CMS images do. The
// path is written relative to the entry's own file, as Astro resolves it.
function ImagePathField(props: {
  readonly value: RemoteValue | undefined;
  readonly context: RemoteEditContext;
  readonly onChange: (value: RemoteValue | undefined) => void;
}) {
  return (
    <AssetField
      value={typeof props.value === 'string' ? props.value : ''}
      mediaKind="image"
      showModeToggle={false}
      // In a pop-up, so the entry stays open while its image is chosen.
      pickPresentation="overlay"
      projectPath={props.context.projectPath}
      baseDir={props.context.folder}
      onChange={(next) => props.onChange(next === '' ? undefined : next)}
    />
  );
}

/** A group's fields, each one a RemoteField, written back into the group whole. */
export function RemoteObjectEditor(props: {
  readonly fields: readonly RemoteSchemaField[];
  readonly typeName: string | undefined;
  /** Side by side, as the schema's `options.columns` lays them out. */
  readonly columns?: number | undefined;
  readonly value: RemoteValue | undefined;
  readonly context: RemoteEditContext;
  readonly onChange: (value: RemoteValue | undefined) => void;
}) {
  const object = remoteObject(props.value) ?? {};
  const context = { ...props.context, depth: props.context.depth + 1 };
  const change = (name: string, next: RemoteValue | undefined) => {
    const rest = Object.fromEntries(Object.entries(object).filter(([key]) => key !== name));
    const typed = props.typeName && props.typeName !== 'object' ? { _type: props.typeName } : {};
    props.onChange({ ...typed, ...rest, ...(next === undefined ? {} : { [name]: next }) });
  };
  return (
    <div className="remote-cms-group" style={props.columns ? { gridTemplateColumns: `repeat(${props.columns}, minmax(0, 1fr))` } : undefined}>
      {props.fields.map((field) => (
        <RemoteField key={field.name} field={field} value={object[field.name]} context={context} onChange={(next) => change(field.name, next)} />
      ))}
    </div>
  );
}

interface Scalar {
  readonly kind: CmsScalarKind;
  readonly options: readonly string[];
  readonly read: (value: RemoteValue | undefined) => CmsScalar | undefined;
  readonly write: (value: CmsScalar | undefined) => RemoteValue | undefined;
}

const asText = (value: RemoteValue | undefined) => (typeof value === 'string' ? value : undefined);
const same = (value: CmsScalar | undefined): RemoteValue | undefined => value;

// The kinds a prop field holds outright, and how each reads and writes its value.
function scalarOf(type: RemoteType): Scalar | undefined {
  switch (type.kind) {
    case 'string':
    case 'url':
    case 'email':
      return {
        kind: 'string',
        options: type.options.map((option) => option.value),
        read: asText,
        write: same,
      };
    case 'text':
      return { kind: 'text', options: [], read: asText, write: same };
    case 'number':
      return {
        kind: 'number',
        options: [],
        read: (value) => (typeof value === 'number' ? value : undefined),
        write: same,
      };
    case 'boolean':
      return {
        kind: 'boolean',
        options: [],
        read: (value) => (typeof value === 'boolean' ? value : undefined),
        write: same,
      };
    case 'slug':
      // Stored as `{ _type: "slug", current }`; the field edits `current`.
      return {
        kind: 'string',
        options: [],
        read: (value) => asText(remoteObject(value)?.['current']),
        write: (value) => (value === undefined ? undefined : { _type: 'slug', current: String(value) }),
      };
    case 'date':
    case 'datetime':
    case 'geopoint':
    case 'object':
    case 'image':
    case 'file':
    case 'reference':
    case 'array':
    case 'richText':
      return undefined;
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}
