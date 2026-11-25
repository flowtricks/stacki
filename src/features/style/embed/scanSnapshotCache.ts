// The last settled answer for each recently selected element, so selecting one again
// paints its chips and fields at once instead of a skeleton (stale-while-revalidate).
//
// An entry is the whole ScanState the panel drew for the element once its answer had
// settled, with the match target and class list the edits use, so nothing drawn from it
// is a mix of two answers. It is valid only for the CSS it was computed from: the key
// carries a fingerprint of every loaded stylesheet's text, so an edit, an undo or a file
// changed outside the app misses the cache and the element is read afresh. The canvas's
// fresh answer still follows every hit and replaces the entry when anything differs.

import { assert } from '../../../../shared/core/assert';
import type { MatchTarget } from '../model/selectors';
import type { EmbedDocument } from '../model/webflow';
import type { ScanState } from './EditorBasics';

/** The most elements remembered: enough for back-and-forth between a few, bounded so a long session cannot grow it. */
export const SCAN_SNAPSHOT_ENTRIES_MAX = 32;

export interface ScanSnapshot {
  readonly scan: ScanState;
  readonly target: MatchTarget;
  readonly classList: readonly string[];
  readonly primed: { readonly target: MatchTarget; readonly key: string } | undefined;
}

// Insertion order is recency: a hit is moved to the end, the oldest is dropped first.
const entries = new Map<string, ScanSnapshot>();

/** The key for an element under the CSS the panel holds now. */
export function scanSnapshotKey(elementKey: string, docs: readonly EmbedDocument[]): string {
  assert(elementKey.length > 0, 'scanSnapshotKey: an element key is never empty');
  return `${elementKey}\u0000${docsFingerprint(docs)}`;
}

export function readScanSnapshot(key: string): ScanSnapshot | undefined {
  const found = entries.get(key);
  if (found === undefined) {
    return undefined;
  }
  assert(found.scan.settled, 'readScanSnapshot: only settled answers are remembered');
  entries.delete(key);
  entries.set(key, found);
  return found;
}

export function rememberScanSnapshot(key: string, snapshot: ScanSnapshot): void {
  assert(snapshot.scan.settled, 'rememberScanSnapshot: only a settled answer is remembered');
  assert(!snapshot.scan.awaitingFirstAnswer, 'rememberScanSnapshot: a remembered answer is not waiting');
  entries.delete(key);
  entries.set(key, snapshot);
  for (const oldest of entries.keys()) {
    if (entries.size <= SCAN_SNAPSHOT_ENTRIES_MAX) {
      break;
    }
    entries.delete(oldest);
  }
  assert(entries.size <= SCAN_SNAPSHOT_ENTRIES_MAX, 'rememberScanSnapshot: the cache is bounded');
}

/** Forget every element: used when what the answers were read against is gone (another project, a test). */
export function forgetScanSnapshots(): void {
  entries.clear();
}

// A 32-bit FNV-1a over every document's key and text. Collisions only cost a stale
// paint that the canvas's answer corrects a moment later, and the text is hashed rather
// than kept so a cache of large stylesheets does not hold a copy of each.
function docsFingerprint(docs: readonly EmbedDocument[]): string {
  let hash = 0x811c9dc5;
  const mix = (text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  };
  for (const document of docs) {
    mix(document.source.key);
    mix('\u0000');
    mix(document.code);
    mix('\u0001');
  }
  return `${docs.length}:${hash.toString(36)}`;
}
