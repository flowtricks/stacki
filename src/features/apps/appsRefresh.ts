// A counter the Apps panel re-reads the installed apps on: bumped when an
// automatic update check installed an update or recorded one for approval,
// so an open panel shows it without being reopened.
import { useSyncExternalStore } from 'react';

let tick = 0;
const listeners = new Set<() => void>();

export function bumpAppsRefresh(): void {
  tick += 1;
  for (const listener of [...listeners]) {
    listener();
  }
}

export function useAppsRefresh(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => tick,
  );
}
