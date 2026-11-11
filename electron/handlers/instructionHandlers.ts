// The Instructions panel's channels (shared/properties/instructions.ts): list the
// project's Markdown, read one file, write it against the text it was edited
// from, create a skill, rule or folder, and show a file in the file manager. The
// work is electron/project/instructionFiles.ts; this resolves the project and
// keeps every path inside it.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assert } from '../../shared/core/assert';
import { ok } from '../../shared/core/result';
import { createInstruction, createInstructionFolder, instructionPath, listInstructions, readInstruction, writeInstruction } from '../project/instructionFiles';
import type { MainHost } from './mainHost';

export function registerInstructionHandlers(host: Pick<MainHost, 'ipcMain' | 'assertInProject' | 'shell'>): void {
  // The canonical project, checked to be the one the app has open.
  const root = (projectPath: string): string => {
    const canonical = fs.realpathSync(projectPath);
    host.assertInProject(path.join(canonical, 'package.json'));
    assert(path.isAbsolute(canonical), 'A project root is absolute');
    return canonical;
  };
  host.ipcMain.handle('instructions:list', (_event, input) => listInstructions(root(input.projectPath)));
  host.ipcMain.handle('instructions:read', (_event, input) => {
    const read = readInstruction(root(input.projectPath), input.file);
    return read.ok ? ok({ source: read.value }) : read;
  });
  host.ipcMain.handle('instructions:write', (_event, input) => writeInstruction(root(input.projectPath), input.file, input.source, input.base));
  host.ipcMain.handle('instructions:create', (_event, input) => createInstruction(root(input.projectPath), input.file, input.source));
  host.ipcMain.handle('instructions:createFolder', (_event, input) => createInstructionFolder(root(input.projectPath), input.folder));
  host.ipcMain.handle('instructions:reveal', (_event, input) => {
    const target = instructionPath(root(input.projectPath), input.file);
    if (target.ok) {
      host.shell.showItemInFolder(host.assertInProject(target.value));
    }
    return { ok: true as const };
  });
}
