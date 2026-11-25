// The CMS panel's catalog (the project's data files and content collections)
// and its last read per project, outside the panel's lazy chunk, so the app can
// fill it before the panel first opens (panelPrefetch.ts).
import type { Result } from '../../../shared/core/result';
import { assert } from '../../../shared/core/assert';
import { createPanelCache, prewarmPanelCache } from '../../lib/usePanelData';
import { readCmsFiles, readContentCollections, type CmsPanelContent, type CmsPanelFile } from './cmsPanelBridge';
import { readProjectFolderSettings } from '../../ipc/projectFolderSettings';
import { shownCollections, type ProjectFolders } from '../../../shared/properties/projectFolders';
import { listCmsConnections } from '../../ipc/cmsConnectionsBridge';
import type { CmsConnection } from '../../../shared/properties/cmsConnections';

export interface CmsCatalog {
  readonly files: readonly CmsPanelFile[];
  readonly content: CmsPanelContent;
}

export const cmsCache = createPanelCache<CmsCatalog>();

/** The project's connected CMSs as last read, which the panel lists above its collections. */
export const keptCmsConnections = createPanelCache<readonly CmsConnection[]>();

/** Reads the project's catalog into the cache the panel opens on. */
export function prewarmCmsCatalog(projectPath: string): Promise<void> {
  return prewarmPanelCache(cmsCache, projectPath, () => readCmsCatalog(projectPath));
}

/** Reads the project's connected CMSs, so the panel's first open draws their rows in its first frame. */
export async function prewarmCmsConnections(projectPath: string): Promise<void> {
  assert(projectPath.length > 0, 'prewarmCmsConnections: a project is open');
  if (keptCmsConnections.get(projectPath) !== undefined) {
    return;
  }
  const list = await listCmsConnections(projectPath);
  // A list the panel read meanwhile is newer than this one.
  if (keptCmsConnections.get(projectPath) === undefined) {
    keptCmsConnections.set(projectPath, list.connections);
  }
}

// Folder settings that cannot be read hide nothing: the panel shows everything, as it did before them.
async function readCmsFolderSettings(projectPath: string): Promise<ProjectFolders | undefined> {
  try {
    return await readProjectFolderSettings(projectPath);
  } catch {
    return undefined;
  }
}
export async function readCmsCatalog(projectPath: string): Promise<Result<CmsCatalog, string>> {
  const [files, content, folders] = await Promise.all([readCmsFiles(projectPath), readContentCollections(projectPath), readCmsFolderSettings(projectPath)]);
  if (!files.ok) {
    return files;
  }
  if (!content.ok) {
    return content;
  }
  // Collections the project hides from this panel (Settings → Folders, `cms.hiddenCollections`)
  // stay in the content config; only the panel leaves them out.
  const collections = shownCollections(content.value.collections, folders);
  return { ok: true, value: { files: files.value, content: { ...content.value, collections } } };
}
