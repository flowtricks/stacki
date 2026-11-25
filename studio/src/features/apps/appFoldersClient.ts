// Apps added as a folder, from the Studio editor: the same calls as Desktop's
// bridge (src/ipc/appFoldersBridge.ts, which this module replaces in Studio
// through scripts/shared-source.json), over HTTP to the Studio server
// (appsServer.ts). The editor has no file watcher of its own, so it polls the
// folder's stamps every `pollMs` while something listens and compares them, as
// Desktop's watcher does (vendor/stacki/electron/project/appsWatcher.ts). Like
// the watcher, it waits for the folder to settle: a change is announced on the
// first poll that reads the same as the one before it, so an agent writing a
// bundle across several polls makes one notice, naming every folder that moved.
import { parseAppsResult, type AppsResult } from '../../../vendor/stacki/shared/properties/apps';
import {
  APP_FOLDER_LIMITS,
  changedAppFolders,
  parseAppFolderStamps,
  parseAppFoldersBroken,
  type AppFolderBroken,
  type AppFolderStamps,
  type AppFoldersChange,
} from '../../../vendor/stacki/shared/properties/appFolders';
import { request } from '../project/projectClient';

/** A browser cannot show a folder in the file manager. */
export const APP_FOLDER_REVEAL = false;

export async function listBrokenAppFolders(_projectPath: string): Promise<AppsResult<readonly AppFolderBroken[]>> {
  return parseAppsResult(await request('/studio/api/apps/folders'), parseAppFoldersBroken);
}

/** Nothing to show in a browser; the row names the folder instead. */
export async function revealAppFolder(_projectPath: string, _folder: string): Promise<void> {
  return Promise.resolve();
}

const listeners = new Set<(change: AppFoldersChange) => void>();
let poll: { readonly timer: ReturnType<typeof setInterval>; readonly state: AppFolderPollState } | undefined;

/** What the poll has seen: the stamps last announced (or the baseline) and the latest reading. */
export interface AppFolderPollState {
  announced: AppFolderStamps | undefined;
  latest: AppFolderStamps | undefined;
}

/** Hears `.stacki/apps/` change; one poll serves every listener, and stops with the last. */
export function onAppFoldersChanged(_projectPath: string, listener: (change: AppFoldersChange) => void): () => void {
  listeners.add(listener);
  if (poll === undefined) {
    const state: AppFolderPollState = { announced: undefined, latest: undefined };
    poll = { timer: setInterval(() => void check(state), APP_FOLDER_LIMITS.pollMs), state };
    void check(state);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && poll !== undefined) {
      clearInterval(poll.timer);
      poll = undefined;
    }
  };
}

async function check(state: AppFolderPollState): Promise<void> {
  let next: AppFolderStamps;
  try {
    next = parseAppFolderStamps(await request('/studio/api/apps/stamps'));
  } catch {
    return; // A server that is restarting answers on a later poll.
  }
  const change = settledFolderChange(state, next);
  if (change !== undefined) {
    for (const listener of [...listeners]) {
      listener(change);
    }
  }
}

/**
 * Takes one poll's reading; answers the change to announce, once the folder settled.
 * The first reading is the baseline. A reading that differs from the one before it
 * is still moving and waits; one that matches it and differs from what was last
 * announced is the settled change. Exported for its test.
 */
export function settledFolderChange(state: AppFolderPollState, next: AppFolderStamps): AppFoldersChange | undefined {
  const previous = state.latest;
  state.latest = next;
  if (state.announced === undefined) {
    state.announced = next;
    return undefined;
  }
  if (previous === undefined || changedAppFolders(previous, next).any) {
    return undefined; // Still moving: wait for a quiet poll.
  }
  const change = changedAppFolders(state.announced, next);
  state.announced = next;
  return change.any ? { folders: change.folders } : undefined;
}
