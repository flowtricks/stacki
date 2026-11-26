// The component canvas as the shell sees it: what is open, and what can be asked of it. The host (Desktop's
// src/app/state/useDesktopComponentCanvas.ts) owns the state and the writes; the panel, the title bar and the
// Components panel menu reach it through this context, so none of them depends on the host.
import { createContext, useContext } from 'react';
import { assert } from '../../../../shared/core/assert';
import { CANVAS_DIRECTORY } from '../../../../shared/properties/defaultsCanvas';
import type { ComponentCanvasFile, FrameEdit, FrameSetting } from '../../../../shared/properties/componentCanvas';
import type { ScanComponent } from '../../../../shared/properties/projectScan';
import type { ComponentRecipe } from '../../../../shared/properties/componentDefaults';
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
  /**
   * Where each kind of edit goes, each chosen on its own: a frame key (`` for all frames, a split value's, a group's, or
   * the selected frame's own), or for the canvas root's background and classes PROJECT_SCOPE or COMPONENT_SCOPE.
   * Props start at the frame, sizes at all frames, the background at the frame (all components for the root).
   */
  readonly scopes: CanvasScopes;
  readonly scale: number;
  /** Whether the selected frame's settings popover is open: shown when a frame is selected, hidden by its close. */
  readonly framePanel: 'shown' | 'hidden';
  /** What the component defaults give an inserted instance: what a frame shows where it sets nothing. */
  readonly defaults: ComponentRecipe;
  /** Each frame's instance on the canvas page, by its path in the page's tree: what the navigator lists and a click selects. */
  readonly instances: readonly CanvasInstance[];
  /** The frames' boxes and the groups around them, by path: real elements of the page, selected and listed as divs. */
  readonly boxes: readonly CanvasBox[];
  /** The canvas page's root (its <html>) by path: the canvas itself, selected by a click between frames. */
  readonly root: string;
  /** What Frame settings and the Settings panel speak of: a frame (`frame`), or the canvas root. */
  readonly subject: 'frame' | 'root';
  /**
   * What is selected on the canvas: the selected frame's component, its box (a press on its padding or caption), or a
   * group box around it (then the scope is that group's). The panels show the frame in every case.
   */
  readonly picked: CanvasPick;
}

/** The scope of each section of edits (CanvasOpen.scopes). */
export interface CanvasScopes {
  readonly props: string;
  readonly size: string;
  readonly background: string;
}

export type CanvasSection = keyof CanvasScopes;

/** What is selected on the canvas page while a frame is the subject (CanvasOpen.picked). */
export type CanvasPick = { readonly kind: 'component' } | { readonly kind: 'box' } | { readonly kind: 'group'; readonly key: string };

/** A box on the canvas page: a frame's (around its instance) or a group's (around the frames that share its values). */
export interface CanvasBox {
  readonly kind: 'frame' | 'group';
  /** A frame's key, or the pairs every frame in the group shares (a frame key too). */
  readonly key: string;
  readonly path: string;
  /** Its caption or header, as the canvas draws it: the name its Navigator row and its tag show. */
  readonly label: string;
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

/** The "Apply to" scope of this component's canvas root (componentCanvas.ts ComponentCanvas.root). Never a frame key. */
export const COMPONENT_SCOPE = '*component';

export type CanvasZoom = 'in' | 'out' | 'reset' | 'fit';

export interface ComponentCanvasControl {
  readonly state: CanvasState;
  /** Whether this host can open a canvas for the component (a project component the role may edit). */
  readonly canOpen: (component: ScanComponent) => boolean;
  readonly open: (component: ScanComponent) => void;
  readonly exit: () => void;
  readonly setScope: (section: CanvasSection, scope: string) => void;
  /** A size or background edit, to its section's scope (a background at a root scope goes to the canvas root). */
  readonly edit: (edit: FrameEdit) => void;
  /** Drops what scopes narrower than the section's own say about `setting`, so every frame it reaches shows its value. */
  readonly resetOverrides: (section: CanvasSection, setting: FrameSetting) => void;
  /** The frames a scope choice would change, outlined on the canvas while it is pointed at; undefined clears them. */
  readonly showTargets: (frames: readonly string[] | undefined) => void;
  /** The props that get their own frames; undefined goes back to the default choice. */
  readonly setSplit: (split: readonly string[] | undefined) => void;
  readonly zoom: (action: CanvasZoom) => void;
  readonly hideFramePanel: () => void;
  /** Opens Frame settings on the selected frame, leaving any element selected inside a frame. */
  readonly showFramePanel: () => void;
  /**
   * Preview values from the Settings panel, written together to the frame scope `scope` (a frame, a split value or
   * `` for every frame): the scope the field showed, even when a pick answers after the selection moved. Never to the
   * component or its instances.
   */
  readonly editValues: (scope: string, edits: readonly FrameEdit[]) => void;
  /** The canvas root's classes at the root's "Apply to" scope (this component or the project); undefined clears them there. */
  readonly editRootClasses: (classes: readonly string[] | undefined) => void;
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

/** Whether `path` is the canvas page's root (its <html>): the canvas itself. */
export function isCanvasRoot(path: string | undefined): boolean {
  return noted.kind === 'open' && path !== undefined && path === noted.root;
}

/** The canvas root's path in the open canvas page, if a canvas is open. */
export function canvasRootPath(): string | undefined {
  return noted.kind === 'open' ? noted.root : undefined;
}

/** The instance at exactly `path` in the canvas page, if one is. */
export function canvasInstanceOf(path: string | undefined): CanvasInstance | undefined {
  return noted.kind === 'open' && path !== undefined ? noted.instances.find((instance) => instance.path === path) : undefined;
}

/** The box (a frame's or a group's) at exactly `path` in the open canvas page, if one is. */
export function canvasBoxOf(path: string | undefined): CanvasBox | undefined {
  return noted.kind === 'open' && path !== undefined ? noted.boxes.find((box) => box.path === path) : undefined;
}

// An instance sits directly in its frame (canvasPage.ts frameMarkup).
function framePathOf(instancePath: string): string {
  const parts = instancePath.split('.');
  assert(parts.length > 1, 'A canvas instance is inside a frame');
  return parts.slice(0, -1).join('.');
}
