// The open page's save state (plan §7). A union, not a `dirty` flag: "the last
// save was refused because the file changed on disk" is a state a boolean
// cannot hold, and it is the one that must stop autosave. Every variant names
// the checksum it is relative to, so a write always says which bytes it was
// authored against.
//
// Transitions are pure and total over the states they accept; a transition
// asked of a state it does not apply to is a programmer error and asserts.
import { assert } from '../../shared/core/assert';
import type { Digest } from '../../shared/core/brand';

export type SaveState =
  | { readonly tag: 'clean'; readonly checksum: Digest }
  | { readonly tag: 'dirty'; readonly baseChecksum: Digest }
  | { readonly tag: 'saving'; readonly baseChecksum: Digest }
  | { readonly tag: 'failed'; readonly baseChecksum: Digest; readonly message: string }
  | { readonly tag: 'conflicted'; readonly baseChecksum: Digest; readonly diskChecksum: Digest };

/** Read from disk, written by this app, or reloaded: nothing to save. */
export function saveStateClean(checksum: Digest): SaveState {
  return { tag: 'clean', checksum };
}

/** A local edit. It always applies; only the path to disk depends on the state. */
export function saveStateEdited(state: SaveState): SaveState {
  switch (state.tag) {
    case 'clean':
      return { tag: 'dirty', baseChecksum: state.checksum };
    case 'failed':
      return { tag: 'dirty', baseChecksum: state.baseChecksum };
    case 'dirty':
      return state;
    case 'saving':
      // The write in flight does not contain this edit; a later one must.
      return { tag: 'dirty', baseChecksum: state.baseChecksum };
    case 'conflicted':
      // Edits keep applying locally; autosave stays off until the user decides.
      return state;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

/** The saver sends new edits or retries edits whose earlier write failed. */
export function saveStateStarted(state: SaveState): SaveState {
  assert(saveStateNeedsWrite(state), `Only an unsaved page starts a save, not ${state.tag}`);
  return { tag: 'saving', baseChecksum: saveStateBase(state) };
}

/** A write failed for a reason other than a conflict; the edit is still unsaved. */
export function saveStateFailed(state: SaveState, message: string): SaveState {
  assert(state.tag !== 'clean', 'A clean page has no failed save');
  assert(state.tag !== 'conflicted', 'A failed save cannot dismiss a conflict');
  assert(message.length > 0, 'A failed save explains why it did not reach disk');
  // New typing may already have made an in-flight save dirty again.
  return { tag: 'failed', baseChecksum: state.baseChecksum, message };
}

/** The disk no longer holds the base the write named: refuse to write over
 * it (plan §7). `baseChecksum` is the base actually compared — the saver may
 * have advanced it past the state's own base through its own earlier writes. */
export function saveStateRefused(state: SaveState, baseChecksum: Digest, diskChecksum: Digest): SaveState {
  assert(state.tag !== 'clean', 'A clean page has nothing to refuse');
  assert(diskChecksum !== baseChecksum, 'A refusal names bytes other than the base');
  return { tag: 'conflicted', baseChecksum, diskChecksum };
}

/** The user reviewed the conflict and keeps the local text: it becomes a
 * deliberate edit against what is on disk now, and saves over it. */
export function saveStateAccepted(state: SaveState): SaveState {
  assert(state.tag === 'conflicted', `Only a conflicted page can be accepted, not ${state.tag}`);
  return { tag: 'dirty', baseChecksum: state.diskChecksum };
}

/** New or failed edits can save; clean, in-flight and conflicted pages cannot. */
export function saveStateNeedsWrite(state: SaveState): boolean {
  return state.tag === 'dirty' || state.tag === 'failed';
}

/** The checksum an unsaved state was authored against. */
export function saveStateBase(state: SaveState): Digest {
  return state.tag === 'clean' ? state.checksum : state.baseChecksum;
}
