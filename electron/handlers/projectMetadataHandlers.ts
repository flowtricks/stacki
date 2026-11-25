import * as fs from 'node:fs';
import * as path from 'node:path';
import { METADATA_FILES, type MetadataKind } from '../../shared/properties/projectMetadata';
import { readProjectMetadata, writeProjectMetadata } from '../project/projectMetadata';
import type { MainHost } from './mainHost';
import { assert } from '../../shared/core/assert';
import { createProjectText } from '../documents/documentWrites';
import { ensureExcluded } from '../lib/projectExclusions';
import { translateMain } from '../lib/mainLocale';

export function registerProjectMetadataHandlers(host: Pick<MainHost, 'ipcMain' | 'assertInProject' | 'send' | 'showOpenDialog'>): void {
  const root = (projectPath: string, kind: MetadataKind): string => {
    const canonical = fs.realpathSync(projectPath);
    host.assertInProject(path.join(canonical, METADATA_FILES[kind]));
    return canonical;
  };
  host.ipcMain.handle('project:metadata', (_event, input) => readProjectMetadata(root(input.projectPath, input.kind), input.kind));
  host.ipcMain.handle('project:writeMetadata', (_event, input) => {
    const result = writeProjectMetadata(root(input.projectPath, input.write.kind), input.write);
    // Folder settings decide what the components, layouts, assets and style panels
    // list: a saved change rescans them all now, before any watcher notices.
    if (result.ok && input.write.kind === 'folders') {
      announceFolderChange(host.send);
    }
    return result;
  });
  // The Folders tab's "Add folder": the system dialog opens on the project, and a
  // choice outside it is answered, not followed. The tab checks the folder's own
  // rules (projectFolders.ts); this decides only that it is inside the project.
  host.ipcMain.handle('project:pickFolder', async (_event, input) => {
    const project = fs.realpathSync(input.projectPath);
    const file = input.target === 'file';
    const picked = await host.showOpenDialog({
      title: translateMain(file ? 'dialog.open.projectFile.title' : 'dialog.open.projectFolder.title'),
      defaultPath: project,
      properties: [file ? 'openFile' : 'openDirectory'],
    });
    const chosen = picked.filePaths[0];
    if (picked.canceled || chosen === undefined) {
      return { kind: 'canceled' as const };
    }
    return projectFolderOf(project, chosen);
  });
  host.ipcMain.handle('project:createDefaultsCanvas', (_event, input) => {
    const project = root(input.projectPath, 'components');
    const file = canvasPath(project, input.canvas.file);
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true });
    if (fs.readdirSync(directory).length >= 64) {
      throw new Error('Too many defaults previews. Close an existing preview first.');
    }
    createProjectText(file, input.canvas.source);
    ensureExcluded(project);
    return { file: input.canvas.file };
  });
  host.ipcMain.handle('project:removeDefaultsCanvas', (_event, input) => {
    const project = root(input.projectPath, 'components');
    fs.rmSync(canvasPath(project, input.file), { force: true });
    return undefined;
  });
}

function canvasPath(root: string, relative: string): string {
  const file = path.join(root, relative);
  for (const candidate of [path.join(root, '.stacki'), path.dirname(file), file]) {
    if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) {
      throw new Error('Defaults previews cannot be symbolic links.');
    }
  }
  return file;
}

/** The change events every folder-backed panel refreshes on (projectWatcher.ts sends the same). */
export function announceFolderChange(send: MainHost['send']): void {
  send('fs:changed', { files: [] });
  send('assets:changed', {});
  send('css:changed', {});
}

/** A chosen directory or file as a project-relative path, or why it is not one. Links are resolved first, so a link cannot lead out. */
export function projectFolderOf(
  project: string,
  chosen: string,
): { readonly kind: 'picked'; readonly path: string } | { readonly kind: 'outside'; readonly message: string } {
  assert(path.isAbsolute(project), 'projectFolderOf: the project is absolute');
  let real: string;
  try {
    real = fs.realpathSync(chosen);
  } catch {
    return { kind: 'outside', message: translateMain('error.project.gone') };
  }
  const relative = path.relative(project, real);
  if (relative === '') {
    return { kind: 'outside', message: translateMain('error.project.chooseInside') };
  }
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { kind: 'outside', message: translateMain('error.project.outside') };
  }
  const folder = relative.split(path.sep).join('/');
  assert(!folder.startsWith('/'), 'projectFolderOf: the folder is project-relative');
  return { kind: 'picked', path: folder };
}
