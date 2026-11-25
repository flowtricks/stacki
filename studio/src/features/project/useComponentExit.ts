import { useEffect, useRef } from 'react';
import { isCanvasPage } from '../../../vendor/stacki/shared/properties/defaultsCanvas';
import type { SharedDocument } from '../collaboration/useDocument';
import type { usePreview } from '../preview/usePreview';
import type { OpenFile } from './editorNavigation';

export function useComponentExit(
  file: string,
  page: string,
  document: SharedDocument | undefined,
  preview: ReturnType<typeof usePreview>,
  open: OpenFile | undefined,
  report: (error: unknown) => void,
) {
  const { subscribeOutside } = preview;
  const callbacks = useRef({ open, report });
  callbacks.current = { open, report };
  const canOpen = open !== undefined;
  useEffect(() => {
    if (isCanvasPage(file) || file === page || !canOpen || !document) {
      return undefined;
    }
    let active = true;
    let leaving = false;
    const unsubscribe = subscribeOutside(() => {
      if (leaving) {
        return;
      }
      leaving = true;
      // Keep the component's connection until accepted edits are durably saved.
      void document
        .whenSaved()
        .then(() => {
          if (active) {
            callbacks.current.open?.(page);
          }
        })
        .catch((error: unknown) => {
          leaving = false;
          if (active) {
            callbacks.current.report(error);
          }
        });
    });
    return () => {
      active = false;
      unsubscribe();
    };
    // A render during saving must not cancel the pending navigation. File and
    // document changes still invalidate it so it cannot reopen a stale page.
  }, [file, page, document, canOpen, subscribeOutside]);
}
