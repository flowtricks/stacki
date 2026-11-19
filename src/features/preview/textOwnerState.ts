// The one state machine for a closed component that renders text (the owner) and the text inside it (docs/canvas-closed-component-text.md).
// Every closed component, whatever its text comes from (a prop, children the page writes, a fragment of HTML), is drawn through this
// function and nothing else: the frame reports the hovered and picked words with the page path of the instance that owns them
// (`scope`), and the owner's outline takes the state below.
//
//   state       when                                                   owner outline
//   none        no words of this instance hovered or picked            its ordinary outline
//   field       the pointer is on its words, none of them picked       faint thick outline, no name tag
//   resting     some of its words are picked, whatever the pointer is on  faint thick outline and a light name tag
//   body-hover  its words are picked, the pointer is on its own body   the plain solid green hover and its tag
//
// An instance that is the selection keeps its selected outline in every state; only the thickness, colour strength and the tag change.
import type { TextMarks } from './previewMessages';

export type OwnerState = 'none' | 'field' | 'resting' | 'body-hover';

interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface OwnerOutline {
  readonly path: string;
  readonly slot: 'hover' | 'sel' | 'highlight';
  /** Whether the pointer is on the instance itself (the app's hover path names it). */
  readonly pointedAt: boolean;
}

export function ownerState(marks: TextMarks | undefined, outline: OwnerOutline): OwnerState {
  if (outline.slot === 'highlight' || marks === undefined) {
    return 'none';
  }
  const { hover, picked } = marks;
  if (hover?.scope === outline.path) {
    // The pointer on words of the owner: the field, unless some words of it are already picked (the same or another text), when it rests with its tag.
    return picked?.scope === outline.path ? 'resting' : 'field';
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
  // Words picked make the selected instance their parent. Words under the pointer that name no instance (an older frame) tint it.
  const picked = marks?.picked;
  const hover = marks?.hover;
  const legacyTint = hover !== undefined && hover.scope === undefined && !sameBox(hover, picked);
  return `${own}${picked ? ' parent' : ''}${state === 'body-hover' || legacyTint ? ' tinted' : ''}`;
}

function sameBox(left: Box, right: Box | undefined): boolean {
  return right !== undefined && left.x === right.x && left.y === right.y && left.w === right.w && left.h === right.h;
}
