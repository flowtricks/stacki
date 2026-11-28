// Where a newly selected element's style edits start: on a selector (the editor's way, model/defaultSelector.ts),
// or on its Inline styles chip, its own `style` attribute.
//
// Always `selector` in the editor. Design mode (experimental, docs/design-mode/REMOVE.md) sets `inline` while it is
// on, so a style tried on one element changes that element only, and the person can still pick any selector from
// the well. It stays the default where the attribute takes no edit: the panel locks and says why (useInlineTarget.ts), so
// an edit never moves to a class by itself. Why a setting here rather than in Design mode: the style feature cannot import the app shell, and
// with nobody setting it this module changes nothing.
export type InlineDefault = 'selector' | 'inline';

let preferred: InlineDefault = 'selector';

export function inlineDefault(): InlineDefault {
  return preferred;
}

export function setInlineDefault(next: InlineDefault): void {
  preferred = next;
}
