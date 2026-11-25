import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';

// Scroll position is the one local mutation this coordinator owns on registered elements.
export interface ScrollPeer {
  scrollLeft: number;
}

// Each block contributes rows and a heading; the sheet adds its heading and scrollbar.
export const SCROLL_PEERS_MAX = LIMITS.scanEntriesMax * 2 + 2;

export function createScrollSync() {
  const peers = new Map<ScrollPeer, symbol>();
  let expected = new WeakMap<ScrollPeer, number>();
  let position = 0;
  let maximum = Number.MAX_SAFE_INTEGER;
  const apply = (element: ScrollPeer) => {
    if (Math.abs(element.scrollLeft - position) > 0.5) {
      element.scrollLeft = position;
      // Browsers clamp narrower tables. Their delayed scroll events must not
      // pull the common scrollbar back from the wider table's position.
      expected.set(element, element.scrollLeft);
    }
  };
  const register = (element: ScrollPeer | undefined) => {
    if (!element) {
      return undefined;
    }
    assert(peers.size < SCROLL_PEERS_MAX, 'Variable scroll: peer limit exceeded');
    const registration = Symbol();
    peers.set(element, registration);
    apply(element);
    return () => {
      if (peers.get(element) === registration) {
        peers.delete(element);
        expected.delete(element);
      }
    };
  };
  const broadcast = (from: ScrollPeer, left: number) => {
    assert(Number.isFinite(left), 'Variable scroll: position must be finite');
    assert(peers.size <= SCROLL_PEERS_MAX, 'Variable scroll: peer limit exceeded');
    const echo = expected.get(from);
    expected.delete(from);
    if (echo !== undefined && Math.abs(echo - left) <= 0.5) {
      return;
    }
    position = Math.max(0, Math.min(maximum, left));
    for (const element of peers.keys()) {
      apply(element);
    }
  };
  const fit = (limit: number) => {
    assert(Number.isFinite(limit), 'Variable scroll: range must be finite');
    assert(limit >= 0, 'Variable scroll: range must be nonnegative');
    maximum = limit;
    position = Math.min(position, maximum);
    for (const element of peers.keys()) {
      apply(element);
    }
  };
  const dispose = () => {
    peers.clear();
    expected = new WeakMap();
    position = 0;
    maximum = Number.MAX_SAFE_INTEGER;
  };
  return { register, broadcast, fit, dispose };
}

export type ScrollSync = ReturnType<typeof createScrollSync>;

// Tables scroll together only when their columns line up: the same column
// count means the same tracks, so a value sits under the same heading in each.
// A table with its own count (a matrix of prefixes) scrolled with the sheet
// before, which slid its columns past values they had nothing to do with.
// One lane per count; a lane is created the first time a table asks for it.
export function createScrollLanes() {
  const lanes = new Map<number, ScrollSync>();
  const lane = (columnCount: number) => {
    assert(Number.isSafeInteger(columnCount), 'Variable scroll: column count must be an integer');
    assert(columnCount >= 0, 'Variable scroll: column count must be nonnegative');
    const existing = lanes.get(columnCount);
    if (existing) {
      return existing;
    }
    // Every table could be a lane of its own, and no more than that.
    assert(lanes.size < SCROLL_PEERS_MAX, 'Variable scroll: lane limit exceeded');
    const created = createScrollSync();
    lanes.set(columnCount, created);
    return created;
  };
  // Each lane is reset rather than dropped, so a table that renders again
  // after a dispose (React's development remount) finds the lane it registered
  // with instead of a fresh one the others never joined.
  const dispose = () => {
    for (const sync of lanes.values()) {
      sync.dispose();
    }
  };
  return { lane, dispose };
}
export type ScrollLanes = ReturnType<typeof createScrollLanes>;
