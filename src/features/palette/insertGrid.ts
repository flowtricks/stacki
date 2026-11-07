import { assert } from '../../../shared/core/assert';
import { INSERT_GROUPS, type InsertGroup } from './insertGroups';

// The insert grid's arithmetic: which items it shows, and where the arrow keys go. Pure, so the
// palette component only has to hold state and render.

/** Cards per row. The keyboard moves by this many for up and down, so it is one name. */
export const INSERT_COLUMNS = 3;

/**
 * Most items one grid shows. The old list stopped at 60 because a row is cheap to scroll past;
 * a card is not, and a preview that is never scrolled to is never loaded. Matches beyond this
 * are counted on the pills and reached by typing more.
 */
export const insertResultsMax = 200;

/**
 * Most preview frames mounted at once, the large view included. A frame runs a whole page
 * of the project; the grid keeps the visible ones and drops the rest.
 */
export const previewFramesMax = 12;

export interface ViewItem {
  readonly cat?: string;
  readonly group?: InsertGroup | undefined;
}

export type InsertTab = 'all' | 'components' | 'elements' | 'other';

export interface InsertView<T> {
  readonly shown: readonly T[];
  /** Hits per group among components, whatever the pill; absent outside the Components tab. */
  readonly counts: Readonly<Record<InsertGroup, number>> | undefined;
  /** The group the grid shows on the Components tab. */
  readonly pill: InsertGroup | undefined;
}

/**
 * What the grid shows for the ranked hits of one tab. `ranked` is already filtered to the tab and
 * ordered by relevance. On the Components tab the chosen pill filters; when it has no hits and the
 * other group has, the other is shown instead, so a search never lands on an empty grid next to a
 * full one. On All results the sections come first, then the blocks, then everything else.
 */
export function insertView<T extends ViewItem>(ranked: readonly T[], tab: InsertTab, chosen: InsertGroup): InsertView<T> {
  assert(Number.isSafeInteger(ranked.length), 'Ranked hits form a list');
  if (tab === 'components') {
    const counts = countGroups(ranked);
    const other = otherGroup(chosen);
    const pill = counts[chosen] === 0 && counts[other] > 0 ? other : chosen;
    return { shown: ranked.filter((item) => item.group === pill).slice(0, insertResultsMax), counts, pill };
  }
  if (tab === 'all') {
    const sections = ranked.filter((item) => item.group === 'sections');
    const blocks = ranked.filter((item) => item.group === 'blocks');
    const rest = ranked.filter((item) => item.group === undefined);
    return { shown: [...sections, ...blocks, ...rest].slice(0, insertResultsMax), counts: undefined, pill: undefined };
  }
  return { shown: ranked.slice(0, insertResultsMax), counts: undefined, pill: undefined };
}

function countGroups(items: readonly ViewItem[]): Record<InsertGroup, number> {
  const counts: Record<InsertGroup, number> = { sections: 0, blocks: 0 };
  for (const item of items) {
    if (item.group !== undefined) {
      counts[item.group] += 1;
    }
  }
  return counts;
}

function otherGroup(group: InsertGroup): InsertGroup {
  const [first, second] = INSERT_GROUPS;
  return group === first ? second : first;
}

export type GridMove = 'left' | 'right' | 'up' | 'down';

/**
 * Where the highlight goes. Left and right step one card, up and down one row. Down from a row
 * above a shorter last row lands on the last card instead of doing nothing; at an edge the
 * highlight stays. `count` is the number of cards, `current` an index into them.
 */
export function moveHighlight(current: number, count: number, move: GridMove): number {
  assert(count > 0, 'Moving the highlight needs at least one card');
  assert(current >= 0, 'The highlight is a position');
  assert(current < count, 'The highlight sits on a card');
  const last = count - 1;
  switch (move) {
    case 'left':
      return Math.max(current - 1, 0);
    case 'right':
      return Math.min(current + 1, last);
    case 'up':
      return current >= INSERT_COLUMNS ? current - INSERT_COLUMNS : current;
    case 'down': {
      const next = current + INSERT_COLUMNS;
      if (next <= last) {
        return next;
      }
      const rowOfCurrent = Math.floor(current / INSERT_COLUMNS);
      const rowOfLast = Math.floor(last / INSERT_COLUMNS);
      return rowOfCurrent < rowOfLast ? last : current;
    }
    default: {
      const exhaustive: never = move;
      return exhaustive;
    }
  }
}
