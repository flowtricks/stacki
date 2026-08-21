import { useCallback, useEffect, useRef, useState } from 'react';

// Drag-to-reorder for a vertical list, driven by pointer events rather than
// HTML5 drag-and-drop.
//
// The CMS lists used the native API and never picked the gesture up here; the
// pointer version has no drag image, no dataTransfer, and no dependence on
// what the browser thinks is a drag source, so it behaves the same everywhere
// in the app. It also keeps working while the row is re-rendered mid-gesture
// (the whole list re-renders as the insertion point moves).
//
//   const reorder = useListReorder({ count: items.length, onMove });
//   <div {...reorder.rowProps(i)} className={`row ${reorder.rowClass(i)}`}>
//
// `onMove(from, to)` gets the index the row came from and the index to splice
// it in at BEFORE removal — the same contract the old drop handlers used.
export default function useListReorder({ count, onMove, disabled = false }) {
  const [from, setFrom] = useState(null); // row being dragged
  const [to, setTo] = useState(null); // insertion point
  const rows = useRef([]);
  const start = useRef(null); // {index, y} while the gesture is still a click

  const finish = useCallback(() => {
    start.current = null;
    setFrom(null);
    setTo(null);
  }, []);

  // Where the pointer sits, as an insertion index: the first row whose middle
  // it hasn't passed, or the end of the list.
  const indexAt = useCallback((clientY) => {
    const boxes = rows.current;
    for (let i = 0; i < count; i++) {
      const el = boxes[i];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return count;
  }, [count]);

  useEffect(() => {
    if (start.current === null && from === null) return undefined;
    const onMoveEvent = (e) => {
      // A few pixels of slop first, so clicking a row still selects it.
      if (from === null) {
        if (!start.current || Math.abs(e.clientY - start.current.y) < 4) return;
        setFrom(start.current.index);
      }
      e.preventDefault();
      setTo(indexAt(e.clientY));
    };
    const onUp = (e) => {
      const src = from ?? null;
      const dest = src === null ? null : indexAt(e.clientY);
      finish();
      if (src !== null && dest !== null) onMove(src, dest);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') finish();
    };
    window.addEventListener('pointermove', onMoveEvent);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', onMoveEvent);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('keydown', onKey);
    };
  }, [from, indexAt, onMove, finish]);

  // While a row is being dragged the cursor should say so everywhere, not just
  // over the list.
  useEffect(() => {
    if (from === null) return undefined;
    const prev = document.body.style.cursor;
    document.body.style.cursor = 'grabbing';
    return () => {
      document.body.style.cursor = prev;
    };
  }, [from]);

  const rowProps = (index) => ({
    ref: (el) => {
      rows.current[index] = el;
    },
    onPointerDown: (e) => {
      if (disabled || e.button !== 0) return;
      // Buttons and fields inside the row keep their own behaviour — unless they
      // say otherwise. A control marked `data-drag-through` is one that is also
      // the natural place to grab the row: the variable sheet's names are
      // buttons (a click opens a rename field) and they are the whole width of
      // the row, so a drag that refused to start on them was a drag that
      // refused to start. Nothing is taken away from the control: the gesture
      // only becomes a drag once the pointer moves, and a click that followed a
      // drag is swallowed below.
      const control = e.target instanceof Element ? e.target.closest('button, input, textarea, select, a') : null;
      if (control && !control.hasAttribute('data-drag-through')) return;
      start.current = { index, y: e.clientY };
      setTo(index);
    },
    // A click that turned into a drag must not also select the row.
    onClickCapture: (e) => {
      if (from !== null) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
  });

  // A slot that is measured but not dragged: the "add" line at the end of a
  // group, which is where a row is dropped to land in that group when the group
  // has no rows of its own to aim at.
  const slotProps = (index) => ({
    ref: (el) => {
      rows.current[index] = el;
    },
  });

  // The insertion line, drawn on the row the item would land above — or below
  // the last row when it goes to the end.
  const rowClass = (index) => {
    if (from === null || to === null) return '';
    const marks = [];
    if (to === index) marks.push('drop-before');
    if (to === count && index === count - 1) marks.push('drop-after');
    if (from === index) marks.push('is-dragging');
    return marks.join(' ');
  };

  return { dragIndex: from, dropIndex: to, rowProps, slotProps, rowClass };
}
