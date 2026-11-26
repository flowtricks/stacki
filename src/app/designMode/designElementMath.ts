// Design mode (experimental, removable: docs/design-mode/REMOVE.md): the arithmetic of dragging an element: pure.
//
// An element is moved with the CSS `translate` property, so nothing around it reflows: it goes where it is put, as a
// layer does in a design tool. While it moves, its edges and middle snap to those of the element holding it and of
// its siblings.
import type { FrameBox } from './designFrameDom';

export interface Offset {
  readonly x: number;
  readonly y: number;
}

/** A snap line across a frame: `axis` x is a vertical line at `at`, y a horizontal one. */
export interface SnapGuide {
  readonly axis: 'x' | 'y';
  readonly at: number;
}

export interface Snapped {
  readonly offset: Offset;
  readonly guides: readonly SnapGuide[];
}

/** Boxes an element snaps to: its holder and its siblings, no more than this many. */
export const SNAP_BOXES_MAX = 100;

/**
 * A computed `translate` in pixels: "none", "12px" or "12px -4px". Undefined for one in other units (a percentage),
 * which a drag would replace with a guess.
 */
export function parseTranslate(computed: string): Offset | undefined {
  const value = computed.trim();
  if (value === '' || value === 'none') {
    return { x: 0, y: 0 };
  }
  const parts = value.split(/\s+/);
  const pixels = parts.slice(0, 2).map((part) => (/^-?\d*\.?\d+(e-?\d+)?px$/.test(part) || part === '0' ? Number.parseFloat(part) : Number.NaN));
  const [x, y = 0] = pixels;
  if (x === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
    return undefined;
  }
  return { x, y };
}

/** A length as the project writes it, in rem of the frame's root size: to four places, with no trailing zeros. */
export function remLength(pixels: number, rootPx: number): string {
  if (!(rootPx > 0)) {
    throw new Error('Assertion failed: remLength: a root size is positive');
  }
  const rem = Math.round((pixels / rootPx) * 10_000) / 10_000;
  return rem === 0 ? '0rem' : `${String(rem)}rem`;
}

interface Best {
  readonly shift: number;
  readonly at: number;
}

/** The smallest shift, within `reach`, that puts one of `edges` on one of `lines`. */
function nearest(edges: readonly number[], lines: readonly number[], reach: number): Best | undefined {
  let best: Best | undefined = undefined;
  for (const edge of edges) {
    for (const line of lines) {
      const shift = line - edge;
      if (Math.abs(shift) <= reach && (best === undefined || Math.abs(shift) < Math.abs(best.shift))) {
        best = { shift, at: line };
      }
    }
  }
  return best;
}

const across = (box: FrameBox): readonly number[] => [box.x, box.x + box.width / 2, box.x + box.width];
const down = (box: FrameBox): readonly number[] => [box.y, box.y + box.height / 2, box.y + box.height];

/** Where a drag of `box` by `offset` lands once its edges and middle snap, within `reach`, to the other boxes'. */
export function snapMove(box: FrameBox, offset: Offset, others: readonly FrameBox[], reach: number): Snapped {
  const bounded = others.slice(0, SNAP_BOXES_MAX);
  const moved = { ...box, x: box.x + offset.x, y: box.y + offset.y };
  const x = nearest(across(moved), bounded.flatMap(across), reach);
  const y = nearest(down(moved), bounded.flatMap(down), reach);
  const guides: SnapGuide[] = [];
  if (x !== undefined) {
    guides.push({ axis: 'x', at: x.at });
  }
  if (y !== undefined) {
    guides.push({ axis: 'y', at: y.at });
  }
  return { offset: { x: offset.x + (x?.shift ?? 0), y: offset.y + (y?.shift ?? 0) }, guides };
}
