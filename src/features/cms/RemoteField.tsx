// One connected-CMS field, drawn as a component prop field (CmsPropField.tsx):
// text, numbers, switches, choices and slugs are prop fields outright; any other
// kind keeps its own control (RemoteValueEditor.tsx) under the same label row.
// The label turns blue once the field holds something, and carries an asterisk
// when the CMS requires it; its help is the `?` beside it; a broken rule shows
// under the control, red when it blocks publishing and amber when it only warns.
import {
  remoteObject,
  type RemoteSchemaField,
  type RemoteType,
  type RemoteValue,
} from '../../../shared/properties/cmsRemoteSchema';
import { CmsFieldFrame, CmsPropField, type CmsScalar, type CmsScalarKind } from './CmsPropField';
import { fieldTypeOf } from './remoteFieldTypes';
import { problemsOf } from './remoteValidation';
import { fieldTitle, isEmptyValue } from './remoteValues';
import { RemoteValueEditor, type RemoteEditContext } from './RemoteValueEditor';

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
    <div
      className={`remote-cms-field${field.required ? ' is-required' : ''}`}
      data-kind={field.type.kind}
    >
      {scalar ? (
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
          <RemoteValueEditor
            type={field.type}
            label={name}
            value={value}
            context={props.context}
            onChange={props.onChange}
          />
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
    <div
      className="remote-cms-group"
      style={
        props.columns
          ? { gridTemplateColumns: `repeat(${props.columns}, minmax(0, 1fr))` }
          : undefined
      }
    >
      {props.fields.map((field) => (
        <RemoteField
          key={field.name}
          field={field}
          value={object[field.name]}
          context={context}
          onChange={(next) => change(field.name, next)}
        />
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
        write: (value) =>
          value === undefined ? undefined : { _type: 'slug', current: String(value) },
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
