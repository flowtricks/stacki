// App storage: what an app keeps between runs (docs/apps.md, "Storage"), read and
// written with `stacki.storage.*`. This module is the contract both hosts and
// both stores share: the scopes, the key grammar, every bound, the on-disk file
// format, and the change notice a store sends when a value moves.
//
// Two scopes:
// - `project` values live in the project, one file per app at
//   `.stacki/app-data/<id>.json`, so they commit, merge and pull with it. Not
//   under `.stacki/apps/<id>/`: that folder is the app's bundle, replaced whole
//   on every update (electron/project/appStore.ts installAppBundle) and read
//   whole by a share, so data there would be lost on update or published with
//   the app's code.
// - `local` values are this person's, in the editor's own storage (Desktop's
//   user data; a Studio's per-person folder in its user's home): never committed.
//
// The file is one JSON object of string values with sorted keys, one per line,
// so two people changing different keys merge cleanly in Git.
import { assert } from '../core/assert';
import { record, text } from '../core/boundary';
import { parseAppId } from './apps';

/** Where project-scoped values live: one file per app, beside (not inside) the bundles. */
export const APP_DATA_DIRECTORY = '.stacki/app-data';

export const APP_STORAGE_SCOPES = ['project', 'local'] as const;
export type AppStorageScope = (typeof APP_STORAGE_SCOPES)[number];

export const APP_STORAGE_LIMITS = {
  /** One value, in UTF-8 bytes. */
  valueBytesMax: 256 * 1024,
  /** One app's keys and values together in one scope, in UTF-8 bytes. */
  appBytesMax: 4 * 1024 * 1024,
  /** Keys one app keeps in one scope. */
  keysMax: 1000,
  /** A key's length, slashes included. */
  keyCharsMax: 128,
  /** Path segments in one key (`pins/hero/1` is three). */
  keySegmentsMax: 8,
  /** One file's size: the app bound and the JSON quoting, escaping and layout around it. */
  fileBytesMax: 4 * 1024 * 1024 * 2 + 64 * 1024,
  /** Keys one change notice names; past it, the notice says "many" and an app reads again. */
  changeKeysMax: 64,
  /** A writer token: which editor window or browser tab wrote a value. */
  writerCharsMax: 64,
} as const satisfies Record<string, number>;

/** One app's values in one scope, by key. */
export type AppStorageValues = ReadonlyMap<string, string>;

/**
 * A value moved in a store. `keys` is undefined when more than
 * APP_STORAGE_LIMITS.changeKeysMax moved at once (a pull): read them again.
 * `writer` is the token the write carried, or undefined for a change from
 * outside the editor (Git, a teammate, another program).
 */
export interface AppStorageChange {
  readonly appId: string;
  readonly scope: AppStorageScope;
  readonly keys: readonly string[] | undefined;
  readonly writer: string | undefined;
}

const KEY_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const WRITER = /^[A-Za-z0-9_-]+$/;
const FILE_VERSION = 1;

/** A scope as an app names it; absent is `project`. */
export function parseAppStorageScope(input: unknown): AppStorageScope {
  if (input === undefined) {
    return 'project';
  }
  const found = APP_STORAGE_SCOPES.find((scope) => scope === input);
  if (found === undefined) {
    throw new Error(`scope must be one of ${APP_STORAGE_SCOPES.join(', ')}`);
  }
  return found;
}

/** A key named like a path: segments of letters, digits, `.`, `_` and `-`, joined by `/`; no segment starts with `.`. */
export function parseAppStorageKey(input: unknown): string {
  const key = text(input);
  if (key.length === 0 || key.length > APP_STORAGE_LIMITS.keyCharsMax) {
    throw new Error(`A storage key is 1 to ${APP_STORAGE_LIMITS.keyCharsMax} characters`);
  }
  const segments = key.split('/');
  if (segments.length > APP_STORAGE_LIMITS.keySegmentsMax) {
    throw new Error(`A storage key has at most ${APP_STORAGE_LIMITS.keySegmentsMax} segments`);
  }
  for (const segment of segments) {
    if (!KEY_SEGMENT.test(segment)) {
      throw new Error(`"${key.slice(0, 40)}" is not a storage key: use letters, digits, ., _ and - in segments joined by /`);
    }
  }
  // The segment grammar already refuses these; a key must never climb or stand still on a path.
  assert(
    segments.every((segment) => segment !== '..' && segment !== '.'),
    'A key never names . or ..',
  );
  return key;
}

/** A value: any string up to APP_STORAGE_LIMITS.valueBytesMax UTF-8 bytes. */
export function parseAppStorageValue(input: unknown): string {
  const value = text(input);
  if (utf8Bytes(value) > APP_STORAGE_LIMITS.valueBytesMax) {
    throw new Error(`A storage value is at most ${APP_STORAGE_LIMITS.valueBytesMax} bytes`);
  }
  return value;
}

/** A writer token an editor made up for itself. */
export function parseAppStorageWriter(input: unknown): string {
  const writer = text(input);
  if (writer.length === 0 || writer.length > APP_STORAGE_LIMITS.writerCharsMax || !WRITER.test(writer)) {
    throw new Error('A storage writer is 1 to 64 letters, digits, _ and -');
  }
  return writer;
}

/** The bytes a scope's values count against APP_STORAGE_LIMITS.appBytesMax: each key and value, in UTF-8. */
export function appStorageBytes(values: AppStorageValues): number {
  let bytes = 0;
  for (const [key, value] of values) {
    bytes += utf8Bytes(key) + utf8Bytes(value);
  }
  return bytes;
}

/**
 * The values after setting `key` (or removing it, for undefined), or the reason
 * the change does not fit: too many keys, or too many bytes. An expected
 * failure, so a value, not a throw.
 */
export function nextAppStorageValues(
  values: AppStorageValues,
  key: string,
  value: string | undefined,
): { readonly ok: true; readonly values: AppStorageValues } | { readonly ok: false; readonly reason: string } {
  const next = new Map(values);
  if (value === undefined) {
    next.delete(key);
    return { ok: true, values: next };
  }
  next.set(key, value);
  if (next.size > APP_STORAGE_LIMITS.keysMax) {
    return { ok: false, reason: `An app keeps at most ${APP_STORAGE_LIMITS.keysMax} keys in one scope; remove some first` };
  }
  const bytes = appStorageBytes(next);
  if (bytes > APP_STORAGE_LIMITS.appBytesMax) {
    return { ok: false, reason: `An app keeps at most ${APP_STORAGE_LIMITS.appBytesMax} bytes in one scope; this would make ${bytes}` };
  }
  assert(next.get(key) === value, 'The set value is the one kept');
  return { ok: true, values: next };
}

/** Reads a storage file's text: every key and value parsed, and the scope's bounds held. */
export function parseAppStorageSource(source: string): AppStorageValues {
  if (utf8Bytes(source) > APP_STORAGE_LIMITS.fileBytesMax) {
    throw new Error(`An app storage file exceeds ${APP_STORAGE_LIMITS.fileBytesMax} bytes`);
  }
  const file = record(JSON.parse(source) as unknown);
  if (file['version'] !== FILE_VERSION) {
    throw new Error(`An app storage file is version ${FILE_VERSION}`);
  }
  const entries = Object.entries(record(file['values']));
  if (entries.length > APP_STORAGE_LIMITS.keysMax) {
    throw new Error(`An app storage file holds at most ${APP_STORAGE_LIMITS.keysMax} keys`);
  }
  const values = new Map<string, string>();
  for (const [key, value] of entries) {
    values.set(parseAppStorageKey(key), parseAppStorageValue(value));
  }
  if (appStorageBytes(values) > APP_STORAGE_LIMITS.appBytesMax) {
    throw new Error(`An app storage file holds at most ${APP_STORAGE_LIMITS.appBytesMax} bytes of values`);
  }
  return values;
}

/** The file's text: sorted keys, one per line, so different keys merge cleanly. */
export function serializeAppStorage(values: AppStorageValues): string {
  assert(values.size <= APP_STORAGE_LIMITS.keysMax, 'Stored keys are bounded');
  const sorted: Record<string, string> = {};
  for (const key of [...values.keys()].sort()) {
    const value = values.get(key);
    assert(value !== undefined, 'A sorted key has its value');
    sorted[key] = value;
  }
  return `${JSON.stringify({ version: FILE_VERSION, values: sorted }, undefined, 2)}\n`;
}

/** The keys that differ between two readings of one scope: added, changed or removed. */
export function changedAppStorageKeys(before: AppStorageValues, after: AppStorageValues): readonly string[] {
  const changed = new Set<string>();
  for (const [key, value] of after) {
    if (before.get(key) !== value) {
      changed.add(key);
    }
  }
  for (const key of before.keys()) {
    if (!after.has(key)) {
      changed.add(key);
    }
  }
  assert(changed.size <= before.size + after.size, 'Changed keys come from the two readings');
  return [...changed].sort();
}

/** A change notice as it crosses a process or the network. */
export function parseAppStorageChange(input: unknown): AppStorageChange {
  const value = record(input);
  const keys = value['keys'];
  let parsedKeys: readonly string[] | undefined;
  if (keys === undefined) {
    parsedKeys = undefined;
  } else {
    if (!Array.isArray(keys) || keys.length > APP_STORAGE_LIMITS.changeKeysMax) {
      throw new Error(`A storage change names at most ${APP_STORAGE_LIMITS.changeKeysMax} keys`);
    }
    parsedKeys = keys.map(parseAppStorageKey);
  }
  return {
    appId: parseAppId(value['appId']),
    scope: parseAppStorageScope(value['scope']),
    keys: parsedKeys,
    writer: value['writer'] === undefined ? undefined : parseAppStorageWriter(value['writer']),
  };
}

/** The notice for `keys` moved: the keys themselves, or "many" past the bound. */
export function appStorageChange(appId: string, scope: AppStorageScope, keys: readonly string[], writer: string | undefined): AppStorageChange {
  assert(keys.length > 0, 'A change names what moved');
  return { appId, scope, keys: keys.length > APP_STORAGE_LIMITS.changeKeysMax ? undefined : keys, writer };
}

const encoder = new TextEncoder();

function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}
