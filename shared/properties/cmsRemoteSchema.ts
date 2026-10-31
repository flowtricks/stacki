// What a connected CMS field holds and how it is edited: its type, read from
// the site's own schema code where there is one (sanitySchema.ts) and from the
// value where there is not, and the value itself as plain JSON.
//
// Every field is editable. Scalars are edited in place; an object or a
// location opens into its fields; a list holds items of its member types; an
// image or file is uploaded to the CMS; a reference picks a document; rich
// text is edited as formatted text. A field is written whole — the panel sends
// its new value, or its removal — so a list's order, an image's alt text and a
// rich text's marks travel together and nothing is half-written.

import { record, text } from '../core/boundary';
import { assert } from '../core/assert';

export const REMOTE_SCHEMA_LIMITS = {
  typeDepthMax: 8,
  fieldsMax: 120,
  membersMax: 24,
  rulesMax: 16,
  optionsMax: 200,
  nameCharsMax: 128,
  titleCharsMax: 200,
  descriptionCharsMax: 1000,
  valueDepthMax: 12,
  valueNodesMax: 20_000,
  valueCharsMax: 100_000,
} as const;

export type RemoteScalarKind =
  'string' | 'text' | 'url' | 'email' | 'number' | 'boolean' | 'date' | 'datetime' | 'slug';

export type RemoteType =
  | { readonly kind: RemoteScalarKind; readonly options: readonly RemoteOption[] }
  | { readonly kind: 'geopoint' }
  | {
      readonly kind: 'object';
      readonly name: string;
      readonly fields: readonly RemoteSchemaField[];
      /** How one shows as a list row, from its schema's `preview` (paths into it). */
      readonly preview?: RemoteRowPreview;
      /** Fields side by side, from `options: { columns }` (2 to 4). */
      readonly columns?: number;
    }
  | { readonly kind: 'image'; readonly fields: readonly RemoteSchemaField[] }
  | { readonly kind: 'file' }
  | { readonly kind: 'reference'; readonly to: readonly string[] }
  | { readonly kind: 'array'; readonly of: readonly RemoteType[] }
  | { readonly kind: 'richText' };

/** A row's title path and the paths its subtitle joins, in order (`campus.name`). */
export interface RemoteRowPreview {
  readonly title: string | undefined;
  readonly parts: readonly string[];
}

/** A choice a string field offers instead of free text (`options.list`). */
export interface RemoteOption {
  readonly title: string;
  readonly value: string;
}

export interface RemoteSchemaField {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** The Studio refuses to publish without it (`validation: (rule) => rule.required()`). */
  readonly required: boolean;
  /** The checks its schema states that can be read without running code. */
  readonly rules: readonly RemoteRule[];
  readonly type: RemoteType;
}

/**
 * One validation check from a schema's `validation: (rule) => rule.…` chain.
 * An `error` blocks publishing, as in the Studio; a `warning` only says so.
 */
export type RemoteRule = { readonly level: 'error' | 'warning' } & (
  | { readonly kind: 'required' | 'email' | 'unique' | 'integer' | 'positive' }
  | { readonly kind: 'min' | 'max' | 'length'; readonly limit: number }
  | { readonly kind: 'uri'; readonly schemes: readonly string[]; readonly relative: boolean }
);

const RULE_KINDS = ['required', 'email', 'unique', 'integer', 'positive'] as const;
const LIMIT_KINDS = ['min', 'max', 'length'] as const;

export function parseRemoteRule(input: unknown): RemoteRule {
  const value = record(input);
  const level = value['level'];
  if (level !== 'error' && level !== 'warning') {
    throw new Error('Invalid rule level.');
  }
  const kind = value['kind'];
  const plain = RULE_KINDS.find((candidate) => candidate === kind);
  if (plain !== undefined) {
    return { level, kind: plain };
  }
  const limited = LIMIT_KINDS.find((candidate) => candidate === kind);
  if (limited !== undefined) {
    const limit = value['limit'];
    if (typeof limit !== 'number' || !Number.isFinite(limit)) {
      throw new Error('Invalid rule limit.');
    }
    return { level, kind: limited, limit };
  }
  if (kind !== 'uri') {
    throw new Error('Unknown rule.');
  }
  const schemes = bounded(value['schemes'], REMOTE_SCHEMA_LIMITS.optionsMax).map((scheme) =>
    short(scheme, 32),
  );
  const relative = value['relative'];
  if (typeof relative !== 'boolean') {
    throw new Error('Invalid rule option.');
  }
  assert(schemes.length <= REMOTE_SCHEMA_LIMITS.optionsMax, 'A rule names few schemes');
  return { level, kind, schemes, relative };
}

/** A JSON value as a CMS stores it. Absence is `undefined`; JSON's null is dropped. */
export type RemoteValue =
  string | number | boolean | readonly RemoteValue[] | { readonly [key: string]: RemoteValue };

const SCALARS: readonly RemoteScalarKind[] = [
  'string',
  'text',
  'url',
  'email',
  'number',
  'boolean',
  'date',
  'datetime',
  'slug',
];

const NAME = /^[A-Za-z_][\w.-]{0,127}$/;

export function parseRemoteType(input: unknown, depth = 0): RemoteType {
  assert(depth <= REMOTE_SCHEMA_LIMITS.typeDepthMax + 1, 'A type parse stays bounded');
  if (depth > REMOTE_SCHEMA_LIMITS.typeDepthMax) {
    throw new Error('Field type is nested too deeply.');
  }
  const value = record(input);
  const kind = value['kind'];
  const scalar = SCALARS.find((candidate) => candidate === kind);
  if (scalar !== undefined) {
    return { kind: scalar, options: parseOptions(value['options']) };
  }
  switch (kind) {
    case 'geopoint':
    case 'file':
    case 'richText':
      return { kind };
    case 'object': {
      const preview = value['preview'];
      return {
        kind,
        name: name(value['name']),
        fields: parseFields(value['fields'], depth),
        ...(preview === undefined ? {} : { preview: parseRowPreview(preview) }),
        ...parseColumns(value['columns']),
      };
    }
    case 'image':
      return { kind, fields: parseFields(value['fields'], depth) };
    case 'reference':
      return { kind, to: bounded(value['to'], REMOTE_SCHEMA_LIMITS.membersMax).map(name) };
    case 'array': {
      const of = bounded(value['of'], REMOTE_SCHEMA_LIMITS.membersMax);
      return { kind, of: of.map((member) => parseRemoteType(member, depth + 1)) };
    }
    default:
      throw new Error('Unknown field type.');
  }
}

export function parseRemoteSchemaField(input: unknown, depth = 0): RemoteSchemaField {
  const value = record(input);
  const required = value['required'];
  if (typeof required !== 'boolean') {
    throw new Error('Expected whether the field is required.');
  }
  const field = {
    name: name(value['name']),
    required,
    rules: bounded(value['rules'], REMOTE_SCHEMA_LIMITS.rulesMax).map(parseRemoteRule),
    title: short(value['title'], REMOTE_SCHEMA_LIMITS.titleCharsMax),
    description: short(value['description'], REMOTE_SCHEMA_LIMITS.descriptionCharsMax),
    type: parseRemoteType(value['type'], depth + 1),
  };
  assert(field.name.length > 0, 'A field has a name');
  return field;
}

/** A stored value: JSON, bounded in depth, size and string length; nulls dropped. */
export function parseRemoteValue(input: unknown): RemoteValue | undefined {
  // Every node read counts against one limit, so a wide value is bounded too.
  let nodes = 0;
  const tick = () => {
    nodes += 1;
    if (nodes > REMOTE_SCHEMA_LIMITS.valueNodesMax) {
      throw new Error('The value is too large.');
    }
  };
  const value = valueAt(input, 0, tick);
  assert(nodes <= REMOTE_SCHEMA_LIMITS.valueNodesMax, 'A value parse stays bounded');
  return value;
}

function valueAt(input: unknown, depth: number, tick: () => void): RemoteValue | undefined {
  tick();
  if (depth > REMOTE_SCHEMA_LIMITS.valueDepthMax) {
    throw new Error('The value is nested too deeply.');
  }
  if (input === null || input === undefined) {
    return undefined;
  }
  if (typeof input === 'string') {
    if (input.length > REMOTE_SCHEMA_LIMITS.valueCharsMax) {
      throw new Error('The value is too long.');
    }
    return input;
  }
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      throw new Error('Expected a finite number.');
    }
    return input;
  }
  if (typeof input === 'boolean') {
    return input;
  }
  if (Array.isArray(input)) {
    const items: unknown[] = input;
    return items.flatMap((item) => {
      const parsed = valueAt(item, depth + 1, tick);
      return parsed === undefined ? [] : [parsed];
    });
  }
  return objectValue(record(input), depth, tick);
}

function objectValue(
  input: Readonly<Record<string, unknown>>,
  depth: number,
  tick: () => void,
): RemoteValue {
  const out: Record<string, RemoteValue> = {};
  for (const [key, entry] of Object.entries(input)) {
    if (!/^[A-Za-z_$][\w$-]{0,127}$/.test(key)) {
      throw new Error('Invalid key in a value.');
    }
    const parsed = valueAt(entry, depth + 1, tick);
    if (parsed !== undefined) {
      out[key] = parsed;
    }
  }
  assert(Object.keys(out).length <= Object.keys(input).length, 'Parsing never adds keys');
  return out;
}

const PREVIEW_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){0,2}$/;

function parseColumns(input: unknown): { readonly columns?: number } {
  if (input === undefined) {
    return {};
  }
  if (input !== 2 && input !== 3 && input !== 4) {
    throw new Error('Invalid column count.');
  }
  assert(Number.isSafeInteger(input), 'A column count is whole');
  return { columns: input };
}

function parseRowPreview(input: unknown): RemoteRowPreview {
  const value = record(input);
  const path = (entry: unknown): string => {
    const text = short(entry, REMOTE_SCHEMA_LIMITS.nameCharsMax);
    if (!PREVIEW_PATH.test(text)) {
      throw new Error('Invalid preview path.');
    }
    assert(!text.includes('..'), 'A preview path has no empty steps');
    return text;
  };
  const parts = bounded(value['parts'], REMOTE_SCHEMA_LIMITS.membersMax).map(path);
  assert(parts.length <= REMOTE_SCHEMA_LIMITS.membersMax, 'A preview joins few values');
  return { title: value['title'] === undefined ? undefined : path(value['title']), parts };
}

function parseFields(input: unknown, depth: number): RemoteSchemaField[] {
  const fields = bounded(input, REMOTE_SCHEMA_LIMITS.fieldsMax).map((field) =>
    parseRemoteSchemaField(field, depth),
  );
  if (new Set(fields.map((field) => field.name)).size !== fields.length) {
    throw new Error('A field is named twice.');
  }
  assert(fields.length <= REMOTE_SCHEMA_LIMITS.fieldsMax, 'A type holds a bounded field list');
  return fields;
}

function parseOptions(input: unknown): RemoteOption[] {
  return bounded(input, REMOTE_SCHEMA_LIMITS.optionsMax).map((option) => {
    const value = record(option);
    return {
      title: short(value['title'], REMOTE_SCHEMA_LIMITS.titleCharsMax),
      value: short(value['value'], REMOTE_SCHEMA_LIMITS.titleCharsMax),
    };
  });
}

function name(input: unknown): string {
  const value = text(input);
  if (!NAME.test(value)) {
    throw new Error('Invalid field or type name.');
  }
  assert(value.length <= REMOTE_SCHEMA_LIMITS.nameCharsMax, 'A name stays within its bound');
  return value;
}

function short(input: unknown, max: number): string {
  const value = text(input);
  if (value.length > max) {
    throw new Error('A schema label is too long.');
  }
  assert(value.length <= max, 'A label stays within its bound');
  return value;
}

function bounded(input: unknown, max: number): unknown[] {
  assert(Number.isSafeInteger(max), 'A list bound is a whole number');
  if (!Array.isArray(input)) {
    throw new Error('Expected a list.');
  }
  if (input.length > max) {
    throw new Error('Too many items.');
  }
  return input;
}

/** The plain-object view of a value, or undefined when it is not one. */
export function remoteObject(
  value: RemoteValue | undefined,
): { readonly [key: string]: RemoteValue } | undefined {
  if (value === undefined || typeof value !== 'object' || isRemoteList(value)) {
    return undefined;
  }
  return value;
}

/** The list view of a value, or undefined when it is not one. */
export function remoteList(value: RemoteValue | undefined): readonly RemoteValue[] | undefined {
  return value !== undefined && isRemoteList(value) ? value : undefined;
}

// `Array.isArray` does not narrow a readonly array out of a union; this does.
function isRemoteList(value: RemoteValue): value is readonly RemoteValue[] {
  return Array.isArray(value);
}
