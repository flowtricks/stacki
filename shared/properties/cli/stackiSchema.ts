// i18n-ignore-file: the CLI and its MCP tools speak to agents and scripts in English; none of this is interface text.
// The key reference of every `.stacki` file the Stacki CLI can edit: which keys exist, their types, bounds,
// defaults and which commands set them. It is the one place that says what is settable.
//
// Why a registry beside the parsers: the app's parsers (`validateMetadata`) are the final judge of a file, but
// most of them are open-world, so they silently ignore a key they do not know. An agent that sets
// `visibel: false` would get a file the parser accepts and the app ignores. The registry closes that gap: the CLI
// refuses a key that is not listed here, then asks the real parser to accept the finished file. A coverage test
// (test/shared/properties/cli/stackiSchemaCoverage.test.ts) reads each parser's source and fails when the parser
// reads a key that this registry does not list, so adding a setting to the app without CLI coverage breaks the build.
import { toArray, toRecord } from '../../core/record';

export const SCHEMA_LIMITS = {
  /** Keys one object schema lists: a settings file is hand-written, not a data table. */
  fieldsMax: 64,
  /** Nesting of one schema; deeper shapes are not settings. */
  depthMax: 8,
} as const satisfies Record<string, number>;

/** A value's shape. `json` is the bounded escape hatch for values the parser itself validates (it says why). */
export type ValueSchema =
  | { readonly kind: 'boolean' }
  | { readonly kind: 'integer'; readonly min: number; readonly max: number }
  | { readonly kind: 'number'; readonly min: number; readonly max: number }
  | { readonly kind: 'string'; readonly charsMax: number; readonly charsMin?: number; readonly pattern?: string }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'literal'; readonly value: string | number | boolean }
  | { readonly kind: 'array'; readonly item: ValueSchema; readonly itemsMax: number; readonly unique?: boolean }
  | { readonly kind: 'object'; readonly fields: Readonly<Record<string, FieldSchema>> }
  | { readonly kind: 'map'; readonly value: ValueSchema; readonly entriesMax: number; readonly keyPattern?: string; readonly keyDescription: string }
  | { readonly kind: 'variant'; readonly tag: string; readonly variants: Readonly<Record<string, Readonly<Record<string, FieldSchema>>>> }
  | { readonly kind: 'json'; readonly reason: string };

export interface FieldSchema {
  readonly type: ValueSchema;
  readonly description: string;
  /** A required key cannot be unset; a file missing it is refused by the parser. */
  readonly required: boolean;
  /** What the app does when the key is absent, for the reference; never written by the CLI. */
  readonly default?: string | number | boolean;
  /** The commands that set this key besides `config set` (for example `guides set`). */
  readonly commands?: readonly string[];
  /** A key an older app wrote, still read and dropped on the next save: not settable, listed so coverage knows it. */
  readonly legacy?: boolean;
}

export type SettingsFormat = 'json' | 'text';

/** One `.stacki` file: where it is, what holds it valid, and every key in it. */
export interface FileSchema {
  /** The name a command uses: `guide`, `roles`, `breakpointSync`. */
  readonly id: string;
  /** Project-relative path. */
  readonly file: string;
  readonly description: string;
  /** The access feature (shared/properties/projectRoles.ts) a role needs to change this file, or `admin` for admin only. */
  readonly requires: string;
  /** The top-level keys. */
  readonly fields: Readonly<Record<string, FieldSchema>>;
  /** The document written when the file does not exist yet. */
  readonly empty: Readonly<Record<string, unknown>>;
  /**
   * The app's own validator kind (`METADATA_FILES` in shared/properties/projectMetadata.ts) for a file written through the
   * project metadata transport. Absent for a file with its own store (the apps files), which names `validate` instead.
   */
  readonly metadataKind?: string;
  /** For a file outside the metadata transport: the app's parser applied to the finished text; throws the reason when it refuses. */
  readonly validate?: (source: string) => void;
  /** Text the app writes for this document, when it has a canonical writer (key order, indent); default is two-space JSON and a newline. */
  readonly serialize?: (document: Record<string, unknown>) => string;
  /** The domain commands that edit this file with its cross-file rules. */
  readonly commands: readonly string[];
  /** Source files whose reads of keys the coverage test checks against `fields`. */
  readonly parserSources: readonly string[];
  /** Keys the parsers read that are not settings (a legacy key, an internal marker), each with the reason. */
  readonly parserKeyExceptions?: Readonly<Record<string, string>>;
  /** The installed app that declared this file; absent for the core files. Config edits of an app's file need `cli:apps`. */
  readonly appId?: string;
}

/** A file the CLI will never read or write, and why. */
export interface UnsettableEntry {
  readonly path: string;
  readonly reason: string;
}

// Builders: short, so a file's schema reads like its format.
export const bool = (): ValueSchema => ({ kind: 'boolean' });
export const integer = (min: number, max: number): ValueSchema => ({ kind: 'integer', min, max });
export const numberIn = (min: number, max: number): ValueSchema => ({ kind: 'number', min, max });
export const text = (charsMax: number, options: { readonly charsMin?: number; readonly pattern?: string } = {}): ValueSchema => ({
  kind: 'string',
  charsMax,
  ...options,
});
export const oneOf = (...values: readonly string[]): ValueSchema => ({ kind: 'enum', values });
export const literal = (value: string | number | boolean): ValueSchema => ({ kind: 'literal', value }); // eslint-disable-line stacki/no-boolean-parameter -- a literal may be true or false; the value is the data, not a switch
export const arrayOf = (item: ValueSchema, itemsMax: number, options: { readonly unique?: boolean } = {}): ValueSchema => ({
  kind: 'array',
  item,
  itemsMax,
  ...options,
});
export const objectOf = (fields: Readonly<Record<string, FieldSchema>>): ValueSchema => ({ kind: 'object', fields });
export const mapOf = (value: ValueSchema, entriesMax: number, keyDescription: string, keyPattern?: string): ValueSchema => ({
  kind: 'map',
  value,
  entriesMax,
  keyDescription,
  ...(keyPattern === undefined ? {} : { keyPattern }),
});
export const variantOf = (tag: string, variants: Readonly<Record<string, Readonly<Record<string, FieldSchema>>>>): ValueSchema => ({
  kind: 'variant',
  tag,
  variants,
});
export const jsonValue = (reason: string): ValueSchema => ({ kind: 'json', reason });

export function field(
  type: ValueSchema,
  description: string,
  options: { readonly required?: boolean; readonly default?: string | number | boolean; readonly commands?: readonly string[]; readonly legacy?: boolean } = {},
): FieldSchema {
  return {
    type,
    description,
    required: options.required ?? false,
    ...(options.default === undefined ? {} : { default: options.default }),
    ...(options.commands === undefined ? {} : { commands: options.commands }),
    ...(options.legacy === undefined ? {} : { legacy: options.legacy }),
  };
}

/** Why `value` does not fit `schema`, or undefined when it does. `where` is the path shown in the reason. */
export function checkValue(schema: ValueSchema, value: unknown, where: string, depth: number = 0): string | undefined {
  if (depth > SCHEMA_LIMITS.depthMax) {
    return `${where}: nested deeper than ${SCHEMA_LIMITS.depthMax} levels`;
  }
  switch (schema.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? undefined : `${where}: expected true or false`;
    case 'integer':
      return checkNumber(value, { min: schema.min, max: schema.max, whole: 'integer' }, where);
    case 'number':
      return checkNumber(value, { min: schema.min, max: schema.max, whole: 'number' }, where);
    case 'string':
      return checkString(schema, value, where);
    case 'enum':
      return typeof value === 'string' && schema.values.includes(value) ? undefined : `${where}: expected one of ${schema.values.join(', ')}`;
    case 'literal':
      return value === schema.value ? undefined : `${where}: expected ${JSON.stringify(schema.value)}`;
    case 'array':
      return checkArray(schema, value, where, depth);
    case 'object':
      return checkObject(schema.fields, value, where, depth);
    case 'map':
      return checkMap(schema, value, where, depth);
    case 'variant':
      return checkVariant(schema, value, where, depth);
    case 'json':
      return value === undefined ? `${where}: a value is required` : undefined;
    default: {
      const exhaustive: never = schema;
      return exhaustive;
    }
  }
}

function checkNumber(
  value: unknown,
  range: { readonly min: number; readonly max: number; readonly whole: 'integer' | 'number' },
  where: string,
): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return `${where}: expected a number`;
  }
  if (range.whole === 'integer' && !Number.isSafeInteger(value)) {
    return `${where}: expected a whole number`;
  }
  return value >= range.min && value <= range.max ? undefined : `${where}: must be between ${range.min} and ${range.max}`;
}

function checkString(schema: Extract<ValueSchema, { readonly kind: 'string' }>, value: unknown, where: string): string | undefined {
  if (typeof value !== 'string') {
    return `${where}: expected text`;
  }
  const charsMin = schema.charsMin ?? 0;
  if (value.length < charsMin || value.length > schema.charsMax) {
    return `${where}: must be ${charsMin} to ${schema.charsMax} characters`;
  }
  if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
    return `${where}: does not match ${schema.pattern}`;
  }
  return undefined;
}

function checkArray(schema: Extract<ValueSchema, { readonly kind: 'array' }>, value: unknown, where: string, depth: number): string | undefined {
  const items = toArray(value);
  if (items === undefined) {
    return `${where}: expected a list`;
  }
  if (items.length > schema.itemsMax) {
    return `${where}: at most ${schema.itemsMax} entries`;
  }
  for (const [index, item] of items.entries()) {
    const reason = checkValue(schema.item, item, `${where}[${index}]`, depth + 1);
    if (reason !== undefined) {
      return reason;
    }
  }
  if (schema.unique === true && new Set(items.map((item) => JSON.stringify(item))).size !== items.length) {
    return `${where}: entries must be unique`;
  }
  return undefined;
}

function checkObject(fields: Readonly<Record<string, FieldSchema>>, value: unknown, where: string, depth: number): string | undefined {
  const source = toRecord(value);
  if (source === undefined) {
    return `${where}: expected an object`;
  }
  for (const [key, entry] of Object.entries(source)) {
    const known = fields[key];
    if (known === undefined || known.legacy === true) {
      return `${where}.${key}: unknown key (known: ${settableKeys(fields).join(', ')})`;
    }
    const reason = checkValue(known.type, entry, `${where}.${key}`, depth + 1);
    if (reason !== undefined) {
      return reason;
    }
  }
  for (const [key, entry] of Object.entries(fields)) {
    if (entry.required && source[key] === undefined) {
      return `${where}.${key}: required`;
    }
  }
  return undefined;
}

function checkMap(schema: Extract<ValueSchema, { readonly kind: 'map' }>, value: unknown, where: string, depth: number): string | undefined {
  const source = toRecord(value);
  if (source === undefined) {
    return `${where}: expected an object keyed by ${schema.keyDescription}`;
  }
  const entries = Object.entries(source);
  if (entries.length > schema.entriesMax) {
    return `${where}: at most ${schema.entriesMax} entries`;
  }
  for (const [key, entry] of entries) {
    const keyReason = checkMapKey(schema, key, where);
    if (keyReason !== undefined) {
      return keyReason;
    }
    const reason = checkValue(schema.value, entry, `${where}[${JSON.stringify(key)}]`, depth + 1);
    if (reason !== undefined) {
      return reason;
    }
  }
  return undefined;
}

/** Why `key` cannot name an entry of the map, or undefined. Also refuses names that would reach an object's prototype. */
export function checkMapKey(schema: Extract<ValueSchema, { readonly kind: 'map' }>, key: string, where: string): string | undefined {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
    return `${where}: ${JSON.stringify(key)} is not a usable key`;
  }
  if (key.length === 0 || key.length > 512) {
    return `${where}: a key is 1 to 512 characters (${schema.keyDescription})`;
  }
  if (schema.keyPattern !== undefined && !new RegExp(schema.keyPattern, 'u').test(key)) {
    return `${where}: key ${JSON.stringify(key)} is not ${schema.keyDescription}`;
  }
  return undefined;
}

function checkVariant(schema: Extract<ValueSchema, { readonly kind: 'variant' }>, value: unknown, where: string, depth: number): string | undefined {
  const source = toRecord(value);
  if (source === undefined) {
    return `${where}: expected an object`;
  }
  const tag = source[schema.tag];
  const fields = typeof tag === 'string' && Object.hasOwn(schema.variants, tag) ? schema.variants[tag] : undefined;
  if (fields === undefined) {
    return `${where}.${schema.tag}: expected one of ${Object.keys(schema.variants).join(', ')}`;
  }
  return checkObject(
    { [schema.tag]: { type: oneOf(...Object.keys(schema.variants)), description: 'The variant.', required: true }, ...fields },
    value,
    where,
    depth,
  );
}

/** The keys of `fields` a person can set, in declaration order. */
export function settableKeys(fields: Readonly<Record<string, FieldSchema>>): readonly string[] {
  return Object.entries(fields)
    .filter(([, entry]) => entry.legacy !== true)
    .map(([key]) => key);
}

/** A short type name for a human reference line: `integer 2..32`, `enum a|b`, `list of text`. */
export function describeType(schema: ValueSchema, depth: number = 0): string {
  if (depth > SCHEMA_LIMITS.depthMax) {
    return 'nested';
  }
  switch (schema.kind) {
    case 'boolean':
      return 'boolean';
    case 'integer':
      return `integer ${schema.min}..${schema.max}`;
    case 'number':
      return `number ${schema.min}..${schema.max}`;
    case 'string':
      return `text up to ${schema.charsMax} characters`;
    case 'enum':
      return `one of ${schema.values.join(' | ')}`;
    case 'literal':
      return `exactly ${JSON.stringify(schema.value)}`;
    case 'array':
      return `list (at most ${schema.itemsMax}) of ${describeType(schema.item, depth + 1)}`;
    case 'object':
      return 'object';
    case 'map':
      return `map of ${schema.keyDescription} to ${describeType(schema.value, depth + 1)} (at most ${schema.entriesMax})`;
    case 'variant':
      return `object tagged by "${schema.tag}": ${Object.keys(schema.variants).join(' | ')}`;
    case 'json':
      return `JSON (${schema.reason})`;
    default: {
      const exhaustive: never = schema;
      return exhaustive;
    }
  }
}

/** The schema of the value at `segments`, walking objects, maps, arrays and variants; undefined when the path names no key. */
export function schemaAt(
  root: FileSchema,
  segments: readonly (string | number)[],
  document: unknown,
): { readonly type: ValueSchema; readonly field?: FieldSchema } | undefined {
  let current: ValueSchema = { kind: 'object', fields: root.fields };
  let currentField: FieldSchema | undefined;
  let currentValue: unknown = document;
  for (const segment of segments) {
    const step = stepInto(current, segment, currentValue);
    if (step === undefined) {
      return undefined;
    }
    current = step.type;
    currentField = step.field ?? currentField;
    currentValue = toRecord(currentValue)?.[String(segment)] ?? toArray(currentValue)?.[Number(segment)];
  }
  return currentField === undefined ? { type: current } : { type: current, field: currentField };
}

function stepInto(schema: ValueSchema, segment: string | number, value: unknown): { readonly type: ValueSchema; readonly field?: FieldSchema } | undefined {
  if (schema.kind === 'object' && typeof segment === 'string') {
    const known = Object.hasOwn(schema.fields, segment) ? schema.fields[segment] : undefined;
    return known === undefined || known.legacy === true ? undefined : { type: known.type, field: known };
  }
  if (schema.kind === 'variant' && typeof segment === 'string') {
    const tag = toRecord(value)?.[schema.tag];
    const fields = typeof tag === 'string' && Object.hasOwn(schema.variants, tag) ? schema.variants[tag] : undefined;
    if (segment === schema.tag) {
      return { type: oneOf(...Object.keys(schema.variants)), field: field(oneOf(...Object.keys(schema.variants)), 'The variant.', { required: true }) };
    }
    const known = fields !== undefined && Object.hasOwn(fields, segment) ? fields[segment] : undefined;
    return known === undefined ? undefined : { type: known.type, field: known };
  }
  if (schema.kind === 'map' && typeof segment === 'string') {
    return { type: schema.value };
  }
  if (schema.kind === 'array' && typeof segment === 'number') {
    return { type: schema.item };
  }
  return undefined;
}
