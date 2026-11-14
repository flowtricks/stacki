// A cleared property looks cleared the moment it is cleared.
//
// Clearing is a save followed by a model rebuild (every rule re-resolved against the
// element). The canvas does not wait for either (liveRules previews the removal at once),
// but the panel read its labels and fields from that rebuilt model, so the blue label
// and the old value stayed on screen until it finished. Here the panel holds the property
// as unset from the click until the clear settles, then reads the model again: if the
// save succeeded the model agrees, and if it failed the model still has the value, which
// is the rollback. The save's own error message is unchanged.

import { useCallback, useState } from 'react';
import { assert } from '../../../../shared/core/assert';
import type { ResolvedProp } from '../model/resolved';

// Properties one clear may hold. Group clears are the widest (a gap, a border side).
const HELD_PER_CLEAR_MAX = 64;
// Overlapping clears of one property each add a hold; the property shows again when all settle.
const HOLDS_PER_PROPERTY_MAX = 1024;

type Holds = ReadonlyMap<string, number>;

export function useOptimisticClear(
  props: ReadonlyMap<string, ResolvedProp>,
  clearProp: (prop: string | string[]) => Promise<void>,
): {
  readonly read: (prop: string) => ResolvedProp | undefined;
  readonly clearProp: (prop: string | string[]) => void;
} {
  const [holds, setHolds] = useState<Holds>(new Map());
  const adjust = useCallback((names: readonly string[], delta: 1 | -1) => {
    setHolds((previous) => {
      const next = new Map(previous);
      for (const name of names) {
        const count = (next.get(name) ?? 0) + delta;
        assert(count >= 0, 'useOptimisticClear: a release has its hold');
        assert(count <= HOLDS_PER_PROPERTY_MAX, 'useOptimisticClear: holds stay bounded');
        if (count === 0) {
          next.delete(name);
        } else {
          next.set(name, count);
        }
      }
      return next;
    });
  }, []);
  const clear = (prop: string | string[]): void => {
    const names = Array.isArray(prop) ? prop : [prop];
    assert(names.length <= HELD_PER_CLEAR_MAX, 'useOptimisticClear: one clear holds a bounded group');
    adjust(names, 1);
    // The write starts in this same call, so the canvas preview is not delayed by the hold.
    const settled = clearProp(prop);
    // A rejected save stays loud (unhandled, as before): the finally only lifts the hold.
    void Promise.resolve(settled).finally(() => adjust(names, -1));
  };
  const read = (prop: string): ResolvedProp | undefined => (holds.has(prop) ? undefined : props.get(prop));
  return { read, clearProp: clear };
}
