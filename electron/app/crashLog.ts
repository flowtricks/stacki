// The record of what went wrong with the app window and the main process: a bounded ring, kept in memory and on disk.
//
// Why on disk: a crash that ends the app takes the memory with it, and "it went black, then it closed" is the report
// that cannot be acted on without it. Why a ring: the log is written at the worst moments (a crash loop) and must
// not itself become the next problem, so it keeps the newest `entriesMax` records and each field is cut to its bound.
// What it holds: a time, a source, a reason and a detail (an error's message and top frames, a URL). No page content,
// no project file text, no account data. Paths appear because error messages carry them; the home directory is
// written as `~` so a shared log does not name the person.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assert } from '../../shared/core/assert';

export const CRASH_LOG_LIMITS = {
  /** Records kept; the oldest is dropped first. */
  entriesMax: 50,
  /** Characters of one record's reason. */
  reasonCharsMax: 500,
  /** Characters of one record's detail (an error message and its first frames). */
  detailCharsMax: 4_000,
  /** Bytes of the file read back; a larger file is damaged or foreign and is not trusted. */
  fileBytesMax: 1_048_576,
} as const satisfies Record<string, number>;

export const CRASH_SOURCES = ['load-failed', 'renderer-gone', 'unresponsive', 'child-gone', 'main-error', 'renderer-error', 'reload-loop'] as const;
export type CrashSource = (typeof CRASH_SOURCES)[number];

export interface CrashRecord {
  readonly atMs: number;
  readonly source: CrashSource;
  readonly reason: string;
  readonly detail: string;
}

export const CRASH_LOG_FILE = 'crash-log.json';

/** `log` with `entry` appended, cut to the ring's bounds. Pure: the input is not changed. */
export function appendCrash(log: readonly CrashRecord[], entry: CrashRecord, homeDirectory: string | undefined): readonly CrashRecord[] {
  assert(log.length <= CRASH_LOG_LIMITS.entriesMax, 'A crash log stays inside its ring');
  assert(Number.isFinite(entry.atMs), 'A crash record has a time');
  const bounded: CrashRecord = {
    atMs: entry.atMs,
    source: entry.source,
    reason: redactHome(entry.reason, homeDirectory).slice(0, CRASH_LOG_LIMITS.reasonCharsMax),
    detail: redactHome(entry.detail, homeDirectory).slice(0, CRASH_LOG_LIMITS.detailCharsMax),
  };
  const next = [...log, bounded].slice(-CRASH_LOG_LIMITS.entriesMax);
  assert(next.length <= CRASH_LOG_LIMITS.entriesMax, 'An appended crash log is still inside its ring');
  return next;
}

/** The records in `text`, newest last. A damaged file, or a damaged entry in one, yields what is valid and no error: the log must never block a start. */
export function parseCrashLog(text: string): readonly CrashRecord[] {
  assert(typeof text === 'string', 'A crash log is read from text');
  assert(CRASH_LOG_LIMITS.entriesMax > 0, 'A crash log has room');
  if (text.length > CRASH_LOG_LIMITS.fileBytesMax) {
    return [];
  }
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(input)) {
    return [];
  }
  const records: CrashRecord[] = [];
  for (const candidate of input.slice(-CRASH_LOG_LIMITS.entriesMax)) {
    const parsed = parseCrashRecord(candidate);
    if (parsed !== undefined) {
      records.push(parsed);
    }
  }
  return records;
}

export function serializeCrashLog(log: readonly CrashRecord[]): string {
  assert(log.length <= CRASH_LOG_LIMITS.entriesMax, 'A crash log written is inside its ring');
  return JSON.stringify(log);
}

/** Plain text for the Copy details button: the newest records first, one block each. */
export function describeCrashLog(log: readonly CrashRecord[]): string {
  assert(log.length <= CRASH_LOG_LIMITS.entriesMax, 'A crash log described is inside its ring');
  return [...log]
    .reverse()
    .map((entry) => `${new Date(entry.atMs).toISOString()} ${entry.source}: ${entry.reason}${entry.detail === '' ? '' : `\n${entry.detail}`}`)
    .join('\n\n');
}

/** The log stored in `directory`, or empty when there is none or it cannot be read. */
export function readCrashLog(directory: string): readonly CrashRecord[] {
  try {
    const file = path.join(directory, CRASH_LOG_FILE);
    if (fs.statSync(file).size > CRASH_LOG_LIMITS.fileBytesMax) {
      return [];
    }
    return parseCrashLog(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

/** Stores `log` in `directory`. Failure is reported by the return value, never thrown: writing the log must not cause a crash. */
export function writeCrashLog(directory: string, log: readonly CrashRecord[]): boolean {
  try {
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, CRASH_LOG_FILE);
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, serializeCrashLog(log), 'utf8');
    fs.renameSync(temporary, file);
    return true;
  } catch {
    return false;
  }
}

function parseCrashRecord(input: unknown): CrashRecord | undefined {
  if (typeof input !== 'object' || input === undefined || input === null) {
    return undefined;
  }
  const atMs: unknown = Reflect.get(input, 'atMs');
  const source: unknown = Reflect.get(input, 'source');
  const reason: unknown = Reflect.get(input, 'reason');
  const detail: unknown = Reflect.get(input, 'detail');
  if (typeof atMs !== 'number' || !Number.isFinite(atMs)) {
    return undefined;
  }
  const knownSource = CRASH_SOURCES.find((candidate) => candidate === source);
  if (knownSource === undefined || typeof reason !== 'string' || typeof detail !== 'string') {
    return undefined;
  }
  return {
    atMs,
    source: knownSource,
    reason: reason.slice(0, CRASH_LOG_LIMITS.reasonCharsMax),
    detail: detail.slice(0, CRASH_LOG_LIMITS.detailCharsMax),
  };
}

function redactHome(value: string, homeDirectory: string | undefined): string {
  if (homeDirectory === undefined || homeDirectory.length < 2) {
    return value;
  }
  return value.split(homeDirectory).join('~');
}
