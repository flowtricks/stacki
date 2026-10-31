// One Sanity document's fields for the panel: the schema's fields in its order,
// each with the document's value, then any field the document holds that the
// schema does not name. A field's type comes from the schema where the code
// settles it (sanitySchema.ts) and from its value where it does not.

import { assert } from '../../shared/core/assert';
import type { RemoteDocumentField } from '../../shared/properties/cmsRemote';
import {
  REMOTE_SCHEMA_LIMITS,
  parseRemoteValue,
  remoteList,
  remoteObject,
  type RemoteScalarKind,
  type RemoteSchemaField,
  type RemoteType,
  type RemoteValue,
} from '../../shared/properties/cmsRemoteSchema';
import type { SanityDocumentSchema } from './sanitySchema';

const ORDER_RANK = 'orderRank';
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
// Kinds a list's members are told apart by when inferred from its items.
const MEMBERS_INFERRED_MAX = 4;

export function documentFields(
  document: object,
  schema: SanityDocumentSchema | undefined,
): RemoteDocumentField[] {
  // `orderRank` is the orderable plugin's sort key, written by dragging rows;
  // the Studio never shows it, whatever a schema says or does not say.
  const values = new Map<string, unknown>(
    Object.entries(document).filter(([key]) => key !== ORDER_RANK),
  );
  const named = new Set(schema?.fields.map((field) => field.name) ?? []);
  const declared = (schema?.fields ?? [])
    .filter((field) => field.name !== ORDER_RANK)
    .map((field) => {
      const value = parseRemoteValue(values.get(field.name));
      return { ...field, type: field.type ?? inferType(value), value };
    });
  const extra = [...values.keys()]
    .filter((key) => FIELD_NAME.test(key) && !named.has(key) && !schema?.hidden.has(key))
    .map((name): RemoteDocumentField => {
      const value = parseRemoteValue(values.get(name));
      return {
        name,
        title: '',
        description: '',
        required: false,
        rules: [],
        type: inferType(value),
        value,
      };
    });
  const fields = [...declared, ...extra].slice(0, REMOTE_SCHEMA_LIMITS.fieldsMax);
  assert(
    fields.every((field) => !field.name.startsWith('_')),
    'System keys are not fields',
  );
  return fields;
}

/** A type for a value no schema describes, read from the value's own shape. */
export function inferType(value: RemoteValue | undefined, depth = 0): RemoteType {
  assert(depth <= REMOTE_SCHEMA_LIMITS.valueDepthMax, 'Inference follows the value depth bound');
  if (typeof value === 'boolean') {
    return { kind: 'boolean', options: [] };
  }
  if (typeof value === 'number') {
    return { kind: 'number', options: [] };
  }
  if (typeof value === 'string' || value === undefined) {
    return { kind: textKind(value ?? ''), options: [] };
  }
  const list = remoteList(value);
  if (list !== undefined) {
    return listType(list, depth);
  }
  return objectType(remoteObject(value) ?? {}, depth);
}

function listType(items: readonly RemoteValue[], depth: number): RemoteType {
  if (items.length > 0 && items.every((item) => typeOfItem(item) === 'block')) {
    return { kind: 'richText' };
  }
  const of: RemoteType[] = [];
  for (const item of items) {
    const type = inferType(item, depth + 1);
    if (!of.some((known) => sameShape(known, type)) && of.length < MEMBERS_INFERRED_MAX) {
      of.push(type);
    }
  }
  return { kind: 'array', of: of.length > 0 ? of : [{ kind: 'string', options: [] }] };
}

function objectType(value: { readonly [key: string]: RemoteValue }, depth: number): RemoteType {
  const typeName = value['_type'];
  switch (typeof typeName === 'string' ? typeName : '') {
    case 'slug':
      return { kind: 'slug', options: [] };
    case 'reference':
      return { kind: 'reference', to: [] };
    case 'geopoint':
      return { kind: 'geopoint' };
    case 'file':
      return { kind: 'file' };
    case 'image':
      return { kind: 'image', fields: fieldsInferred(value, depth, ['asset', 'crop', 'hotspot']) };
    default: {
      const name = typeof typeName === 'string' ? typeName : 'object';
      return { kind: 'object', name, fields: fieldsInferred(value, depth, []) };
    }
  }
}

function fieldsInferred(
  value: { readonly [key: string]: RemoteValue },
  depth: number,
  skipped: readonly string[],
): RemoteSchemaField[] {
  return Object.entries(value)
    .filter(([key]) => FIELD_NAME.test(key) && !skipped.includes(key))
    .slice(0, REMOTE_SCHEMA_LIMITS.fieldsMax)
    .map(([name, entry]) => ({
      name,
      title: '',
      description: '',
      required: false,
      rules: [],
      type: inferType(entry, depth + 1),
    }));
}

function textKind(value: string): RemoteScalarKind {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return 'date';
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    return 'datetime';
  }
  if (/^https?:\/\/\S+$/.test(value)) {
    return 'url';
  }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return 'email';
  }
  return value.includes('\n') || value.length > 120 ? 'text' : 'string';
}

function typeOfItem(item: RemoteValue): string | undefined {
  const type = remoteObject(item)?.['_type'];
  return typeof type === 'string' ? type : undefined;
}

function sameShape(left: RemoteType, right: RemoteType): boolean {
  if (left.kind === 'object' && right.kind === 'object') {
    return left.name === right.name;
  }
  return left.kind === right.kind;
}

/** Every asset a value points at (`image-…`, `file-…` refs), for their addresses. */
export function assetRefs(value: RemoteValue | undefined): string[] {
  const out = new Set<string>();
  const queue: RemoteValue[] = value === undefined ? [] : [value];
  for (let at = 0; at < queue.length && at < REMOTE_SCHEMA_LIMITS.valueNodesMax; at++) {
    const next = queue[at];
    const object = remoteObject(next);
    if (object !== undefined || remoteList(next) !== undefined) {
      queue.push(...(remoteList(next) ?? Object.values(object ?? {})));
      const reference = object?.['_ref'];
      if (typeof reference === 'string' && /^(image|file)-[\w-]{1,200}$/.test(reference)) {
        out.add(reference);
      }
    }
  }
  return [...out];
}
