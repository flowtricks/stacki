// Which recorded frames the person chose in the "Pick frames" sheet. Pure, so tests drive it directly.
// A click or Enter toggles one frame; a shift-click adds the range from the last frame toggled; "Pick evenly"
// replaces the choice with every Nth frame. The choice never holds more than `cap` frames (the attachment
// slots the draft has left): an action that would pass it keeps what fits, in frame order, and says so.
import { assert } from '../../../../shared/core/assert';
import { RECORDING_FRAMES_MAX } from '../../../../shared/ipc/aiChat';

export interface FrameSelection {
  /** Chosen frame indices, ascending, no repeats. */
  readonly chosen: readonly number[];
  /** The frame a shift-click extends from: the last one toggled. */
  readonly anchor: number | undefined;
}

export interface SelectionChange {
  readonly selection: FrameSelection;
  /** The action wanted more frames than the cap allows; the selection holds the first that fit. */
  readonly capped: boolean;
}

export const EMPTY_SELECTION: FrameSelection = { chosen: [], anchor: undefined };

/** Toggles one frame: chosen frames are unchosen, others are added while there is room. */
export function toggleFrame(selection: FrameSelection, index: number, cap: number): SelectionChange {
  checkIndex(index);
  checkCap(cap);
  if (selection.chosen.includes(index)) {
    return { selection: { chosen: selection.chosen.filter((other) => other !== index), anchor: index }, capped: false };
  }
  if (selection.chosen.length < cap) {
    return { selection: { chosen: sorted([...selection.chosen, index]), anchor: index }, capped: false };
  }
  return { selection: { ...selection, anchor: index }, capped: true };
}

/** Adds every frame from the anchor to `index` (either direction); without an anchor it toggles `index`. */
export function extendTo(selection: FrameSelection, index: number, cap: number): SelectionChange {
  checkIndex(index);
  checkCap(cap);
  const anchor = selection.anchor;
  if (anchor === undefined) {
    return toggleFrame(selection, index, cap);
  }
  // From the anchor towards the click, so at the cap the frames nearest the anchor are the ones kept.
  const direction = index >= anchor ? 1 : -1;
  const range = Array.from({ length: Math.abs(index - anchor) + 1 }, (_, offset) => anchor + offset * direction);
  return fill(selection.chosen, range, cap, index);
}

/** Every `step`th frame of `frameCount`, starting with the first, as far as the cap allows. */
export function everyNth(frameCount: number, step: number, cap: number): SelectionChange {
  assert(Number.isSafeInteger(frameCount), 'everyNth: a whole number of frames');
  assert(frameCount <= RECORDING_FRAMES_MAX, 'everyNth: within the recording bound');
  assert(Number.isSafeInteger(step), 'everyNth: a whole step');
  assert(step >= 1, 'everyNth: a step of at least one');
  checkCap(cap);
  const picks = Array.from({ length: Math.ceil(frameCount / step) }, (_, offset) => offset * step);
  return fill([], picks, cap, picks[0]);
}

// `base` plus `added`, in frame order, until the cap; `capped` when something did not fit.
function fill(base: readonly number[], added: readonly number[], cap: number, anchor: number | undefined): SelectionChange {
  const chosen = new Set(base);
  let capped = false;
  for (const index of added) {
    if (!chosen.has(index)) {
      if (chosen.size < cap) {
        chosen.add(index);
      } else {
        capped = true;
      }
    }
  }
  const result = sorted([...chosen]);
  assert(result.length <= Math.max(cap, base.length), 'fill: never past the cap');
  return { selection: { chosen: result, anchor }, capped };
}

function sorted(indices: readonly number[]): readonly number[] {
  return [...indices].sort((left, right) => left - right);
}

function checkIndex(index: number): void {
  assert(Number.isSafeInteger(index), 'frameSelection: a whole frame index');
  assert(index >= 0, 'frameSelection: an index from zero');
  assert(index < RECORDING_FRAMES_MAX, 'frameSelection: within the recording bound');
}

function checkCap(cap: number): void {
  assert(Number.isSafeInteger(cap), 'frameSelection: a whole cap');
  assert(cap >= 0, 'frameSelection: a cap of zero or more');
}
