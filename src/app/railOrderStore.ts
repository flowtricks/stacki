// The rail order a person arranged, kept for the app as a whole in localStorage beside the other per-person
// UI preferences (style/model/toolPreferences.ts, settings/settingsTab.ts). It is not the project's: it
// follows the person into every project, never goes in `.stacki/` or any project directory, and a second
// project window picks a change up through the `storage` event.
//
// Best-effort: missing, full, blocked or corrupt storage gives the default order and never stops the rail
// from drawing. The read is synchronous and happens in the first render, so the rail's first frame is the
// person's order and never the default flashing into place.
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { assert } from '../../shared/core/assert';
import { isDefaultRailOrder, parseStoredRailOrder, railOrderIds, resolveRailOrder, stringifyRailOrder, type RailOrder } from './railOrder';
import { DEFAULT_RAIL_ORDER } from './railDefaults';

export const RAIL_ORDER_KEY = 'stacki.rail.order';

/** The stored order laid over `defaults`; the default when nothing usable is stored. */
export function loadRailOrder(defaults: RailOrder): RailOrder {
  try {
    return resolveRailOrder(defaults, parseStoredRailOrder(localStorage.getItem(RAIL_ORDER_KEY)));
  } catch {
    return defaults;
  }
}

/** Remembers `order`; the default order is remembered by forgetting, so a later default change still reaches the person. */
export function saveRailOrder(defaults: RailOrder, order: RailOrder): void {
  try {
    if (isDefaultRailOrder(defaults, order)) {
      localStorage.removeItem(RAIL_ORDER_KEY);
    } else {
      localStorage.setItem(RAIL_ORDER_KEY, stringifyRailOrder(order));
    }
  } catch {
    /* noop: an unsaved order only means the rail opens in the default order next time */
  }
}

// One store for the whole window: the rail, the Settings panel's root and Editor settings all read it, so a drag or a reset shows in both at once.
// The snapshot is the stored text (an empty string for none), a stable primitive for useSyncExternalStore.
// Storage is read each time (a synchronous string read), so another window's change is seen; when storage is
// blocked, the last text written in this window stands in for it.
let memoryRaw = '';
const listeners = new Set<() => void>();
let watchingStorage = false;

function readRaw(): string {
  try {
    return localStorage.getItem(RAIL_ORDER_KEY) ?? '';
  } catch {
    return memoryRaw;
  }
}

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!watchingStorage) {
    watchingStorage = true;
    window.addEventListener('storage', (event: StorageEvent) => {
      // A null key is `localStorage.clear()`; either way the stored order is read again.
      if (event.key === RAIL_ORDER_KEY || event.key === null) {
        notify();
      }
    });
  }
  return () => listeners.delete(listener);
}

/** Remembers `order` for this window and in storage. */
export function writeRailOrder(defaults: RailOrder, order: RailOrder): void {
  saveRailOrder(defaults, order);
  memoryRaw = isDefaultRailOrder(defaults, order) ? '' : stringifyRailOrder(order);
  notify();
}

/** Back to the default order; the same call serves the rail's menu and Settings. */
export function resetRailOrder(): void {
  writeRailOrder(DEFAULT_RAIL_ORDER, DEFAULT_RAIL_ORDER);
}

/** Whether the person's order is the default, live: Settings uses it to enable its reset button. */
export function useRailOrderIsDefault(): boolean {
  return isDefaultRailOrder(DEFAULT_RAIL_ORDER, useRailOrder(DEFAULT_RAIL_ORDER).order);
}

export interface RailOrderControl {
  readonly order: RailOrder;
  /** Replaces the order and remembers it. */
  readonly change: (next: RailOrder) => void;
  /** Back to the default order, and forgets the stored one. */
  readonly reset: () => void;
}

/** The rail's order, read before the first frame and kept in step with every reader and other windows. */
export function useRailOrder(defaults: RailOrder): RailOrderControl {
  const text = useSyncExternalStore(subscribe, readRaw, readRaw);
  const order = useMemo(() => resolveRailOrder(defaults, parseStoredRailOrder(text === '' ? undefined : text)), [defaults, text]);
  const change = useCallback(
    (next: RailOrder) => {
      assert(railOrderIds(next).length === railOrderIds(defaults).length, 'A change keeps every rail item');
      writeRailOrder(defaults, next);
    },
    [defaults],
  );
  const reset = useCallback(() => writeRailOrder(defaults, defaults), [defaults]);
  return { order, change, reset };
}
