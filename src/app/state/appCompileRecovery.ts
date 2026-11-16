// The notice for a page that stopped compiling right after an edit (compileRecovery.ts): the
// compiler's message, with "Undo last change" as the first action. The undo is the app's own
// (history, the same one ⌘Z runs), so the file is restored through the normal path and the
// preview recovers by itself once it compiles again.
import { useEffect, useRef } from 'react';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { inspectProjectPreview, onPageMaybeChanged, onPreviewFailed } from '../../ipc/appBridge';
import { dismissErrorToast, reportActionToast } from '../../ui/errorNotices';
import { compileFailureMessage, failureFollowsEdit } from '../model/compileRecovery';
import type { useCoreState } from './appLifecycle';

export function useCompileFailureNotice(coreState: ReturnType<typeof useCoreState>, undo: () => Promise<void>): void {
  const { devUrl, livePathRef } = coreState;
  const translate = useTranslate();
  const lastWriteRef = useRef(-Infinity);
  const shownRef = useRef<string | undefined>(undefined);
  const undoRef = useRef(undo);
  undoRef.current = undo;
  useEffect(() => {
    if (!devUrl) {
      return undefined;
    }
    // Both arrive with the main process, which a newer renderer may outrun: absent means nothing to ask.
    if (
      typeof window.avb.onPreviewFailed !== 'function' ||
      typeof window.avb.onPageMaybeChanged !== 'function' ||
      typeof window.avb.inspectDevPage !== 'function'
    ) {
      return undefined;
    }
    const dismiss = (): void => {
      if (shownRef.current !== undefined) {
        dismissErrorToast(shownRef.current);
        shownRef.current = undefined;
      }
    };
    const offWrite = onPageMaybeChanged((event) => {
      if (!event.external) {
        lastWriteRef.current = Date.now();
      }
    });
    const offFailure = onPreviewFailed((failedURL) => {
      // Only the page on show, and only a failure that follows the app's own write: an old page's failure is nobody's undo.
      if (failedURL !== new URL(livePathRef.current || '/', devUrl).href || !failureFollowsEdit(lastWriteRef.current, Date.now())) {
        return;
      }
      inspectProjectPreview(failedURL)
        .then((health) => {
          const message = compileFailureMessage(health);
          if (message === undefined) {
            return;
          }
          dismiss();
          shownRef.current = reportActionToast(translate('structure.placement.compileFailed', { message }), 'error', [
            {
              label: translate('structure.placement.undoLast'),
              run: () => {
                dismiss();
                void undoRef.current();
              },
            },
          ]);
        })
        .catch(() => {});
    });
    return () => {
      offWrite();
      offFailure();
      dismiss();
    };
  }, [devUrl, livePathRef, translate]);
}
