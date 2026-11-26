// Whether the element menu offers "Unlink component", and what it does. Only a mode that can turn an instance into
// plain elements offers it (src/app/designMode, an experimental and removable feature); everywhere else the row is
// not there at all.
import { useSyncExternalStore } from 'react';

export interface UnlinkOffer {
  /** The row's words, in the interface language. */
  readonly label: string;
  readonly unlink: (nodeId: string) => void;
}

let offer: UnlinkOffer | undefined = undefined;
const listeners = new Set<() => void>();
/** Mounted menus; a leak past this is a bug, not growth. */
const LISTENERS_MAX = 20;

export function setUnlinkMenu(next: UnlinkOffer | undefined): void {
  offer = next;
  for (const listener of [...listeners]) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  if (listeners.size >= LISTENERS_MAX) {
    throw new Error('Assertion failed: unlinkMenu: listeners are bounded');
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The offer now, for an action taken outside React's render. */
export const currentUnlinkMenu = (): UnlinkOffer | undefined => offer;

export function useUnlinkMenu(): UnlinkOffer | undefined {
  return useSyncExternalStore(subscribe, currentUnlinkMenu, currentUnlinkMenu);
}
