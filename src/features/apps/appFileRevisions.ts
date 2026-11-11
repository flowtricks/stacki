// A counter per app that moves when the app's files on disk changed while it
// ran. Every frame of that app (AppFrame.tsx) loads its document again when its
// counter moves, so a running app picks up its new files by itself: the cleaner
// choice over a "Reload" button, since a person who just changed the files (or
// let an agent change them) wants to see them, and a change that leaves the app
// unable to run stops it instead (appFolderChanges.ts).
import { useSyncExternalStore } from 'react';
import { assert } from '../../../shared/core/assert';
import { APP_FOLDER_LIMITS } from '../../../shared/properties/appFolders';

const revisions = new Map<string, number>();
const listeners = new Set<() => void>();

/** Moves the counter of each app named, so its frames reload. */
export function bumpAppFileRevisions(appIds: readonly string[]): void {
  assert(appIds.length <= APP_FOLDER_LIMITS.entriesMax * 2, 'A reload names a bounded set of apps');
  for (const id of appIds) {
    revisions.set(id, (revisions.get(id) ?? 0) + 1);
  }
  // One counter per app ever reloaded this session: bounded by the folders a project can hold, kept small regardless.
  if (revisions.size > APP_FOLDER_LIMITS.entriesMax * 4) {
    const oldest = revisions.keys().next().value;
    if (oldest !== undefined) {
      revisions.delete(oldest);
    }
  }
  for (const listener of [...listeners]) {
    listener();
  }
}

/** The app's counter: 0 until its files first change. */
export function useAppFileRevision(appId: string): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => revisions.get(appId) ?? 0,
  );
}
