// Design mode's model: frames, the session they belong to, and the component instances a page copy carries.
// Nothing here names a project write: a session is a set of copies of the rendered page, kept in the renderer
// (and in the app's own storage, designDrafts.ts), never in the project.
import type { DesignJson } from '../../../../shared/designMode/designModeContract';
import {
  ELEMENT_ID_PATTERN,
  FRAME_ID_PATTERN,
  toDesignElementId,
  toFrameId,
  type DesignElementId,
  type FrameId,
} from '../../../../shared/designMode/designIds';

export { ELEMENT_ID_PATTERN, FRAME_ID_PATTERN, toDesignElementId, toFrameId, type DesignElementId, type FrameId };

export const DESIGN_LIMITS = {
  framesMax: 12,
  frameNameCharsMax: 80,
  frameWidthPxMin: 240,
  frameWidthPxMax: 3_840,
  viewportHeightPxMin: 320,
  viewportHeightPxMax: 2_400,
  /** Elements a page copy may number; a page past it is refused rather than half-numbered. */
  elementsMax: 60_000,
  selectionMax: 500,
  historyEntriesMax: 120,
  /** Characters the undo history may hold across all its entries. */
  historyCharsMax: 240_000_000,
  /** A frame's document height, measured. */
  frameHeightPxMax: 60_000,
  /** The gap between frames side by side. */
  frameGapPx: 160,
  changesListedMax: 60,
  zoomMin: 0.05,
  zoomMax: 8,
} as const satisfies Record<string, number>;

export interface DesignFrameRecord {
  readonly id: FrameId;
  readonly name: string;
  readonly widthPx: number;
  /** The screen height `vh` units resolve against; the frame itself is as tall as its page. */
  readonly viewportHeightPx: number;
  /** Where the frame sits on the canvas, in canvas pixels. */
  readonly xPx: number;
  readonly yPx: number;
}

/** What a page copy says about one component instance it shows: what the props panel reads and the hand-off names. */
export interface DesignInstanceInfo {
  /** The instance's node path in the page file (`0.1.2`). */
  readonly path: string;
  /** The component's name as the page writes it (`Button`). */
  readonly name: string;
  /** The component's file, project-relative (`src/components/Button.astro`). */
  readonly component: string;
  /** The props the page writes literally, as values. */
  readonly props: Readonly<Record<string, DesignJson>>;
  /** The props the page sets with code, by name, as written: shown, never sent. */
  readonly codeProps: Readonly<Record<string, string>>;
  /** The page file's line the instance starts on, when the page is the editor's open file. */
  readonly line: number | undefined;
  /** The slots the page fills (`default` and any named ones), whose content a new rendering keeps. */
  readonly slots: readonly string[];
}

/** The page a session copies. */
export interface DesignPage {
  readonly projectPath: string;
  /** The page file, project-relative (`src/pages/index.astro`); undefined for a route without a file. */
  readonly file: string | undefined;
  readonly route: string;
  readonly title: string;
}

/** A source location of a page node, for the hand-off: the page's file and the line the node starts on. */
export interface DesignNodeSource {
  readonly path: string;
  readonly kind: 'component' | 'element' | 'other';
  readonly name: string;
  readonly line: number | undefined;
}
