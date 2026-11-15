// What the sync dialog decides: which places start checked, what a check changes, and the request the checked places make.
// Pure, so the dialog's rules and their tests are the same code.
//
// A place is named by its file and locator (`rel` + `\0` + locator). Exact matches the person has not unchecked before start
// checked; inclusive 1px forms and places remembered as "Not synced" start unchecked. A file's box is checked when all its places
// are, and half-checked when some are.
import type { BreakpointSyncApply, BreakpointSyncScan, SyncFile, SyncOccurrence, SyncReason } from './breakpointSyncPlan';
import { canonicalRefs, entryOf, withEntry, type BreakpointSyncRecord } from './breakpointSyncRecord';

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

/** One place the person checked or unchecked on the Breakpoints screen. */
export interface PlaceChoice {
  readonly file: string;
  readonly locator: string;
  readonly reason: SyncReason;
  readonly checked: boolean;
}

/**
 * The record after the person's choices for one breakpoint. An exact place is remembered only when unchecked (`excluded`, shown as
 * "Not synced"); an inclusive or exclusive one starts unchecked, so it is remembered only when checked (`linked`). Checking a place
 * forgets that it was excluded; unchecking an ambiguous one goes back to its default and is not remembered at all.
 */
export function recordWithChoices(record: BreakpointSyncRecord, id: string, choices: readonly PlaceChoice[]): BreakpointSyncRecord {
  const entry = entryOf(record, id);
  const named = (choice: PlaceChoice): string => placeKey(choice.file, choice.locator);
  const touched = new Set(choices.map(named));
  const excluded = entry.excluded.filter((ref) => !touched.has(placeKey(ref.file, ref.locator)));
  const linked = entry.linked.filter((ref) => !touched.has(placeKey(ref.file, ref.locator)));
  for (const choice of choices) {
    const ref = { file: choice.file, locator: choice.locator };
    if (choice.reason === 'exact') {
      if (!choice.checked) {
        excluded.push(ref);
      }
    } else if (choice.checked) {
      linked.push(ref);
    }
  }
  return withEntry(record, id, { excluded: canonicalRefs(excluded), linked: canonicalRefs(linked), appliedAt: entry.appliedAt });
}

/** The places that will change if this breakpoint's number does: how many, and in how many files. */
export function checkedTotals(files: readonly SyncFile[]): { readonly places: number; readonly files: number } {
  let places = 0;
  let touched = 0;
  for (const file of files) {
    const on = file.occurrences.filter((place) => place.checked).length;
    places += on;
    touched += on > 0 ? 1 : 0;
  }
  return { places, files: touched };
}

/** Every place found, and in how many files. */
export function foundTotals(files: readonly SyncFile[]): { readonly places: number; readonly files: number } {
  return { places: files.reduce((sum, file) => sum + file.occurrences.length, 0), files: files.length };
}

/** The scan's files with each place's `checked` set from the person's boxes (the dialog's and the card's boxes agree). */
export function withChecked(files: readonly SyncFile[], checked: CheckedPlaces): readonly SyncFile[] {
  return files.map((file) => ({
    ...file,
    occurrences: file.occurrences.map((place) => ({ ...place, checked: checked.has(placeKey(file.rel, place.locator)) })),
  }));
}

/** The checked places of a set of files, in the form the file rows read. */
export function checkedOf(files: readonly SyncFile[]): CheckedPlaces {
  return new Set(files.flatMap((file) => file.occurrences.filter((place) => place.checked).map((place) => placeKey(file.rel, place.locator))));
}
