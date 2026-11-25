// What a closed component lets a person change on one instance without opening it. A closed component is an instance on
// the canvas whose template is not edited in place; the only things of its insides that belong to this instance are the
// values the page hands it: its props and its slot. Words or a picture the component writes itself (hardcoded, or
// computed from its own code) are the same for every instance, so the canvas offers nothing for them: no hover outline,
// no label, no double click, no popover explaining why. The hover outline, the text editor and the image popup all ask
// this one module, so the three cannot drift apart.
//
// The decision is made from data the canvas already holds (the text catalog, the image trace), never fetched while the
// pointer moves: until that data has arrived the answer is `pending`, which offers nothing, so an affordance never shows
// and then disappears.

/** How a part of a closed component reaches the instance that renders it. */
export const CLOSED_COMPONENT_REACHES = ['pending', 'prop', 'slot', 'internal'] as const;
export type ClosedComponentReach = (typeof CLOSED_COMPONENT_REACHES)[number];

/**
 * Whether a part of a closed component can be changed on this instance: only when a prop or the slot of this instance
 * decides it. `pending` (the catalog or scan has not arrived) and `internal` (hardcoded or computed in the component)
 * offer nothing.
 */
export function isEditableThroughProps(reach: ClosedComponentReach): boolean {
  switch (reach) {
    case 'prop':
    case 'slot':
      return true;
    case 'pending':
    case 'internal':
      return false;
    default: {
      const exhaustive: never = reach;
      return exhaustive;
    }
  }
}

/**
 * How words inside a closed component reach its instance. `loaded` is whether the text catalog has arrived; `covering`
 * is the catalog's entry for the words (a target's `from`, or `prop` for prop text the catalog names as blocked), or
 * undefined when no entry covers them: the component writes them itself.
 */
export function textReach(words: { readonly loaded: boolean; readonly covering: { readonly from?: 'slot' | 'prop' } | undefined }): ClosedComponentReach {
  const { loaded, covering } = words;
  if (!loaded) {
    return 'pending';
  }
  if (covering === undefined) {
    return 'internal';
  }
  switch (covering.from) {
    case 'prop':
      return 'prop';
    case 'slot':
      return 'slot';
    case undefined:
      // An entry with no `from` is the open file's own words, never a closed component's: nothing of this instance decides it.
      return 'internal';
    default: {
      const exhaustive: never = covering.from;
      return exhaustive;
    }
  }
}
