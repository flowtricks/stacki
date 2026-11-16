// i18n-ignore-file: the CLI and its MCP tools speak to agents and scripts in English; none of this is interface text.
// The generic key-level edit behind `stacki config get|set|unset|add|remove`: a pure function from a parsed `.stacki` document
// and one operation to the next document, judged by the file's key registry (stackiSchema.ts).
//
// Why pure and registry-judged: every settable key of every file is reachable through here, so the rules that stop a bad edit
// (unknown key, wrong type, out of bounds, a required key removed) live in one function, not in each command. The caller then
// hands the finished text to the app's own parser (`validateMetadata`), which stays the last word on what the app will accept.
import { toArray, toRecord } from '../../core/record';
import { err, ok, type Result } from '../../core/result';
import type { CliError } from './stackiOutput';
import type { PathSegment } from './stackiConfigPath';
import { formatConfigPath } from './stackiConfigPath';
import { checkMapKey, checkValue, schemaAt, settableKeys, describeType, type FieldSchema, type FileSchema, type ValueSchema } from './stackiSchema';

export type ConfigOperation =
  | { readonly kind: 'set'; readonly path: readonly PathSegment[]; readonly value: unknown }
  | { readonly kind: 'unset'; readonly path: readonly PathSegment[] }
  /** Appends to the list at `path`, or creates the new map entry `path` names; refuses an entry that already exists. */
  | { readonly kind: 'add'; readonly path: readonly PathSegment[]; readonly value: unknown; readonly position?: number }
  /** Removes the list entry equal to `value` from the list at `path`, or the entry (list position, map key, optional key) `path` names. */
  | { readonly kind: 'remove'; readonly path: readonly PathSegment[]; readonly value?: unknown };

export interface ConfigRead {
  readonly path: string;
  readonly value?: unknown;
  readonly type: string;
  readonly description?: string;
  readonly default?: string | number | boolean;
  readonly present: boolean;
}

type Container = Record<string, unknown> | unknown[];

/** The document after `operation`, or why it is refused. The input document is never changed. */
export function applyConfigOperation(file: FileSchema, document: unknown, operation: ConfigOperation): Result<Record<string, unknown>, CliError> {
  const root = toRecord(document);
  if (root === undefined) {
    return refusal('invalid-file', `${file.file}: the file is not a JSON object`);
  }
  const next: Record<string, unknown> = structuredClone(root);
  const path = operation.path;
  if (path.length === 0) {
    return refusal('bad-path', 'A path is required: name a key such as "visible", or use "stacki schema" to list them');
  }
  const known = schemaAt(file, path, next);
  if (known === undefined && !mapEntryAllowed(file, path, next)) {
    return unknownKey(file, path, next);
  }
  const done = run(file, next, operation);
  if (!done.ok) {
    return done;
  }
  const top = path[0];
  if (typeof top !== 'string') {
    return refusal('bad-path', 'A path starts with a key');
  }
  const field = Object.hasOwn(file.fields, top) ? file.fields[top] : undefined;
  if (field === undefined || field.legacy === true) {
    return unknownKey(file, path, next);
  }
  const value = next[top];
  if (value === undefined) {
    return field.required ? refusal('required', `${top} is required and cannot be removed`) : ok(next);
  }
  const reason = checkValue(field.type, value, top);
  return reason === undefined ? ok(next) : refusal(reason.endsWith(': required') ? 'required' : 'invalid-value', reason);
}

/** What the file holds at `path`, with the key's type and description from the registry. */
export function readConfigValue(file: FileSchema, document: unknown, path: readonly PathSegment[]): Result<ConfigRead, CliError> {
  const root = toRecord(document) ?? {};
  if (path.length === 0) {
    return ok({ path: '', value: root, type: 'object', description: file.description, present: true });
  }
  const known = schemaAt(file, path, root);
  if (known === undefined && !mapEntryAllowed(file, path, root)) {
    return unknownKey(file, path, root);
  }
  const value = valueAt(root, path);
  const type = known === undefined ? 'a map entry' : describeType(known.type);
  const text = formatConfigPath(path);
  return ok({
    path: text,
    ...(value === undefined ? {} : { value }),
    type,
    ...(known?.field === undefined ? {} : { description: known.field.description }),
    ...(known?.field?.default === undefined ? {} : { default: known.field.default }),
    present: value !== undefined,
  });
}

function mapEntryAllowed(file: FileSchema, path: readonly PathSegment[], document: unknown): boolean {
  // A map's entries are listed by their parent's schema: `components["New.astro"]` names no entry yet but is a valid place.
  const parent = path.length === 1 ? { type: { kind: 'object', fields: file.fields } satisfies ValueSchema } : schemaAt(file, path.slice(0, -1), document);
  const last = path[path.length - 1];
  return parent?.type.kind === 'map' && typeof last === 'string' && checkMapKey(parent.type, last, formatConfigPath(path)) === undefined;
}

function run(file: FileSchema, next: Record<string, unknown>, operation: ConfigOperation): Result<void, CliError> {
  const path = operation.path;
  const last = path[path.length - 1];
  if (last === undefined) {
    return refusal('bad-path', 'A path is required');
  }
  if (operation.kind === 'add' || operation.kind === 'remove') {
    const target = valueAt(next, path);
    if (Array.isArray(target)) {
      return operation.kind === 'add' ? addToList(target, operation) : removeFromList(target, operation);
    }
  }
  const parent = operation.kind === 'set' || operation.kind === 'add' ? ensureParent(next, path) : valueAt(next, path.slice(0, -1));
  const container = toContainer(parent);
  if (container === undefined) {
    return refusal('missing', `${formatConfigPath(path.slice(0, -1))} does not exist in ${file.file}`);
  }
  switch (operation.kind) {
    case 'set':
      return assign(container, last, operation.value, 'replace');
    case 'add':
      return assign(container, last, operation.value, 'create');
    case 'unset':
    case 'remove':
      return removeEntry(container, last, formatConfigPath(path));
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}

function addToList(list: unknown[], operation: Extract<ConfigOperation, { readonly kind: 'add' }>): Result<void, CliError> {
  const position = operation.position ?? list.length;
  if (!Number.isSafeInteger(position) || position < 0 || position > list.length) {
    return refusal('invalid-value', `The position must be 0 to ${list.length}`);
  }
  list.splice(position, 0, operation.value);
  return ok(undefined);
}

function removeFromList(list: unknown[], operation: Extract<ConfigOperation, { readonly kind: 'remove' }>): Result<void, CliError> {
  if (operation.value === undefined) {
    return refusal('usage', `Name the entry to remove from ${formatConfigPath(operation.path)}: a value, or a path with a position such as [0]`);
  }
  const wanted = JSON.stringify(operation.value);
  const index = list.findIndex((entry) => JSON.stringify(entry) === wanted);
  if (index < 0) {
    return refusal('missing', `${formatConfigPath(operation.path)} has no entry equal to ${wanted}`);
  }
  list.splice(index, 1);
  return ok(undefined);
}

function assign(container: Container, key: PathSegment, value: unknown, mode: 'replace' | 'create'): Result<void, CliError> {
  if (Array.isArray(container)) {
    if (typeof key !== 'number' || key > container.length) {
      return refusal('bad-path', `A list position must be 0 to ${container.length}`);
    }
    if (mode === 'create' || key === container.length) {
      container.splice(key, 0, value);
    } else {
      Reflect.set(container, key, value);
    }
    return ok(undefined);
  }
  const name = String(key);
  if (mode === 'create' && Object.hasOwn(container, name)) {
    return refusal('exists', `${name} already exists; use "set" to replace it`);
  }
  Reflect.set(container, name, value);
  return ok(undefined);
}

function removeEntry(container: Container, key: PathSegment, shown: string): Result<void, CliError> {
  if (Array.isArray(container)) {
    if (typeof key !== 'number' || key >= container.length) {
      return refusal('missing', `${shown} does not exist`);
    }
    container.splice(key, 1);
    return ok(undefined);
  }
  if (!Object.hasOwn(container, String(key))) {
    return refusal('missing', `${shown} is not set`);
  }
  // Removal is the one place a key leaves the document, by name, never by index arithmetic.
  Reflect.deleteProperty(container, String(key));
  return ok(undefined);
}

function ensureParent(document: Record<string, unknown>, path: readonly PathSegment[]): unknown {
  let current: unknown = document;
  for (const [index, segment] of path.slice(0, -1).entries()) {
    const container = toContainer(current);
    if (container === undefined) {
      return undefined;
    }
    const existing = Array.isArray(container) ? container[Number(segment)] : container[String(segment)];
    if (existing === undefined) {
      if (typeof path[index + 1] === 'number') {
        return undefined;
      }
      const created: Record<string, unknown> = {};
      if (Array.isArray(container)) {
        container[Number(segment)] = created;
      } else {
        container[String(segment)] = created;
      }
      current = created;
    } else {
      current = existing;
    }
  }
  return current;
}

function valueAt(document: unknown, path: readonly PathSegment[]): unknown {
  let current: unknown = document;
  for (const segment of path) {
    const list = toArray(current);
    const record = toRecord(current);
    if (list !== undefined && typeof segment === 'number') {
      current = list[segment];
    } else if (record !== undefined && typeof segment === 'string' && Object.hasOwn(record, segment)) {
      current = record[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function toContainer(value: unknown): Container | undefined {
  return toArray(value) ?? toRecord(value);
}

function unknownKey(file: FileSchema, path: readonly PathSegment[], document: unknown): Result<never, CliError> {
  const parentPath = path.slice(0, -1);
  const parent = parentPath.length === 0 ? { type: { kind: 'object', fields: file.fields } satisfies ValueSchema } : schemaAt(file, parentPath, document);
  const siblings = parent === undefined ? undefined : knownKeysOf(parent.type, document, parentPath);
  const where = siblings === undefined ? '' : ` (known here: ${siblings.join(', ')})`;
  return refusal('unknown-key', `${file.file}: "${formatConfigPath(path)}" is not a setting${where}. Run "stacki schema ${file.id}" for the reference`);
}

function knownKeysOf(type: ValueSchema, document: unknown, parentPath: readonly PathSegment[]): readonly string[] | undefined {
  if (type.kind === 'object') {
    return settableKeys(type.fields);
  }
  if (type.kind === 'variant') {
    const tag = toRecord(valueAt(document, parentPath))?.[type.tag];
    const fields: Readonly<Record<string, FieldSchema>> | undefined =
      typeof tag === 'string' && Object.hasOwn(type.variants, tag) ? type.variants[tag] : undefined;
    return [type.tag, ...(fields === undefined ? [] : settableKeys(fields))];
  }
  return undefined;
}

function refusal(code: CliError['code'], message: string): Result<never, CliError> {
  return err({ code, message });
}
