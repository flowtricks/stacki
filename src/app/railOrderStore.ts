// The rail order a person arranged, kept for the app as a whole in localStorage beside the other per-person
// UI preferences (style/model/toolPreferences.ts, settings/settingsTab.ts). It is not the project's: it
// follows the person into every project, never goes in `.stacki/` or any project directory, and a second
// project window picks a change up through the `storage` event.
//
// Best-effort: missing, full, blocked or corrupt storage gives the default order and never stops the rail
// from drawing. The read is synchronous and happens in the first render, so the rail's first frame is the
// person's order and never the default flashing into place.
import { useCallback, useEffect, useState } from 'react';
import { assert } from '../../shared/core/assert';
import { isDefaultRailOrder, parseStoredRailOrder, resolveRailOrder, stringifyRailOrder, type RailOrder } from './railOrder';

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

export interface RailOrderControl {
  readonly order: RailOrder;
  /** Replaces the order and remembers it. */
  readonly change: (next: RailOrder) => void;
  /** Back to the default order, and forgets the stored one. */
  readonly reset: () => void;
}

/** The rail's order, read before the first frame and kept in step with other windows. */
export function useRailOrder(defaults: RailOrder): RailOrderControl {
  const [order, setOrder] = useState<RailOrder>(() => loadRailOrder(defaults));
  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      // A null key is `localStorage.clear()`; either way the stored order is read again.
      if (event.key === RAIL_ORDER_KEY || event.key === null) {
        setOrder(loadRailOrder(defaults));
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [defaults]);
  const change = useCallback(
    (next: RailOrder) => {
      assert(next.top.length + next.bottom.length === defaults.top.length + defaults.bottom.length, 'A change keeps every rail button');
      saveRailOrder(defaults, next);
      setOrder(next);
    },
    [defaults],
  );
  const reset = useCallback(() => {
    saveRailOrder(defaults, defaults);
    setOrder(defaults);
  }, [defaults]);
  return { order, change, reset };
}
