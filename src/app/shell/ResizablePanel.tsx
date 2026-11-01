import { useState } from 'react';
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import { usePointerDrag } from '../../ui/usePointerDrag';

type PanelKind = 'left' | 'code' | 'right';
const WIDTH_PX_MIN = { left: 260, code: 360, right: 322 } as const;
const WIDTH_PX_MAX = 600;
const WIDTH_PX_STEP = 10;

interface ResizablePanelProps {
  readonly kind: PanelKind;
  readonly children: ReactNode;
}

export function ResizablePanel({ kind, children }: ResizablePanelProps) {
  const [widths, setWidths] = useState(() => ({
    left: readWidth('left'),
    code: readWidth('code'),
    right: readWidth('right'),
  }));
  const [dragging, setDragging] = useState(false);
  const startDrag = usePointerDrag();
  const width = widths[kind];
  const side = kind === 'right' ? 'right' : 'left';
  const changeWidth = (next: number): void => {
    setWidths((previous) => ({ ...previous, [kind]: next }));
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || event.isPrimary === false) {
      return;
    }
    event.preventDefault();
    const panel = event.currentTarget.parentElement;
    assert(panel instanceof HTMLElement, 'Resize handle must belong to a panel');
    const startWidth = panel.getBoundingClientRect().width;
    const startX = event.clientX;
    let nextWidth = startWidth;
    setDragging(true);
    startDrag(event, {
      cursor: 'col-resize',
      onMove: (move) => {
        const delta = (move.clientX - startX) * (side === 'right' ? -1 : 1);
        nextWidth = clampWidth(startWidth + delta, kind);
        changeWidth(nextWidth);
      },
      onEnd: () => {
        setDragging(false);
        storeWidth(kind, clampWidth(nextWidth, kind));
      },
    });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = keyboardWidth(event, kind, width);
    if (next !== undefined) {
      event.preventDefault();
      changeWidth(next);
      storeWidth(kind, next);
    }
  };
  return (
    <div className={`panel ${side}${kind === 'code' ? ' code-panel-shell' : ''}`} style={{ width }}>
      {children}
      <div
        className={`panel-resize${dragging ? ' on' : ''}`}
        role="separator"
        tabIndex={0}
        aria-label={`Resize ${side} panel`}
        aria-orientation="vertical"
        aria-valuemin={WIDTH_PX_MIN[kind]}
        aria-valuemax={WIDTH_PX_MAX}
        aria-valuenow={width}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        title="Drag to resize; use arrow keys when focused"
      />
      {/* Keep the drag in the editor when the pointer crosses a preview iframe. */}
      {dragging && <div className="panel-resize-cover" />}
    </div>
  );
}

export function parsePanelWidth(input: unknown, kind: PanelKind): number | undefined {
  if (typeof input !== 'string') {
    return undefined;
  }
  if (input.length === 0 || input.length > 3) {
    return undefined;
  }
  const width = Number(input);
  if (!Number.isSafeInteger(width)) {
    return undefined;
  }
  if (width < WIDTH_PX_MIN[kind] || width > WIDTH_PX_MAX) {
    return undefined;
  }
  return width;
}

function clampWidth(width: number, kind: PanelKind): number {
  assert(Number.isFinite(width), 'Panel width must be finite');
  const next = Math.min(WIDTH_PX_MAX, Math.max(WIDTH_PX_MIN[kind], Math.round(width)));
  assert(Number.isSafeInteger(next), 'Panel width must be an integer');
  return next;
}

function keyboardWidth(event: KeyboardEvent<HTMLDivElement>, kind: PanelKind, width: number): number | undefined {
  switch (event.key) {
    case 'Home':
      return WIDTH_PX_MIN[kind];
    case 'End':
      return WIDTH_PX_MAX;
    case 'ArrowLeft':
    case 'ArrowRight': {
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      return clampWidth(width + direction * (kind === 'right' ? -1 : 1) * WIDTH_PX_STEP, kind);
    }
    default:
      return undefined;
  }
}

function readWidth(kind: PanelKind): number {
  const fallback = kind === 'code' ? clampWidth(window.innerWidth * 0.34, kind) : WIDTH_PX_MIN[kind];
  try {
    return parsePanelWidth(localStorage.getItem(`stacki.panel.width.${kind}`), kind) ?? fallback;
  } catch {
    // Storage can be unavailable; resizing must still work for this session.
    return fallback;
  }
}

function storeWidth(kind: PanelKind, width: number): void {
  assert(width === clampWidth(width, kind), 'Stored panel width must be within bounds');
  try {
    localStorage.setItem(`stacki.panel.width.${kind}`, String(width));
  } catch {
    // Storage failures must not interrupt an editor gesture.
  }
}
