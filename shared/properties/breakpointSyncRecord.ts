// `.stacki/breakpoint-sync.json`: what a breakpoint's sync has been told, per breakpoint.
//
//   { "version": 1,
//     "laptop": { "excluded": [{ "file": "src/pages/index.astro", "locator": "2d535645:0" }],
//                 "linked":   [{ "file": "src/styles/site.css",    "locator": "a0446607:1" }],
//                 "appliedAt": "2026-11-15T12:00:00.000Z" } }
//
// Changing a breakpoint in Settings offers to change every `@media` bound that equals its old value (mediaBreakpointSync.ts). A
// bound the person unchecks is `excluded`: it is listed unchecked and labelled "Not synced" on every later sync, never changed
// unless they check it again. A bound that was changed is `linked`, with when. A bound is named by its file (a project-relative
// path with `/`) and its locator, which survives the number changing and lines moving.
//
// It is a tracked project file beside `.stacki/breakpoints.json`, read by Desktop and Studio and committed with the project. A
// missing file is an empty record. A hand-edited or truncated file is an error value: callers sync with nothing excluded, say
// so, and never write over it. Writes are canonical (sorted, deduplicated, two-space indent, trailing newline), so equal records
// are equal bytes, and an unchanged record is not written.
import { assert } from '../core/assert';
import { err, ok, type AppError, type Result } from '../core/result';
import { BREAKPOINT_KEYS, type BreakpointKey } from './projectBreakpoints';

export const BREAKPOINT_SYNC_FILE = '.stacki/breakpoint-sync.json';

export const SYNC_RECORD_LIMITS = {
  fileBytesMax: 512 * 1024,
  /** Excluded or linked places kept for one breakpoint. */
  refsMax: 2_000,
  /** Characters in a project-relative path. */
  fileCharsMax: 512,
  /** Characters in a locator (`2d535645:0`). */
  locatorCharsMax: 32,
} as const satisfies Record<string, number>;

/** One place a bound lives: a project-relative file and the bound's locator. */
export interface SyncRef {
  readonly file: string;
  readonly locator: string;
}

export interface BreakpointSyncEntry {
  readonly excluded: readonly SyncRef[];
  readonly linked: readonly SyncRef[];
  readonly appliedAt: string | undefined;
}

export type BreakpointSyncRecord = Readonly<Record<BreakpointKey, BreakpointSyncEntry>>;

export const EMPTY_SYNC_ENTRY: BreakpointSyncEntry = { excluded: [], linked: [], appliedAt: undefined };

export const EMPTY_SYNC_RECORD: BreakpointSyncRecord = { laptop: EMPTY_SYNC_ENTRY, tablet: EMPTY_SYNC_ENTRY, phone: EMPTY_SYNC_ENTRY };

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const LOCATOR = /^[0-9a-f]{8}:\d{1,6}$/;

/** The file's bytes to a record. `undefined` (no file yet) is the empty record. */
export function parseBreakpointSyncSource(source: string | undefined): Result<BreakpointSyncRecord> {
  if (source === undefined) {
    return ok(EMPTY_SYNC_RECORD);
  }
  if (source.length > SYNC_RECORD_LIMITS.fileBytesMax) {
    return failure('limit', `larger than ${SYNC_RECORD_LIMITS.fileBytesMax} bytes`);
  }
  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch (error: unknown) {
    return failure('unreadable', `not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  return parseBreakpointSyncRecord(input);
}

export function parseBreakpointSyncRecord(input: unknown): Result<BreakpointSyncRecord> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return failure('shape', 'expected an object');
  }
  const fields = new Map<string, unknown>(Object.entries(input));
  if (fields.get('version') !== 1) {
    return failure('version', 'unsupported version, expected 1');
  }
  for (const name of fields.keys()) {
    if (name !== 'version' && !isBreakpointKey(name)) {
      return failure('shape', `unknown field "${name}"`);
    }
  }
  const entries: Partial<Record<BreakpointKey, BreakpointSyncEntry>> = {};
  for (const key of BREAKPOINT_KEYS) {
    const entry = parseEntry(key, fields.get(key));
    if (!entry.ok) {
      return entry;
    }
    entries[key] = entry.value;
  }
  const { laptop, tablet, phone } = entries;
  assert(laptop !== undefined, 'parseBreakpointSyncRecord: laptop was read above');
  assert(tablet !== undefined, 'parseBreakpointSyncRecord: tablet was read above');
  assert(phone !== undefined, 'parseBreakpointSyncRecord: phone was read above');
  return ok({ laptop, tablet, phone });
}

function parseEntry(key: BreakpointKey, input: unknown): Result<BreakpointSyncEntry> {
  if (input === undefined) {
    return ok(EMPTY_SYNC_ENTRY);
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return failure('shape', `${key} must be an object`);
  }
  const fields = new Map<string, unknown>(Object.entries(input));
  for (const name of fields.keys()) {
    if (name !== 'excluded' && name !== 'linked' && name !== 'appliedAt') {
      return failure('shape', `unknown field "${name}" in ${key}`);
    }
  }
  const excluded = parseRefs(key, 'excluded', fields.get('excluded'));
  if (!excluded.ok) {
    return excluded;
  }
  const linked = parseRefs(key, 'linked', fields.get('linked'));
  if (!linked.ok) {
    return linked;
  }
  const appliedAt = fields.get('appliedAt');
  if (appliedAt !== undefined && (typeof appliedAt !== 'string' || !TIMESTAMP.test(appliedAt) || Number.isNaN(Date.parse(appliedAt)))) {
    return failure('timestamp', `${key}.appliedAt must be an ISO time ending in Z`);
  }
  return ok({ excluded: excluded.value, linked: linked.value, appliedAt });
}

function parseRefs(key: BreakpointKey, field: string, input: unknown): Result<readonly SyncRef[]> {
  if (input === undefined) {
    return ok([]);
  }
  if (!Array.isArray(input)) {
    return failure('shape', `${key}.${field} must be an array`);
  }
  if (input.length > SYNC_RECORD_LIMITS.refsMax) {
    return failure('limit', `${key}.${field} holds more than ${SYNC_RECORD_LIMITS.refsMax} places`);
  }
  const refs: SyncRef[] = [];
  // The array is bounded above, so this loop is too.
  for (const item of input) {
    const ref = parseRef(item);
    if (!ref.ok) {
      return failure(ref.error.code.replace('breakpoint-sync-', ''), `${key}.${field}: ${ref.error.message.replace('.stacki/breakpoint-sync.json: ', '')}`);
    }
    refs.push(ref.value);
  }
  return ok(canonicalRefs(refs));
}

function parseRef(input: unknown): Result<SyncRef> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return failure('shape', 'a place must be an object');
  }
  const fields = new Map<string, unknown>(Object.entries(input));
  for (const name of fields.keys()) {
    if (name !== 'file' && name !== 'locator') {
      return failure('shape', `unknown field "${name}" in a place`);
    }
  }
  const file = fields.get('file');
  const locator = fields.get('locator');
  if (typeof file !== 'string' || !isProjectPath(file)) {
    return failure('file', 'a place needs a project-relative file path');
  }
  if (typeof locator !== 'string' || locator.length > SYNC_RECORD_LIMITS.locatorCharsMax || !LOCATOR.test(locator)) {
    return failure('locator', 'a place needs a locator such as 2d535645:0');
  }
  return ok({ file, locator });
}

/** A relative path with `/` separators that stays inside the project. */
export function isProjectPath(file: string): boolean {
  if (file.length === 0 || file.length > SYNC_RECORD_LIMITS.fileCharsMax) {
    return false;
  }
  if (file.startsWith('/') || file.includes('\\') || file.includes('\0')) {
    return false;
  }
  return file.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

/** Sorted and deduplicated, so equal records are equal bytes. */
export function canonicalRefs(refs: readonly SyncRef[]): readonly SyncRef[] {
  const unique = new Map<string, SyncRef>();
  for (const ref of refs) {
    unique.set(`${ref.file}\0${ref.locator}`, ref);
  }
  return [...unique.values()].sort((first, second) => compareText(first.file, second.file) || compareText(first.locator, second.locator));
}

/** A new entry for one breakpoint. Past the bound the oldest places are dropped, never the newest. */
export function withEntry(record: BreakpointSyncRecord, key: BreakpointKey, entry: BreakpointSyncEntry): BreakpointSyncRecord {
  return { ...record, [key]: { excluded: bounded(entry.excluded), linked: bounded(entry.linked), appliedAt: entry.appliedAt } };
}

export function recordsEqual(first: BreakpointSyncRecord, second: BreakpointSyncRecord): boolean {
  return serializeBreakpointSyncRecord(first) === serializeBreakpointSyncRecord(second);
}

/** The canonical file text. An empty record is `{ "version": 1 }`. */
export function serializeBreakpointSyncRecord(record: BreakpointSyncRecord): string {
  const body: Record<string, unknown> = { version: 1 };
  for (const key of BREAKPOINT_KEYS) {
    const entry = record[key];
    assert(entry.excluded.length <= SYNC_RECORD_LIMITS.refsMax, 'serializeBreakpointSyncRecord: excluded within the bound');
    assert(entry.linked.length <= SYNC_RECORD_LIMITS.refsMax, 'serializeBreakpointSyncRecord: linked within the bound');
    if (entry.excluded.length === 0 && entry.linked.length === 0 && entry.appliedAt === undefined) {
      continue;
    }
    const written: Record<string, unknown> = {};
    if (entry.excluded.length > 0) {
      written['excluded'] = canonicalRefs(entry.excluded).map((ref) => ({ file: ref.file, locator: ref.locator }));
    }
    if (entry.linked.length > 0) {
      written['linked'] = canonicalRefs(entry.linked).map((ref) => ({ file: ref.file, locator: ref.locator }));
    }
    if (entry.appliedAt !== undefined) {
      assert(TIMESTAMP.test(entry.appliedAt), 'serializeBreakpointSyncRecord: appliedAt is an ISO time');
      written['appliedAt'] = entry.appliedAt;
    }
    body[key] = written;
  }
  const text = JSON.stringify(body, undefined, 2) + '\n';
  assert(text.length <= SYNC_RECORD_LIMITS.fileBytesMax, 'serializeBreakpointSyncRecord: within the file bound');
  return text;
}

function bounded(refs: readonly SyncRef[]): readonly SyncRef[] {
  const canonical = canonicalRefs(refs);
  return canonical.length > SYNC_RECORD_LIMITS.refsMax ? canonical.slice(canonical.length - SYNC_RECORD_LIMITS.refsMax) : canonical;
}

function compareText(first: string, second: string): number {
  // Code unit order: the same on every machine, unlike a locale-aware compare.
  return first < second ? -1 : first > second ? 1 : 0;
}

function isBreakpointKey(name: string): name is BreakpointKey {
  return BREAKPOINT_KEYS.some((key) => key === name);
}

function failure(code: string, detail: string): Result<never, AppError> {
  return err({ code: `breakpoint-sync-${code}`, message: `.stacki/breakpoint-sync.json: ${detail}` });
}
