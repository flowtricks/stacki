// When each project scan began, in the order scans began: the revision key that tells a scan which
// read the files after an edit was saved from one that read them before (liveInstanceCounts.ts).
//
// A scan is keyed by its components array, not the result object: the page titles patch the result
// with a spread (usePageTitles.ts), which keeps the array and replaces the object.
//
// Mutable module state, owned here: one counter for the window and a weak map that forgets a scan
// once nothing holds it, so the map is bounded by the scans still alive.

import { assert } from '../../../shared/core/assert';

let scansBegun = 0;
const sequences = new WeakMap<object, number>();

/** Called as a scan starts reading the project; returns its place in the order. */
export function scanBegin(): number {
  scansBegun += 1;
  assert(Number.isSafeInteger(scansBegun), 'scanBegin: the counter stays an integer');
  return scansBegun;
}

/** Records which scan a result came from (its components array is the key). */
export function scanRecord(components: object, sequence: number): void {
  assert(sequence > 0, 'scanRecord: a sequence comes from scanBegin');
  assert(sequence <= scansBegun, 'scanRecord: a sequence was handed out');
  sequences.set(components, sequence);
}

/** The scan a result came from; 0 for one from before this window (a boot snapshot). */
export function scanSequenceOf(components: object): number {
  return sequences.get(components) ?? 0;
}

/** How many scans have begun: a scan whose sequence is above this began after now. */
export function scanSequenceLatest(): number {
  return scansBegun;
}
