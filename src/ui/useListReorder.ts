import { useCallback, useEffect, useRef, useState } from 'react';
import type { HTMLAttributes, MutableRefObject, RefCallback } from 'react';
import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';

interface ReorderOptions {
  readonly count: number;
  readonly onMove: (source: number, target: number) => void;
  readonly disabled?: boolean;
}
interface ReorderState {
  readonly rows: MutableRefObject<(HTMLElement | undefined)[]>;
  readonly start: MutableRefObject<{ readonly index: number; readonly y: number } | undefined>;
  readonly from: number | undefined;
  readonly to: number | undefined;
  readonly setFrom: (value: number | undefined) => void;
  readonly setTo: (value: number | undefined) => void;
  readonly indexAt: (clientY: number) => number;
  readonly arm: (index: number, y: number) => void;
  readonly finish: () => void;
}
type RowProps = HTMLAttributes<HTMLElement> & { readonly ref: RefCallback<HTMLElement> };

// The renderer owns one gesture and at most one element slot per bounded row.
// Drop indices are measured before removal, preserving the editor's splice API.
export default function useListReorder({ count, onMove, disabled = false }: ReorderOptions) {
  assert(Number.isSafeInteger(count), 'Reorder count must be a safe integer');
  assert(count >= 0, 'Reorder count must be nonnegative');
  assert(count <= LIMITS.scanEntriesMax, 'Reorder count exceeds bounds');
  const [from, setFrom] = useState<number | undefined>(undefined);
  const [to, setTo] = useState<number | undefined>(undefined);
  const rows = useRef<(HTMLElement | undefined)[]>([]);
  const start = useRef<{ readonly index: number; readonly y: number } | undefined>(undefined);
  const finish = useCallback(() => {
    start.current = undefined;
    setFrom(undefined);
    setTo(undefined);
  }, []);
  const indexAt = useCallback(
    (clientY: number): number => {
      for (let index = 0; index < count; index++) {
        const element = rows.current[index];
        if (!element) {
          continue;
        }
        const rectangle = element.getBoundingClientRect();
        if (clientY < rectangle.top + rectangle.height / 2) {
          return index;
        }
      }
      return count;
    },
    [count],
  );
  // A press arms the gesture; the drag starts once the pointer has moved far enough.
  const arm = useCallback((index: number, y: number) => {
    start.current = { index, y };
    setTo(index);
  }, []);
  const state = { rows, start, from, to, setFrom, setTo, indexAt, arm, finish };
  useReorderEvents(state, onMove);
  useReorderCursor(from);
  useEffect(() => {
    rows.current.length = Math.min(rows.current.length, count + 1);
  }, [count]);
  return {
    dragIndex: from,
    dropIndex: to,
    rowProps: (index: number) => reorderRowProps(index, state, { disabled }),
    slotProps: (index: number) => ({ ref: reorderRowRef(rows, index) }),
    rowClass: (index: number) => reorderRowClass(index, { from, to, count }),
  };
}

function useReorderEvents(state: ReorderState, onMove: ReorderOptions['onMove']): void {
  const { start, from, to, setFrom, setTo, indexAt, finish } = state;
  useEffect(() => {
    if (start.current === undefined && from === undefined) {
      return undefined;
    }
    const move = (event: PointerEvent): void => {
      if (from === undefined) {
        if (!start.current || Math.abs(event.clientY - start.current.y) < 4) {
          return;
        }
        setFrom(start.current.index);
      }
      event.preventDefault();
      setTo(indexAt(event.clientY));
    };
    const up = (event: PointerEvent): void => {
      const target = from === undefined ? undefined : indexAt(event.clientY);
      finish();
      if (from !== undefined && target !== undefined) {
        onMove(from, target);
      }
    };
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        finish();
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('keydown', key);
    };
    // Arming a click changes `to`, so stable onMove callbacks still install
    // listeners before the first move crosses the drag threshold.
  }, [start, from, to, setFrom, setTo, indexAt, onMove, finish]);
}

function useReorderCursor(from: number | undefined): void {
  useEffect(() => {
    if (from === undefined) {
      return undefined;
    }
    const previous = document.body.style.cursor;
    document.body.style.cursor = 'grabbing';
    return () => {
      document.body.style.cursor = previous;
    };
  }, [from]);
}

function reorderRowRef(rowsRef: ReorderState['rows'], index: number): RefCallback<HTMLElement> {
  assert(Number.isSafeInteger(index), 'Reorder index must be a safe integer');
  assert(index >= 0, 'Reorder index must be nonnegative');
  assert(index <= LIMITS.scanEntriesMax, 'Reorder index exceeds bounds');
  return (element) => {
    rowsRef.current[index] = element ?? undefined;
  };
}

function reorderRowProps(index: number, state: ReorderState, options: { readonly disabled: boolean }): RowProps {
  return {
    ref: reorderRowRef(state.rows, index),
    onPointerDown: (event) => {
      if (options.disabled || event.button !== 0) {
        return;
      }
      const control = event.target instanceof Element ? event.target.closest('button, input, textarea, select, a') : undefined;
      if (control && !control.hasAttribute('data-drag-through')) {
        return;
      }
      state.arm(index, event.clientY);
    },
    onClickCapture: (event) => {
      if (state.from !== undefined) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
  };
}

function reorderRowClass(
  index: number,
  state: {
    readonly from: number | undefined;
    readonly to: number | undefined;
    readonly count: number;
  },
): string {
  if (state.from === undefined || state.to === undefined) {
    return '';
  }
  const marks: string[] = [];
  if (state.to === index) {
    marks.push('drop-before');
  }
  if (state.to === state.count && index === state.count - 1) {
    marks.push('drop-after');
  }
  if (state.from === index) {
    marks.push('is-dragging');
  }
  return marks.join(' ');
}
