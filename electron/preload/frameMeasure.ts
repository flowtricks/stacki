// Measuring what the editor tracks: a path's rectangles, its classes, its
// padding, margins and gap bands, and the thin elements that get a wider hit
// area so they can still be pointed at.

import { assert } from '../../shared/core/assert';
import type { Box, GapBand, GapRow, Rect, Spacing, ThinTarget } from './frameBasics';
import { PROBE_ATTR, isElement } from './frameBasics';
import { PATH_ATTR, addNode, elementsWithPath, inFocus, inScope, pathsOf, regions, runsOf, taggedPlaces, toRect } from './frameRegions';
import { inlineTextRuns } from './inlineText';
import { rectsForPseudo } from './framePseudo';
import { splitPseudoPath } from '../../shared/page/pseudoPath';

// One rect per marker-pair occurrence (a loop child renders once per
// item — each instance gets its own box), unioned across the nodes
// inside each occurrence.
// The box of the nearest descendants that DO have regions, unioned. Used for
// a node whose own markers could not survive the HTML parser: a layout wraps
// <html>, so its start marker is hoisted into <head> and its end into <body>
// — never siblings, so the pair is never found. Its children are inside the
// body and marked normally, and their union is exactly the layout's box.
const rectsFromDescendants = (nodePath: string): Rect[] | undefined => {
  const prefix = nodePath + '.';
  let best = Infinity;
  const paths: string[] = [];
  for (const key of regions.keys()) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    const depth = key.split('.').length;
    if (depth < best) {
      best = depth;
      paths.length = 0;
    }
    if (depth === best) {
      paths.push(key);
    }
  }
  let acc: Box | undefined = undefined;
  for (const key of paths) {
    for (const run of runsOf(key) || []) {
      for (const node of run) {
        acc = addNode(acc, node);
      }
    }
  }
  return acc ? [toRect(acc)] : undefined;
};

// A box with no width or no height, sitting beside boxes that have both.
//
// A line-splitter (GSAP's SplitText, Splitting.js) rebuilds a heading into
// one element per line and leaves the original inline elements behind, empty.
// Emptied, they still carry the path tag and still have a box — zero wide and
// a line tall — so the node that WAS a word now reported two places: a hollow
// one and the real one. The hollow one is first in the document, so it is the
// one an outline drew: a 1px bar against the left edge of the line.
//
// Kept when it is all there is: an element that genuinely renders nothing wide
// should still show where it sits.
const withoutHollow = (list: Rect[]): Rect[] => {
  const real = list.filter((rect) => rect.w > 0 && rect.h > 0);
  return real.length ? real : list;
};

// One box per place the unmarked text run renders, around its words only.
const rectsForInlineText = (nodePath: string): Rect[] => {
  const out: Rect[] = [];
  for (const run of inlineTextRuns(nodePath)) {
    let acc: Box | undefined = undefined;
    for (const node of run) {
      acc = addNode(acc, node);
    }
    if (acc) {
      out.push(toRect(acc));
    }
  }
  return out;
};

// The box one occurrence draws: its run, and when the path has only that run,
// every tagged piece of it too (see rectsForPath). The outline and the hit test
// both read this, so the space a click can land in is the space outlined.
export const boxOfRun = (nodePath: string, run: readonly Node[], runCount: number): Box | undefined => {
  let acc = run.reduce<Box | undefined>((grown, node) => addNode(grown, node), undefined);
  if (runCount === 1) {
    for (const element of elementsWithPath(nodePath)) {
      acc = addNode(acc, element);
    }
  }
  return acc;
};

export const rectsForPath = (nodePath: string): Rect[] | undefined => {
  // A ::before or ::after layer (shared/page/pseudoPath.ts) is measured on its element.
  const pseudo = splitPseudoPath(nodePath);
  if (pseudo !== undefined) {
    const boxes = rectsForPseudo(pseudo.nodePath, pseudo.pseudo);
    return boxes.length > 0 ? boxes : undefined;
  }
  const runs = runsOf(nodePath);
  if (!runs) {
    const places = taggedPlaces(nodePath);
    if (places.length) {
      return places.map((place) => place.rect);
    }
    // A text run in an inline run has neither markers nor a tag (inlineText.ts).
    const inline = rectsForInlineText(nodePath);
    return inline.length ? inline : rectsFromDescendants(nodePath);
  }
  const out: Rect[] = [];
  for (const run of runs) {
    let acc: Box | undefined = undefined;
    for (const node of run) {
      acc = addNode(acc, node);
    }
    if (acc) {
      out.push(toRect(acc));
    }
  }
  // A single node can still be many elements on the page — see PATH_ATTR:
  // a split paragraph's original element covers only its last line, and
  // the rest of it lives in clones. Union every tagged piece back into one
  // box. Repeated occurrences (a loop child, once per item) are meant to
  // stay separate boxes, so they keep the per-run rects above.
  if (runs.length === 1) {
    const acc = boxOfRun(nodePath, runs[0] || [], runs.length);
    // Nothing measurable: fall through to the children (see below).
    if (acc) {
      return [toRect(acc)];
    }
  }
  if (out.length) {
    return out;
  }
  // Every run measured nothing, yet the node may well be on screen: a page
  // script can replace the recorded nodes outright (a marquee that clones its
  // track, a slider that rebuilds slides). The tag survives on the clones, so
  // re-resolve from the live DOM — one box per tagged element, in document
  // order, which is the order occurrences are counted in. Without this a
  // looped node under such a script draws no outline at all, even though
  // clicking it still selects (nodeAt reads the same tag).
  const tagged = elementsWithPath(nodePath);
  if (tagged.length) {
    for (const element of tagged) {
      const acc = addNode(undefined, element);
      if (acc) {
        out.push(toRect(acc));
      }
    }
    const real = withoutHollow(out);
    if (real.length) {
      return real;
    }
  }
  // A region that exists but contains nothing with a box — the layout case:
  // its start marker is orphaned in <head>, so the walk collected the head's
  // scripts and links rather than the page. Its children still measure.
  return rectsFromDescendants(nodePath);
};

// The classes actually on the page for a node, one entry per occurrence (a
// node inside a loop renders once per item). The model can't answer this:
// `class:list={[...]}` and `class={expr}` are expressions, so the authored
// source has no class text to read — only the rendered element knows what
// the expression evaluated to for THIS instance.
// The classes this file puts on the page itself, which the app must never see
// among the element's own: they would show up in the class picker, in the
// selector well, and in the navigator's labels as if the project had written
// them.
export const STACKI_CLASSES = new Set(['stacki-opened', 'stacki-designer', 'stacki-preview']);
export const ownClasses = (element: Element): string[] => Array.from(element.classList).filter((className) => !STACKI_CLASSES.has(className));

export const classesForPath = (nodePath: string): string[][] => {
  const out: string[][] = [];
  for (const run of runsOf(nodePath) || []) {
    const element = run.find((node): node is Element => isElement(node) && node.tagName !== 'TEMPLATE');
    if (element) {
      out.push(ownClasses(element));
    }
  }
  if (!out.length) {
    for (const element of elementsWithPath(nodePath)) {
      out.push(ownClasses(element));
    }
  }
  return out;
};

// The element's own spacing, in px, for the box the style panel draws over the
// canvas: hovering `padding-top` there lights the strip of this element that
// padding-top actually occupies. Read from the computed style rather than the
// authored value, because that is the question being asked — where is it on
// the page, not what was typed.
const SIDES = ['top', 'right', 'bottom', 'left'];

// Where an element's `gap` actually is, as rectangles.
//
// Padding and margin are four numbers on the element itself, so the panel can
// draw them from the box alone. A gap is not: it lives BETWEEN children, and
// where those children are is a question only the laid-out page can answer —
// flex wraps, grid places, and neither is reconstructable from the parent's
// rectangle. So the bands are measured here, in the same viewport coordinates
// as every other rect, and the app only has to draw them.
//
// Measured, but never larger than the gap: with `justify-content:
// space-between` the space between two children is the gap PLUS the free
// space shared out between them, and lighting all of that would say `gap` is
// bigger than it is. The band is capped at the computed gap and sits against
// the child before it, which is the part of that space the property is
// actually responsible for.
// The children of a flex or grid box a gap can be seen between: each laid
// out, with a box of its own.
const gapChildRects = (element: Element): DOMRect[] => {
  const kids: DOMRect[] = [];
  for (const child of Array.from(element.children)) {
    if (child.tagName === 'TEMPLATE') {
      continue;
    }
    const rect = child.getBoundingClientRect();
    // A child with no box is not somewhere a gap can be seen.
    if (rect.width <= 0 && rect.height <= 0) {
      continue;
    }
    const cd = window.getComputedStyle(child).display;
    if (cd === 'none' || cd === 'contents') {
      continue;
    }
    kids.push(rect);
  }
  return kids;
};

// Children grouped into visual rows: two that overlap vertically are on
// the same line, whether that line came from flex-wrap or from grid.
const visualRows = (kids: DOMRect[]): GapRow[] => {
  const byTop = [...kids].sort((left, right) => left.top - right.top || left.left - right.left);
  const rows: GapRow[] = [];
  for (const rect of byTop) {
    const row = rows[rows.length - 1];
    const overlaps = row && rect.top < row.bottom - 1 && rect.bottom > row.top + 1;
    if (overlaps) {
      row.items.push(rect);
      row.top = Math.min(row.top, rect.top);
      row.bottom = Math.max(row.bottom, rect.bottom);
    } else {
      rows.push({ top: rect.top, bottom: rect.bottom, items: [rect] });
    }
  }
  return rows;
};

// Between columns, within each row.
const columnGapBands = (rows: GapRow[], colGap: number): GapBand[] => {
  const bands: GapBand[] = [];
  for (const row of rows) {
    const across = [...row.items].sort((left, right) => left.left - right.left);
    for (let i = 1; i < across.length; i++) {
      const previous = across[i - 1];
      const next = across[i];
      if (!previous || !next) {
        continue;
      }
      const space = next.left - previous.right;
      const width = Math.min(space, colGap);
      if (width <= 0.5) {
        continue;
      }
      bands.push({
        axis: 'column',
        x: previous.right,
        y: row.top,
        w: width,
        h: row.bottom - row.top,
      });
    }
  }
  return bands;
};

// Between rows, across the width the children occupy.
const rowGapBands = (rows: GapRow[], rowGap: number): GapBand[] => {
  const bands: GapBand[] = [];
  for (let i = 1; i < rows.length; i++) {
    const previous = rows[i - 1];
    const next = rows[i];
    if (!previous || !next) {
      continue;
    }
    const space = next.top - previous.bottom;
    const height = Math.min(space, rowGap);
    if (height <= 0.5) {
      continue;
    }
    const span = [...previous.items, ...next.items];
    const left = Math.min(...span.map((rect) => rect.left));
    const right = Math.max(...span.map((rect) => rect.right));
    bands.push({ axis: 'row', x: left, y: previous.bottom, w: right - left, h: height });
  }
  return bands;
};

// A gap in px, as the page lays it out.
//
// The authored value is never parsed: `var(--site-gutter)`, `calc()` and
// `clamp()` are all the engine's to resolve. But the computed value of
// `column-gap` and `row-gap` is not always pixels either. Variables, `em`,
// `rem`, `vw` and container units are resolved, while a percentage is kept,
// because it resolves against the box only at layout time. So a gutter written
// as `min(5%, 40px)` or `calc(2% + 4px)` computes to that same text, and
// `parseFloat` read it as no gap at all (or `8.33333%` as 8px): hovering the
// field drew nothing, or a sliver, while a plain `16px` drew its bands.
//
// Pixels are read directly. Anything else is handed back to the engine on a
// probe the size of this element's content box, which is what a percentage gap
// resolves against: the width for the column gap, the height for the row gap.
const PX_LENGTH = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?px$/i;
const gapPx = (cs: CSSStyleDeclaration, axis: GapBand['axis']): number => {
  const value = (axis === 'column' ? cs.columnGap : cs.rowGap).trim();
  // `normal` is zero in flex and grid, which is the only place a gap is drawn.
  if (value === '' || value === 'normal') {
    return 0;
  }
  if (PX_LENGTH.test(value)) {
    return Math.max(0, parseFloat(value));
  }
  const basisPx = contentBoxPx(cs, axis);
  const resolved = probeLengthPx(value, basisPx, axis);
  assert(Number.isFinite(resolved), 'gapPx: a probed gap is a finite number');
  return Math.max(0, resolved);
};

// The element's content box along one axis, in px: what a percentage gap on
// that axis is a percentage of. `width` and `height` are used values here, so
// they are px; with `border-box` they include padding and border, taken off.
const contentBoxPx = (cs: CSSStyleDeclaration, axis: GapBand['axis']): number => {
  const sides = axis === 'column' ? (['left', 'right'] as const) : (['top', 'bottom'] as const);
  const size = parseFloat(axis === 'column' ? cs.width : cs.height) || 0;
  if (cs.boxSizing !== 'border-box') {
    return Math.max(0, size);
  }
  let edges = 0;
  for (const side of sides) {
    edges += (parseFloat(cs.getPropertyValue(`padding-${side}`)) || 0) + (parseFloat(cs.getPropertyValue(`border-${side}-width`)) || 0);
  }
  return Math.max(0, size - edges);
};

// What `value` is in px inside a box `basisPx` wide (or tall, for the row
// axis). The probe is the canvas's own (PROBE_ATTR): adding and removing it
// never starts a page walk. Its outer box fixes the percentage basis, and the
// inner one takes the value as its width or height; a value the engine
// rejects leaves the inner box at zero, which is no gap.
const probeLengthPx = (value: string, basisPx: number, axis: GapBand['axis']): number => {
  assert(basisPx >= 0, 'probeLengthPx: a percentage basis is never negative');
  const body = document.body;
  if (!body) {
    return 0;
  }
  const reset = 'margin:0;padding:0;border:0;box-sizing:content-box;';
  const outer = document.createElement('div');
  outer.setAttribute(PROBE_ATTR, '');
  outer.setAttribute(
    'style',
    `position:absolute;left:0;top:0;visibility:hidden;pointer-events:none;overflow:hidden;${reset}width:${basisPx}px;height:${basisPx}px`,
  );
  const inner = document.createElement('div');
  inner.setAttribute(PROBE_ATTR, '');
  inner.setAttribute('style', `display:block;${reset}width:0;height:0`);
  inner.style.setProperty(axis === 'column' ? 'width' : 'height', value);
  outer.appendChild(inner);
  body.appendChild(outer);
  try {
    const rect = inner.getBoundingClientRect();
    const size = axis === 'column' ? rect.width : rect.height;
    return Number.isFinite(size) ? size : 0;
  } finally {
    outer.remove();
  }
};

export const gapBandsFor = (element: Element, cs: CSSStyleDeclaration): GapBand[] => {
  const display = cs.display;
  if (!/(^|\s)(flex|grid|inline-flex|inline-grid)$/.test(display)) {
    return [];
  }
  const colGap = gapPx(cs, 'column');
  const rowGap = gapPx(cs, 'row');
  assert(colGap >= 0, 'gapBandsFor: a column gap is never negative');
  assert(rowGap >= 0, 'gapBandsFor: a row gap is never negative');
  if (colGap <= 0 && rowGap <= 0) {
    return [];
  }
  const kids = gapChildRects(element);
  if (kids.length < 2) {
    return [];
  }
  const rows = visualRows(kids);
  return [...(colGap > 0 ? columnGapBands(rows, colGap) : []), ...(rowGap > 0 ? rowGapBands(rows, rowGap) : [])];
};

export const spacingForPath = (nodePath: string): (Spacing | undefined)[] => {
  const out: Element[] = [];
  for (const run of runsOf(nodePath) || []) {
    const element = run.find((node): node is Element => isElement(node) && node.tagName !== 'TEMPLATE');
    if (element) {
      out.push(element);
    }
  }
  if (!out.length) {
    out.push(...elementsWithPath(nodePath));
  }
  return out.map((element) => {
    try {
      const cs = window.getComputedStyle(element);
      const box = (kind: string) => Object.fromEntries(SIDES.map((side): [string, number] => [side, parseFloat(cs.getPropertyValue(`${kind}-${side}`)) || 0]));
      // What a length is worth here, so a value being dragged in the panel can
      // be drawn in pixels before the page has laid it out (withLiveSpacing in
      // the app): em is this element's font, rem the root's, vw and vh the frame.
      const rootFont = parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
      const units = {
        em: parseFloat(cs.fontSize) || rootFont,
        rem: rootFont,
        vw: window.innerWidth / 100,
        vh: window.innerHeight / 100,
      };
      const gaps = gapBandsFor(element, cs);
      return { padding: box('padding'), margin: box('margin'), gaps, units };
    } catch {
      // Whatever went wrong measuring one element, the boxes everything else
      // depends on still have to be reported.
      return undefined;
    }
  });
};

// Nodes that render as a line — an empty <div>, an <hr>, a wrapper whose
// children are all absolutely positioned. They have a box, and the app draws
// it, but nothing can be *inside* something zero pixels tall, so the hit test
// below always lands on the parent and they'd be reachable only from the
// navigator. Hit-test those with a few pixels of slack instead, which is how
// wide the outline looks anyway.
const THIN = 3; // a box this flat can't be entered
const THIN_SLACK = 5; // …so accept the cursor this near it
let thinCache: ThinTarget[] | undefined = undefined;

// The widened targets are found again on the next hit test: boxes moved, or
// the scope that decides what is hit-testable changed.
export function resetThinCache(): void {
  thinCache = undefined;
}
const thinTargets = (): ThinTarget[] => {
  if (thinCache) {
    return thinCache;
  }
  thinCache = [];
  for (const element of Array.from(document.querySelectorAll(`[${PATH_ATTR}]`))) {
    if (!inFocus(element)) {
      continue;
    }
    const nodePath = pathsOf(element).find(inScope);
    if (!nodePath) {
      continue;
    }
    const rect = element.getBoundingClientRect();
    // Fully collapsed (0×0) is left alone: the app draws no outline for it,
    // so snapping to it would highlight nothing.
    if (rect.width < 1 && rect.height < 1) {
      continue;
    }
    if (rect.height > THIN && rect.width > THIN) {
      continue;
    }
    thinCache.push({ path: nodePath, el: element, box: rect });
  }
  return thinCache;
};

// The deepest line-thin node the cursor is within slack of. Constrained to
// descendants of what the normal hit test found, so this only ever refines
// the answer — it can't jump to something else on the page.
export const thinAt = (x: number, y: number, best: string | undefined): ThinTarget | undefined => {
  let hit: ThinTarget | undefined = undefined;
  let hitDepth = best ? best.split('.').length : 0;
  for (const target of thinTargets()) {
    if (best && !target.path.startsWith(best + '.')) {
      continue;
    }
    const depth = target.path.split('.').length;
    if (depth <= hitDepth) {
      continue;
    }
    const box = target.box;
    if (x < box.left - THIN_SLACK || x > box.right + THIN_SLACK) {
      continue;
    }
    if (y < box.top - THIN_SLACK || y > box.bottom + THIN_SLACK) {
      continue;
    }
    hit = target;
    hitDepth = depth;
  }
  return hit;
};
