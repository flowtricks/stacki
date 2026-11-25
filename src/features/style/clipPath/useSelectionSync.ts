// Keeping the editor on the designer's selection: the breakpoint it reads at
// and re-reading the selected element when either changes (ClipPath.tsx).

import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import type { BreakpointId, WebflowApi } from './webflowDesigner';
import { type SelectionReadOptions } from './clipPathTypes';
import { readWebflowApi, STYLE_REFRESH_MS } from './clipPathConstants';
import { type EditorAfterWindowKeyListeners, type SelectionSession, loadNoneIfChanged, readSelectedElement } from './clipPathSelectionRead';

// Reading the Webflow selection.
export function useSelectionSync(editor: EditorAfterWindowKeyListeners) {
  const { selectionReadInProgressRef, selectionReadSeqRef, selectionReadTimerRef } = editor;
  const { activeBreakpointRef, setIsClipPathLabelMenuOpen, refreshSelectedElementRef } = editor;
  // The listeners below outlive this render; they read the editor through this ref.
  const readerRef = useRef(editor);
  readerRef.current = editor;
  useEffect(() => {
    const webflowApi = readWebflowApi();
    if (!webflowApi) {
      return;
    }
    const session: SelectionSession = { cancelled: false, webflowApi, readerRef };
    refreshSelectedElementRef.current = (options: SelectionReadOptions = {}) => {
      void readCurrentSelectedElement(session, options);
    };
    const scheduleRead = () => scheduleCurrentSelectedElementRead(session, selectionReadTimerRef);
    const unsubscribeSelectedElement = webflowApi.subscribe?.('selectedelement', scheduleRead);
    const unsubscribeMediaQuery = webflowApi.subscribe?.('mediaquery', (breakpoint) => {
      activeBreakpointRef.current = breakpoint || 'main';
      setIsClipPathLabelMenuOpen(false);
      scheduleRead();
    });
    const styleRefreshTimer = window.setInterval(() => {
      if (selectionReadInProgressRef.current) {
        return;
      }
      void readCurrentSelectedElement(session);
    }, STYLE_REFRESH_MS);

    void syncCurrentBreakpoint(webflowApi, activeBreakpointRef).then(() => readCurrentSelectedElement(session, { force: true, resetStyle: true }));

    return () => {
      session.cancelled = true;
      selectionReadSeqRef.current += 1;
      selectionReadInProgressRef.current = false;
      window.clearInterval(styleRefreshTimer);
      if (selectionReadTimerRef.current !== undefined) {
        window.clearTimeout(selectionReadTimerRef.current);
        selectionReadTimerRef.current = undefined;
      }
      unsubscribeSelectedElement?.();
      unsubscribeMediaQuery?.();
      refreshSelectedElementRef.current = undefined;
    };
  }, [selectionReadInProgressRef, selectionReadSeqRef, selectionReadTimerRef, activeBreakpointRef, setIsClipPathLabelMenuOpen, refreshSelectedElementRef]);
}

export async function syncCurrentBreakpoint(webflowApi: WebflowApi, activeBreakpointRef: MutableRefObject<BreakpointId>): Promise<void> {
  try {
    activeBreakpointRef.current = (await webflowApi.getMediaQuery?.()) || 'main';
  } catch {
    activeBreakpointRef.current = 'main';
  }
}

// A selection change reads the new element a beat later, once the Designer settles.
export function scheduleCurrentSelectedElementRead(session: SelectionSession, selectionReadTimerRef: MutableRefObject<number | undefined>): void {
  if (selectionReadTimerRef.current !== undefined) {
    window.clearTimeout(selectionReadTimerRef.current);
  }
  selectionReadTimerRef.current = window.setTimeout(() => {
    selectionReadTimerRef.current = undefined;
    void readCurrentSelectedElement(session, { force: true, resetStyle: true });
  }, 120);
}

export async function readCurrentSelectedElement(session: SelectionSession, options: SelectionReadOptions = {}): Promise<void> {
  try {
    await readSelectedElement(session, await session.webflowApi.getSelectedElement?.(), options);
  } catch {
    if (!session.cancelled && options.force) {
      loadNoneIfChanged(session.readerRef.current, { force: options.force });
    }
  }
}
