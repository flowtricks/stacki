// Which marketplace app another surface (the command palette) asked the Apps
// panel to show. The palette sets it and asks the panel to open its
// Marketplace tab (appsDirectory.ts `requestAppMarketplace`); the panel reads it
// once, scrolls that app into view, and clears it. One id at most.
import { useSyncExternalStore } from 'react';
import { assert } from '../../../../shared/core/assert';
import { requestAppMarketplace } from '../appsDirectory';

let focus: string | undefined;
const listeners = new Set<() => void>();

function publish(next: string | undefined): void {
  focus = next;
  for (const listener of [...listeners]) {
    listener();
  }
}

/** Opens the Apps panel's Marketplace tab, on `appId` when given. */
export function requestMarketplaceApp(appId: string | undefined): void {
  assert(appId === undefined || appId.length > 0, 'A marketplace app to show has an id');
  publish(appId);
  requestAppMarketplace();
}

/** The app the Marketplace tab was asked to show, and how to mark it shown. */
export function useMarketplaceFocus(): { readonly appId: string | undefined; readonly shown: () => void } {
  const appId = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => focus,
  );
  return { appId, shown: () => publish(undefined) };
}
