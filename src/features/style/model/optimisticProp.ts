// What a property reads as between an edit and the model that holds it.
//
// A committed or cleared value is written to its file, and the panel's model is rebuilt from the
// edited stylesheet before any field hears about it. The field read that model, so it went on
// showing the value from before the edit for as long as the save and the rebuild took (measured
// in the real app: 2 to 6 painted frames after Enter on a 3,000-rule stylesheet, and a clear
// showed the empty `currentColor` placeholder for 100 ms before the value under it came back).
//
// These two functions say what the model will say, from the model already loaded: a commit puts
// the value on the picked selector's declaration, and a clear takes the picked selector's
// declarations away so the next one in the cascade shows (the variable chip a heading inherits
// from `.heading`, say). Each costs time in the property's own contributors, never in the
// project's rules. The rebuilt model replaces the guess when the save settles
// (embed/useOptimisticEdits.ts), so a guess that ranks a selector differently from the cascade is
// corrected one save later, never kept.

import { assert } from '../../../../shared/core/assert';
import type { Contributor, ResolvedProp } from './resolved';

/** `resolved` with `value` set on the picked selector, which shows it. */
export function withCommitted(
  resolved: ResolvedProp | undefined,
  edit: { readonly prop: string; readonly value: string; readonly important: boolean; readonly selector: string },
): ResolvedProp {
  assert(edit.prop.length > 0, 'withCommitted: a property is named');
  assert(resolved === undefined || resolved.prop === edit.prop, 'withCommitted: the model is for the edited property');
  // The declaration being edited, else any of the pick's own (the model names one as edited when it can).
  const own = resolved?.contributors.find((contributor) => contributor.editing === true) ?? resolved?.contributors.find(isPicked);
  if (resolved === undefined || own === undefined) {
    // The picked selector does not set it yet: its new declaration is drawn as the one in use,
    // the usual outcome of styling the selector you picked. The model says otherwise if it loses.
    const added: Contributor = {
      selectorText: edit.selector,
      value: edit.value,
      important: edit.important,
      specificity: [0, 0, 0],
      order: Number.MAX_SAFE_INTEGER,
      ruleId: '',
      origin: resolved?.selectedOrigin ?? 'embed',
      isSelected: true,
      editing: true,
      winning: true,
      complexOnly: false,
    };
    const others = (resolved?.contributors ?? []).map((contributor) => ({ ...contributor, winning: false }));
    return {
      prop: edit.prop,
      source: 'selected',
      selectedOrigin: added.origin,
      selectedValue: { value: edit.value, important: edit.important },
      winner: added,
      overridden: false,
      contributors: [added, ...others],
    };
  }
  const updated: Contributor = { ...own, value: edit.value, important: edit.important };
  const contributors = resolved.contributors.map((contributor) => (contributor === own ? updated : contributor));
  const winner = resolved.winner === own ? updated : resolved.winner;
  assert(contributors.length === resolved.contributors.length, 'withCommitted: an update keeps every contributor');
  return { ...resolved, source: 'selected', selectedOrigin: own.origin, selectedValue: { value: edit.value, important: edit.important }, winner, contributors };
}

/**
 * `resolved` without the picked selector's declarations: the next contributor in the cascade
 * shows (the list is already in cascade order), or nothing when there is none.
 */
export function withCleared(resolved: ResolvedProp | undefined): ResolvedProp | undefined {
  if (resolved === undefined) {
    return undefined;
  }
  const remaining = resolved.contributors.filter((contributor) => !isPicked(contributor));
  assert(remaining.length <= resolved.contributors.length, 'withCleared: a clear only removes');
  const next = remaining[0];
  if (next === undefined) {
    return undefined;
  }
  const winner: Contributor = { ...next, winning: true };
  const contributors = [winner, ...remaining.slice(1).map((contributor) => ({ ...contributor, winning: false }))];
  return { prop: resolved.prop, source: 'other', winner, overridden: false, contributors };
}

// The picked selector's own declaration: the one being edited, and every embed or inline rule of
// the pick (a clear removes the property from each of them, not only from the one that shows).
function isPicked(contributor: Contributor): boolean {
  if (contributor.editing === true) {
    return true;
  }
  return contributor.isSelected;
}
