/*
 * Which icon set the left rail draws: Stacki's own, Phosphor's, or the custom
 * set (src/ui/railIcons.tsx). A comparison while the sets are being tested, and
 * a person's taste rather than a project's, so it is kept for the app as a
 * whole in localStorage, as the Settings tab is (settings/settingsTab.ts).
 * Best-effort: a read or write failure falls back to the default rather than
 * throwing, so blocked or corrupt storage never stops the rail from drawing.
 */
import { useSyncExternalStore } from 'react';
import { assert } from '../../shared/core/assert';

/** The sets, in the order Settings lists them. */
export const RAIL_ICON_SETS = ['stacki', 'phosphor', 'custom'] as const;
export type RailIconSet = (typeof RAIL_ICON_SETS)[number];

/** Custom while the sets are compared, so the newest drawing is the one seen first. */
export const RAIL_ICON_SET_DEFAULT: RailIconSet = 'custom';

export const RAIL_ICON_SET_LABELS: Readonly<Record<RailIconSet, string>> = {
  stacki: 'Stacki (current)',
  phosphor: 'Phosphor',
  custom: 'Custom',
};

const RAIL_ICON_SET_KEY = 'stacki.rail.iconSet';

// Every rail icon on screen subscribes: the rail's buttons, the More menu, the
// Settings tabs and the Roles grid. A few dozen at most; far more means an
// icon subscribes without unsubscribing.
const SUBSCRIBERS_MAX = 1024;
const subscribers = new Set<() => void>();
// Read once, then kept in step by saveRailIconSet, so a render never touches storage.
let current: RailIconSet | undefined;

/** A stored set, or the default for anything absent or not one: storage is
 * shared with every earlier build, so what it holds is parsed like any input. */
export function parseStoredRailIconSet(raw: unknown): RailIconSet {
  if (typeof raw === 'string') {
    const found = RAIL_ICON_SETS.find((set) => set === raw);
    if (found === undefined) {
      return RAIL_ICON_SET_DEFAULT;
    }
    return found;
  }
  return RAIL_ICON_SET_DEFAULT;
}

export function loadRailIconSet(): RailIconSet {
  try {
    return parseStoredRailIconSet(localStorage.getItem(RAIL_ICON_SET_KEY));
  } catch {
    return RAIL_ICON_SET_DEFAULT;
  }
}

/** Saves the set and redraws every rail icon. A failed write still switches this window. */
export function saveRailIconSet(set: RailIconSet): void {
  assert(RAIL_ICON_SETS.includes(set), 'A rail icon set is one of RAIL_ICON_SETS');
  current = set;
  try {
    localStorage.setItem(RAIL_ICON_SET_KEY, set);
  } catch {
    /* noop: an unsaved choice only means the next launch opens on the default */
  }
  assert(current === set, 'The saved set is the one drawn');
  for (const notify of subscribers) {
    notify();
  }
}

function snapshot(): RailIconSet {
  if (current === undefined) {
    current = loadRailIconSet();
  }
  return current;
}

function subscribe(notify: () => void): () => void {
  assert(subscribers.size < SUBSCRIBERS_MAX, 'Rail icon subscribers stay bounded');
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
  };
}

/** The set the rail draws now; the caller redraws when Settings changes it. */
export function useRailIconSet(): RailIconSet {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
