// The style and source IPC: the stylesheets the style panel can author, and
// the source files behind a symbol, read and written inside the open project.

import { MAIN_LIMITS, readSource } from '../lib/mainLimits';
import { writeProjectText } from '../documents/documentWrites';
import * as path from 'path';
import * as fs from 'fs';
import { toPosix } from '../lib/mainHelpers';
import { resolveImportPath, declarationLine } from '../properties/importPaths';
import { listCssFiles, listAstroStyleFiles } from '../project/styleFiles';
import { announceVariableWrite } from './cssVariableHandlers';
import type { MainHost } from './mainHost';

export function registerStyleSourceHandlers(host: Pick<MainHost, 'assertInProject' | 'ipcMain' | 'send'>): void {
  registerStyleListFilesHandlers(host);
  registerSourceWriteTextHandler(host);
}

function registerStyleListFilesHandlers({ ipcMain, assertInProject, send }: Pick<MainHost, 'ipcMain' | 'assertInProject' | 'send'>): void {
  ipcMain.handle('style:listFiles', async (_event, projectPath) => {
    if (!projectPath) {
      return { files: [] };
    }
    return { files: listCssFiles(projectPath) };
  });

  ipcMain.handle('style:listAstroStyles', async (_event, projectPath) => {
    if (!projectPath) {
      return { files: [] };
    }
    return { files: listAstroStyleFiles(projectPath) };
  });

  ipcMain.handle('style:readFile', async (_event, filePath) => {
    const abs = assertInProject(filePath);
    return { css: readSource(abs) };
  });

  ipcMain.handle('style:writeFile', async (_event, { filePath, css, announce }) => {
    const abs = assertInProject(filePath);
    writeProjectText(abs, css); // notes the write, so the watcher does not see it as external
    if (announce === true) {
      announceVariableWrite(send, [abs]);
    }
    return { ok: true as const };
  });

  // Opens the file an imported symbol comes from. `fromFile` is the file doing
  // the importing, so relative specifiers resolve the way the bundler sees them.
  ipcMain.handle('src:readSymbol', async (_event, { projectPath, fromFile, spec, name }) => {
    if (!projectPath || !fromFile) {
      return { ok: false as const };
    }
    const abs = resolveImportPath(projectPath, path.resolve(fromFile), spec);
    if (!abs) {
      return { ok: false as const, reason: 'not-found' };
    }
    assertInProject(abs);
    const stat = fs.statSync(abs);
    if (stat.size > MAIN_LIMITS.editableFileBytesMax) {
      return { ok: false as const, reason: 'too-large' };
    }
    const text = readSource(abs);
    return {
      ok: true as const,
      rel: path.relative(projectPath, abs),
      text,
      line: declarationLine(text, name),
    };
  });

  // Where an import points, as a project-relative path. Same resolution as
  // src:readSymbol, but it never reads the file — the callers here are asking
  // about images, and their bytes are none of this channel's business.
  ipcMain.handle('src:resolvePath', async (_event, { projectPath, fromFile, spec }) => {
    if (!projectPath || !fromFile) {
      return { ok: false as const };
    }
    const abs = resolveImportPath(projectPath, path.resolve(fromFile), spec);
    if (!abs) {
      return { ok: false as const };
    }
    assertInProject(abs);
    return { ok: true as const, rel: toPosix(path.relative(projectPath, abs)) };
  });

  ipcMain.handle('src:readText', async (_event, { projectPath, rel }) => {
    const abs = assertInProject(path.resolve(projectPath, rel));
    return { text: readSource(abs) };
  });
}

function registerSourceWriteTextHandler({ ipcMain, assertInProject }: Pick<MainHost, 'ipcMain' | 'assertInProject'>): void {
  ipcMain.handle('src:writeText', async (_event, { projectPath, rel, text }) => {
    const abs = assertInProject(path.resolve(projectPath, rel));
    writeProjectText(abs, text);
    return { ok: true as const };
  });
}
