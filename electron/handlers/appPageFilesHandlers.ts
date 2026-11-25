// What Stacki Apps read of pages that are not open (docs/apps.md, "Reading other
// pages"): each file's modification stamp, so the renderer's page index
// (src/features/apps/appPageIndex.ts) re-reads only what changed. The files
// themselves are read through `page:read`, the parser every open page uses.
//
// One batch is at most APP_FILE_STAMPS_MAX files (the payload parser holds it),
// each confined to the project; a file that is gone, or is not a file, answers
// undefined rather than failing the batch.
import * as fs from 'fs';
import * as path from 'path';
import { assert } from '../../shared/core/assert';
import { APP_FILE_STAMPS_MAX } from '../../shared/ipc/ipcPayloads';
import type { MainHost } from './mainHost';

export function registerAppPageFilesHandlers({ ipcMain, assertInProject }: Pick<MainHost, 'ipcMain' | 'assertInProject'>): void {
  ipcMain.handle('apps:fileStamps', async (_event, { projectPath, rels }) => {
    assert(rels.length <= APP_FILE_STAMPS_MAX, 'A stamp batch is bounded by its payload parser');
    const stamps = await Promise.all(
      rels.map(async (rel) => {
        const absolute = assertInProject(path.resolve(projectPath, rel));
        try {
          const stat = await fs.promises.stat(absolute);
          return stat.isFile() ? { mtimeMs: stat.mtimeMs, sizeBytes: stat.size } : undefined;
        } catch {
          return undefined; // Gone between the scan and the stamp: the index forgets it.
        }
      }),
    );
    assert(stamps.length === rels.length, 'Every file asked about is answered');
    return { stamps };
  });
}
