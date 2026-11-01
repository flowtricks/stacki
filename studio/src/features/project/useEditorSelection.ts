import { useEffect, useRef } from 'react';
import type { SharedDocument } from '../collaboration/useDocument';
import type { ParserNode } from '../source/source';
import type { usePreview } from '../preview/usePreview';
import { clearAssetRequest, getPendingAsset } from '../../../vendor/stacki/src/ui/assetPick';
import { previewSelection } from './previewSelection';
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
  const select = (id: string, occurrence = 0) => {
    if (!id || !ready || !document?.select(id, page, occurrence)) {
      return;
    }
    if (id !== selected && getPendingAsset()) {
      clearAssetRequest();
    }
  };
  return {
    selected,
    select,
    restore: () => previewSelection(preview, file, nodes, focus).select(selected, occurrence),
    hover: previewSelection(preview, file, nodes, focus).hover,
  };
}
