// The component canvas as the shell sees it: what is open, and what can be asked of it. The host (Desktop's
// src/app/state/useDesktopComponentCanvas.ts) owns the state and the writes; the panel, the title bar and the
// Components panel menu reach it through this context, so none of them depends on the host.
import { createContext, useContext } from 'react';
import type { ComponentCanvasFile, FrameEdit } from '../../../../shared/properties/componentCanvas';
import type { ScanComponent } from '../../../../shared/properties/projectScan';
import type { DefaultValue } from '../../../../shared/properties/componentDefaults';
import type { CanvasComponent, CanvasLayout } from './canvasModel';

export interface CanvasOpen {
  readonly kind: 'open';
  /** The canvas page's UUID: its file is `.stacki/canvas/<id>.astro`. */
  readonly id: string;
  readonly component: CanvasComponent;
  readonly settings: ComponentCanvasFile;
  readonly layout: CanvasLayout;
  /** The selected frame's key; always one of the layout's frames. */
  readonly frame: string;
  /** Where the panel's edits go: `` all frames, a split value's key, or the selected frame's own key. */
  readonly scope: string;
  readonly scale: number;
  /** The props the component defaults give an inserted instance: what a frame shows where it sets nothing. */
  readonly defaults: Readonly<Record<string, DefaultValue>>;
}

export type CanvasState = { readonly kind: 'idle' } | { readonly kind: 'opening'; readonly component: string } | CanvasOpen;

export type CanvasZoom = 'in' | 'out' | 'reset' | 'fit';

export interface ComponentCanvasControl {
  readonly state: CanvasState;
  /** Whether this host can open a canvas for the component (a project component the role may edit). */
  readonly canOpen: (component: ScanComponent) => boolean;
  readonly open: (component: ScanComponent) => void;
  readonly exit: () => void;
  readonly selectFrame: (key: string) => void;
  readonly setScope: (scope: string) => void;
  readonly edit: (edit: FrameEdit) => void;
  /** The props that get their own frames; undefined goes back to the default choice. */
  readonly setSplit: (split: readonly string[] | undefined) => void;
  readonly zoom: (action: CanvasZoom) => void;
}

export const ComponentCanvasContext = createContext<ComponentCanvasControl | undefined>(undefined);

export function useComponentCanvas(): ComponentCanvasControl | undefined {
  return useContext(ComponentCanvasContext);
}

// Read by code outside React's tree of this context (the canvas click handler): whether a canvas is open now.
let canvasShown = false;
export function componentCanvasShown(): boolean {
  return canvasShown;
}
export function noteComponentCanvas(state: CanvasState): void {
  canvasShown = state.kind !== 'idle';
}
