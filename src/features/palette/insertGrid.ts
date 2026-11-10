import { assert } from '../../../shared/core/assert';
import { insertFolderKeys, type InsertFolderKey } from './insertFolders';

// The insert grid's arithmetic: which items it shows, and where the arrow keys go. Pure, so the
// palette component only has to hold state and render.

/** Cards per row. The keyboard moves by this many for up and down, so it is one name. */
export const INSERT_COLUMNS = 3;

/**
 * Most items one grid shows. The old list stopped at 60 because a row is cheap to scroll past;
 * a card is not, and a preview that is never scrolled to is never loaded. Matches beyond this
 * are counted on the pills and reached by typing more or picking a folder.
 */
export const insertResultsMax = 200;

/**
 * Most preview frames mounted at once. A frame runs a whole render
 * of a component on the dev server; the grid keeps the visible ones and drops the rest.
 */
export const previewFramesMax = 12;

/**
 * Most card frames loading at once. Each one is a full render of a page by the dev server the canvas
 * also uses, so a palette opening on nine visible cards asks for three pages, then the next three as
 * those answer, instead of nine at once. A frame that has answered keeps its place without counting.
 */
export const frameLoadsMax = 3;

/**
 * The cards that get a frame now: visible ones in grid order, up to `framesMax`, of which at most
 * `frameLoadsMax` are still loading. Grid order and not highlight order, so moving the highlight never
 * takes a frame away from a card that is half loaded.
 */
export function mountedFrameKeys(
  orderedKeys: readonly string[],
  { visible, settled, framesMax }: { readonly visible: ReadonlySet<string>; readonly settled: ReadonlySet<string>; readonly framesMax: number },
): ReadonlySet<string> {
  assert(framesMax >= 0, 'The frame limit is not negative');
  assert(orderedKeys.length <= insertResultsMax, 'Only shown cards are ordered');
  const keys = new Set<string>();
  let loading = 0;
  for (const key of orderedKeys) {
    if (keys.size >= framesMax) {
      break;
    }
    if (!visible.has(key)) {
      continue;
    }
    if (settled.has(key)) {
      keys.add(key);
    } else if (loading < frameLoadsMax) {
      keys.add(key);
      loading += 1;
    }
  }
  assert(loading <= frameLoadsMax, 'Never more frames loading than the limit');
  return keys;
}

export interface ViewItem {
  readonly cat?: string;
  /** Where a card sits; absent on everything that is not a card. */
  readonly card?: { readonly folder: InsertFolderKey | undefined } | undefined;
}

export type InsertTab = 'all' | 'components' | 'elements' | 'other';

export interface InsertPill {
  readonly key: InsertFolderKey;
  /** Hits in this folder for the current search, whichever pill is selected. */
  readonly count: number;
}

/** The Components tab's folder filter: every folder the project's cards fill, and the one selected, if any. */
export interface InsertFolderFilter {
  readonly pills: readonly InsertPill[];
  readonly selected: InsertFolderKey | undefined;
}

export interface InsertView<T> {
  readonly shown: readonly T[];
  /** Absent outside the Components tab. */
  readonly folders: InsertFolderFilter | undefined;
}

/**
 * What the grid shows for the ranked hits of one tab. `ranked` is already filtered to the tab and
 * ordered by relevance. On the Components tab every folder the project has gets a pill (`present`,
 * whatever the search hits), counting the hits in it; with none selected the grid shows every card,
 * and with one selected only its cards. A remembered folder the project no longer has selects nothing.
 */
export function insertView<T extends ViewItem>(
  ranked: readonly T[],
  tab: InsertTab,
  { chosen, present }: { readonly chosen: InsertFolderKey | undefined; readonly present: readonly InsertFolderKey[] },
): InsertView<T> {
  assert(Number.isSafeInteger(ranked.length), 'Ranked hits form a list');
  if (tab !== 'components') {
    return { shown: ranked.slice(0, insertResultsMax), folders: undefined };
  }
  const keys = insertFolderKeys(present);
  const counts = new Map<InsertFolderKey, number>(keys.map((key) => [key, 0]));
  for (const item of ranked) {
    const folder = item.card?.folder;
    if (folder !== undefined) {
      counts.set(folder, (counts.get(folder) ?? 0) + 1);
    }
  }
  const selected = chosen !== undefined && keys.includes(chosen) ? chosen : undefined;
  const pills = keys.map((key) => ({ key, count: counts.get(key) ?? 0 }));
  const shown = selected === undefined ? ranked : ranked.filter((item) => item.card?.folder === selected);
  assert(pills.length === keys.length, 'Every folder has one pill');
  return { shown: shown.slice(0, insertResultsMax), folders: { pills, selected } };
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
