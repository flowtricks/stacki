// Desktop's side of the Components panel's "…" menu (src/features/palette/paletteManagement.ts): confirm, call main, rescan,
// and record one undo step per gesture on the same history Cmd+Z reads. Main refuses what it must (a component still used,
// a path outside the component folders) with a typed error; this shows that sentence and changes nothing else.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ScanComponent } from '../../../shared/properties/projectScan';
import { assert } from '../../../shared/core/assert';
import { COMPONENT_OP_LIMITS, type ComponentOpTarget } from '../../../shared/properties/componentOps';
import type { ManagedItem, PaletteManagement } from '../../features/palette/paletteManagement';
import {
  duplicateProjectComponent,
  planProjectComponentRemoval,
  planProjectComponentRename,
  removeProjectComponent,
  renameProjectComponent,
  restoreRemovedProjectComponent,
  revertProjectComponentRename,
} from '../../ipc/componentOpsBridge';
import { readMetadata } from '../../ipc/projectMetadataBridge';
import { componentRuleFile } from '../../../shared/properties/componentAccess';
import type { ComponentRenameRequest } from '../../../shared/properties/componentRename';
import { configOf, foldersFor, readProjectFoldersSource } from '../../../shared/properties/projectFolders';
import { cleanError } from '../../lib/cleanError';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { confirmDialog } from '../../ui/ConfirmDialog';
import { confirmComponentRemoval } from './componentRemovalDialog';
import type { ShellView } from '../App';

export function useComponentManagement(app: ShellView): PaletteManagement {
  const translate = useTranslate();
  const { currentScanPage, flushSave, onSelectPage, openComponent, pushCommand, reportFailure, rescan, setLeftTab, showToast } = app;
  const projectPath = app.project.path;
  const fail = useCallback((message: string) => showToast(message, 'error'), [showToast]);

  const editSettings = useCallback(
    (component: ScanComponent): void => {
      // The properties tab exists only while a component is the open document, so it is chosen once the file has opened.
      void openComponent(component.name, undefined, 0, component.path, 'jump')
        .then(() => setLeftTab('properties'))
        .catch(reportFailure);
    },
    [openComponent, reportFailure, setLeftTab],
  );

  const duplicate = useCallback(
    async (item: ManagedItem): Promise<void> => {
      const target: ComponentOpTarget = { kind: item.kind, path: item.path };
      if (item.kind === 'folder' && item.files >= COMPONENT_OP_LIMITS.folderConfirmFilesMin) {
        const sure = await confirmDialog({
          title: translate('palette.manage.duplicateTitle', { name: item.name }),
          body: translate('palette.manage.duplicateBody', { count: item.files }),
          confirmLabel: translate('palette.manage.duplicateConfirm'),
        });
        if (sure !== true) {
          return;
        }
      }
      const made = await duplicateProjectComponent(projectPath, target);
      if (!made.ok) {
        fail(made.error.message);
        return;
      }
      let copy = made.value;
      const scan = await rescan(projectPath);
      showToast(translate('palette.manage.duplicateDone', { name: copy.name }), 'success');
      pushCommand({
        label: translate('palette.manage.labelDuplicate', { name: item.name }),
        // Undo takes the copy out the same way a deletion does; a copy that something now uses is kept, and the person is told.
        undo: async () => {
          const removed = await removeProjectComponent(projectPath, { kind: copy.kind, path: copy.path }, 'refuse');
          if (!removed.ok) {
            fail(removed.error.message);
            return;
          }
          await rescan(projectPath);
        },
        redo: async () => {
          const again = await duplicateProjectComponent(projectPath, target);
          if (!again.ok) {
            fail(again.error.message);
            return;
          }
          copy = again.value;
          await rescan(projectPath);
        },
      });
      const opened = copy.kind === 'component' ? scan.components.find((component) => component.file === copy.path) : undefined;
      if (opened !== undefined) {
        editSettings(opened);
      }
    },
    [editSettings, fail, projectPath, pushCommand, rescan, showToast, translate],
  );

  const remove = useCallback(
    async (item: ManagedItem): Promise<void> => {
      const target: ComponentOpTarget = { kind: item.kind, path: item.path };
      // Pending canvas edits land first: the plan reads the pages from disk, and so does the deletion.
      await flushSave();
      const preview = await planProjectComponentRemoval(projectPath, target);
      if (!preview.ok) {
        fail(preview.error.message);
        return;
      }
      if (!(await confirmComponentRemoval(preview.value, translate))) {
        return;
      }
      const removed = await removeProjectComponent(projectPath, target, 'remove');
      if (!removed.ok) {
        fail(removed.error.message);
        return;
      }
      let undoToken = removed.value.undo;
      await reloadOpen();
      showToast(translate('palette.manage.deleteDone', { name: item.name }), 'success');
      pushCommand({
        label: translate('palette.manage.labelDelete', { name: item.name }),
        undo: async () => {
          const restored = await restoreRemovedProjectComponent(undoToken);
          if (!restored.ok) {
            fail(restored.error.message);
            return;
          }
          if (restored.value.metadata === 'kept') {
            showToast(translate('palette.manage.undoMetadataKept'), 'warning');
          }
          await reloadOpen();
        },
        redo: async () => {
          const again = await removeProjectComponent(projectPath, target, 'remove');
          if (!again.ok) {
            fail(again.error.message);
            return;
          }
          undoToken = again.value.undo;
          await reloadOpen();
        },
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the reload helper reads the latest app state through refs on `app`
    [fail, flushSave, projectPath, pushCommand, rescan, showToast, translate],
  );

  const roots = useComponentRoots(projectPath);

  // Rename or move: main rewrites the component and every reference in one step; the open page is reloaded from disk after.
  const rename = useMemo(
    () => ({
      roots,
      plan: (request: ComponentRenameRequest) => planProjectComponentRename(projectPath, request),
      apply: (component: ScanComponent, request: ComponentRenameRequest, change: 'rename' | 'move' | 'both'): Promise<boolean> => {
        const run = async (): Promise<boolean> => {
          await flushSave();
          const done = await renameProjectComponent(projectPath, request);
          if (!done.ok) {
            fail(done.error.message);
            return false;
          }
          let undoToken = done.value.undo;
          const reopened = await reloadAfterRename(request);
          showToast(translate(change === 'move' ? 'palette.manage.moveDone' : 'palette.manage.renameDone', { name: component.name }), 'success');
          pushCommand({
            label: translate(change === 'move' ? 'palette.manage.labelMove' : 'palette.manage.labelRename', { name: component.name }),
            undo: async () => {
              const back = await revertProjectComponentRename(undoToken, 'undo');
              if (!back.ok) {
                fail(back.error.message);
                return;
              }
              await reloadAfterRename({ from: request.to, to: request.from });
            },
            redo: async () => {
              const again = await revertProjectComponentRename(undoToken, 'redo');
              if (!again.ok) {
                fail(again.error.message);
                return;
              }
              await reloadAfterRename(request);
            },
          });
          assert(reopened === undefined || reopened === true, 'A reload reports nothing or that it reopened');
          return true;
        };
        return run().catch((error: unknown) => {
          fail(cleanError(error));
          return false;
        });
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the reload helper reads the latest app state through refs on `app`
    [roots, projectPath, flushSave, fail, pushCommand, showToast, translate],
  );

  // A deletion edits the pages that used the component: the open page is reloaded from disk, as after a rename.
  async function reloadOpen(): Promise<void> {
    const scan = await rescan(projectPath);
    if (app.currentPage?.kind === 'component' || currentScanPage === undefined) {
      return;
    }
    const page = scan.pages.find((candidate) => candidate.path === currentScanPage.path);
    if (page !== undefined) {
      onSelectPage(page);
    }
  }

  // Whatever is open may have changed on disk: a moved component is reopened at its new place, a page that imported it is reloaded.
  async function reloadAfterRename(request: ComponentRenameRequest): Promise<true | undefined> {
    const scan = await rescan(projectPath);
    const open = app.currentPage;
    if (open?.kind === 'component') {
      const moved = scan.components.find((component) => componentRuleFile(component) === request.to);
      const stillThere = scan.components.find((component) => component.path === open.path);
      const target = moved !== undefined && open.path.endsWith(request.from) ? moved : stillThere;
      if (target !== undefined) {
        await openComponent(target.name, undefined, 0, target.path, 'jump');
        return true;
      }
      return undefined;
    }
    if (currentScanPage !== undefined) {
      const page = scan.pages.find((candidate) => candidate.path === currentScanPage.path);
      if (page !== undefined) {
        onSelectPage(page);
        return true;
      }
    }
    return undefined;
  }

  return useMemo(
    () => ({
      rename,
      editSettings,
      duplicate: (item) => void duplicate(item).catch((error: unknown) => fail(cleanError(error))),
      remove: (item) => void remove(item).catch((error: unknown) => fail(cleanError(error))),
    }),
    [duplicate, editSettings, fail, remove, rename],
  );
}

// The configured component folders (`.stacki/folders.json`, else `src/components`), read once per project.
function useComponentRoots(projectPath: string): readonly string[] {
  const [roots, setRoots] = useState<readonly string[]>(foldersFor('components', undefined));
  useEffect(() => {
    let current = true;
    void readMetadata(projectPath, 'folders').then(
      (file) => {
        if (current) {
          setRoots(foldersFor('components', configOf(readProjectFoldersSource(file.source))));
        }
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [projectPath]);
  return roots;
}
