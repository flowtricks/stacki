// Desktop's side of the Pages panel's Select mode: the deletion goes through main as one planned, atomic write with one
// undo token (page:removeMany), recorded on the same history Cmd+Z reads as ONE step whatever number of pages it took.
// After the step, or its undo, the scan is read again and the canvas shows a page that still exists.
import { useMemo } from 'react';
import { ok, type Result } from '../../../shared/core/result';
import { messageRef } from '../../../shared/properties/i18n/messageRef';
import { isHomePage } from '../../../shared/properties/pageSettings';
import type { PageBulkRemoveApplied } from '../../../shared/properties/pageBulkRemove';
import { describeRemoval, type PageBulkRemoveHost } from '../../features/pages/PageBulkRemoveFlow';
import { planRemovePages, removePages } from '../../ipc/pageBulkRemoveBridge';
import { revertPageSettings } from '../../ipc/pageSettingsBridge';
import { useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import type { ShellView } from '../App';

export function usePageBulkRemoveHost(app: ShellView): PageBulkRemoveHost {
  const translate = useTranslate();
  const describe = useTranslateDescribed();
  const projectPath = app.project.path;
  return useMemo(
    () => ({
      plan: (request) => planRemovePages(projectPath, request),
      fail: (error) => app.showToast(describe(error), 'error'),
      apply: async (request): Promise<Result<void>> => {
        await app.flushSave();
        const applied = await removePages(projectPath, request);
        if (!applied.ok) {
          return applied;
        }
        const what = describeRemoval(applied.value.summary, translate);
        const openName = app.currentScanPage?.name;
        await afterStep(app, openName, 'forward');
        app.showToast(translate('pages.select.done', { what }), 'success');
        recordUndo(app, applied.value, what, openName);
        return ok(undefined);
      },
    }),
    [app, describe, projectPath, translate],
  );
}

// One entry in the undo history for the whole deletion; its token is replaced each time it is redone.
function recordUndo(app: ShellView, applied: PageBulkRemoveApplied, what: string, openName: string | undefined): void {
  let token = applied.undo;
  app.pushCommand({
    labelRef: messageRef('pages.select.undo', { what }),
    undo: async () => {
      const back = await revertPageSettings(token, 'undo');
      if (!back.ok) {
        app.reportFailure(new Error(back.error.message));
        return;
      }
      await afterStep(app, openName, 'back');
    },
    redo: async () => {
      const again = await revertPageSettings(token, 'redo');
      if (!again.ok) {
        app.reportFailure(new Error(again.error.message));
        return;
      }
      token = applied.undo;
      await afterStep(app, openName, 'forward');
    },
  });
}

// The canvas shows the page it was on; when that page is gone it shows the homepage, and after Undo the page comes back to it.
async function afterStep(app: ShellView, openName: string | undefined, direction: 'forward' | 'back'): Promise<void> {
  window.dispatchEvent(new Event('stacki:pages-renamed'));
  const result = await app.rescan(app.project.path);
  const current = app.currentScanPage?.name;
  const gone = current !== undefined && !result.pages.some((candidate) => candidate.name === current);
  const wanted = direction === 'back' ? openName : gone ? result.pages.find((candidate) => isHomePage(candidate.name))?.name : undefined;
  const next = wanted === undefined ? undefined : result.pages.find((candidate) => candidate.name === wanted);
  if (next !== undefined) {
    app.onSelectPage(next);
  } else if (gone && result.pages[0] !== undefined) {
    app.onSelectPage(result.pages[0]);
  }
}
