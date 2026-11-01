import * as fs from 'node:fs';
import * as path from 'node:path';
import { METADATA_FILES, type MetadataKind } from '../../shared/properties/projectMetadata';
import { readProjectMetadata, writeProjectMetadata } from '../project/projectMetadata';
import type { MainHost } from './mainHost';
import { createProjectText } from '../documents/documentWrites';
import { ensureExcluded } from '../lib/projectExclusions';

export function registerProjectMetadataHandlers(host: Pick<MainHost, 'ipcMain' | 'assertInProject'>): void {
  const root = (projectPath: string, kind: MetadataKind): string => {
    const canonical = fs.realpathSync(projectPath);
    host.assertInProject(path.join(canonical, METADATA_FILES[kind]));
    return canonical;
  };
  host.ipcMain.handle('project:metadata', (_event, input) => readProjectMetadata(root(input.projectPath, input.kind), input.kind));
  host.ipcMain.handle('project:writeMetadata', (_event, input) => writeProjectMetadata(root(input.projectPath, input.write.kind), input.write));
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
