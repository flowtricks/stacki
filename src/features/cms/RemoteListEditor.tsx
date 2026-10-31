// A list field of a connected CMS. A list of plain text or numbers is edited as
// options (CmsListField.tsx), like a project's own lists. Any other list is
// rows: drag to reorder, open one to edit it in place, remove it with the
// trash, and add by its member types — a group or text added blank, an image
// or file uploaded, a reference picked. Each added item gets the `_key` the CMS
// tells array items apart by; an item keeps its key through every edit.
import { useState } from 'react';
import { assert } from '../../../shared/core/assert';
import {
  REMOTE_SCHEMA_LIMITS,
  remoteList,
  remoteObject,
  type RemoteOption,
  type RemoteType,
  type RemoteValue,
} from '../../../shared/properties/cmsRemoteSchema';
import { uploadRemoteAsset } from '../../ipc/cmsConnectionsBridge';
import Dropdown from '../../ui/Dropdown';
import { ErrorToast } from '../../ui/ErrorToast';
import { ChevronDownIcon, ChevronRightIcon, DragIcon, PlusIcon, TrashIcon } from '../../ui/Icons';
import useListReorder from '../../ui/useListReorder';
import { CmsListField } from './CmsListField';
import { RemoteImageGrid } from './RemoteImageGrid';
import { labelize } from './cmsSchema';
import { fieldTypeOf } from './remoteFieldTypes';
import { SanityTypeIcon, typeIcons } from './SanityTypeIcon';
import { pointingAt } from './RemoteAssetInput';
import { referenceTitle, useReferenceOptions } from './RemoteReferenceInput';
import { RemoteValueEditor, type RemoteValueProps } from './RemoteValueEditor';
import { fieldTitle, remoteKey } from './remoteValues';

type ListProps = RemoteValueProps & { readonly of: readonly RemoteType[] };

const PLAIN: ReadonlySet<RemoteType['kind']> = new Set(['string', 'number']);

export function RemoteListEditor(props: ListProps) {
  const items = remoteList(props.value) ?? [];
  assert(items.length <= REMOTE_SCHEMA_LIMITS.valueNodesMax, 'A list stays within its bound');
  const plain = props.of.every((member) => PLAIN.has(member.kind) && !hasOptions(member));
  if (plain) {
    return (
      <CmsListField
        layout="open"
        value={items}
        onChange={(next) => props.onChange(next.filter(isPlainValue))}
      />
    );
  }
  // Images with no fields of their own are a grid of thumbnails, not rows.
  const tiles = props.of.every((member) => member.kind === 'image' && member.fields.length === 0);
  if (tiles) {
    return (
      <RemoteImageGrid
        items={items}
        context={props.context}
        onChange={(next) => props.onChange(next.length > 0 ? next : undefined)}
      />
    );
  }
  return <ItemRows {...props} items={items} />;
}

function ItemRows(props: ListProps & { readonly items: readonly RemoteValue[] }) {
  const { items } = props;
  const [open, setOpen] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  // Documents a row may be titled by: the list's own references, and a group's
  // reference fields (a nav dropdown's category is its name).
  const targets = [...new Set(props.of.flatMap(referenceTargetsOf))];
  const options = useReferenceOptions(props.context, targets);
  const { write, change } = listWrites(items, props.onChange);
  const reorder = useListReorder({
    count: items.length,
    onMove: (from, to) => {
      write(moved(items, from, to));
      setOpen(undefined);
    },
  });
  return (
    <div className="remote-cms-list">
      {items.map((item, index) => (
        <ItemRow
          key={keyOf(item) ?? index}
          {...props}
          item={item}
          index={index}
          open={open === index}
          rowClass={reorder.rowClass(index)}
          rowProps={reorder.rowProps(index)}
          subtitle={itemSubtitle(item, memberFor(item, props.of), options)}
          title={itemTitle(item, memberFor(item, props.of), {
            options,
            assets: props.context.assets,
            index,
          })}
          onToggle={() => setOpen(open === index ? undefined : index)}
          onRemove={() => {
            write(items.filter((_, position) => position !== index));
            setOpen(undefined);
          }}
          onItemChange={(next) => change(index, next)}
          referencedType={
            options.find((option) => option.id === remoteObject(item)?.['_ref'])?.type
          }
        />
      ))}
      {error && <ErrorToast message={error} />}
      <AddControls
        {...props}
        onAdd={(item) => {
          write([...items, item]);
          setOpen(items.length);
        }}
        onError={setError}
      />
    </div>
  );
}

// One item: a row to drag or remove. What it holds decides the rest: a
// reference is its document's name and nothing more (swap one by removing it
// and adding another); one value — a text, or a group with a single simple
// field — is edited right in the row; anything larger opens below it.
function ItemRow(
  props: ListProps & {
    readonly item: RemoteValue;
    readonly index: number;
    readonly open: boolean;
    readonly title: string;
    readonly subtitle: string | undefined;
    readonly rowClass: string;
    readonly rowProps: ReturnType<ReturnType<typeof useListReorder>['rowProps']>;
    readonly onToggle: () => void;
    readonly onRemove: () => void;
    readonly onItemChange: (value: RemoteValue | undefined) => void;
    /** The type of the document a reference item points at, once known. */
    readonly referencedType: string | undefined;
  },
) {
  const member = memberFor(props.item, props.of);
  const { icon: Icon } = fieldTypeOf(member);
  const shape = rowShape(member);
  // A reference shows its document's type icon, as the Studio's row does.
  const referenced = member.kind === 'reference' ? props.referencedType : undefined;
  const context = { ...props.context, depth: props.context.depth + 1 };
  return (
    <div className={`remote-cms-list-item ${props.rowClass}`}>
      <div
        className={`remote-cms-list-row is-${shape}`}
        {...props.rowProps}
        onClick={shape === 'opens' ? props.onToggle : undefined}
      >
        <span className="remote-cms-grip" title="Drag to reorder">
          <DragIcon size={11} />
        </span>
        {shape === 'opens' &&
          (props.open ? <ChevronDownIcon size={11} /> : <ChevronRightIcon size={11} />)}
        <RowIcon
          icon={Icon}
          sanity={referenced && typeIcons(props.context.connectionId).get(referenced)}
        />
        {shape === 'inline' ? (
          // A press inside the editor selects text; it never starts a row drag.
          <div
            className="remote-cms-list-inline"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <InlineItemEditor {...props} member={member} context={context} />
          </div>
        ) : (
          <span className="remote-cms-list-title">
            {props.title}
            {props.subtitle && <span className="remote-cms-subtitle">{props.subtitle}</span>}
          </span>
        )}
        <RemoveButton onRemove={props.onRemove} />
      </div>
      {shape === 'opens' && props.open && (
        <div className="remote-cms-list-body">
          <RemoteValueEditor
            type={member}
            label={props.label}
            value={props.item}
            context={context}
            onChange={props.onItemChange}
          />
        </div>
      )}
    </div>
  );
}

// Removing an item, without also opening or closing its row.
function RemoveButton(props: { readonly onRemove: () => void }) {
  return (
    <button
      type="button"
      className="ghost"
      title="Remove"
      onClick={(event) => {
        event.stopPropagation();
        props.onRemove();
      }}
    >
      <TrashIcon size={11} />
    </button>
  );
}

// A row's type icon: a reference's document type's Sanity icon, else the member's.
function RowIcon(props: {
  readonly icon: ReturnType<typeof fieldTypeOf>['icon'];
  readonly sanity: string | undefined;
}) {
  const Icon = props.icon;
  return props.sanity === undefined ? (
    <Icon size={12} />
  ) : (
    <SanityTypeIcon symbol={props.sanity} size={12} />
  );
}

// An item's one value, edited in its row: the item itself, or a group's only field.
function InlineItemEditor(
  props: ListProps & {
    readonly item: RemoteValue;
    readonly member: RemoteType;
    readonly onItemChange: (value: RemoteValue | undefined) => void;
  },
) {
  const { member, item } = props;
  const only = member.kind === 'object' ? member.fields[0] : undefined;
  if (only === undefined) {
    return (
      <RemoteValueEditor
        type={member}
        label={props.label}
        value={item}
        context={props.context}
        onChange={props.onItemChange}
      />
    );
  }
  const object = remoteObject(item) ?? {};
  const rest = Object.fromEntries(Object.entries(object).filter(([key]) => key !== only.name));
  return (
    <RemoteValueEditor
      type={only.type}
      label={fieldTitle(only)}
      value={object[only.name]}
      context={props.context}
      onChange={(next) =>
        props.onItemChange(next === undefined ? rest : { ...rest, [only.name]: next })
      }
    />
  );
}

const INLINE_KINDS: ReadonlySet<RemoteType['kind']> = new Set([
  'string',
  'url',
  'email',
  'number',
  'boolean',
  'date',
  'datetime',
  'slug',
]);

function rowShape(member: RemoteType): 'fixed' | 'inline' | 'opens' {
  // A reference, or a choice from a fixed list, is the thing it names: its name
  // is shared by every document that chooses it, so a row never renames it.
  if (member.kind === 'reference' || hasOptions(member)) {
    return 'fixed';
  }
  if (INLINE_KINDS.has(member.kind)) {
    return 'inline';
  }
  if (member.kind === 'object') {
    const [only, ...more] = member.fields;
    if (only !== undefined && more.length === 0) {
      return INLINE_KINDS.has(only.type.kind) ? 'inline' : 'opens';
    }
  }
  return 'opens';
}

// Writing the list whole: an emptied list is removed, an edited item keeps its key.
function listWrites(
  items: readonly RemoteValue[],
  onChange: (value: RemoteValue | undefined) => void,
) {
  const write = (next: readonly RemoteValue[]) => onChange(next.length > 0 ? next : undefined);
  const change = (index: number, next: RemoteValue | undefined) =>
    write(
      items
        .map((entry, position) => (position === index ? keep(entry, next) : entry))
        .filter(defined),
    );
  return { write, change };
}

// One add control per member type: blank, uploaded, or picked.
function AddControls(
  props: ListProps & {
    readonly onAdd: (item: RemoteValue) => void;
    readonly onError: (message: string | undefined) => void;
  },
) {
  const { context } = props;
  const upload = async (kind: 'image' | 'file') => {
    props.onError(undefined);
    const uploaded = await uploadRemoteAsset(context.projectPath, context.connectionId, kind);
    if (!uploaded.ok) {
      props.onError(uploaded.message);
    } else if (uploaded.value !== undefined) {
      context.addAsset(uploaded.value);
      const value = remoteObject(pointingAt(undefined, kind, uploaded.value)) ?? {};
      props.onAdd({ ...value, _key: remoteKey() });
    }
  };
  return (
    <div className="remote-cms-list-add">
      {props.of.map((member, index) => {
        const name = memberName(member);
        if (member.kind === 'reference') {
          return <AddReference key={index} {...props} to={member.to} name={name} />;
        }
        if (member.kind === 'string' && member.options.length > 0) {
          return <AddOption key={index} {...props} options={member.options} />;
        }
        // An image or file is added by uploading one; anything else starts blank.
        const kind = assetKind(member);
        const add = kind ? () => void upload(kind) : () => props.onAdd(blank(member));
        return (
          <button key={index} type="button" className="cms-add" onClick={add}>
            <PlusIcon size={11} /> Add {name.toLowerCase()}
          </button>
        );
      })}
    </div>
  );
}

// A choice from a fixed list, offering only the ones the list does not hold yet.
function AddOption(
  props: ListProps & {
    readonly options: readonly RemoteOption[];
    readonly onAdd: (item: RemoteValue) => void;
  },
) {
  const chosen = new Set(remoteList(props.value) ?? []);
  const left = props.options.filter((option) => !chosen.has(option.value));
  if (left.length === 0) {
    return undefined;
  }
  return (
    <Dropdown
      value=""
      placeholder={`Add ${props.label.toLowerCase().replace(/s$/, '')}…`}
      options={left.map((option) => ({ value: option.value, label: option.title }))}
      onChange={(value) => props.onAdd(value)}
    />
  );
}

function AddReference(
  props: ListProps & {
    readonly to: readonly string[];
    readonly name: string;
    readonly onAdd: (item: RemoteValue) => void;
  },
) {
  const options = useReferenceOptions(props.context, props.to);
  const icons = typeIcons(props.context.connectionId);
  const chosen = new Set(
    (remoteList(props.value) ?? []).map((item) => remoteObject(item)?.['_ref']),
  );
  return (
    <Dropdown
      value=""
      placeholder={`Add ${props.to.map(labelize).join(' or ').toLowerCase() || 'reference'}…`}
      searchable={true}
      searchPlaceholder="Search…"
      options={options
        .filter((option) => !chosen.has(option.id))
        .map((option) => ({
          value: option.id,
          label: option.title,
          icon: <SanityTypeIcon symbol={icons.get(option.type)} size={12} />,
        }))}
      onChange={(id) => props.onAdd({ _type: 'reference', _ref: id, _key: remoteKey() })}
    />
  );
}

// The member type an item is: by its `_type` where it names one, else the first.
function memberFor(item: RemoteValue, of: readonly RemoteType[]): RemoteType {
  const typeName = remoteObject(item)?.['_type'];
  const found = of.find((member) => {
    if (member.kind === 'object') {
      return member.name === typeName;
    }
    return member.kind === typeName;
  });
  const fallback = of[0];
  assert(fallback !== undefined, 'A list has at least one member type');
  return found ?? fallback;
}

function memberName(member: RemoteType): string {
  if (member.kind === 'object') {
    return labelize(member.name);
  }
  return fieldTypeOf(member).label === 'Plain text' ? 'Item' : fieldTypeOf(member).label;
}

function blank(member: RemoteType): RemoteValue {
  switch (member.kind) {
    case 'object':
      return { _type: member.name, _key: remoteKey() };
    case 'geopoint':
      return { _type: 'geopoint', _key: remoteKey(), lat: 0, lng: 0 };
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'slug':
      return { _type: 'slug', _key: remoteKey(), current: '' };
    case 'array':
    case 'richText':
      return [];
    case 'string':
    case 'text':
    case 'url':
    case 'email':
    case 'date':
    case 'datetime':
      return '';
    case 'image':
    case 'file':
    case 'reference':
      // Added by an upload or a pick, never blank (AddControls).
      throw new Error(`A ${member.kind} is never added blank.`);
    default: {
      const exhaustive: never = member;
      return exhaustive;
    }
  }
}

function assetKind(member: RemoteType): 'image' | 'file' | undefined {
  if (member.kind === 'image') {
    return 'image';
  }
  return member.kind === 'file' ? 'file' : undefined;
}

// A row's title: a reference's document, an image's file, or a group's first
// text in its schema's order with its first date after it ("Sunday · 9:00 AM").
function itemTitle(
  item: RemoteValue,
  member: RemoteType,
  known: {
    readonly options: Parameters<typeof referenceTitle>[1];
    readonly assets: ReadonlyMap<string, { readonly filename: string }>;
    readonly index: number;
  },
): string {
  if (member.kind === 'reference') {
    return referenceTitle(item, known.options);
  }
  const object = remoteObject(item);
  if (object === undefined) {
    const option =
      member.kind === 'string' ? member.options.find((entry) => entry.value === item) : undefined;
    return option?.title ?? (String(item) || `Item ${known.index + 1}`);
  }
  const asset = remoteObject(object['asset'])?.['_ref'];
  if (typeof asset === 'string') {
    return known.assets.get(asset)?.filename ?? asset;
  }
  // A group whose schema says how it previews is titled as the Studio titles it.
  const previewTitle =
    member.kind === 'object' && member.preview?.title
      ? pathText(object, member.preview.title, known.options)
      : undefined;
  if (previewTitle) {
    return previewTitle;
  }
  const fields = member.kind === 'object' ? member.fields : [];
  const text = fields.find((field) => titled(field.type, object[field.name]));
  const date = fields.find(
    (field) => DATE_KINDS.has(field.type.kind) && filled(object[field.name]),
  );
  const parts = [
    text === undefined ? undefined : titleText(text.type, object[text.name], known.options),
    date === undefined ? undefined : shortDate(String(object[date.name]), date.type.kind),
  ].filter((part): part is string => part !== undefined && part !== '');
  return parts.length > 0 ? parts.join(' · ') : `${memberName(member)} ${known.index + 1}`;
}

const TITLE_KINDS: ReadonlySet<RemoteType['kind']> = new Set(['string', 'text', 'email', 'slug']);
const DATE_KINDS: ReadonlySet<RemoteType['kind']> = new Set(['date', 'datetime']);

/** The line under a group's title, as its schema's preview builds it ("Donaldsonville · 6 PM"). */
function itemSubtitle(
  item: RemoteValue,
  member: RemoteType,
  options: Parameters<typeof referenceTitle>[1],
): string | undefined {
  const object = remoteObject(item);
  if (object === undefined || member.kind !== 'object' || member.preview === undefined) {
    return undefined;
  }
  const line = member.preview.parts
    .map((path) => pathText(object, path, options))
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' · ');
  return line || undefined;
}

// A preview path's value as text: a step through a reference reads the
// referenced document's title; a date reads as a date; a list as its count.
function pathText(
  object: { readonly [key: string]: RemoteValue },
  path: string,
  options: Parameters<typeof referenceTitle>[1],
): string | undefined {
  const [first = '', ...rest] = path.split('.');
  let value: RemoteValue | undefined = object[first];
  for (const step of rest) {
    const at = remoteObject(value);
    if (typeof at?.['_ref'] === 'string') {
      return referenceTitle(value, options);
    }
    value = at?.[step];
  }
  if (typeof value === 'string') {
    return DATE_SHAPE.test(value) ? shortDate(value, 'datetime') : value;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  const list = remoteList(value);
  return list === undefined ? undefined : `${list.length} ${first}`;
}

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

// A field that can title its group: filled text, or a reference that points somewhere.
function titled(type: RemoteType, value: RemoteValue | undefined): boolean {
  if (type.kind === 'reference') {
    return typeof remoteObject(value)?.['_ref'] === 'string';
  }
  return TITLE_KINDS.has(type.kind) && filled(value);
}

function titleText(
  type: RemoteType,
  value: RemoteValue | undefined,
  options: Parameters<typeof referenceTitle>[1],
): string {
  return type.kind === 'reference' ? referenceTitle(value, options) : String(value);
}

function referenceTargetsOf(member: RemoteType): readonly string[] {
  if (member.kind === 'reference') {
    return member.to;
  }
  if (member.kind === 'object') {
    return member.fields.flatMap((field) => (field.type.kind === 'reference' ? field.type.to : []));
  }
  return [];
}

function filled(value: RemoteValue | undefined): boolean {
  return typeof value === 'string' ? value.trim() !== '' : false;
}

// A date as people read it, in local time; a value that is not one is shown as it is.
function shortDate(value: string, kind: RemoteType['kind']): string {
  const date = new Date(kind === 'date' ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  if (kind === 'date') {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  return date.toLocaleString(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// An edited item keeps the key it had; an emptied one leaves the list.
function keep(previous: RemoteValue, next: RemoteValue | undefined): RemoteValue | undefined {
  const key = keyOf(previous);
  const object = remoteObject(next);
  if (key === undefined || object === undefined) {
    return next;
  }
  return { ...object, _key: key };
}

function keyOf(item: RemoteValue): string | undefined {
  const key = remoteObject(item)?.['_key'];
  return typeof key === 'string' ? key : undefined;
}

function moved(items: readonly RemoteValue[], from: number, to: number): RemoteValue[] {
  assert(from >= 0, 'A move starts inside the list');
  assert(from < items.length, 'A move starts inside the list');
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item !== undefined) {
    next.splice(to > from ? to - 1 : to, 0, item);
  }
  return next;
}

function hasOptions(member: RemoteType): boolean {
  return member.kind === 'string' && member.options.length > 0;
}

function isPlainValue(value: unknown): value is string | number {
  return typeof value === 'string' || typeof value === 'number';
}

function defined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
