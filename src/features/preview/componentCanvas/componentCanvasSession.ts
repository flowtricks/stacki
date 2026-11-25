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
  /** Where the panel's edits go: `` all frames, a split value's key, the selected frame's own key, or PROJECT_SCOPE. */
  readonly scope: string;
  readonly scale: number;
  /** Whether the selected frame's settings popover is open: shown when a frame is selected, hidden by its close. */
  readonly framePanel: 'shown' | 'hidden';
  /** The props the component defaults give an inserted instance: what a frame shows where it sets nothing. */
  readonly defaults: Readonly<Record<string, DefaultValue>>;
}

export type CanvasState = { readonly kind: 'idle' } | { readonly kind: 'opening'; readonly component: string } | CanvasOpen;

/**
 * The "Apply to" scope of the whole project: its one setting is the canvas background (ComponentCanvasFile.background).
 * Never a frame key, which is sorted `name=value` pairs or empty.
 */
export const PROJECT_SCOPE = '*project';

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
  readonly hideFramePanel: () => void;
  /** How much of the canvas, in screen pixels from its right edge, the popover covers: the frames fit beside it. */
  readonly coverRight: (pixels: number) => void;
}

export const ComponentCanvasContext = createContext<ComponentCanvasControl | undefined>(undefined);

export function useComponentCanvas(): ComponentCanvasControl | undefined {
  return useContext(ComponentCanvasContext);
}

// How the element menus (navigator and canvas) open a canvas for a component instance: set by the host while it can,
// absent where there is no canvas (Studio), so the menus leave the row out there.
type InstanceOpener = (name: string, id: string) => void;
let instanceOpener: InstanceOpener | undefined;
export function canvasInstanceOpener(): InstanceOpener | undefined {
  return instanceOpener;
}
export function registerCanvasInstanceOpener(opener: InstanceOpener | undefined): void {
  instanceOpener = opener;
}

// Read by code outside React's tree of this context (the canvas click handler): whether a canvas is open now.
let canvasShown = false;
export function componentCanvasShown(): boolean {
  return canvasShown;
}
export function noteComponentCanvas(state: CanvasState): void {
  canvasShown = state.kind !== 'idle';
}
