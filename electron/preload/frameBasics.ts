// What every part of the preload shares: the boxes it measures and the shapes
// it reports, the bounds of its walks, and the node guards.

// The boxes this file measures and the shapes it reports, shared by the
// outline, gap and hit-test paths.
export type Box = { left: number; top: number; right: number; bottom: number };
export type Rect = { x: number; y: number; w: number; h: number };
export type TaggedPlace = { el: Element; rect: Rect };
export type GapBand = { axis: 'column' | 'row'; x: number; y: number; w: number; h: number };
export type ThinTarget = { path: string; el: Element; box: DOMRect };
export type Spacing = {
  padding: Record<string, number>;
  margin: Record<string, number>;
  gaps: GapBand[];
  /** What one em, rem, vw and vh is worth in px for the element measured. */
  units: Record<string, number>;
};
export type GapRow = { top: number; bottom: number; items: DOMRect[] };

// The canvas protocol spells absence `undefined`, like every other value in
// the app (AGENTS.md §6): postMessage is a structured clone, which keeps it,
// and the app's parsers (src/features/preview/previewMessages.ts,
// src/editor/canvasReply.ts) read it.

// How deep the frame walks the page. An HTML parser stops nesting elements at
// 512 (Chromium's limit), and style rules nest far less; a deeper tree did not
// come from the project's markup, and what lies below the bound is skipped.
export const PRELOAD_LIMITS = { domDepthMax: 512, cssRuleDepthMax: 64 } as const;

// Marks the elements the canvas adds to the page to measure it: its own
// writes, which never start a page walk (mutationKind in frameReports.ts).
export const PROBE_ATTR = 'data-avb-probe';

export const isElement = (node: Node): node is Element => node.nodeType === 1;
export const isComment = (node: Node): node is Comment => node.nodeType === 8;
export const isText = (node: Node): node is Text => node.nodeType === 3;
export const isChildNode = (node: Node): node is ChildNode => 'remove' in node && typeof node['remove'] === 'function';
