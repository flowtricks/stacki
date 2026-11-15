// What the sync dialog decides: which places start checked, what a check changes, and the request the checked places make.
// Pure, so the dialog's rules and their tests are the same code.
//
// A place is named by its file and locator (`rel` + `\0` + locator). Exact matches the person has not unchecked before start
// checked; inclusive 1px forms and places remembered as "Not synced" start unchecked. A file's box is checked when all its places
// are, and half-checked when some are.
import type { BreakpointSyncApply, BreakpointSyncScan, SyncFile, SyncOccurrence } from './breakpointSyncPlan';

export type CheckedPlaces = ReadonlySet<string>;

export const placeKey = (rel: string, locator: string): string => `${rel}\0${locator}`;

export function initialChecked(scan: BreakpointSyncScan): CheckedPlaces {
  const checked = new Set<string>();
  for (const file of scan.files) {
    for (const place of file.occurrences) {
      if (place.checked) {
        checked.add(placeKey(file.rel, place.locator));
      }
    }
  }
  return checked;
}

export function placeCount(scan: BreakpointSyncScan): number {
  return scan.files.reduce((sum, file) => sum + file.occurrences.length, 0);
}

export function checkedCount(scan: BreakpointSyncScan, checked: CheckedPlaces): number {
  return scan.files.reduce((sum, file) => sum + file.occurrences.filter((place) => checked.has(placeKey(file.rel, place.locator))).length, 0);
}

export type FileCheck = 'all' | 'some' | 'none';

export function fileCheck(file: SyncFile, checked: CheckedPlaces): FileCheck {
  const on = file.occurrences.filter((place) => checked.has(placeKey(file.rel, place.locator))).length;
  if (on === 0) {
    return 'none';
  }
  return on === file.occurrences.length ? 'all' : 'some';
}

/** A file's box: checks every place when not all are checked, otherwise unchecks them. */
export function toggledFile(file: SyncFile, checked: CheckedPlaces): CheckedPlaces {
  const next = new Set(checked);
  const turnOn = fileCheck(file, checked) !== 'all';
  for (const place of file.occurrences) {
    const key = placeKey(file.rel, place.locator);
    if (turnOn) {
      next.add(key);
    } else {
      next.delete(key);
    }
  }
  return next;
}

export function toggledPlace(file: SyncFile, place: SyncOccurrence, checked: CheckedPlaces): CheckedPlaces {
  const next = new Set(checked);
  const key = placeKey(file.rel, place.locator);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return next;
}

export function allPlaces(scan: BreakpointSyncScan): CheckedPlaces {
  return new Set(scan.files.flatMap((file) => file.occurrences.map((place) => placeKey(file.rel, place.locator))));
}

/** The label a place wears: remembered exclusions win, then the inclusive form. */
export type PlaceLabel = 'notSynced' | 'inclusive' | 'exclusive' | undefined;

export function placeLabel(place: SyncOccurrence): PlaceLabel {
  if (place.excluded) {
    return 'notSynced';
  }
  return place.reason === 'exact' ? undefined : place.reason;
}

/** The request the checked places make: those to write by file, and the unchecked ones to remember. */
export function applyRequest(projectPath: string, key: string, scan: BreakpointSyncScan, checked: CheckedPlaces): BreakpointSyncApply {
  const files = scan.files.flatMap((file) => {
    const edits = file.occurrences
      .filter((place) => checked.has(placeKey(file.rel, place.locator)))
      .map((place) => ({ locator: place.locator, start: place.start, end: place.end, before: place.before, after: place.after }));
    return edits.length === 0 ? [] : [{ rel: file.rel, digest: file.digest, edits }];
  });
  const unchecked = scan.files.flatMap((file) =>
    file.occurrences.filter((place) => !checked.has(placeKey(file.rel, place.locator))).map((place) => ({ file: file.rel, locator: place.locator })),
  );
  return { projectPath, key, files, unchecked };
}

/** A path shortened in the middle to `max` characters, keeping the folder's start and the file's name: `src/…/sections/Hero.astro`. */
export function middleEllipsis(rel: string, max: number): string {
  if (rel.length <= max) {
    return rel;
  }
  const tail = Math.ceil((max - 1) * 0.6);
  const head = max - 1 - tail;
  return `${rel.slice(0, head)}…${rel.slice(rel.length - tail)}`;
}
