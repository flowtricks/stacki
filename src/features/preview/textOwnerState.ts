// The one state machine for a closed component that renders text (the owner) and the text inside it (docs/canvas-closed-component-text.md).
// Every closed component, whatever its text comes from (a prop, children the page writes, a fragment of HTML), is drawn through this
// function and nothing else: the frame reports the hovered and picked words with the page path of the instance that owns them
// (`scope`), and the owner's outline takes the state below.
//
//   state       when                                                   owner outline
//   none        no words of this instance hovered or picked            its ordinary outline
//   field       the pointer is on its words, none picked, owner unselected  faint thick outline, no name tag
//   selected    the same, the owner being the selection                its selected outline and tag, unchanged, no fill
//   resting     some of its words are picked, whatever the pointer is on  faint thick outline and a light name tag
//   body-hover  its words are picked, the pointer is on its own body   the plain solid green hover and its tag
//
// An instance that is the selection keeps its selected outline in every state; only the thickness, colour strength and the tag change.
import { assert } from '../../../shared/core/assert';
import type { TextMarks } from './previewMessages';

export type OwnerState = 'none' | 'field' | 'selected' | 'resting' | 'body-hover';

export interface OwnerOutline {
  /** Whether the outline is of a component instance that can own words: never a layout or page host, never a plain element. */
  readonly ownable: boolean;
  readonly path: string;
  readonly slot: 'hover' | 'sel' | 'highlight';
  /** Whether the pointer is on the instance itself (the app's hover path names it). */
  readonly pointedAt: boolean;
}

export function ownerState(marks: TextMarks | undefined, outline: OwnerOutline): OwnerState {
  // By construction the state belongs to the one resolved owner: words that name no owner, or an outline that is a layout or a
  // host, take none of it (never a fallback to the page or to everything).
  if (outline.slot === 'highlight' || marks === undefined || !outline.ownable) {
    return 'none';
  }
  assert(
    new Set([marks.hover?.scope, marks.picked?.scope].filter((scope) => scope !== undefined)).size <= 2,
    'Words hovered and picked name at most two owners',
  );
  const { hover, picked } = marks;
  if (hover?.scope === outline.path) {
    // The pointer on words of the owner: the field, unless some words of it are already picked (the same or another text), when it rests with its tag.
    if (picked?.scope === outline.path) {
      return 'resting';
    }
    // The owner is the selection: its selected outline and tag stay exactly as they are, with no fill; the words carry the hover.
    return outline.slot === 'sel' ? 'selected' : 'field';
  }
  if (picked?.scope === outline.path) {
    return outline.pointedAt && hover === undefined ? 'body-hover' : 'resting';
  }
  return 'none';
}

/** The classes an outline takes for its owner state, and for the selected instance's parent look while words are picked. */
export function ownerClasses(marks: TextMarks | undefined, outline: OwnerOutline): string {
  const state = ownerState(marks, outline);
  const own = state === 'field' ? ' text-owner' : state === 'resting' ? ' text-owner owner-tag' : '';
  if (outline.slot !== 'sel') {
    return own;
  }
  // Words picked make the selected instance their parent; the tint is only ever the body hover of the words' own owner.
  return `${own}${state !== 'none' && marks?.picked?.scope === outline.path ? ' parent' : ''}${state === 'body-hover' ? ' tinted' : ''}`;
}
