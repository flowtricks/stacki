// Apps added as a folder, from the renderer (shared/properties/appFolders.ts):
// the folders under `.stacki/apps/` that do not read as an app, showing one in
// the file manager, and hearing `.stacki/apps/` change. Desktop asks the main
// process, whose project watcher hears the folder (electron/project/appsWatcher.ts);
// Stacki Studio replaces this module with its HTTP client, which polls
// (studio/src/features/apps/appFoldersClient.ts).
import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';
import { parseAppsResult, type AppsResult } from '../../shared/properties/apps';
import { parseAppFoldersBroken, parseAppFoldersChange, type AppFolderBroken, type AppFoldersChange } from '../../shared/properties/appFolders';

/** Whether this host can show a folder in the file manager: Desktop can; a browser cannot. */
export const APP_FOLDER_REVEAL = true;

/** The folders that do not read as an app, each with the reason: broken rows of the Installed list. */
export async function listBrokenAppFolders(projectPath: string): Promise<AppsResult<readonly AppFolderBroken[]>> {
  // A preload from before folder apps has nothing to say; the apps still show.
  if (typeof window.avb.appFolders !== 'function') {
    return { ok: true, value: [] };
  }
  const input = parseIpcPayload('apps:folders', { projectPath });
  return parseAppsResult(await window.avb.appFolders(input), parseAppFoldersBroken);
}

/** Shows `.stacki/apps/<folder>` in Finder or the system's file manager. */
export async function revealAppFolder(projectPath: string, folder: string): Promise<void> {
  const input = parseIpcPayload('apps:revealFolder', { projectPath, folder });
  await window.avb.revealAppFolder(input);
}

/** Hears `.stacki/apps/` change while the project is open; returns the stop. */
export function onAppFoldersChanged(_projectPath: string, listener: (change: AppFoldersChange) => void): () => void {
  if (typeof window.avb.onAppFoldersChanged !== 'function') {
    return () => undefined; // An older preload: the list refreshes when the panel opens.
  }
  return window.avb.onAppFoldersChanged((data) => {
    let change: AppFoldersChange;
    try {
      change = parseAppFoldersChange(data);
    } catch {
      return; // A notice this renderer cannot read is dropped; the next one, or opening the panel, reads the folder.
    }
    listener(change);
  });
}
