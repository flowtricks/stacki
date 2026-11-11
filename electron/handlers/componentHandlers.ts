// The component IPC: creating components, editing their declared properties
// with undo, where they are used, the import paths between pages, and copying a
// selection.

import {
  inverseBatch,
  loadComponentProperties,
  PropertyUndoStore,
  revertComponentProperties,
  updateComponentProperties,
  type FileChange,
} from '../properties/componentProperties';
import { createProjectText } from '../documents/documentWrites';
import { definedFields } from '../../shared/core/boundary';
import { isPathDescendant } from '../lib/platform';
import { assert } from '../../shared/core/assert';
import { ok } from '../../shared/core/result';
import * as path from 'path';
import * as fs from 'fs';
import { componentFile, discardComponentFile } from '../documents/componentFile';
import { componentUsage } from '../properties/componentUsage';
import { toPosix } from '../lib/mainHelpers';
import { selectionTrail } from '../documents/pageRequests';
import type { MainHost } from './mainHost';
import { projectFoldersFor } from '../lib/projectFolders';
import { componentSpecifier } from '../properties/componentImports';

// Step 6: every applied property batch leaves its inverse here, and the reply
// carries the token Undo sends back (componentProperties.ts).
const propertyUndo = new PropertyUndoStore();

export function registerComponentHandlers(host: Pick<MainHost, 'clipboard' | 'documents' | 'ipcMain' | 'noteAppWrite'>): void {
  registerComponentCreateHandlers(host);
  registerSelectionCopyHandler(host);
}

function registerComponentCreateHandlers({ ipcMain, documents, noteAppWrite }: Pick<MainHost, 'ipcMain' | 'documents' | 'noteAppWrite'>): void {
  // Turn a piece of a page into a component of its own. The file is worked out
  // in componentFile.js; writing it belongs here, with every other write.
  // The checksum is what Undo hands back to `component:discard`: the file goes
  // only while it still holds these bytes.
  ipcMain.handle('component:create', async (_event, options) => {
    const { path: target, rel, text } = componentFile({ ...options, componentFolders: projectFoldersFor(options.projectPath, 'components') });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const checksum = createProjectText(target, text);
    return { path: target, rel, name: options.name, checksum };
  });

  // Undo of creating a component: one step with the page edit that placed it.
  ipcMain.handle('component:discard', async (_event, { projectPath, path: target, checksum, force }) => {
    noteAppWrite();
    return {
      outcome: discardComponentFile({
        projectPath,
        path: target,
        checksum,
        force: force === true,
        componentFolders: projectFoldersFor(projectPath, 'components'),
      }),
    };
  });

  // Component property edits validate their revision before updating project sources.
  ipcMain.handle('component:properties', (_event, location) => loadComponentProperties(location));
  ipcMain.handle('component:editProperties', (_event, request) => {
    let undo: string | undefined;
    const onCommitted = (changes: readonly FileChange[]) => {
      undo = propertyUndo.record(inverseBatch(changes));
    };
    const result = updateComponentProperties(request, {
      documents,
      noteWrite: noteAppWrite,
      onCommitted,
    });
    if (!result.ok) {
      return result;
    }
    assert(undo !== undefined, 'An applied batch recorded its inverse');
    return ok({ ...result.value, undo });
  });
  ipcMain.handle('component:revertProperties', (_event, { token }) => revertComponentProperties(token, propertyUndo, { documents, noteWrite: noteAppWrite }));

  // Which files hold instances of a component — the palette’s instance count.
  ipcMain.handle('component:usage', async (_event, { projectPath, name, exclude }) => componentUsage(definedFields({ projectPath, name, exclude })));

  ipcMain.handle('page:importPathFor', async (_event, { pagePath, targetPath, projectPath }) => {
    const preferred = projectPath ? componentSpecifier(projectPath, targetPath) : undefined;
    if (preferred !== undefined) {
      return { relative: preferred, srcRelative: undefined };
    }
    const rel = toPosix(path.relative(path.dirname(pagePath), targetPath));
    const relative = rel.startsWith('.') ? rel : './' + rel;
    let sourceRelative: string | undefined = undefined;
    if (projectPath) {
      const sourceDirectory = path.join(projectPath, 'src');
      if (isPathDescendant(sourceDirectory, targetPath)) {
        sourceRelative = toPosix(path.relative(sourceDirectory, targetPath));
      }
    }
    return { relative, srcRelative: sourceRelative };
  });

  // The same import, written for another page.
  //
  // A relative specifier says where a file is FROM WHERE IT IS WRITTEN, so
  // `../assets/hero.png` copied from src/pages/index.astro into
  // src/pages/blog/post.astro points at nothing. Anything else — an alias, a bare
  // package, `astro:content` — means the same thing wherever it is written, and
  // is handed back untouched.
  ipcMain.handle('page:rebaseImport', async (_event, { fromPagePath, toPagePath, spec }) => {
    const text = String(spec || '');
    if (!text.startsWith('.')) {
      return { path: text };
    }
    if (!fromPagePath || !toPagePath) {
      return { path: text };
    }
    const abs = path.resolve(path.dirname(fromPagePath), text);
    const rel = toPosix(path.relative(path.dirname(toPagePath), abs));
    return { path: rel.startsWith('.') ? rel : './' + rel };
  });
}

function registerSelectionCopyHandler({ ipcMain, clipboard }: Pick<MainHost, 'clipboard' | 'ipcMain'>): void {
  ipcMain.handle('selection:copy', async (_event, state) => {
    const trail = selectionTrail(state);
    if (!trail) {
      return { ok: false as const };
    }
    // Electron's clipboard is asynchronous; acknowledge only after the copy finishes.
    await clipboard.writeText(trail.join('\n'));
    return { ok: true as const, count: trail.length };
  });
}
