// Going to an audit finding's element: select it exactly as a Navigator click
// does (panelSelection.ts), so the canvas outline, the inspector and the scroll
// follow; flash it; and, when its file had to be opened first, wait until the
// canvas has rendered that file before selecting, since a selection made while
// the frame still shows the old page is never scrolled to or outlined.
import { assert } from '../../../shared/core/assert';
import { selectFromPanel, type PanelSelectionTarget } from './panelSelection';

export interface RevealTarget extends PanelSelectionTarget {
  readonly setHoverNodeId: (id: string | undefined) => void;
}

/** How long a revealed element stays outlined. */
export const REVEAL_FLASH_MS = 900;
/** When the scroll is asked for again, for a page whose layout was still settling (fonts, images). */
export const REVEAL_SETTLE_MS = 350;

type Schedule = (run: () => void, delayMs: number) => void;

export function revealNode(target: RevealTarget, id: string, schedule: Schedule = (run, delayMs) => void setTimeout(run, delayMs)): void {
  assert(id.length > 0, 'revealNode: an element has an id');
  selectFromPanel(target, id);
  target.setHoverNodeId(id);
  schedule(() => target.setNavigatorSelectionTick((tick) => tick + 1), REVEAL_SETTLE_MS);
  schedule(() => target.setHoverNodeId(undefined), REVEAL_FLASH_MS);
}

/** A go-to waiting for its file: `opening` until the file shows, `rendering` until the canvas reports that file rendered. */
export interface PendingReveal {
  readonly path: string;
  readonly trail: readonly number[];
  readonly phase: 'opening' | 'rendering';
}

/** The next state of a waiting go-to, and whether to select now. */
export function nextReveal(
  pending: PendingReveal,
  seen: { readonly shownPath: string | undefined; readonly editable: boolean; readonly rendered: boolean },
): { readonly pending: PendingReveal | undefined; readonly select: boolean } {
  assert(pending.trail.length > 0, 'nextReveal: names an element');
  if (seen.shownPath !== pending.path || !seen.editable) {
    return { pending, select: false };
  }
  if (pending.phase === 'opening') {
    // The canvas drops its report when the page changes; a report seen now is the old page's.
    return { pending: { ...pending, phase: 'rendering' }, select: false };
  }
  return seen.rendered ? { pending: undefined, select: true } : { pending, select: false };
}
