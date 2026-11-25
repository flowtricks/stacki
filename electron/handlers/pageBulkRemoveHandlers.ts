// The Pages panel's Select mode, in main: planning the deletion of several pages and folders for its confirm (nothing
// written), and doing it as ONE step with ONE undo token. The step is written all or nothing by the Page settings
// writer, and its token lives in that writer's store, so Undo and Redo are `page:revertSettings`, like every other
// Page settings step. A folder holding anything but pages is refused at the plan, so every byte Undo restores was read.
import fs from 'node:fs';
import path from 'node:path';
import { err, ok, type Result } from '../../shared/core/result';
import { readAstroPages } from '../lib/astroConfig';
import { desktopRenameWriter } from '../project/pageRenameDesktop';
import { applyRelocationStep, type RelocationStep, type RelocationStore } from '../project/pageRelocationWrite';
import { JUNK_FILES, planBulkRemoveSliced } from './pageBulkRemovePlan';
import type { MainHost } from './mainHost';

export function registerPageBulkRemoveHandlers({ ipcMain, noteAppWrite }: Pick<MainHost, 'ipcMain' | 'noteAppWrite'>, store: RelocationStore): void {
  ipcMain.handle('page:planRemoveMany', async (_event, { projectPath, request }) => {
    const refused = refuseMovedPagesFolder(projectPath);
    if (refused !== undefined) {
      return refused;
    }
    const planned = await planBulkRemoveSliced(projectPath, request);
    return planned.ok ? ok(planned.value.summary) : err(planned.error);
  });

  // Planned again from disk: what the confirm showed may be stale, and the write is checked against these bytes.
  ipcMain.handle('page:removeMany', async (_event, { projectPath, request }) => {
    const refused = refuseMovedPagesFolder(projectPath);
    if (refused !== undefined) {
      return refused;
    }
    const planned = await planBulkRemoveSliced(projectPath, request);
    if (!planned.ok) {
      return err(planned.error);
    }
    noteAppWrite();
    const applied = applyRelocationStep(planned.value.step, desktopRenameWriter());
    if (applied.ok) {
      removeJunkFolders(planned.value.step);
    }
    noteAppWrite();
    return applied.ok ? ok({ summary: planned.value.summary, undo: store.record(planned.value.step) }) : err(applied.error);
  });
}

// A folder the step removes may still hold the file manager's own litter, which kept it from going as empty.
function removeJunkFolders(step: RelocationStep): void {
  for (const folder of step.folders.removed) {
    const full = path.join(step.root, ...folder.split('/'));
    try {
      for (const entry of fs.readdirSync(full)) {
        if (JUNK_FILES.has(entry)) {
          fs.rmSync(path.join(full, entry), { force: true });
        }
      }
      if (fs.readdirSync(full).length === 0) {
        fs.rmdirSync(full);
      }
    } catch {
      // Already gone or not readable: the folder is left as it is, which loses nothing.
    }
  }
}

// Steps name files by their src/pages paths, so a project whose astro.config moves the pages folder is refused with the reason.
function refuseMovedPagesFolder(projectPath: string): Result<never> | undefined {
  const { pagesFolder, configFile } = readAstroPages(projectPath);
  if (pagesFolder === 'src/pages') {
    return undefined;
  }
  return err({
    code: 'pages-folder',
    message: `Deleting pages here is not supported when ${configFile ?? 'astro.config'} moves the pages folder to ${pagesFolder}. Delete the files in your editor.`,
  });
}
