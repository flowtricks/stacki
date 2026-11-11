// The assets panel's IPC: listing, uploading, moving, renaming and deleting a
// project's asset files, and reading and writing the text ones.

import { MAIN_LIMITS, readSource } from '../lib/mainLimits';
import { writeProjectText } from '../documents/documentWrites';
import { isPathWithin, sameFilesystemPath } from '../lib/platform';
import { toPosix } from '../lib/mainHelpers';
import * as path from 'path';
import * as fs from 'fs';
import type { MainHost } from './mainHost';
import { replacementRefusal } from '../../shared/properties/mediaHosting';
import { rootOfRel, assetAbs, assetWriteRefusal, uniqueTarget, imageSizeOf, listAssetEntries } from '../project/assetFiles';

export function registerAssetHandlers(host: Pick<MainHost, 'assertInProject' | 'ipcMain' | 'noteAppWrite' | 'send' | 'shell' | 'showOpenDialog'>): void {
  registerAssetsListHandlers(host);
  registerAssetsMoveHandlers(host);
  registerAssetsReadTextHandlers(host);
}

function registerAssetsListHandlers({
  ipcMain,
  showOpenDialog,
  noteAppWrite,
  send,
}: Pick<MainHost, 'ipcMain' | 'showOpenDialog' | 'noteAppWrite' | 'send'>): void {
  ipcMain.handle('assets:list', async (_event, projectPath) => {
    // Which folders under public/ and src/ hold assets is the project's choice
    // (.stacki/folders.json); by default, all of both.
    const { entries, hasPublic } = listAssetEntries(projectPath);
    return { entries, missing: !hasPublic };
  });

  // Opens a picker and copies the chosen files into public/<destRel>.
  ipcMain.handle('assets:pickUpload', async (_event, { projectPath, destRel: targetRel }) => {
    const result = await showOpenDialog({
      title: 'Upload assets',
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled || !result.filePaths.length) {
      return { added: 0 };
    }
    return copyAssetsIn({ noteAppWrite, send }, projectPath, targetRel, result.filePaths);
  });

  // Copies OS-dragged files into public/<destRel>.
  ipcMain.handle('assets:upload', async (_event, { projectPath, destRel: targetRel, filePaths }) => {
    return copyAssetsIn({ noteAppWrite, send }, projectPath, targetRel, filePaths || []);
  });
}

function registerAssetsMoveHandlers({
  ipcMain,
  noteAppWrite,
  send,
  shell,
  showOpenDialog,
}: Pick<MainHost, 'ipcMain' | 'noteAppWrite' | 'send' | 'shell' | 'showOpenDialog'>): void {
  ipcMain.handle('assets:move', async (_event, { projectPath, fromRel, toDirRel: toDirectoryRel }) => {
    const from = assetAbs(projectPath, fromRel);
    const toDirectory = assetAbs(projectPath, toDirectoryRel);
    // Between roots the file's IDENTITY changes, not just its path: a public/
    // asset is referenced by URL and a src/ one by import, so every reference to
    // it would have to be rewritten in place. Until that rewrite exists, refuse
    // — moving the file alone would leave the site pointing at nothing, quietly.
    if (rootOfRel(fromRel) !== rootOfRel(toDirectoryRel)) {
      throw new Error(
        'Moving between public/ and src/ changes how the file is referenced ' +
          '(URL vs import), so it needs the references updated too. Not supported yet — ' +
          'move it outside the app and fix the references by hand.',
      );
    }
    if (!fs.existsSync(from)) {
      return { ok: false as const };
    }
    // Refuse moving a folder into itself/its own subtree.
    if (fs.statSync(from).isDirectory() && isPathWithin(from, toDirectory)) {
      throw new Error('Cannot move a folder into itself.');
    }
    const target = uniqueTarget(toDirectory, path.basename(from));
    noteAppWrite();
    noteAppWrite();
    fs.mkdirSync(toDirectory, { recursive: true });
    fs.renameSync(from, target);
    send('assets:changed', {});
    return { ok: true as const };
  });

  ipcMain.handle('assets:rename', async (_event, { projectPath, rel, newName }) => {
    const clean = String(newName).trim().replace(/[/\\]/g, '');
    if (!clean) {
      throw new Error('Invalid name');
    }
    const from = assetAbs(projectPath, rel);
    const target = path.join(path.dirname(from), clean);
    if (sameFilesystemPath(target, from)) {
      return { ok: true as const };
    }
    // A file under src/ stays media on both sides of a rename: renaming code, or
    // renaming an image to `.astro`, is not an asset operation.
    if (fs.statSync(from).isFile()) {
      for (const side of [from, target]) {
        const refusal = assetWriteRefusal(toPosix(path.relative(path.resolve(projectPath), side)));
        if (refusal !== undefined) {
          throw new Error(refusal);
        }
      }
    }
    if (fs.existsSync(target)) {
      throw new Error('Something with that name already exists.');
    }
    noteAppWrite();
    noteAppWrite();
    fs.renameSync(from, target);
    send('assets:changed', {});
    return { ok: true as const };
  });

  // Swaps a file's bytes in place: the name and path stay, so every page,
  // import and CMS entry pointing at it keeps working. The person picks the
  // new file; one of another media type is refused, since the old name would
  // then lie about what it holds. A cancel is no replacement, not a failure.
  ipcMain.handle('assets:replace', async (_event, { projectPath, rel }) => {
    const target = assetAbs(projectPath, rel);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return { ok: false as const, message: `${path.basename(rel)} is no longer there.` };
    }
    // Under src/ only media is an asset; everything else there is code (pages,
    // components, stylesheets) that only the document actors write, so a raw
    // byte copy must never reach it (test/electron/documents/singleWriter.test.ts).
    const refusal = assetWriteRefusal(toPosix(path.relative(path.resolve(projectPath), target)));
    if (refusal !== undefined) {
      return { ok: false as const, message: refusal };
    }
    const picked = await showOpenDialog({ title: `Replace ${path.basename(rel)}`, properties: ['openFile'] });
    const source = picked.filePaths[0];
    if (picked.canceled || source === undefined) {
      return { ok: true as const, value: false };
    }
    const mismatch = replacementRefusal(path.basename(target), path.basename(source));
    if (mismatch !== undefined) {
      return { ok: false as const, message: mismatch };
    }
    noteAppWrite();
    fs.copyFileSync(source, target);
    send('assets:changed', {});
    return { ok: true as const, value: true };
  });

  // To the system's bin, not to nothing. An asset is somebody's photograph as
  // often as it is a placeholder, references to it live in files this does not
  // read, and the app has no copy of it — so "gone" has to mean somewhere they
  // can get it back from without us.
  ipcMain.handle('assets:delete', async (_event, { projectPath, rel }) => {
    const abs = assetAbs(projectPath, rel);
    if (!fs.existsSync(abs)) {
      return { ok: false as const };
    }
    noteAppWrite();
    await shell.trashItem(abs);
    send('assets:changed', {});
    return { ok: true as const };
  });
}

function registerAssetsReadTextHandlers({
  ipcMain,
  noteAppWrite,
  send,
  assertInProject,
}: Pick<MainHost, 'ipcMain' | 'noteAppWrite' | 'send' | 'assertInProject'>): void {
  // Text assets (css/js/json/svg/…) are editable in the floating code window.
  ipcMain.handle('assets:readText', async (_event, { projectPath, rel }) => {
    const abs = assetAbs(projectPath, rel);
    const stat = fs.statSync(abs);
    if (stat.size > MAIN_LIMITS.editableFileBytesMax) {
      throw new Error('That file is too large to edit in the app (over 5 MB).');
    }
    return { text: readSource(abs) };
  });

  ipcMain.handle('assets:writeText', async (_event, { projectPath, rel, text }) => {
    const abs = assetAbs(projectPath, rel);
    writeProjectText(abs, text);
    return { ok: true as const };
  });

  ipcMain.handle('assets:mkdir', async (_event, { projectPath, parentRel, name }) => {
    const clean = String(name).trim().replace(/[/\\]/g, '');
    if (!clean) {
      throw new Error('Invalid folder name');
    }
    const directory = path.join(assetAbs(projectPath, parentRel), clean);
    noteAppWrite();
    fs.mkdirSync(directory, { recursive: true });
    send('assets:changed', {});
    return { ok: true as const };
  });

  ipcMain.handle('assets:dimensions', async (_event, { projectPath, rel }) => {
    const abs = assertInProject(path.resolve(projectPath, rel));
    return { dims: imageSizeOf(abs) ?? undefined };
  });
}

function copyAssetsIn({ noteAppWrite, send }: Pick<MainHost, 'noteAppWrite' | 'send'>, projectPath: string, targetRel: string, filePaths: readonly string[]) {
  const targetDirectory = assetAbs(projectPath, targetRel);
  fs.mkdirSync(targetDirectory, { recursive: true });
  let added = 0;
  for (const source of filePaths) {
    try {
      const target = uniqueTarget(targetDirectory, path.basename(source));
      noteAppWrite();
      fs.cpSync(source, target, { recursive: true });
      added++;
    } catch {
      /* skip unreadable file */
    }
  }
  send('assets:changed', {});
  return { added };
}
