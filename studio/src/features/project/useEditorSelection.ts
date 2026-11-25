import { useEffect, useRef, useState } from 'react';
import type { SharedDocument } from '../collaboration/useDocument';
import type { ParserNode } from '../source/source';
import type { usePreview } from '../preview/usePreview';
import { clearAssetRequest, getPendingAsset } from '../../../vendor/stacki/src/ui/assetPick';
import { pathFor, previewSelection } from './previewSelection';
import { openingSelection } from './openingSelection';
import type { ComponentFocus } from './editorNavigation';

export function useEditorSelection(
  file: string,
  page: string,
  nodes: readonly ParserNode[],
  document: SharedDocument | undefined,
  preview: ReturnType<typeof usePreview>,
  focus: ComponentFocus | undefined,
) {
  const selected = document?.selected ?? '';
  const occurrence = document?.selectedOccurrence ?? 0;
  const ready = document?.ready;
  const opened = useRef<SharedDocument>();
  const current = useRef({ preview, nodes });
  current.current = { preview, nodes };
  useEffect(() => {
    if (!document || !ready || opened.current === document) {
      return;
    }
    opened.current = document;
    const id = openingSelection(file, nodes)?.id ?? '';
    document.select(id, page);
  }, [document, ready, file, page, nodes]);
  useEffect(() => {
    if (!ready) {
      return;
    }
    previewSelection(current.current.preview, file, current.current.nodes, focus).select(selected, occurrence);
  }, [file, selected, occurrence, ready, focus, preview.url, nodes]);
  // A pick made anywhere but the canvas brings the node into view, as Desktop's
  // canvas does (previewRuntime.ts): the person cannot see where it is yet. A
  // click on the canvas never scrolls, since what was clicked is on screen. The
  // tick makes picking the same row again reveal it again. Declared after the
  // effect above so the frame hears the selection before the reveal.
  const [revealRequest, setRevealRequest] = useState<RevealRequest>();
  // Keyed on the request alone: a document turning ready, or another file opening,
  // must not replay an old pick. A request is only ever made while ready.
  useEffect(() => {
    if (revealRequest === undefined) {
      return;
    }
    current.current.preview.reveal(pathFor(revealRequest.id), revealRequest.occurrence, { replayOnLoad: false });
  }, [revealRequest]);
  const pick = (id: string, occurrence: number): boolean => {
    if (!id || !ready || !document?.select(id, page, occurrence)) {
      return false;
    }
    if (id !== selected && getPendingAsset()) {
      clearAssetRequest();
    }
    return true;
  };
  const select = (id: string, occurrence = 0) => {
    if (pick(id, occurrence)) {
      setRevealRequest((previous) => ({ id, occurrence, tick: (previous?.tick ?? 0) + 1 }));
    }
  };
  return {
    selected,
    select,
    selectFromCanvas: (id: string, occurrence = 0) => {
      pick(id, occurrence);
    },
    restore: () => previewSelection(preview, file, nodes, focus).select(selected, occurrence),
    hover: previewSelection(preview, file, nodes, focus).hover,
  };
}

interface RevealRequest {
  readonly id: string;
  readonly occurrence: number;
  readonly tick: number;
}
