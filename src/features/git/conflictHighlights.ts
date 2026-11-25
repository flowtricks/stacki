import { conflictTextChanges } from './conflictTextChanges';
import type { Clash } from './gitConflictModel';
import type { ConflictDraft } from './conflictDraft';

export interface ConflictHighlight {
  readonly from: number;
  readonly to: number;
  readonly source: 'ours' | 'theirs' | 'custom';
}
export function conflictHighlights(draft: ConflictDraft, clashes: readonly Clash[]): readonly ConflictHighlight[] {
  return draft.regions.flatMap((region, index): readonly ConflictHighlight[] => {
    const clash = clashes[index];
    if (clash === undefined || region.from === region.to) {
      return [];
    }
    const result = draft.text.slice(region.from, region.to);
    if (region.choice === 'custom') {
      return [{ ...region, source: 'custom' }];
    }
    const sides: readonly ('ours' | 'theirs')[] = region.choice === 'merged' || region.choice === 'both' ? ['ours', 'theirs'] : [region.choice];
    return sides.flatMap((source) => {
      const other = source === 'ours' ? clash.theirs : clash.ours;
      return changedTextRanges(other, result).map((range) => ({
        from: range.from + region.from,
        to: range.to + region.from,
        source,
      }));
    });
  });
}

// Highlight only the changed target tokens; large changes retain a whole-region tint.
export function changedTextRanges(source: string, target: string) {
  const changes = conflictTextChanges(source, target);
  return changes === undefined ? [{ from: 0, to: target.length }] : changes.map((change) => ({ from: change.targetFrom, to: change.targetTo }));
}
