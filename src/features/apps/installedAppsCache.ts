// The Apps panel's last Installed list per project, outside the panel, so the app
// can fill it before the panel first opens (panelPrefetch.ts).
//
// Why: the panel read the list on every mount and drew its loading tiles until the
// answer came back, then swapped in the apps, on every open of the panel, not
// only the first. It now opens on the kept list and reads again in place.
import { assert } from '../../../shared/core/assert';
import type { AppFolderBroken, InstalledAppList } from '../../../shared/properties/appFolders';
import { listInstalledAppList } from '../../ipc/appsBridge';
import { listBrokenAppFolders } from '../../ipc/appFoldersBridge';
import { createPanelCache } from '../../lib/usePanelData';

export interface KeptInstalledApps {
  readonly list: InstalledAppList;
  readonly brokenFolders: readonly AppFolderBroken[];
}

export const installedAppsCache = createPanelCache<KeptInstalledApps>();

/** Reads the project's installed apps into the cache the panel opens on. A failure is left for the panel to report. */
export async function prewarmInstalledApps(projectPath: string): Promise<void> {
  assert(projectPath.length > 0, 'prewarmInstalledApps: a project is open');
  if (installedAppsCache.get(projectPath) !== undefined) {
    return;
  }
  const [answer, folders] = await Promise.all([
    listInstalledAppList(projectPath),
    // A host without folder apps lists the apps alone.
    listBrokenAppFolders(projectPath).catch(() => undefined),
  ]);
  if (!answer.ok) {
    return;
  }
  // A list the panel read meanwhile is newer than this one.
  if (installedAppsCache.get(projectPath) === undefined) {
    installedAppsCache.set(projectPath, { list: answer.value, brokenFolders: folders?.ok === true ? folders.value : [] });
  }
}
