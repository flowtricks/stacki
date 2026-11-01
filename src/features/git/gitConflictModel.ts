import type { WireMergeClash, WireConflictPart, WireMergeOutcome } from '../../../shared/ipc/ipcResults';
import type { MergeResolution } from '../../../shared/ipc/mergeResolution';
import { assert } from '../../../shared/core/assert';
import { BOUNDARY_LIMITS } from '../../../shared/core/boundary';

export type Conflict = Extract<WireMergeOutcome, { readonly conflicted: true }>;
export type Clash = Extract<WireConflictPart, { readonly kind: 'clash' }>;
export type ConflictChoice = 'ours' | 'theirs' | 'both' | 'merged';
export type ConflictPicks = Readonly<Record<string, readonly ConflictChoice[]>>;
export type ConflictChoices = Readonly<Record<string, MergeResolution>>;
export interface ConflictHunk {
  readonly clash: Clash;
  readonly index: number;
  readonly before: string | undefined;
  readonly after: string | undefined;
}

export function clashesOf(file: WireMergeClash): readonly Clash[] {
  const parts = file.parts ?? [];
  assert(parts.length <= BOUNDARY_LIMITS.itemsMax, 'Merge conflict: part limit exceeded');
  return parts.filter((part): part is Clash => part.kind === 'clash');
}
export function defaultChoice(clash: Clash): ConflictChoice {
  return clash.merged !== undefined ? 'merged' : clash.changedBy === 'theirs' ? 'theirs' : 'ours';
}
export function contestedIn(file: WireMergeClash): number {
  return clashesOf(file).filter((clash) => clash.changedBy === 'both' && clash.merged === undefined).length;
}
export function initialConflictPicks(conflict: Conflict): ConflictPicks {
  assert(conflict.files.length > 0, 'Merge conflict: at least one file is required');
  assert(conflict.files.length <= BOUNDARY_LIMITS.itemsMax, 'Merge conflict: file limit exceeded');
  return Object.fromEntries(conflict.files.map((file) => [file.path, clashesOf(file).map(defaultChoice)]));
}
export function choicesForSend(conflict: Conflict, picks: ConflictPicks): ConflictChoices {
  assert(conflict.files.length > 0, 'Merge conflict: at least one file is required');
  assert(conflict.files.length <= BOUNDARY_LIMITS.itemsMax, 'Merge conflict: file limit exceeded');
  return Object.fromEntries(
    conflict.files.map((file): readonly [string, 'ours' | 'theirs' | readonly ConflictChoice[]] => {
      const choices = picks[file.path] ?? [];
      if (!file.parts || choices.length === 0) {
        return [file.path, choices[0] === 'theirs' ? 'theirs' : 'ours'];
      }
      assert(choices.length === clashesOf(file).length, 'Merge conflict: choice count changed');
      return [file.path, choices];
    }),
  );
}
export function conflictHunks(parts: readonly WireConflictPart[]): readonly ConflictHunk[] {
  assert(parts.length <= BOUNDARY_LIMITS.itemsMax, 'Merge conflict: part limit exceeded');
  const hunks: ConflictHunk[] = [];
  // One pass pairs each hunk with its adjacent context. Scanning the full parts
  // list once per hunk made rendering quadratic for files with many conflicts.
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    assert(part !== undefined, 'Merge conflict: part index must exist');
    if (part.kind !== 'clash') {
      continue;
    }
    const previous = parts[index - 1];
    const next = parts[index + 1];
    hunks.push({
      clash: part,
      index: hunks.length,
      before: previous?.kind === 'same' ? previous.text.split('\n').filter(Boolean).at(-1) : undefined,
      after: next?.kind === 'same' ? next.text.split('\n').find(Boolean) : undefined,
    });
  }
  return hunks;
}
export function conflictLabel(conflict: Conflict, clash: Clash): string {
  if (clash.merged !== undefined) {
    return 'Both branches changed this line, in different places';
  }
  if (clash.changedBy === 'both') {
    return 'Both branches changed this';
  }
  return `Only ${clash.changedBy === 'theirs' ? conflict.branch : conflict.from} changed this`;
}
