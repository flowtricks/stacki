import { conflictTextChanges } from './conflictTextChanges';
import { ChangeSet, Text } from '@codemirror/state';
import { assert } from '../../../shared/core/assert';
import { BOUNDARY_LIMITS } from '../../../shared/core/boundary';
import type { MergeResolution } from '../../../shared/ipc/mergeResolution';
import { mergeConflictSnapshot } from '../../../shared/ipc/mergeResolution';
import type { WireMergeClash } from '../../../shared/ipc/ipcResults';
import type { Clash, ConflictChoice, ConflictChoices, Conflict } from './gitConflictModel';
import { defaultChoice } from './gitConflictModel';

export interface ConflictRegion {
  readonly clash: Clash;
  readonly from: number;
  readonly to: number;
  readonly choice: ConflictChoice | 'custom';
  readonly selectable: boolean;
  readonly review: 'pending' | 'done';
}
export interface ConflictDraft {
  readonly text: string;
  readonly regions: readonly ConflictRegion[];
  readonly mode: 'choices' | 'edited';
}
export type ConflictDrafts = Readonly<Record<string, ConflictDraft>>;

export function conflictChoiceText(clash: Extract<NonNullable<WireMergeClash['parts']>[number], { readonly kind: 'clash' }>, choice: ConflictChoice): string {
  switch (choice) {
    case 'ours':
      return clash.ours;
    case 'theirs':
      return clash.theirs;
    case 'merged':
      assert(clash.merged !== undefined, 'Merge result: combined text exists');
      return clash.merged;
    case 'both':
      return [clash.ours, clash.theirs].filter((side) => side !== '').join('\n');
  }
}

export function createConflictDraft(file: WireMergeClash): ConflictDraft {
  assert(file.parts !== undefined, 'Merge result: text parts required');
  assert(file.parts.length <= BOUNDARY_LIMITS.itemsMax, 'Merge result: part limit exceeded');
  const pieces: string[] = [];
  const regions: ConflictRegion[] = [];
  let length = 0;
  for (const part of file.parts) {
    if (pieces.length > 0) {
      length += 1;
    }
    const choice = part.kind === 'clash' ? defaultChoice(part) : undefined;
    const text = part.kind === 'same' ? part.text : conflictChoiceText(part, defaultChoice(part));
    if (part.kind === 'clash' && choice !== undefined) {
      const additions = createConflictRegions(part, length, choice);
      assert(regions.length + additions.length <= BOUNDARY_LIMITS.itemsMax, 'Merge result: region limit exceeded');
      regions.push(...additions);
    }
    pieces.push(text);
    length += text.length;
  }
  assert(length <= BOUNDARY_LIMITS.textLengthMax, 'Merge result: text limit exceeded');
  return { text: pieces.join('\n'), regions, mode: 'choices' };
}

export function editConflictDraft(draft: ConflictDraft, changes: ChangeSet): ConflictDraft {
  assert(changes.length === draft.text.length, 'Merge result: edit uses current document');
  assert(changes.newLength <= BOUNDARY_LIMITS.textLengthMax, 'Merge result: text limit exceeded');
  const touched = new Set<number>();
  const detached = new Set<number>();
  changes.iterChangedRanges((from, to) => {
    const hits = draft.regions.flatMap((region, index) => (from <= region.to && to >= region.from ? [index] : []));
    for (const index of hits) {
      touched.add(index);
      if (hits.length > 1) {
        detached.add(index);
      }
    }
  });
  const regions = draft.regions.map((region, index): ConflictRegion => ({
    clash: region.clash,
    from: changes.mapPos(region.from, -1),
    to: changes.mapPos(region.to, 1),
    choice: touched.has(index) ? 'custom' : region.choice,
    review: touched.has(index) ? 'done' : region.review,
    // A rewrite across multiple decisions has no unambiguous individual range.
    // Keep the user's result, but never let a branch toggle overwrite other edits.
    selectable: region.selectable && !detached.has(index),
  }));
  return {
    text: changes.apply(Text.of(draft.text.split('\n'))).toString(),
    regions,
    mode: 'edited',
  };
}

export function chooseConflictRegion(
  draft: ConflictDraft,
  index: number,
  replacement: { readonly choice: ConflictChoice; readonly text: string },
): ConflictDraft {
  const region = draft.regions[index];
  assert(region !== undefined, 'Merge result: region exists');
  assert(region.selectable, 'Merge result: region can be replaced independently');
  const changes = ChangeSet.of({ from: region.from, to: region.to, insert: replacement.text }, draft.text.length, '\n');
  const changed = editConflictDraft(draft, changes);
  return {
    ...changed,
    mode: draft.mode,
    regions: changed.regions.map((entry, position) => (position === index ? { ...entry, choice: replacement.choice, review: 'done' } : entry)),
  };
}

export function conflictDraftsForSend(conflict: Conflict, drafts: ConflictDrafts, whole: Readonly<Record<string, 'ours' | 'theirs'>>): ConflictChoices {
  return Object.fromEntries(
    conflict.files.map((file): readonly [string, MergeResolution] => {
      const draft = drafts[file.path];
      if (draft === undefined) {
        return [file.path, whole[file.path] ?? 'ours'];
      }
      assert(file.parts !== undefined, 'Merge result: edited file has text parts');
      return [
        file.path,
        {
          kind: 'text',
          text: draft.text,
          expected: mergeConflictSnapshot(file.parts),
          expectedBranch: conflict.from,
        },
      ];
    }),
  );
}

function createConflictRegions(clash: Clash, offset: number, choice: ConflictChoice): readonly ConflictRegion[] {
  const text = conflictChoiceText(clash, choice);
  const basic: ConflictRegion = {
    clash,
    from: offset,
    to: offset + text.length,
    choice,
    selectable: true,
    review: clash.changedBy === 'both' && clash.merged === undefined ? 'pending' : 'done',
  };
  if (clash.merged === undefined) {
    return [basic];
  }
  const ours = conflictChoiceChanges(clash.merged, clash.ours);
  const theirs = conflictChoiceChanges(clash.merged, clash.theirs);
  if (ours === undefined || theirs === undefined) {
    return [basic];
  }
  const regions = [
    ...ours.map((change) => ({ change, source: 'theirs' as const, other: clash.ours })),
    ...theirs.map((change) => ({ change, source: 'ours' as const, other: clash.theirs })),
  ].sort((left, right) => left.change.from - right.change.from);
  // Ambiguous alignments stay one combined decision. The result is always the
  // engine's original text, and only provably separate ranges get separate toggles.
  let end = -1;
  for (const { change } of regions) {
    if (change.from <= end) {
      return [basic];
    }
    end = change.to;
  }
  if (regions.length === 0) {
    return [basic];
  }
  return regions.map(({ change, source, other }) => {
    const selected = text.slice(change.from, change.to);
    const alternative = other.slice(change.targetFrom, change.targetTo);
    return {
      from: offset + change.from,
      to: offset + change.to,
      choice: source,
      selectable: true,
      review: 'done',
      clash: {
        kind: 'clash',
        changedBy: source,
        ours: source === 'ours' ? selected : alternative,
        theirs: source === 'theirs' ? selected : alternative,
      },
    };
  });
}

// Words within one attribute value or text node form one useful choice. Keep
// markup boundaries separate so changing the words cannot replace a class or id.
function conflictChoiceChanges(source: string, target: string) {
  const changes = conflictTextChanges(source, target);
  if (changes === undefined) {
    return undefined;
  }
  const grouped: Array<(typeof changes)[number]> = [];
  for (const change of changes) {
    const previous = grouped.at(-1);
    if (previous !== undefined && /^[^<>"'=\r\n]*$/.test(source.slice(previous.to, change.from))) {
      grouped[grouped.length - 1] = { ...previous, to: change.to, targetTo: change.targetTo };
    } else {
      grouped.push(change);
    }
  }
  return grouped;
}
