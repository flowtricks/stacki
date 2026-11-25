// The component canvas as the shell sees it: what is open, and what can be asked of it. The host (Desktop's
// src/app/state/useDesktopComponentCanvas.ts) owns the state and the writes; the panel, the title bar and the
// Components panel menu reach it through this context, so none of them depends on the host.
import { createContext, useContext } from 'react';
import { assert } from '../../../../shared/core/assert';
import { CANVAS_DIRECTORY } from '../../../../shared/properties/defaultsCanvas';
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
  /** Each frame's instance on the canvas page, by its path in the page's tree: what the navigator lists and a click selects. */
  readonly instances: readonly CanvasInstance[];
}

/** One frame's instance of the component on the canvas page. */
export interface CanvasInstance {
  /** The frame's key (componentCanvas.ts frame keys). */
  readonly key: string;
  /** The instance's node path in the canvas page (`0.1.2`): stable while the page's frames are, unlike a node id. */
  readonly path: string;
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
  /** Opens Frame settings on the selected frame, leaving any element selected inside a frame. */
  readonly showFramePanel: () => void;
  /**
   * A preview prop value from the Settings panel: written to the Apply to scope (this frame unless a wider one is
   * chosen; the project level holds no props, so there it is this frame). Never to the component or its instances.
   */
  readonly editProp: (edit: Extract<FrameEdit, { readonly kind: 'prop' | 'unset' | 'inherit' }>) => void;
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

// Read by code outside React's tree of this context (the canvas click handler, the edit commit): what is open now.
let noted: CanvasState = { kind: 'idle' };
export function componentCanvasShown(): boolean {
  return noted.kind !== 'idle';
}
export function noteComponentCanvas(state: CanvasState): void {
  noted = state;
}

/** The canvas page's file, project-relative: `.stacki/canvas/<id>.astro`. */
export function canvasPageFile(id: string): string {
  assert(/^[a-f0-9-]{36}$/.test(id), 'A canvas page is named by a UUID');
  return CANVAS_DIRECTORY + id + '.astro';
}

/**
 * Whether `path` (an open file's absolute path) is the open canvas's page. That page is generated from the canvas
 * settings and rewritten whole, so it is never edited: its instances are selected, and opened to edit the component.
 */
export function isComponentCanvasPage(path: string | undefined): boolean {
  if (noted.kind !== 'open' || path === undefined) {
    return false;
  }
  return path.replaceAll('\\', '/').endsWith('/' + canvasPageFile(noted.id));
}

/**
 * The frame whose instance a node of the canvas page belongs to: the node is the instance, inside it, or the frame's
 * label or body around it. Undefined for the space between frames, or with no canvas open.
 */
export function canvasInstanceAt(path: string | undefined): CanvasInstance | undefined {
  if (noted.kind !== 'open' || path === undefined) {
    return undefined;
  }
  return noted.instances.find((instance) => {
    const frame = framePathOf(instance.path);
    return path === frame || path.startsWith(frame + '.');
  });
}

/** The instance at exactly `path` in the canvas page, if one is. */
export function canvasInstanceOf(path: string | undefined): CanvasInstance | undefined {
  return noted.kind === 'open' && path !== undefined ? noted.instances.find((instance) => instance.path === path) : undefined;
}

// An instance sits in its frame's body, which sits in the frame (canvasPage.ts frameMarkup).
function framePathOf(instancePath: string): string {
  const parts = instancePath.split('.');
  assert(parts.length > 2, 'A canvas instance is inside a frame body inside a frame');
  return parts.slice(0, -2).join('.');
}
