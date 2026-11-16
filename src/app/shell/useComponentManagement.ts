// Desktop's side of the Components panel's "…" menu (src/features/palette/paletteManagement.ts): confirm, call main, rescan,
// and record one undo step per gesture on the same history Cmd+Z reads. Main refuses what it must (a component still used,
// a path outside the component folders) with a typed error; this shows that sentence and changes nothing else.
import { useCallback, useMemo } from 'react';
import type { ScanComponent } from '../../../shared/properties/projectScan';
import { COMPONENT_OP_LIMITS, type ComponentOpTarget } from '../../../shared/properties/componentOps';
import type { ManagedItem, PaletteManagement } from '../../features/palette/paletteManagement';
import { duplicateProjectComponent, removeProjectComponent, restoreRemovedProjectComponent } from '../../ipc/componentOpsBridge';
import { cleanError } from '../../lib/cleanError';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { confirmDialog } from '../../ui/ConfirmDialog';
import type { ShellView } from '../App';

export function useComponentManagement(app: ShellView): PaletteManagement {
  const translate = useTranslate();
  const { openComponent, pushCommand, reportFailure, rescan, setLeftTab, showToast } = app;
  const projectPath = app.project.path;
  const fail = useCallback((message: string) => showToast(message, 'error'), [showToast]);

  const editSettings = useCallback(
    (component: ScanComponent): void => {
      // The properties tab exists only while a component is the open document, so it is chosen once the file has opened.
      void openComponent(component.name, undefined, 0, component.path)
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
          const removed = await removeProjectComponent(projectPath, { kind: copy.kind, path: copy.path });
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
      const sure = await confirmDialog({
        title: translate('palette.manage.deleteTitle', { name: item.name }),
        body:
          item.kind === 'folder'
            ? translate('palette.manage.deleteBodyFolder', { count: item.files })
            : translate('palette.manage.deleteBodyComponent', { name: item.name }),
        confirmLabel: translate('palette.manage.deleteConfirm'),
        danger: true,
      });
      if (sure !== true) {
        return;
      }
      const removed = await removeProjectComponent(projectPath, target);
      if (!removed.ok) {
        fail(removed.error.message);
        return;
      }
      let undoToken = removed.value.undo;
      await rescan(projectPath);
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
          await rescan(projectPath);
        },
        redo: async () => {
          const again = await removeProjectComponent(projectPath, target);
          if (!again.ok) {
            fail(again.error.message);
            return;
          }
          undoToken = again.value.undo;
          await rescan(projectPath);
        },
      });
    },
    [fail, projectPath, pushCommand, rescan, showToast, translate],
  );

  return useMemo(
    () => ({
      editSettings,
      duplicate: (item) => void duplicate(item).catch((error: unknown) => fail(cleanError(error))),
      remove: (item) => void remove(item).catch((error: unknown) => fail(cleanError(error))),
    }),
    [duplicate, editSettings, fail, remove],
  );
}
