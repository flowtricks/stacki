import type { ReactNode } from 'react';
import { CodeInline } from '../../ui/CodeBlock';
import { confirmDialog } from '../../ui/ConfirmDialog';
import type { Translator } from '../../lib/i18n/localeContext';
import { parseTrackList } from './model/gridTemplate';
import { repeatTracks } from './gridTracks';

// Turning a track list that is not N equal tracks (see classifyTrackCount) into a
// count. It is only ever asked for by choosing "Count" in the axis's mode control
// (GridAxisMode), never automatic, and it asks first: the question shows the value
// being replaced. The write that follows is the stepper's own, so it is undoable.

/** The value as the count it becomes: one track per track it has, at least one. */
export function trackCountOf(value: string): number {
  return Math.max(1, parseTrackList(value).length);
}

/** Ask whether to replace `value` with a count; true only when the question is confirmed. */
export async function confirmSwitchToCount({ value, translate }: { readonly value: string; readonly translate: Translator }): Promise<boolean> {
  const body: ReactNode = (
    <>
      <p>{translate('style.gridControls.switchToCountBody', { count: trackCountOf(value) })}</p>
      <CodeInline text={value} language="css" />
    </>
  );
  const answer = await confirmDialog({
    title: translate('style.gridControls.switchToCountTitle'),
    body,
    confirmLabel: translate('style.gridControls.switchToCount'),
  });
  return answer === true;
}

/** What a confirmed switch writes: `repeat(N, cell)`. */
export function countValue({ value, cell }: { readonly value: string; readonly cell: string }): string {
  return repeatTracks(trackCountOf(value), cell);
}
