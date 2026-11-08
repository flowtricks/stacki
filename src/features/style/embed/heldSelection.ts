// The selector well's switch from one element to the next, made in one step.
//
// Selecting another element fills the well in stages: the model is blanked, the
// source-known selectors land, then the canvas's answer, and the default pick
// (the highlighted chip) a render after that. Drawn as they came, the chips went
// `.text .text-style-large …` → `:target :focus-visible` → the heading's chips →
// the same with `.heading` highlighted, a flicker on every click. The well now
// keeps showing the last settled list until the next one is settled and picked,
// then swaps in a single render. A resolve that never settles (a canvas that does
// not answer) is waited out for SELECTION_HOLD_MS_MAX, then shown as it stands.

import { useEffect, useRef, useState } from 'react';
import { assert } from '../../../../shared/core/assert';
import type { MatchedSelector } from '../model/resolved';

/** The longest the well keeps the previous element's chips while the next ones resolve. */
export const SELECTION_HOLD_MS_MAX = 600;

/** What the well draws: its chips and which one is highlighted. */
export type SelectionView = {
  readonly selectors: readonly MatchedSelector[];
  readonly activeSelector: string;
  readonly activePicked: boolean;
};

/**
 * Whether a view is the finished answer for its element: the scan settled and,
 * during an element switch, the default pick has landed (a well with chips always
 * highlights one by then). Outside a switch no pick is fine: deselecting the active
 * chip leaves every chip unhighlighted on purpose.
 */
export function selectionReady(view: SelectionView, scan: { readonly settled: boolean; readonly switching: boolean }): boolean {
  if (!scan.settled) {
    return false;
  }
  if (!scan.switching) {
    return true;
  }
  if (view.selectors.length === 0) {
    return true;
  }
  return view.activeSelector.length > 0;
}

/** Which view to draw: the current one, or the last settled one while the next is on its way. */
export type HoldDecision = { readonly kind: 'show' } | { readonly kind: 'hold'; readonly view: SelectionView; readonly remainingMs: number };

export function holdDecision(input: {
  readonly ready: boolean;
  readonly last: SelectionView | undefined;
  readonly holdStartMs: number | undefined;
  readonly nowMs: number;
}): HoldDecision {
  if (input.ready) {
    return { kind: 'show' };
  }
  // Nothing settled yet (the first selection): there is nothing to keep, and the
  // well's own spinner says the chips are on their way.
  if (input.last === undefined) {
    return { kind: 'show' };
  }
  const startMs = input.holdStartMs ?? input.nowMs;
  assert(input.nowMs >= startMs, 'holdDecision: a hold starts no later than now');
  const elapsedMs = input.nowMs - startMs;
  if (elapsedMs < SELECTION_HOLD_MS_MAX) {
    const remainingMs = SELECTION_HOLD_MS_MAX - elapsedMs;
    assert(remainingMs > 0, 'holdDecision: a hold has time left');
    return { kind: 'hold', view: input.last, remainingMs };
  }
  return { kind: 'show' };
}

/**
 * The view to draw for `current`, holding the last settled view across an element
 * switch (see the file comment). `holding` is true while the drawn chips are the
 * previous element's: a click on one then would pick a selector for the wrong
 * element, so the well ignores it.
 */
export function useHeldSelection(current: SelectionView, scan: { readonly settled: boolean }): { readonly view: SelectionView; readonly holding: boolean } {
  const lastRef = useRef<SelectionView | undefined>(undefined);
  const holdStartRef = useRef<number | undefined>(undefined);
  const ready = selectionReady(current, { settled: scan.settled, switching: holdStartRef.current !== undefined });
  // Bumped when a hold runs out, to draw the view as it then stands.
  const [, setExpiredCount] = useState(0);
  const nowMs = performance.now();
  const decision = holdDecision({ ready, last: lastRef.current, holdStartMs: holdStartRef.current, nowMs });
  // Refs written during render: each write is idempotent for the same inputs, so a
  // repeated render (StrictMode) lands on the same values.
  if (ready) {
    lastRef.current = current;
    holdStartRef.current = undefined;
  } else if (decision.kind === 'hold') {
    holdStartRef.current ??= nowMs;
  }
  const remainingMs = decision.kind === 'hold' ? decision.remainingMs : undefined;
  useEffect(() => {
    if (remainingMs === undefined) {
      return undefined;
    }
    const timer = window.setTimeout(() => setExpiredCount((count) => count + 1), Math.ceil(remainingMs));
    return () => window.clearTimeout(timer);
  }, [remainingMs]);
  return decision.kind === 'hold' ? { view: decision.view, holding: true } : { view: current, holding: false };
}
