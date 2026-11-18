// The component IPC: creating components, editing their declared properties
// with undo, where they are used, the import paths between pages, and copying a
// selection.

import {
  inverseBatch,
  loadComponentProperties,
  previewComponentPropertyRemoval,
  PropertyUndoStore,
  revertComponentProperties,
  updateComponentProperties,
  type FileChange,
} from '../properties/componentProperties';
import { createProjectText } from '../documents/documentWrites';
import { definedFields } from '../../shared/core/boundary';
import { translateMain } from '../lib/mainLocale';
import { assert } from '../../shared/core/assert';
import { err, ok } from '../../shared/core/result';
import * as path from 'path';
import * as fs from 'fs';
import { componentFile, discardComponentFile } from '../documents/componentFile';
import { componentUsage } from '../properties/componentUsage';
import { toPosix } from '../lib/mainHelpers';
import { selectionTrail } from '../documents/pageRequests';
import type { MainHost } from './mainHost';
import { applyComponentRename, ComponentRenameStore, revertComponentRename } from './componentRenameApply';
import { planComponentRenameWork } from './componentRenamePlan';
import { desktopRenameWriter } from '../project/pageRenameDesktop';
import { runSliced } from '../lib/slicedWork';
import { ComponentRemovalStore, duplicateComponentTarget, previewRemoveTarget, removeComponentTarget, restoreRemovedComponent } from './componentOps';
import { projectFoldersFor } from '../lib/projectFolders';
import { componentImportPaths } from '../properties/componentImports';

// Step 6: every applied property batch leaves its inverse here, and the reply
// carries the token Undo sends back (componentProperties.ts).
const propertyUndo = new PropertyUndoStore();
// What each deletion from the Components panel removed, so Undo can put it back (componentOps.ts).
const removalUndo = new ComponentRemovalStore();
const renameUndo = new ComponentRenameStore();

export function registerComponentHandlers(host: Pick<MainHost, 'clipboard' | 'documents' | 'ipcMain' | 'noteAppWrite' | 'shell'>): void {
  registerComponentCreateHandlers(host);
  registerSelectionCopyHandler(host);
}

function registerComponentCreateHandlers({
  ipcMain,
  documents,
  noteAppWrite,
  shell,
}: Pick<MainHost, 'ipcMain' | 'documents' | 'noteAppWrite' | 'shell'>): void {
  // Turn a piece of a page into a component of its own. The file is worked out
  // in componentFile.js; writing it belongs here, with every other write.
  // The checksum is what Undo hands back to `component:discard`: the file goes
  // only while it still holds these bytes.
  ipcMain.handle('component:create', async (_event, options) => {
    const { path: target, rel, text, folders } = componentFile({ ...options, componentFolders: projectFoldersFor(options.projectPath, 'components') });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const checksum = createProjectText(target, text);
    assert(
      folders.every((folder) => fs.existsSync(folder)),
      'Every folder the component needed was made',
    );
    return { path: target, rel, name: options.name, checksum, folders };
  });

  // The Components panel's "…" menu. Expected refusals (used, outside the component folders, a name that cannot be found)
  // come back as typed errors with nothing changed; see componentOps.ts for what each writes.
  // Rename or move a component and everything that names it: a preview of the files that change, the rename itself (all
  // files or none, one undo token), and its undo and redo. See componentRenamePlan.ts for what counts as a reference.
  ipcMain.handle('component:planRename', async (_event, { projectPath, request }) => {
    const plan = await runSliced(planComponentRenameWork(projectPath, request));
    return plan.ok ? ok(plan.value.summary) : err(plan.error);
  });
  ipcMain.handle('component:rename', async (_event, { projectPath, request }) => {
    noteAppWrite();
    const plan = await runSliced(planComponentRenameWork(projectPath, request));
    if (!plan.ok) {
      return err(plan.error);
    }
    const applied = applyComponentRename(plan.value, desktopRenameWriter());
    return applied.ok ? ok({ ...plan.value.summary, undo: renameUndo.record(plan.value) }) : err(applied.error);
  });
  ipcMain.handle('component:revertRename', async (_event, { token, direction }) => {
    noteAppWrite();
    const plan = renameUndo.get(token);
    if (plan === undefined) {
      return err({ code: 'unknown-undo', message: translateMain('error.component.unknownUndo') });
    }
    const done = direction === 'undo' ? revertComponentRename(plan, desktopRenameWriter()) : applyComponentRename(plan, desktopRenameWriter());
    return done.ok ? ok({ files: plan.texts.length }) : err(done.error);
  });
  ipcMain.handle('component:duplicate', async (_event, { projectPath, target }) => duplicateComponentTarget(projectPath, target));
  // Deleting a component: the plan the confirmation shows (no write), then the deletion with every instance and import
  // (componentRemovalPlan.ts), pages first and the file last, undone in one step.
  ipcMain.handle('component:planRemove', async (_event, { projectPath, target }) => previewRemoveTarget(projectPath, target));
  ipcMain.handle('component:remove', async (_event, { projectPath, target, uses }) => {
    noteAppWrite();
    return removeComponentTarget(projectPath, target, removalUndo, { trash: (file) => shell.trashItem(file), writer: desktopRenameWriter() }, uses);
  });
  ipcMain.handle('component:restoreRemoved', async (_event, { token }) => {
    noteAppWrite();
    return restoreRemovedComponent(token, removalUndo, desktopRenameWriter());
  });

  // Undo of creating a component: one step with the page edit that placed it.
  ipcMain.handle('component:discard', async (_event, { projectPath, path: target, checksum, force, folders }) => {
    noteAppWrite();
    return {
      outcome: discardComponentFile({
        projectPath,
        path: target,
        checksum,
        force: force === true,
        componentFolders: projectFoldersFor(projectPath, 'components'),
        folders: folders ?? [],
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
  ipcMain.handle('component:previewPropertyRemoval', (_event, { projectPath, file, name }) => previewComponentPropertyRemoval({ projectPath, file }, name));
  ipcMain.handle('component:revertProperties', (_event, { token }) => revertComponentProperties(token, propertyUndo, { documents, noteWrite: noteAppWrite }));

  // Which files hold instances of a component — the palette’s instance count.
  ipcMain.handle('component:usage', async (_event, { projectPath, name, exclude }) => componentUsage(definedFields({ projectPath, name, exclude })));

  ipcMain.handle('page:importPathFor', async (_event, { pagePath, targetPath, projectPath }) =>
    componentImportPaths({ pagePath, targetPath, projectPath: projectPath ?? undefined }),
  );

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
