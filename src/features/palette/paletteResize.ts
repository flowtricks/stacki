import { useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { assert } from '../../../shared/core/assert';
import { prefersReducedMotion } from '../../ui/segmentIndicator';

// The insert palette changes size with its tab: Components is a wide grid of previews, the other
// tabs the narrow list. Snapping between the two reads as a different window opening, so the box
// slides from its old size to its new one instead (FLIP: measure the new size, start at the old
// one, transition to the new one, then hand the size back to CSS).
//
// While it moves, the content is laid out once at its final width and centred in the box, which
// clips it. Laying it out at every intermediate width would reflow the grid, and its live preview
// frames, every frame of the animation, and would show the grid squeezed into the list's width.

/** Long enough to read as one box moving, short enough not to hold up the search. */
export const paletteResizeMs = 240;

/** Sizes closer than this are the same box; a transition between them would be invisible. */
const sizeEpsilonPx = 0.5;

export interface PaletteSize {
  readonly width: number;
  readonly height: number;
}

export type PaletteMotion = 'full' | 'reduced';

export type PaletteResizePlan = { readonly kind: 'none' } | { readonly kind: 'animate'; readonly from: PaletteSize; readonly to: PaletteSize };

/** Whether, and between which sizes, the palette animates when its layout changes. */
export function planPaletteResize(from: PaletteSize | undefined, to: PaletteSize, motion: PaletteMotion): PaletteResizePlan {
  assertSize(to);
  if (from === undefined) {
    // Nothing was measured yet: the palette is opening, which has its own entrance.
    return { kind: 'none' };
  }
  assertSize(from);
  if (motion === 'reduced') {
    return { kind: 'none' };
  }
  const widthSame = Math.abs(from.width - to.width) < sizeEpsilonPx;
  const heightSame = Math.abs(from.height - to.height) < sizeEpsilonPx;
  if (widthSame) {
    if (heightSame) {
      return { kind: 'none' };
    }
  }
  return { kind: 'animate', from, to };
}

/**
 * Animates the palette box between layouts. `layoutKey` names the layout ('grid' or 'list');
 * a change of key is what animates, so typing (which changes the list's height) never does.
 */
export function usePaletteResize(paletteRef: RefObject<HTMLElement>, layoutKey: string): void {
  // The box's size as last laid out, kept current by a ResizeObserver, so mid-animation it is
  // the size on screen: a second switch starts from where the first one had got to.
  const lastSize = useRef<PaletteSize | undefined>(undefined);
  const previousKey = useRef(layoutKey);
  const timer = useRef<number | undefined>(undefined);

  useLayoutEffect(() => {
    const palette = paletteRef.current;
    assert(palette !== null, 'paletteResize: the palette is mounted');
    lastSize.current = measurePalette(palette);
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(() => {
      lastSize.current = measurePalette(palette);
    });
    observer.observe(palette);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer.current);
    };
  }, [paletteRef]);

  useLayoutEffect(() => {
    if (previousKey.current === layoutKey) {
      return;
    }
    previousKey.current = layoutKey;
    const palette = paletteRef.current;
    assert(palette !== null, 'paletteResize: the palette is mounted');
    const from = lastSize.current;
    window.clearTimeout(timer.current);
    endPaletteResize(palette);
    // Measured with every inline size cleared: the size CSS gives the new layout.
    const to = measurePalette(palette);
    const contentWidth = palette.clientWidth;
    lastSize.current = to;
    const plan = planPaletteResize(from, to, prefersReducedMotion() ? 'reduced' : 'full');
    if (plan.kind === 'none') {
      return;
    }
    startPaletteResize(palette, plan, contentWidth);
    timer.current = window.setTimeout(() => endPaletteResize(palette), paletteResizeMs);
  }, [paletteRef, layoutKey]);
}

function measurePalette(palette: HTMLElement): PaletteSize {
  return { width: palette.offsetWidth, height: palette.offsetHeight };
}

function startPaletteResize(palette: HTMLElement, plan: Extract<PaletteResizePlan, { kind: 'animate' }>, contentWidth: number): void {
  assert(contentWidth >= 0, 'paletteResize: content width is not negative');
  palette.style.setProperty('--insert-palette-content-width', `${contentWidth}px`);
  palette.style.setProperty('--insert-palette-resize-ms', `${paletteResizeMs}ms`);
  palette.style.setProperty('width', `${plan.from.width}px`);
  palette.style.setProperty('height', `${plan.from.height}px`);
  palette.classList.add('is-resizing');
  // Lay the old size out before the transition is switched on, so it starts there instead of
  // jumping to the new size.
  assert(palette.offsetWidth >= 0, 'paletteResize: the start size is laid out');
  palette.classList.add('is-resizing-run');
  palette.style.setProperty('width', `${plan.to.width}px`);
  palette.style.setProperty('height', `${plan.to.height}px`);
}

function endPaletteResize(palette: HTMLElement): void {
  palette.classList.remove('is-resizing', 'is-resizing-run');
  palette.style.removeProperty('width');
  palette.style.removeProperty('height');
  palette.style.removeProperty('--insert-palette-content-width');
  palette.style.removeProperty('--insert-palette-resize-ms');
}

function assertSize(size: PaletteSize): void {
  assert(Number.isFinite(size.width), 'paletteResize: width is finite');
  assert(Number.isFinite(size.height), 'paletteResize: height is finite');
  assert(size.width >= 0, 'paletteResize: width is not negative');
  assert(size.height >= 0, 'paletteResize: height is not negative');
}
