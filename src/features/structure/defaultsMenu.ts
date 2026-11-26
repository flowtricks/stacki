// Whether the element menu offers "Set component defaults". It writes the project's insertion defaults
// (.stacki/components.json), so a mode that must not change project settings takes the row away
// (src/app/designMode, an experimental and removable feature).
import { useSyncExternalStore } from 'react';

let offered: 'offered' | 'withheld' = 'offered';
const listeners = new Set<() => void>();
/** Mounted menus; a leak past this is a bug, not growth. */
const LISTENERS_MAX = 20;

export function setDefaultsMenu(next: 'offered' | 'withheld'): void {
  offered = next;
  for (const listener of [...listeners]) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  if (listeners.size >= LISTENERS_MAX) {
    throw new Error('Assertion failed: defaultsMenu: listeners are bounded');
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const read = (): 'offered' | 'withheld' => offered;

export function useDefaultsMenu(): 'offered' | 'withheld' {
  return useSyncExternalStore(subscribe, read, read);
}
