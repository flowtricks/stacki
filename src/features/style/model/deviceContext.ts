// What a canvas device switch does to the style panel's context.
//
// Returning to the desktop canvas is leaving the narrow view a width query was
// being written for. If the panel stayed in that `@media` query, the next edit
// would land in a query whose styles the desktop canvas does not show, and the
// edit would look like it did nothing. So switching the canvas to desktop puts
// a width-query context back on Base.
//
// Only `@media` contexts move. A container query follows its container, not the
// window, so it is as true on desktop as anywhere; `@supports` has nothing to do
// with width; Base is already Base. The interaction state (`:hover` and the
// rest) is a separate choice from the context and is never touched here. The
// other devices change nothing: the context list only names queries that are
// authored (model/nativeStyles.ts), so there is no preset query to move into.

import { assert } from '../../../../shared/core/assert';
import type { StyleContext } from './resolved';

/** The panel's next context after a device switch. */
export type ContextAfterDevice = { readonly kind: 'keep' } | { readonly kind: 'base' };

/** The canvas device the switch lands on, as the host reports it. */
export type DeviceTarget = { readonly kind: 'desktop' } | { readonly kind: 'other'; readonly device: string };

/** Parse the host's device string (an app-side `PreviewDevice`). */
export function deviceTargetOf(device: string): DeviceTarget {
  return device === 'desktop' ? { kind: 'desktop' } : { kind: 'other', device };
}

/** What kind of query a context is written in: its innermost at-rule decides. */
export type ContextQuery = { readonly kind: 'base' } | { readonly kind: 'media' } | { readonly kind: 'other' };

export function contextQueryOf(context: Pick<StyleContext, 'key' | 'breakpoint' | 'embedAtContext'>): ContextQuery {
  if (context.key === '') {
    return { kind: 'base' };
  }
  const atContext = context.embedAtContext;
  if (atContext === undefined || atContext === '') {
    // A breakpoint with no authored query behind it is a width breakpoint, and
    // those are `@media` conditions (nativeStyles.ts BREAKPOINTS).
    if (context.breakpoint !== undefined && context.breakpoint !== 'main') {
      return { kind: 'media' };
    }
    return { kind: 'other' };
  }
  // A chain (`@container x › @media y`) is written in its last link: the rule
  // sits inside that one.
  const innermost = (atContext.split(' › ').pop() ?? '').trim().toLowerCase();
  assert(innermost.length > 0, 'contextQueryOf: an at-context names a query');
  return /^@media\b/.test(innermost) ? { kind: 'media' } : { kind: 'other' };
}

export function contextAfterDevice(context: Pick<StyleContext, 'key' | 'breakpoint' | 'embedAtContext'>, target: DeviceTarget): ContextAfterDevice {
  const query = contextQueryOf(context);
  switch (target.kind) {
    case 'other':
      return { kind: 'keep' };
    case 'desktop':
      switch (query.kind) {
        case 'media':
          return { kind: 'base' };
        case 'base':
        case 'other':
          return { kind: 'keep' };
        default: {
          const exhaustive: never = query;
          return exhaustive;
        }
      }
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}
