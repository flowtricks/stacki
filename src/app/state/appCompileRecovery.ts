// The notice for a page the canvas cannot show (src/features/preview/canvasRecovery.ts finds the error and
// brings the canvas back by itself): the dev server's own words, "Undo last change" when the failure follows the
// app's own write (the app's history, the same one ⌘Z runs, so the file is restored through the normal path), and
// "Reload canvas". A different error replaces the notice; the page coming back takes it down and says so briefly.
import { useEffect, useRef } from 'react';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { onPageMaybeChanged } from '../../ipc/appBridge';
import { onCanvasRecovery } from '../../features/preview/canvasRecoveryBus';
import { dismissErrorToast, reportActionToast } from '../../ui/errorNotices';
import { failureFollowsEdit } from '../model/compileRecovery';
import type { useCoreState } from './appLifecycle';

export function useCompileFailureNotice(coreState: ReturnType<typeof useCoreState>, undo: () => Promise<void>): void {
  const { devUrl, setRefreshKey } = coreState;
  const translate = useTranslate();
  const lastWriteRef = useRef(-Infinity);
  const shownRef = useRef<string | undefined>(undefined);
  const undoRef = useRef(undo);
  undoRef.current = undo;
  useEffect(() => {
    if (!devUrl) {
      return undefined;
    }
    // The bridge arrives with the main process, which a newer renderer may outrun: absent means nothing to hear.
    if (typeof window.avb.onPageMaybeChanged !== 'function') {
      return undefined;
    }
    const dismiss = (): boolean => {
      const shown = shownRef.current;
      if (shown === undefined) {
        return false;
      }
      dismissErrorToast(shown);
      shownRef.current = undefined;
      return true;
    };
    const offWrite = onPageMaybeChanged((event) => {
      if (!event.external) {
        lastWriteRef.current = Date.now();
      }
    });
    const offRecovery = onCanvasRecovery((event) => {
      switch (event.kind) {
        case 'failed': {
          // Until the dev server has said why there is nothing to show; Astro's own page is on the canvas meanwhile.
          const message = event.error.message;
          if (message === undefined) {
            return;
          }
          dismiss();
          const afterEdit = failureFollowsEdit(lastWriteRef.current, Date.now());
          const reload = { label: translate('shell.canvas.reload'), run: () => setRefreshKey((count) => count + 1) };
          const undoLast = {
            label: translate('structure.placement.undoLast'),
            run: () => {
              dismiss();
              void undoRef.current();
            },
          };
          shownRef.current = reportActionToast(
            translate(afterEdit ? 'structure.placement.compileFailed' : 'shell.canvas.errorShown', { message }),
            'error',
            afterEdit ? [undoLast, reload] : [reload],
          );
          return;
        }
        case 'recovered': {
          if (dismiss()) {
            reportActionToast(translate('shell.canvas.recovered'), 'info', []);
          }
          return;
        }
        case 'left': {
          dismiss();
          return;
        }
        case 'gave-up': {
          return;
        }
        default: {
          const unreachable: never = event;
          return unreachable;
        }
      }
    });
    return () => {
      offWrite();
      offRecovery();
      dismiss();
    };
  }, [devUrl, setRefreshKey, translate]);
}
