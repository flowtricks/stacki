// The declaration the browser actually applies to the selected element, per property.
//
// The panel ranks the project's CSS itself (src/features/style/model/cascadeResolve.ts), which
// can only be as right as its reading of the files: which stylesheet loads first, which
// conditions hold now. The canvas knows better, so it reports, for each property asked, the
// winner Chromium's own cascade picks (found by mirroring every declaration into a registered
// carrier property, electron/preload/frameAuthoredStyles.ts), the used value from
// getComputedStyle, and the other declarations that reach the element in document order. The
// panel checks its listed winner against this and never crowns a rule that does not produce the
// used value. The reply crosses from the page, so it is parsed and bounded here.

import { boolean, count, list, object, optional, text } from '../core/boundary';

export const parseCascadeOrigin = object({
  /** The rule's selector list as the browser serializes it, or `style` for the style attribute. */
  selector: text,
  /** The stylesheet's file (a development style tag's id or a link's address), when it has one. */
  file: optional(text),
  /** The declared value for this property as the browser holds it (a shorthand arrives expanded). */
  value: text,
  important: boolean,
  /** The cascade layer's dotted name, absent when unlayered. */
  layer: optional(text),
  /** The `@media`, `@supports` or `@container` conditions around the rule, outermost first. */
  conditions: list(text),
  /** Position in the page's document order across every stylesheet, ascending. */
  order: count,
});
export type CascadeOrigin = ReturnType<typeof parseCascadeOrigin>;

export const parseCascadeProperty = object({
  /** The used value, from getComputedStyle. */
  used: text,
  /** The declaration that wins for the element itself; absent when none of its own rules sets it. */
  winner: optional(parseCascadeOrigin),
  /** Every declaration of the property that reaches the element, in document order. */
  candidates: list(parseCascadeOrigin),
});
export type CascadeProperty = ReturnType<typeof parseCascadeProperty>;

/** At most this many candidates are reported for one property. */
export const CASCADE_CANDIDATES_MAX = 64;
/** At most this many properties are reported for one question. */
export const CASCADE_PROPERTIES_MAX = 512;
