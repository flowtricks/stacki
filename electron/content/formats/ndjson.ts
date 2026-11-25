// One JSON object per line. The format's whole point is that a line is a
// record, so a record is rewritten by rewriting its line — and every other line
// comes out byte-identical, which is what keeps a five-record file's diff to
// the one record that changed.
//
// Never pretty-printed: a record spread over several lines is several broken
// records.

import { LIMITS } from '../../../shared/core/limits';
import { toRecord, toArray } from '../../../shared/core/record';

interface LineInfo {
  readonly index: number;
  readonly line: string;
  record: unknown;
  readonly error?: boolean;
  removed?: boolean;
}

const parseLine = (line: string, index: number): LineInfo => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('//')) {
    return { index, line, record: undefined };
  }
  let record: unknown;
  try {
    record = JSON.parse(trimmed);
  } catch {
    return { index, line, record: undefined, error: true };
  }
  return { index, line, record };
};

const parseLines = (text: string): LineInfo[] => text.split('\n').map(parseLine);

const parseData = (text: string): unknown[] =>
  parseLines(text)
    .filter((info) => info.record)
    .map((info) => info.record);

const DELETE = Symbol('delete');

export interface Edit {
  readonly path: readonly (string | number)[];
  readonly value?: unknown;
}

const setIn = (target: unknown, path: readonly (string | number)[], value: unknown, depth = 0): unknown => {
  // The path arrives with an edit from the renderer. One deeper than any value that crosses a
  // boundary names nothing a record can hold, so the edit fails rather than the stack.
  if (depth > LIMITS.ipcDepthMax) {
    throw new Error('The edit path is nested too deeply.');
  }
  if (!path.length) {
    return value;
  }
  const [key, ...rest] = path;
  if (key === undefined) {
    return value; // unreachable: path is non-empty here
  }
  const isIndex = typeof key === 'number';
  // JSON's null is a value in the file, but there is nothing inside it to write into: like an
  // absent member, it becomes the container the path asks for.
  const absent = target === undefined || target === null;
  const next = absent ? (isIndex ? [] : {}) : target;
  const list = toArray(next);
  const record = toRecord(next);
  if (!list && !record) {
    // A primitive where the path says container: the untyped write was a
    // silent no-op in sloppy mode; keeping it a no-op keeps this total.
    return next;
  }
  if (rest.length === 0) {
    if (value === DELETE) {
      if (list) {
        list.splice(Number(key), 1);
      } else if (record) {
        delete record[String(key)];
      }
      return next;
    }
    if (list) {
      list[Number(key)] = value;
    } else if (record) {
      record[String(key)] = value;
    }
    return next;
  }
  const child = list ? list[Number(key)] : record?.[String(key)];
  const updated = setIn(child, rest, value, depth + 1);
  if (list) {
    list[Number(key)] = updated;
  } else if (record) {
    record[String(key)] = updated;
  }
  return next;
};

/**
 * Edits are { path: [recordIndex, ...rest], value }, indexed over the records
 * the file holds rather than its lines — blank lines and comments are neither.
 */
function applyEdits(text: string, edits: readonly Edit[]): string {
  if (!edits.length) {
    return text;
  }
  const lines = parseLines(text);
  const records = lines.filter((info) => info.record);
  const touched = new Set<number>();

  for (const { path, value } of edits) {
    const head = path[0];
    if (typeof head !== 'number') {
      continue;
    }
    const entry = records[head];
    if (!entry) {
      continue;
    }
    if (path.length === 1 && value === DELETE) {
      entry.removed = true;
      touched.add(entry.index);
      continue;
    }
    entry.record = setIn(entry.record, path.slice(1), value);
    touched.add(entry.index);
  }

  return lines
    .filter((info) => !info.removed)
    .map((info) => (touched.has(info.index) ? JSON.stringify(info.record) : info.line))
    .join('\n');
}

export { parseData, applyEdits, DELETE };
