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

import { createContext, useContext, useEffect, useState } from 'react';
import { hasCanvas, onCanvasReady, queryCanvas } from '../../../editor/canvasQuery';
import { getHost, onHostChange } from './host';
import { createQueryCache } from './queryCache';
import { textStyleContext } from './styleQuery';
import { declaredValues, literalColorOf, parseComputedColor, rootColorQuery, type RootColorQuery } from './rootColors';
import type { ProjectVariable } from './webflow';

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
  const answer = await queryCanvas(path, [], values, [], textStyleContext(path, getHost().selectedId));
  return answer?.computed;
});

// The same question asked of the page's root element (`:root`, its <html>): the code editors' swatches,
// whose text is a stylesheet rather than any one element's styles (rootColors.ts). Path '' with no
// text context is the document element on the canvas's side (frameQueries.ts).
const ROOT_PATH = '';
const rootCache = createQueryCache(rootColorQuery((values) => queryCanvas(ROOT_PATH, [], values, []).then((answer) => answer?.computed)));

/** Forget everything: the page changed under us, so the answers may have too. */
export function forgetComputedColors(): void {
  cache.clear();
  rootCache.clear();
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
 * Where a swatch's value is resolved: on the selected element (the Style panel), or on the page's
 * root element (a code editor, whose text is a stylesheet), with `literal` reading the value from
 * the declared text while the page has not answered or there is no canvas to ask.
 */
export type SwatchScope = { readonly on: 'selection' } | { readonly on: 'root'; readonly literal: (value: string) => string | undefined };

/** A code editor's swatch scope: `:root`, read from `variables`' declared text until the page answers. */
export function rootSwatchScope(variables: readonly ProjectVariable[]): SwatchScope {
  const declared = declaredValues(variables);
  return { on: 'root', literal: (value) => literalColorOf(value, declared) };
}

/** The swatch scope of the pickers below it; the Style panel's selection unless a code editor says root. */
export const SwatchScopeContext = createContext<SwatchScope>({ on: 'selection' });

// What a root answer depends on: the page shown and its sources, and the breakpoint it is shown at.
// The selection is not part of it: `:root` is the same element whatever is selected.
function rootScope(): readonly unknown[] {
  const host = getHost();
  return [host.projectPath, host.openFilePath, host.nodes, host.device, host.historyTick];
}

/**
 * The colour `value` computes to on the page's root element, as the cache holds it now; undefined
 * while it is being asked, with no canvas, or for a value that is no colour. A miss asks the page,
 * batched with the other swatches of the frame, and `subscribeRootColors` hears the answer.
 */
export function rootColorNow(value: string): string | undefined {
  const raw = value.trim();
  if (!needsPage(raw) || !hasCanvas()) {
    return undefined;
  }
  rootCache.setScope(rootScope());
  const cached = rootCache.read(ROOT_PATH, raw);
  if (cached.kind === 'pending') {
    void rootCache.request(ROOT_PATH, raw);
    return undefined;
  }
  return parseComputedColor(cached.answer);
}

/** Calls `listener` whenever root answers arrive or are forgotten. */
export function subscribeRootColors(listener: () => void): () => void {
  return rootCache.subscribe(listener);
}

/**
 * The colour to paint for `value`: the value itself when it stands alone, and
 * what the page computes it to when it doesn't. Returns the raw value until
 * the answer arrives, so a swatch never flashes empty on a re-render. Under a
 * root SwatchScope the value is resolved on `:root`, and until then painted from
 * its declared text.
 */
export function useResolvedColor(value: string): string {
  const raw = String(value ?? '').trim();
  const [, bump] = useState(0);
  const host = getHost();
  const scope = useContext(SwatchScopeContext);
  const store: RootColorQuery | typeof cache = scope.on === 'root' ? rootCache : cache;
  store.setScope(scope.on === 'root' ? rootScope() : [host.projectPath, host.openFilePath, host.nodes, host.selectedId, host.device, host.historyTick]);
  const path = scope.on === 'root' ? ROOT_PATH : pathOfSelection();
  const pageDependent = needsPage(raw);
  const enabled = pageDependent && hasCanvas();
  const cached = enabled ? store.read(path, raw) : undefined;

  useEffect(() => {
    if (!pageDependent) {
      return undefined;
    }
    const sync = () => bump((count) => count + 1);
    const offCache = store.subscribe(sync);
    const offHost = onHostChange(sync);
    return () => {
      offCache();
      offHost();
    };
  }, [pageDependent, store]);

  useEffect(() => {
    if (cached?.kind === 'pending') {
      // The answer arrives through the subscription above, which re-renders.
      void store.request(path, raw);
    }
  });

  const settled = cached?.kind === 'settled' ? cached.answer : undefined;
  // A root answer is a colour the page computed, validated here; anything else (a length, nothing)
  // keeps the declared text's paint.
  const resolved = scope.on === 'root' ? parseComputedColor(settled) : settled;
  const fallback = scope.on === 'root' ? (scope.literal(raw) ?? raw) : raw;
  return useStableStyleValue(resolved || fallback, { pending: cached?.kind === 'pending' }, [host.projectPath, host.openFilePath, host.selectedId, path, raw]);
}
