// Settings' "Chromium scrollbar" choice as it is stored and carried over IPC: `off`, or the id of the breakpoint (or
// Desktop's `desktop`) from which Chromium's own scrollbar is kept. What the choice does to a frame lives in
// canvasScrollbar.ts. This parser is a module of its own because the preference payloads read it at the IPC boundary,
// and that boundary's module graph is kept small (test/renderer/app/viteModules.test.ts): it needs the id rules, not
// the scrollbar's messages, styles and breakpoint icons.

import { assert } from '../core/assert';
import { BREAKPOINT_LIMITS } from './projectBreakpoints';

/** None (the canvas's bar everywhere), or from one breakpoint (or Desktop) up. */
export type CanvasScrollbarPreference = { readonly kind: 'off' } | { readonly kind: 'from'; readonly breakpointId: string };

/** How the preference is written in `settings.json` and carried over IPC: `off`, or a breakpoint id. */
export const CANVAS_SCROLLBAR_OFF = 'off';

export const CANVAS_SCROLLBAR_DEFAULT: CanvasScrollbarPreference = { kind: 'off' };

/** The preference a stored text names. Throws on anything else: `off` and breakpoint ids are the whole vocabulary. */
export function parseCanvasScrollbarPreference(input: unknown): CanvasScrollbarPreference {
  if (typeof input !== 'string') {
    throw new Error('canvasScrollbar: expected text');
  }
  if (input === CANVAS_SCROLLBAR_OFF) {
    return CANVAS_SCROLLBAR_DEFAULT;
  }
  if (input.length === 0) {
    throw new Error('canvasScrollbar: expected off or a breakpoint id');
  }
  if (input.length > BREAKPOINT_LIMITS.idCharsMax) {
    throw new Error('canvasScrollbar: breakpoint id exceeds limit');
  }
  if (!BREAKPOINT_ID_PATTERN.test(input)) {
    throw new Error('canvasScrollbar: expected off or a breakpoint id');
  }
  return { kind: 'from', breakpointId: input };
}

/** The text the preference is stored as; `parseCanvasScrollbarPreference` reads it back. */
export function canvasScrollbarPreferenceText(preference: CanvasScrollbarPreference): string {
  const stored = preference.kind === 'off' ? CANVAS_SCROLLBAR_OFF : preference.breakpointId;
  assert(stored.length > 0, 'canvasScrollbarPreferenceText: never empty');
  assert(stored.length <= BREAKPOINT_LIMITS.idCharsMax, 'canvasScrollbarPreferenceText: within the id bound');
  return stored;
}

// The id rule of `.stacki/breakpoints.json` (projectBreakpoints.ts `ID_PATTERN`): a lowercase letter, then letters,
// digits and hyphens. `off` is not an id any project gives a breakpoint (built-in ids and `bp-N`).
const BREAKPOINT_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
