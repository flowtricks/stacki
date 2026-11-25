// State that belongs to the selector being edited, without remounting the fields for it.
//
// The Typography and Flex child sections used to be keyed by the active selector, so a
// field's "custom value" mode (a Weight typed as `550`, an Order seeded `1`) started over
// for the next selector. A key change remounts the whole section, and the pick can change
// without anyone pressing anything: the default pick settles when the element's answer lands
// (useTokenDefault, useDefaultUpgrade). Every menu and variable picker open in the section
// was torn down with it, so a chooser opened in that moment closed on its own. The few
// values that are about one selector now carry that selector instead, and read as their
// initial value under any other: the same reset, with nothing remounted.

import { createContext, useCallback, useContext, useState } from 'react';

/** The selector the panel's fields are editing ('' with none picked). */
export const SelectorScopeContext = createContext('');

/** `useState`, scoped to the selector being edited: under another selector it reads as `initial`. */
export function useSelectorState<T>(initial: T): readonly [T, (next: T) => void] {
  const selector = useContext(SelectorScopeContext);
  const [held, setHeld] = useState<{ readonly selector: string; readonly value: T }>({ selector, value: initial });
  const value = held.selector === selector ? held.value : initial;
  const set = useCallback((next: T) => setHeld({ selector, value: next }), [selector]);
  return [value, set] as const;
}
