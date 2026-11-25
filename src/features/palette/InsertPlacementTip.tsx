// The reason the highlighted item cannot go where the page's selection points, as a tooltip on that row instead of a note under the
// list. Why: the note followed the keyboard highlight and appeared and vanished below the list, shifting the palette's height
// with every arrow press; a tip anchored on the row takes no room and sits where the eyes already are.
// How: the highlight (pointer or keyboard, one state) names the row; the tip measures the row in a layout effect, so it never paints
// unplaced, and again when the list scrolls (a row arrowed into view moves it). The row points at the reason with aria-describedby,
// so a screen reader reads it with the row; the reason text lives in a hidden element that is always present while the row is highlighted.
import { useLayoutEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { tooltipAnchor, tooltipHost, type TooltipAnchor } from '../../ui/delayedTooltip';
import FittedTooltip from '../../ui/FittedTooltip';
import '../../ui/infoHint.css';

/** The id the highlighted, refused row names in aria-describedby. */
export const PLACEMENT_REASON_ID = 'insert-placement-reason';

interface InsertPlacementTipProps {
  /** The reason, already translated; undefined when the highlighted row can be inserted. */
  readonly reason: string | undefined;
  readonly listRef: RefObject<HTMLElement>;
  /** The highlighted index: a change means the row to name changed. */
  readonly highlight: number;
}

export function InsertPlacementTip({ reason, listRef, highlight }: InsertPlacementTipProps) {
  const [anchor, setAnchor] = useState<TooltipAnchor | undefined>(undefined);
  // Found in the layout effect, never while rendering: a render has no document on the server (and in the picker tests).
  const [host, setHost] = useState<HTMLElement | undefined>(undefined);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (reason === undefined || list === null) {
      setAnchor(undefined);
      return undefined;
    }
    const measure = () => {
      const row = list.querySelector<HTMLElement>('[data-refused] .insert-item.highlight');
      if (row === null) {
        setAnchor(undefined);
        return;
      }
      const rowBox = row.getBoundingClientRect();
      const listBox = list.getBoundingClientRect();
      // A row scrolled out of the list has nothing to name.
      if (rowBox.bottom < listBox.top || rowBox.top > listBox.bottom) {
        setAnchor(undefined);
        return;
      }
      setHost(tooltipHost(row));
      setAnchor(tooltipAnchor(rowBox));
    };
    measure();
    list.addEventListener('scroll', measure);
    return () => list.removeEventListener('scroll', measure);
  }, [reason, listRef, highlight]);
  if (reason === undefined) {
    return undefined;
  }
  return (
    <>
      <span id={PLACEMENT_REASON_ID} className="info-hint-text">
        {reason}
      </span>
      {anchor !== undefined &&
        host !== undefined &&
        createPortal(
          <FittedTooltip className="settings-info-tip" role="tooltip" hidden anchor={anchor}>
            {reason}
          </FittedTooltip>,
          host,
        )}
    </>
  );
}
