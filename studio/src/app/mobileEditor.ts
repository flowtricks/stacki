import { useLayoutEffect, useSyncExternalStore } from 'react';
import { editorLayoutFor, type EditorLayout } from '../../vendor/stacki/src/app/shell/editorLayout';
import { currentWidths, type PanelWidths } from '../../vendor/stacki/src/app/shell/ResizablePanel';
import type { Panel } from './EditorRail';

// Studio's copy of Desktop's layout rule (editorLayout.ts). The editor collapses its side
// panels into overlays when, docked, they would leave the canvas too narrow; the panel
// widths the user set stay stored and come back when the editor docks again.
//
// One layout per page: the shell, its panels and the selection handler all read it, and
// the editor writes it from the width of its rail and its open panels.
const RAIL_WIDTH_PX = 44; // .rail in Desktop's styles.css.
const CHAT_WIDTH_PX_MIN = 320; // .studio-left:has(.chat-panel) min-width in chat.css.
// The shell, both panels, the selection handler and the toolbar subscribe; more is a leak.
const LAYOUT_LISTENERS_MAX = 64;

let layout: EditorLayout | undefined;
const listeners = new Set<() => void>();

export function isMobileEditor(): boolean {
  return currentLayout() === 'collapsed';
}

export function useMobileEditor(): boolean {
  return useSyncExternalStore(subscribe, isMobileEditor);
}

export function useEditorLayout(): EditorLayout {
  return useSyncExternalStore(subscribe, currentLayout);
}

// The rail, the open left panel and the docked inspector, at the widths the user set.
export function dockedWidthPx(input: { readonly panel: Panel | undefined; readonly inspector: boolean; readonly widths: PanelWidths }): number {
  const left = leftPanelWidthPx(input.panel, input.widths);
  const right = input.inspector ? input.widths.right : 0;
  const total = RAIL_WIDTH_PX + left + right;
  return total;
}

// Re-reads the layout before paint whenever the window or the docked width changes, so
// a panel toggle never shows one frame of the wrong layout.
export function useEditorLayoutSync(docked: number): void {
  useLayoutEffect(() => {
    const update = () => {
      const next = editorLayoutFor({ previous: currentLayout(), viewportWidthPx: window.innerWidth, dockedWidthPx: docked });
      if (next !== layout) {
        layout = next;
        for (const changed of listeners) {
          changed();
        }
      }
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [docked]);
}

function leftPanelWidthPx(panel: Panel | undefined, widths: PanelWidths): number {
  if (panel === undefined) {
    return 0;
  }
  if (panel === 'code') {
    return widths.code;
  }
  if (panel === 'ai') {
    return Math.max(widths.left, CHAT_WIDTH_PX_MIN);
  }
  return widths.left;
}

// Before the editor first measures, assume Studio's opening arrangement: the Navigator
// and the inspector docked at their stored widths.
function currentLayout(): EditorLayout {
  if (layout === undefined) {
    layout = editorLayoutFor({
      previous: 'docked',
      viewportWidthPx: window.innerWidth,
      dockedWidthPx: dockedWidthPx({ panel: 'navigator', inspector: true, widths: currentWidths() }),
    });
  }
  return layout;
}

function subscribe(changed: () => void): () => void {
  if (listeners.size >= LAYOUT_LISTENERS_MAX) {
    throw new Error('Editor layout listeners exceed their limit');
  }
  listeners.add(changed);
  return () => listeners.delete(changed);
}
