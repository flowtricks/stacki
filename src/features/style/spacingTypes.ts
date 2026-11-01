// The spacing box's shared shapes: the writers it is handed, the four sides,
// and what one side's value shows (SpacingBox.tsx).

import { selectorsMatch, type ResolvedProp } from './model/resolved';

export type SetProp = (prop: string, value: string, important: boolean) => void;
export type ClearProp = (prop: string | string[]) => void;
export type LiveSetProp = (prop: string | readonly string[], value: string | undefined, important: boolean) => void;
export type Read = (prop: string) => ResolvedProp | undefined;
export type SelectSelector = (selector: string, prop?: string) => void;

export type Side = 'top' | 'right' | 'bottom' | 'left';

export type Display = {
  present: boolean;
  isSelected: boolean;
  value: string;
  important: boolean;
  /** The picked selector sets this side but a more specific selector wins. */
  overridden: boolean;
  /** The selector that wins the cascade (for the override tooltip). */
  winnerSelector: string;
};
export function displayOf(resolved: ResolvedProp | undefined): Display {
  if (!resolved) {
    return {
      present: false,
      isSelected: false,
      value: '',
      important: false,
      overridden: false,
      winnerSelector: '',
    };
  }
  const isSelected = resolved.source === 'selected';
  // A wrapped value that Webflow cannot round-trip is moved to the selected embed
  // rule, while its native class can still read back as the inner Variable object.
  // Prefer that authored fallback so spacing shows/edits `calc(...)`, not the lossy
  // variable name. This remains scoped to the same selected selector.
  const editingSelector = resolved.contributors.find((contributor) => contributor.editing)?.selectorText;
  const wrappedFallback = resolved.contributors.find(
    (contributor) =>
      contributor.origin === 'embed' &&
      isWrappedValue(contributor.value) &&
      (contributor.isSelected || (!!editingSelector && selectorsMatch(contributor.selectorText, editingSelector))),
  );
  const source = wrappedFallback ?? (isSelected && resolved.selectedValue ? resolved.selectedValue : resolved.winner);
  return {
    present: true,
    isSelected,
    value: source.value,
    important: source.important,
    overridden: resolved.overridden,
    winnerSelector: resolved.winner.selectorText,
  };
}

export function isWrappedValue(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const raw = value.trim().replace(/\s*!important$/i, '');
  return /^(?!var\()[a-z-]+\(/i.test(raw);
}
