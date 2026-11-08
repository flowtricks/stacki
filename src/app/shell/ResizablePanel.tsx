import { useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import { usePointerDrag } from '../../ui/usePointerDrag';
import { setPanelDragPhase } from '../../ui/panelDragPhase';

// Desktop and Studio share this file through Studio's vendored source, so both
// editions resize their side panels with the same handle, limits and storage.
export type PanelKind = 'left' | 'code' | 'right';
export const PANEL_WIDTH_PX_MIN = { left: 260, code: 360, right: 322 } as const satisfies Record<PanelKind, number>;
export const PANEL_WIDTH_PX_MAX = 600;
const WIDTH_PX_STEP = 10;
// Panels and layout readers mounted at once: a few per edition, so more means a leak.
const WIDTH_LISTENERS_MAX = 64;

export type PanelWidths = Readonly<Record<PanelKind, number>>;

interface ResizablePanelProps {
  readonly kind: PanelKind;
  readonly children: ReactNode;
}

export interface PanelResize {
  readonly width: number;
  // The handle must be a direct child of the panel it resizes: a drag starts from the parent's measured width.
  readonly handle: ReactNode;
}

export function ResizablePanel({ kind, children }: ResizablePanelProps) {
  const { width, handle } = usePanelResize(kind);
  const side = panelSide(kind);
  return (
    <div className={`panel ${side}${kind === 'code' ? ' code-panel-shell' : ''}`} style={{ width }}>
      {children}
      {handle}
    </div>
  );
}

// The widths the user settled on, shared by every panel and by the editor's layout rule
// (editorLayout.ts), which needs them to know how much room the docked panels take.
// A drag in progress stays local to its handle until release, so the layout does not
// switch under the pointer mid-drag.
let committedWidths: PanelWidths | undefined;
const widthListeners = new Set<() => void>();

export function usePanelWidths(): PanelWidths {
  return useSyncExternalStore(subscribeWidths, currentWidths);
}

// Owns a panel's width: pointer drags, arrow keys, and the stored preference.
export function usePanelResize(kind: PanelKind): PanelResize {
  const widths = usePanelWidths();
  const [dragWidth, setDragWidth] = useState<number | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const startDrag = usePointerDrag();
  const width = dragWidth ?? widths[kind];
  const side = panelSide(kind);
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
    // The canvas holds its page width until release, so the page does not re-lay out each frame.
    setPanelDragPhase('dragging');
    startDrag(event, {
      cursor: 'col-resize',
      onMove: (move) => {
        nextWidth = dragPanelWidth(kind, startWidth, move.clientX - startX);
        setDragWidth(nextWidth);
      },
      onEnd: () => {
        setDragging(false);
        setPanelDragPhase('idle');
        commitWidth(kind, clampWidth(nextWidth, kind));
        setDragWidth(undefined);
      },
    });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = keyboardWidth(event, kind, width);
    if (next !== undefined) {
      event.preventDefault();
      commitWidth(kind, next);
    }
  };
  const handle = (
    <>
      <div
        className={`panel-resize${dragging ? ' on' : ''}`}
        role="separator"
        tabIndex={0}
        aria-label={`Resize ${side} panel`}
        aria-orientation="vertical"
        aria-valuemin={PANEL_WIDTH_PX_MIN[kind]}
        aria-valuemax={PANEL_WIDTH_PX_MAX}
        aria-valuenow={width}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        title="Drag to resize; use arrow keys when focused"
      />
      {/* Keep the drag in the editor when the pointer crosses a preview iframe. */}
      {dragging && <div className="panel-resize-cover" />}
    </>
  );
  return { width, handle };
}

// A right panel grows when the pointer moves left, so its delta is mirrored.
export function dragPanelWidth(kind: PanelKind, startWidth: number, deltaPx: number): number {
  assert(Number.isFinite(startWidth), 'Drag start width must be finite');
  assert(Number.isFinite(deltaPx), 'Drag delta must be finite');
  const direction = panelSide(kind) === 'right' ? -1 : 1;
  return clampWidth(startWidth + deltaPx * direction, kind);
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
  if (width < PANEL_WIDTH_PX_MIN[kind] || width > PANEL_WIDTH_PX_MAX) {
    return undefined;
  }
  return width;
}

function panelSide(kind: PanelKind): 'left' | 'right' {
  return kind === 'right' ? 'right' : 'left';
}

function clampWidth(width: number, kind: PanelKind): number {
  assert(Number.isFinite(width), 'Panel width must be finite');
  const next = Math.min(PANEL_WIDTH_PX_MAX, Math.max(PANEL_WIDTH_PX_MIN[kind], Math.round(width)));
  assert(Number.isSafeInteger(next), 'Panel width must be an integer');
  return next;
}

function keyboardWidth(event: KeyboardEvent<HTMLDivElement>, kind: PanelKind, width: number): number | undefined {
  switch (event.key) {
    case 'Home':
      return PANEL_WIDTH_PX_MIN[kind];
    case 'End':
      return PANEL_WIDTH_PX_MAX;
    case 'ArrowLeft':
    case 'ArrowRight': {
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      return dragPanelWidth(kind, width, direction * WIDTH_PX_STEP);
    }
    default:
      return undefined;
  }
}

// The settled widths, for a reader outside React, such as an opening layout.
export function currentWidths(): PanelWidths {
  committedWidths ??= { left: readWidth('left'), code: readWidth('code'), right: readWidth('right') };
  return committedWidths;
}

function subscribeWidths(changed: () => void): () => void {
  assert(widthListeners.size < WIDTH_LISTENERS_MAX, 'Panel width listeners exceed their limit');
  widthListeners.add(changed);
  return () => {
    widthListeners.delete(changed);
    if (widthListeners.size === 0) {
      // With no panel mounted, the next one reads storage afresh, as a new window would.
      committedWidths = undefined;
    }
  };
}

function commitWidth(kind: PanelKind, width: number): void {
  assert(width === clampWidth(width, kind), 'Committed panel width must be within bounds');
  committedWidths = { ...currentWidths(), [kind]: width };
  storeWidth(kind, width);
  assert(committedWidths[kind] === width, 'Committed panel width must be readable');
  for (const changed of widthListeners) {
    changed();
  }
}

function readWidth(kind: PanelKind): number {
  const fallback = kind === 'code' ? clampWidth(window.innerWidth * 0.34, kind) : PANEL_WIDTH_PX_MIN[kind];
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
