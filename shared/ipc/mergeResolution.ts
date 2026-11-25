import { list, optional, record, text } from '../core/boundary';
import type { WireConflictPart } from './ipcWire';

export type MergePick = 'ours' | 'theirs' | 'both' | 'merged';
export type MergeTextResolution = {
  readonly kind: 'text';
  readonly text: string;
  readonly expected: string;
  readonly expectedBranch: string | undefined;
};
export type MergeResolution = 'ours' | 'theirs' | readonly MergePick[] | MergeTextResolution;

export function parseMergePick(input: unknown): MergePick {
  if (input === 'ours' || input === 'theirs' || input === 'both' || input === 'merged') {
    return input;
  }
  throw new Error('Merge resolution: unknown choice');
}

export function parseMergeResolution(input: unknown): MergeResolution {
  if (input === 'ours' || input === 'theirs') {
    return input;
  }
  if (Array.isArray(input)) {
    return list(parseMergePick)(input);
  }
  const value = record(input);
  if (value['kind'] !== 'text') {
    throw new Error('Merge resolution: expected text result');
  }
  return {
    kind: 'text',
    text: text(value['text']),
    expected: text(value['expected']),
    expectedBranch: optional(text)(value['expectedBranch']),
  };
}

// Canonical tuples avoid object-property order differences across IPC. Comparing
// the complete parts also protects unchanged context from a stale result editor.
export function mergeConflictSnapshot(parts: readonly WireConflictPart[]): string {
  return text(
    JSON.stringify(
      parts.map((part) =>
        part.kind === 'same'
          ? ['same', part.text]
          : ['clash', part.ours, part.theirs, part.changedBy, part.merged === undefined ? 'uncombined' : 'combined', part.merged ?? ''],
      ),
    ),
  );
}
