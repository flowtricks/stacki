// Boundary parsing for everything the release helpers read from gh, npm and the network
// (AGENTS.md §2): text becomes `unknown`, and each field is checked once, as a value, before use.
// Every reader returns a Result, so a malformed or missing field is a reported failure, never a
// thrown TypeError halfway through a release.

import { fail, ok, type Result } from './releaseResult.mts';

export const JSON_LIMITS = {
  /** One gh or npm answer; the largest is a release's asset list, a few tens of kilobytes. */
  textCharsMax: 4 * 1024 * 1024,
  arrayLengthMax: 2_000,
} as const satisfies Record<string, number>;

export type JsonRecord = Readonly<Record<string, unknown>>;

export function parseJson(text: string, label: string): Result<unknown> {
  if (text.length > JSON_LIMITS.textCharsMax) {
    return fail('json-too-large', `${label}: answer exceeds ${JSON_LIMITS.textCharsMax} characters.`);
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return ok(parsed);
  } catch (error: unknown) {
    return fail('json-malformed', `${label}: not valid JSON (${error instanceof Error ? error.message : String(error)}).`);
  }
}

export function readRecord(value: unknown, label: string): Result<JsonRecord> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('json-shape', `${label}: expected an object.`);
  }
  return ok(Object.fromEntries(Object.entries(value)));
}

export function readList(value: unknown, label: string): Result<readonly unknown[]> {
  if (!Array.isArray(value)) {
    return fail('json-shape', `${label}: expected an array.`);
  }
  if (value.length > JSON_LIMITS.arrayLengthMax) {
    return fail('json-too-large', `${label}: more than ${JSON_LIMITS.arrayLengthMax} entries.`);
  }
  const entries: readonly unknown[] = value;
  return ok(entries);
}

export function readString(record: JsonRecord, key: string, label: string): Result<string> {
  const value = record[key];
  if (typeof value !== 'string') {
    return fail('json-field', `${label}: field "${key}" is missing or not a string.`);
  }
  return ok(value);
}

/** A string that may be absent or null (gh reports a pending conclusion as an empty string or null). */
export function readOptionalString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return undefined;
}

export function readInteger(record: JsonRecord, key: string, label: string): Result<number> {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return fail('json-field', `${label}: field "${key}" is missing or not a safe integer.`);
  }
  return ok(value);
}

export function readBoolean(record: JsonRecord, key: string, label: string): Result<boolean> {
  const value = record[key];
  if (typeof value !== 'boolean') {
    return fail('json-field', `${label}: field "${key}" is missing or not true or false.`);
  }
  return ok(value);
}

/** Parses text as a JSON array and reads each entry as a record. */
export function parseRecordList(text: string, label: string): Result<readonly JsonRecord[]> {
  const parsed = parseJson(text, label);
  if (!parsed.ok) {
    return parsed;
  }
  const list = readList(parsed.value, label);
  if (!list.ok) {
    return list;
  }
  const records: JsonRecord[] = [];
  for (const [index, entry] of list.value.entries()) {
    const record = readRecord(entry, `${label}[${index}]`);
    if (!record.ok) {
      return record;
    }
    records.push(record.value);
  }
  return ok(records);
}

export function parseRecord(text: string, label: string): Result<JsonRecord> {
  const parsed = parseJson(text, label);
  if (!parsed.ok) {
    return parsed;
  }
  return readRecord(parsed.value, label);
}
