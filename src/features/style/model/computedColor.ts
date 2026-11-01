import { useStableStyleValue } from './useStableStyleValue';
// What a colour value actually looks like, on the element it applies to.
//
// A swatch used to paint the value straight into the panel's own DOM, which
// works for `#c6fb50` and fails for everything that depends on where it lives:
// `var(--background)` is not defined in the app's document, so it painted
// nothing (a transparent chequerboard), and `color-mix(in srgb, var(--brand)
// 20%, transparent)` the same. Worse, those values are not even constant —
// the same variable resolves differently under a theme class, a colour scheme
// or a container query, so there is no static answer to look up.
//
// So the page is asked. The canvas resolves the value against the selected
// element (see the `compute` half of avb:query) and hands back the computed
// colour, which is what the swatch paints.

import { useEffect, useState } from 'react';
import { hasCanvas, onCanvasReady, queryCanvas } from '../../../editor/canvasQuery';
import { getHost, onHostChange } from './host';
import { createQueryCache } from './queryCache';
import { textStyleContext } from './styleQuery';

/**
 * Does this value need the page to resolve it?
 *
 * Anything referring to something outside itself: a custom property, a
 * function whose arguments may hold one, or a keyword that means "whatever
 * this element inherits". A literal colour is painted as-is — no round trip
 * for `#fff`.
 */
export function needsPage(value: string): boolean {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes('var(') ||
    normalized.includes('color-mix(') ||
    normalized.includes('light-dark(') ||
    normalized.includes('currentcolor') ||
    normalized.startsWith('--')
  );
}

const cache = createQueryCache(async (path, values) => {
  const answer = await queryCanvas(path, [], values, [], textStyleContext(path));
  return answer?.computed;
});

/** Forget everything: the page changed under us, so the answers may have too. */
export function forgetComputedColors(): void {
  cache.clear();
}
// A new page's answers are not the old one's.
onCanvasReady(forgetComputedColors);

// The element to resolve against: whatever is selected, and the page itself
// when nothing is — which is where `:root`'s custom properties are declared.
// The variables panel has no selection to speak of and its swatches are as
// answerable as any other.
function pathOfSelection(): string {
  const host = getHost();
  return (host.selectedId ? host.pathOf?.(host.selectedId) : undefined) ?? '';
}

/**
 * The colour to paint for `value`: the value itself when it stands alone, and
 * what the page computes it to when it doesn't. Returns the raw value until
 * the answer arrives, so a swatch never flashes empty on a re-render.
 */
export function useResolvedColor(value: string): string {
  const raw = String(value ?? '').trim();
  const [, bump] = useState(0);
  const host = getHost();
  cache.setScope([host.projectPath, host.openFilePath, host.nodes, host.selectedId, host.device, host.historyTick]);
  const path = pathOfSelection();
  const pageDependent = needsPage(raw);
  const enabled = pageDependent && hasCanvas();
  const cached = enabled ? cache.read(path, raw) : undefined;

  useEffect(() => {
    if (!pageDependent) {
      return undefined;
    }
    const sync = () => bump((count) => count + 1);
    const offCache = cache.subscribe(sync);
    const offHost = onHostChange(sync);
    return () => {
      offCache();
      offHost();
    };
  }, [pageDependent]);

  useEffect(() => {
    if (cached?.kind === 'pending') {
      // The answer arrives through the subscription above, which re-renders.
      void cache.request(path, raw);
    }
  });

  const resolved = cached?.kind === 'settled' ? cached.answer : undefined;
  return useStableStyleValue(resolved || raw, { pending: cached?.kind === 'pending' }, [host.projectPath, host.openFilePath, host.selectedId, path, raw]);
}
