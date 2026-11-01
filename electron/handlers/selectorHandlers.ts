// The unused-selector IPC: check the project, remove proven-unused selectors,
// and undo or redo a removal. The keep list is read from `.stacki/styles.json`
// on every call, so a selector locked a moment ago is never removed.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { err, ok, type Result } from '../../shared/core/result';
import { METADATA_FILES } from '../../shared/properties/projectMetadata';
import { EMPTY_KEEP_LIST, parseStyleKeepList, type StyleKeepList } from '../../shared/properties/styleKeepList';
import { readProjectMetadata } from '../project/projectMetadata';
import { checkSelectorUsage, removeUnusedSelectors, restoreSelectorFiles } from '../properties/selectorRemoval';
import type { MainHost } from './mainHost';

export function registerSelectorHandlers(host: Pick<MainHost, 'ipcMain' | 'assertInProject'>): void {
  const root = (projectPath: string): string => {
    // The same containment check the metadata handlers make: the open
    // project's own settings file must be inside the open project.
    const canonical = fs.realpathSync(projectPath);
    host.assertInProject(path.join(canonical, METADATA_FILES.styles));
    return canonical;
  };
  host.ipcMain.handle('style:selectorUsage', async (_event, input) => {
    const project = root(input.projectPath);
    const keepList = readKeepList(project);
    if (!keepList.ok) {
      return keepList;
    }
    return ok((await checkSelectorUsage(project, keepList.value, input.packages ?? 'search')).report);
  });
  host.ipcMain.handle('style:removeSelectors', async (_event, input) => {
    const project = root(input.projectPath);
    for (const file of input.files) {
      host.assertInProject(path.join(project, file.rel));
    }
    const keepList = readKeepList(project);
    if (!keepList.ok) {
      return keepList;
    }
    return removeUnusedSelectors(project, keepList.value, { ids: input.ids, files: input.files });
  });
  host.ipcMain.handle('style:restoreSelectors', (_event, input) => {
    const project = root(input.projectPath);
    for (const change of input.changes) {
      host.assertInProject(path.join(project, change.rel));
    }
    return restoreSelectorFiles(project, input.changes, input.to);
  });
}

function readKeepList(project: string): Result<StyleKeepList> {
  const stored = readProjectMetadata(project, 'styles');
  if (!stored.ok) {
    return stored;
  }
  if (stored.value.source === undefined) {
    return ok(EMPTY_KEEP_LIST);
  }
  try {
    const input: unknown = JSON.parse(stored.value.source);
    return ok(parseStyleKeepList(input));
  } catch (error: unknown) {
    return err({ code: 'keep-list', message: `.stacki/styles.json is invalid: ${error instanceof Error ? error.message : String(error)}` });
  }
}
