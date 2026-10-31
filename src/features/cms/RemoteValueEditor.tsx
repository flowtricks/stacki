// The control for one connected-CMS value, by its type (cmsRemoteSchema.ts).
// Every type is editable here: text, numbers, switches, dates and options in
// place; a group or a location opens into its own fields; lists, images, files,
// references and rich text have their own editors beside this one. A control
// reports the field's whole new value — `undefined` when emptied — and the field
// above it decides when to save (RemoteFieldInput.tsx).
import { useRef } from 'react';
import { assert } from '../../../shared/core/assert';
import {
  REMOTE_SCHEMA_LIMITS,
  remoteObject,
  type RemoteOption,
  type RemoteType,
  type RemoteValue,
} from '../../../shared/properties/cmsRemoteSchema';
import type { RemoteAsset } from '../../../shared/properties/cmsRemote';
import AutoTextarea from '../../ui/AutoTextarea';
import CalendarField from '../../ui/DateField';
import Dropdown from '../../ui/Dropdown';
import HtmlField from '../../ui/HtmlField';
import { RemoteObjectEditor } from './RemoteField';
import { remoteKey } from './remoteValues';
import { htmlPortableText, portableTextHTML } from './portableText';
import { RemoteListEditor } from './RemoteListEditor';
import { RemoteAssetInput } from './RemoteAssetInput';
import { RemoteReferenceInput } from './RemoteReferenceInput';

/** What every control below a document's field can reach. */
export interface RemoteEditContext {
  readonly projectPath: string;
  readonly connectionId: string;
  /** Stored images and files by asset id, including ones uploaded since the load. */
  readonly assets: ReadonlyMap<string, RemoteAsset>;
  readonly addAsset: (asset: RemoteAsset) => void;
  readonly depth: number;
}

export interface RemoteValueProps {
  readonly type: RemoteType;
  readonly label: string;
  readonly value: RemoteValue | undefined;
  readonly context: RemoteEditContext;
  readonly onChange: (value: RemoteValue | undefined) => void;
}

export function RemoteValueEditor(props: RemoteValueProps) {
  const { type, value, onChange } = props;
  assert(props.context.depth <= REMOTE_SCHEMA_LIMITS.valueDepthMax, 'Editors nest boundedly');
  switch (type.kind) {
    case 'string':
    case 'url':
    case 'email':
    case 'text':
    case 'slug':
      return (
        <TextControl
          {...props}
          kind={type.kind}
          options={type.kind === 'string' ? type.options : []}
        />
      );
    case 'number':
      return <NumberControl value={value} onChange={onChange} />;
    case 'boolean':
      return <SwitchControl on={value === true} onChange={onChange} />;
    case 'date':
      return (
        <CalendarField
          value={typeof value === 'string' ? value : ''}
          label={props.label}
          onChange={(next) => onChange(next || undefined)}
        />
      );
    case 'datetime':
      return <DateTimeControl value={value} onChange={onChange} />;
    case 'geopoint':
      return <GeopointControl value={value} onChange={onChange} />;
    case 'object':
      return (
        <RemoteObjectEditor
          fields={type.fields}
          typeName={type.name}
          columns={type.columns}
          value={value}
          context={props.context}
          onChange={onChange}
        />
      );
    case 'image':
    case 'file':
      return (
        <RemoteAssetInput
          {...props}
          kind={type.kind}
          fields={type.kind === 'image' ? type.fields : []}
        />
      );
    case 'reference':
      return <RemoteReferenceInput {...props} to={type.to} />;
    case 'array':
      return <RemoteListEditor {...props} of={type.of} />;
    case 'richText':
      return <RichTextControl value={value} label={props.label} onChange={onChange} />;
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

function TextControl(
  props: RemoteValueProps & {
    readonly kind: 'string' | 'url' | 'email' | 'text' | 'slug';
    readonly options: readonly RemoteOption[];
  },
) {
  const { kind, value, onChange } = props;
  // A slug is stored as `{ _type: "slug", current }`; the control edits `current`.
  const text = kind === 'slug' ? remoteObject(value)?.['current'] : value;
  const shown = typeof text === 'string' ? text : '';
  const emit = (next: string) => {
    if (next === '') {
      onChange(undefined);
    } else {
      onChange(kind === 'slug' ? { _type: 'slug', current: next } : next);
    }
  };
  if (props.options.length > 0) {
    return (
      <Dropdown
        value={shown}
        placeholder="Choose…"
        options={props.options.map((option) => ({ value: option.value, label: option.title }))}
        onChange={emit}
      />
    );
  }
  if (kind === 'text') {
    return (
      <AutoTextarea value={shown} minRows={3} onChange={(event) => emit(event.target.value)} />
    );
  }
  return (
    <input
      value={shown}
      type={kind === 'url' ? 'url' : kind === 'email' ? 'email' : 'text'}
      spellCheck={kind === 'string'}
      maxLength={REMOTE_SCHEMA_LIMITS.valueCharsMax}
      onChange={(event) => emit(event.target.value)}
    />
  );
}

function NumberControl(props: {
  readonly value: RemoteValue | undefined;
  readonly onChange: (value: RemoteValue | undefined) => void;
}) {
  return (
    <input
      type="number"
      value={typeof props.value === 'number' ? String(props.value) : ''}
      onChange={(event) => {
        const text = event.target.value;
        const next = Number(text);
        if (text === '') {
          props.onChange(undefined);
        } else if (Number.isFinite(next)) {
          props.onChange(next);
        }
      }}
    />
  );
}

function SwitchControl(props: {
  readonly on: boolean;
  readonly onChange: (value: RemoteValue | undefined) => void;
}) {
  return (
    <button
      type="button"
      className={`cms-toggle ${props.on ? 'on' : ''}`}
      onClick={() => props.onChange(!props.on)}
    >
      <span className="cms-toggle-knob" />
      <span className="cms-toggle-label">{props.on ? 'On' : 'Off'}</span>
    </button>
  );
}

// A Sanity datetime is an ISO instant; it is shown and chosen in local time.
function DateTimeControl(props: {
  readonly value: RemoteValue | undefined;
  readonly onChange: (value: RemoteValue | undefined) => void;
}) {
  return (
    <input
      type="datetime-local"
      value={typeof props.value === 'string' ? localDateTime(props.value) : ''}
      onChange={(event) => {
        const local = event.target.value;
        const instant = new Date(local);
        if (local === '') {
          props.onChange(undefined);
        } else if (!Number.isNaN(instant.getTime())) {
          props.onChange(instant.toISOString());
        }
      }}
    />
  );
}

export function localDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function GeopointControl(props: {
  readonly value: RemoteValue | undefined;
  readonly onChange: (value: RemoteValue | undefined) => void;
}) {
  const point = remoteObject(props.value) ?? {};
  const change = (axis: 'lat' | 'lng', text: string) => {
    const next = Number(text);
    if (text !== '' && Number.isFinite(next)) {
      props.onChange({ _type: 'geopoint', lat: 0, lng: 0, ...point, [axis]: next });
    }
  };
  return (
    <div className="remote-cms-geopoint">
      {(['lat', 'lng'] as const).map((axis) => (
        <label key={axis}>
          <span>{axis === 'lat' ? 'Latitude' : 'Longitude'}</span>
          <input
            type="number"
            step="any"
            value={typeof point[axis] === 'number' ? String(point[axis]) : ''}
            onChange={(event) => change(axis, event.target.value)}
          />
        </label>
      ))}
    </div>
  );
}

function RichTextControl(props: {
  readonly value: RemoteValue | undefined;
  readonly label: string;
  readonly onChange: (value: RemoteValue | undefined) => void;
}) {
  // The value this editor last emitted, and the HTML it came from: while the
  // field still holds that value, the editor keeps its own HTML, so a round
  // trip through Portable Text never resets the text under the caret.
  const emitted = useRef<{ readonly value: RemoteValue; readonly html: string }>();
  const own = emitted.current?.value === props.value ? emitted.current?.html : undefined;
  return (
    <HtmlField
      value={own ?? (portableTextHTML(props.value) || '<p></p>')}
      label={props.label}
      onChange={(html) => {
        const next = htmlPortableText(html, props.value, { document, key: remoteKey });
        emitted.current = { value: next, html };
        props.onChange(next);
      }}
    />
  );
}
