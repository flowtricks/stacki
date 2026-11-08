// The variables panel's IPC: the CSS custom properties a project declares,
// and the edits that add, move, rename and group them.

import path from 'path';
import * as cssVars from '../project/cssVars';
import { errorMessage } from '../lib/mainHelpers';
import type { MainHost } from './mainHost';

type Send = MainHost['send'];

/**
 * Tells the renderer that variable edits reached `files`. A write of the app's own
 * is silent to the watcher, so an `.astro` file also has to be named here: it may
 * be the open page, whose model would otherwise keep the old `<style>` text and
 * lose the edit on its next save.
 */
export function announceVariableWrite(send: Send, files: readonly string[]): void {
  send('css:changed', {});
  const pages = files.filter((file) => /\.astro$/i.test(file));
  if (pages.length > 0) {
    send('fs:changed', { files: pages });
  }
}

const inProject = (projectPath: string, edits: ReadonlyArray<{ readonly file: string }>): readonly string[] =>
  edits.map(({ file }) => path.resolve(projectPath, file));

export function registerCssVariableHandlers(host: Pick<MainHost, 'ipcMain' | 'send'>): void {
  registerCssVariablesHandlers(host);
  registerCssAddSectionHandlers(host);
}

function registerCssVariablesHandlers({ ipcMain, send }: Pick<MainHost, 'ipcMain' | 'send'>): void {
  // The collections themselves, with counts, for the panel that lists them.
  // Every CSS custom property in the project, grouped the way the stylesheets
  // themselves group them — see cssVars.js for what "the way" means.
  ipcMain.handle('css:variables', async (_event, projectPath) => {
    try {
      return cssVars.readVariables(projectPath);
    } catch (error: unknown) {
      return { files: [], error: errorMessage(error) };
    }
  });

  // A variable added at the bottom of a group. One call carries several: a row in
  // a table of modes is one name in every mode, and a row in a family is one
  // property of every member.
  ipcMain.handle('css:addVariables', async (_event, { projectPath, adds }) => {
    let last: { ok: boolean; error?: string; name?: string; changed?: boolean } = { ok: true };
    for (const add of adds || []) {
      last = cssVars.addVariable(projectPath, add);
      if (!last.ok) {
        break;
      }
    }
    if (last.ok) {
      announceVariableWrite(send, inProject(projectPath, adds ?? []));
    }
    return last;
  });

  // A row dragged to a new place: the declaration moves inside its rule, which is
  // where the order actually lives.
  ipcMain.handle('css:moveVariables', async (_event, { projectPath, moves }) => {
    let last: { ok: boolean; error?: string; name?: string; changed?: boolean } = { ok: true };
    for (const move of moves || []) {
      // A group carries its heading and every line under it; a row is one line.
      last = 'names' in move ? cssVars.moveSection(projectPath, move) : cssVars.moveVariable(projectPath, move);
      if (!last.ok) {
        break;
      }
    }
    if (last.ok) {
      announceVariableWrite(send, inProject(projectPath, moves ?? []));
    }
    return last;
  });

  // A heading that is a comment rather than a shared name: renaming it rewrites
  // the comment, in place, the same way a value is written.
  ipcMain.handle('css:setSectionTitle', async (_event, { projectPath, ...edit }) => {
    const result = cssVars.setSectionTitle(projectPath, edit);
    if (result.ok) {
      announceVariableWrite(send, inProject(projectPath, [edit]));
    }
    return result;
  });

  // A heading is a line between declarations: removing it joins the runs either
  // side, and adding one splits them.
  ipcMain.handle('css:removeSection', async (_event, { projectPath, ...edit }) => {
    const result = cssVars.removeSection(projectPath, edit);
    if (result.ok) {
      announceVariableWrite(send, inProject(projectPath, [edit]));
    }
    return result;
  });

  ipcMain.handle('css:moveHeading', async (_event, { projectPath, ...edit }) => {
    const result = cssVars.moveHeading(projectPath, edit);
    if (result.ok) {
      announceVariableWrite(send, inProject(projectPath, [edit]));
    }
    return result;
  });
}

function registerCssAddSectionHandlers({ ipcMain, send }: Pick<MainHost, 'ipcMain' | 'send'>): void {
  ipcMain.handle('css:addSection', async (_event, { projectPath, ...edit }) => {
    const result = cssVars.addSection(projectPath, edit);
    if (result.ok) {
      announceVariableWrite(send, inProject(projectPath, [edit]));
    }
    return result;
  });

  // Renaming reaches every file that mentions the name, so it is one call rather
  // than one per file: the panel says which names become which, and either all of
  // them move or none does.
  ipcMain.handle('css:renameVariables', async (_event, { projectPath, renames }) => {
    const result = cssVars.renameVariables(projectPath, { renames });
    if (result.ok) {
      announceVariableWrite(send, result.paths ?? []);
    }
    return result;
  });

  // One value, replaced where it sits. The old value is sent back with the new
  // one: if the file no longer says what the panel was showing, somebody else has
  // edited it and the offsets are meaningless.
  ipcMain.handle('css:setVariable', async (_event, { projectPath, ...edit }) => {
    const result = cssVars.setVariable(projectPath, edit);
    if (result.ok) {
      announceVariableWrite(send, inProject(projectPath, [edit]));
    }
    return result;
  });
}
