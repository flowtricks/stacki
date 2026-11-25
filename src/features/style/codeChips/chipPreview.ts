// The canvas hover preview of a code window's chips: a variable (or keyword) hovered or arrowed in a
// chip's chooser shows on the canvas at once, and goes back when the pointer leaves, the chooser closes
// or Escape is pressed. Only a pick is written, and that is the chip's own range in the editor
// (writeChipValue); the preview never touches the editor's text, the file, history or the save.
//
// Why a chip needs this: the Style panel's pickers reach the canvas through PreviewPropContext
// (connectFieldHelpers.ts), which only the panel's cards provide. A chip chooser opens in the code
// window, where nothing provides it, so a hover reached no canvas at all (the chooser passed no
// `onPreview` either). Inside a card the card's own writer is kept (it knows the panel's state and
// selector); anywhere else the preview is the selected element's own style (SELECTED_ELEMENT_PREVIEW).
//
// The preview is the whole declaration with the hovered value in the chip's place, for the
// declaration's property: `transform: translate3d(0, var(--site-margin), 0rem)` shows that transform.
// A value the property does not take is not sent (canvasPreview.ts); a custom property's value has no
// property to show it under, so it is not previewed.
//
// Lifecycle, as the panel's VariableConnect has it: a preview carries the epoch it was asked in, a
// restore bumps the epoch, so a preview scheduled before it is dropped when it lands; the restore is
// idempotent and runs on every way out (useExitRestore) and on unmount. A pick hands the preview over
// to its save (hoverStyle.settle) so the canvas never flashes the old value. A writer that throws is
// reported once as a toast (never a paragraph in the UI), previews stop for the session, and the
// restore is still attempted.

import { useContext, useEffect, useRef } from 'react';
import { previewNowhere, PreviewPropContext, type PreviewProp } from '../connectFieldHelpers';
import { canvasPreviewProp, SELECTED_ELEMENT_PREVIEW } from '../embed/canvasPreview';
import { writtenValue } from '../model/lengthUnit';
import { hoverStyle } from '../model/liveRuleEdits';
import { useExitRestore } from '../pickerExit';
import type { PreviewEndTiming } from '../VariablePicker';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { reportErrorToast } from '../../../ui/errorNotices';
import { assert } from '../../../../shared/core/assert';

/** What a chooser needs to preview: the handlers VariablePicker takes, and the hand-over of a pick. */
export interface ChipPreview {
  readonly onPreview: (value: string, epoch: number) => void;
  readonly previewEpoch: () => number;
  readonly onPreviewEnd: (timing: PreviewEndTiming) => void;
  /** A pick: the preview is now the save's to settle, and no stale one may land after it. */
  readonly handOver: (value: string) => void;
  /** Takes the preview back now (the chooser's own exits that no listener sees). Idempotent. */
  readonly restore: () => void;
}

/**
 * How a preview ends outside the chooser's own handlers: `window` listens for a press anywhere outside
 * a variable picker, Escape, Tab, blur, scroll, resize and a selection change (pickerExit.ts); `leave`
 * leaves the press alone, for a list whose own pointer-leave and blur end the preview and whose press
 * is a pick.
 */
export type ChipPreviewExits = 'window' | 'leave';

/** The preview a code window's chips use when no Style card provides one. */
export const CANVAS_WRITER: PreviewProp = canvasPreviewProp(SELECTED_ELEMENT_PREVIEW);

/**
 * The preview of a chooser for `property`: `valueWith(value)` is the declaration's whole value with
 * `value` in the chip's place, or undefined when there is none to show. A chooser with no `property`
 * previews nothing.
 */
export function useChipPreview(
  target: { readonly property: string | undefined; readonly valueWith: (value: string) => string | undefined },
  options: { readonly exits: ChipPreviewExits },
): ChipPreview {
  const translate = useTranslate();
  const outer = useContext(PreviewPropContext);
  const write = outer === previewNowhere ? CANVAS_WRITER : outer;
  const latest = useRef({ write, target, translate });
  latest.current = { write, target, translate };
  const epochRef = useRef(0);
  // The property whose preview is up, or undefined when none is.
  const shownRef = useRef<string | undefined>(undefined);
  const failedRef = useRef(false);

  const attempt = (action: () => void): void => {
    try {
      action();
    } catch (error: unknown) {
      console.error('[code chips] the canvas preview failed', error);
      if (!failedRef.current) {
        failedRef.current = true;
        reportErrorToast(latest.current.translate('style.variablePicker.previewFailed'));
      }
    }
  };
  const restore = (): void => {
    epochRef.current += 1;
    const shown = shownRef.current;
    if (shown === undefined) {
      return;
    }
    shownRef.current = undefined;
    attempt(() => latest.current.write(shown, undefined, false));
    assert(shownRef.current === undefined, 'useChipPreview: a restore leaves no preview marked as up');
  };
  const restoreRef = useRef(restore);
  restoreRef.current = restore;
  const onPreview = (value: string, epoch: number): void => {
    const { property, valueWith } = latest.current.target;
    if (property === undefined) {
      return;
    }
    // Asked before a restore: stale, never applied.
    if (epoch !== epochRef.current) {
      return;
    }
    // A writer that threw is not asked again this session: one toast, not one per hovered row.
    if (failedRef.current) {
      return;
    }
    const text = valueWith(value);
    if (text === undefined) {
      return;
    }
    // Marked before the write, so a write that throws half-way is still taken back.
    shownRef.current = property;
    attempt(() => latest.current.write(property, text, false));
  };
  const handOver = (value: string): void => {
    epochRef.current += 1;
    const { property, valueWith } = latest.current.target;
    const shown = shownRef.current;
    shownRef.current = undefined;
    if (property === undefined || shown === undefined) {
      return;
    }
    const text = valueWith(value);
    if (text === undefined) {
      attempt(() => latest.current.write(shown, undefined, false));
      return;
    }
    attempt(() => hoverStyle.settle(property, writtenValue(property, text)));
  };
  // Unmounting with a preview still up (the code window closed, the selection changed) puts the element's own style back.
  useEffect(() => () => restoreRef.current(), []);
  useExitRestore({ active: options.exits === 'window', restore: () => restoreRef.current() });
  return {
    onPreview,
    previewEpoch: () => epochRef.current,
    onPreviewEnd: () => restoreRef.current(),
    handOver,
    restore: () => restoreRef.current(),
  };
}

/** The declaration value `chip` sits in with `value` in its place: `before`, the value, `after`. */
export function valueAround(
  chip: { readonly from: number; readonly to: number; readonly declaration: { readonly from: number; readonly to: number } },
  value: string,
  slice: (from: number, to: number) => string,
): string | undefined {
  assert(chip.declaration.from <= chip.from, 'valueAround: the reference sits in its declaration');
  assert(chip.to <= chip.declaration.to, 'valueAround: the reference ends in its declaration');
  const text = `${slice(chip.declaration.from, chip.from)}${value}${slice(chip.to, chip.declaration.to)}`.trim();
  return text.length === 0 ? undefined : text;
}
