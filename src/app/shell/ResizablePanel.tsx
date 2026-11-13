import { useTranslate } from '../../lib/i18n/useTranslate';
import { useSyncExternalStore } from 'react';
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import { usePointerDrag } from '../../ui/usePointerDrag';
import { setPanelDragPhase } from '../../ui/panelDragPhase';
import { requestedPanelWidth, resizeRequestedPanel, subscribePanelWidthRequests, type PanelKind } from '../../ui/panelWidthRequests';

// Desktop and Studio share this file through Studio's vendored source, so both
// editions resize their side panels with the same handle, limits and storage.
export type { PanelKind } from '../../ui/panelWidthRequests';
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
// The committed widths with any held request laid over them: what the panels draw.
let shownWidths: PanelWidths | undefined;
const widthListeners = new Set<() => void>();

export function usePanelWidths(): PanelWidths {
  return useSyncExternalStore(subscribeWidths, currentWidths);
}

// Owns a panel's width: pointer drags, arrow keys, and the stored preference.
// A drag renders nothing until release. Each animation frame writes the new width
// straight to the panel's style (usePointerDrag batches moves to one per frame), so
// React does not re-render whoever called this hook (Studio calls it from its whole
// editor) at every pointer move; release commits the width to state and storage once.
export function usePanelResize(kind: PanelKind): PanelResize {
  const translate = useTranslate();
  const widths = usePanelWidths();
  const startDrag = usePointerDrag();
  const width = widths[kind];
  const side = panelSide(kind);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || event.isPrimary === false) {
      return;
    }
    event.preventDefault();
    const handle = event.currentTarget;
    const panel = handle.parentElement;
    assert(panel instanceof HTMLElement, 'Resize handle must belong to a panel');
    const startWidth = panel.getBoundingClientRect().width;
    const startX = event.clientX;
    let nextWidth = startWidth;
    // The width is written straight to the panel's style: the drag's own local DOM work.
    const showDragWidth = (shown: number): void => {
      assert(Number.isSafeInteger(shown), 'A shown panel width is a whole number of pixels');
      panel.style.width = `${shown}px`;
      handle.setAttribute('aria-valuenow', String(shown));
    };
    const cover = startPanelDrag(handle, event.pointerId);
    // The canvas holds its page width until release, so the page does not re-lay out each frame.
    setPanelDragPhase('dragging');
    startDrag(event, {
      cursor: 'col-resize',
      onMove: (move) => {
        nextWidth = dragPanelWidth(kind, startWidth, move.clientX - startX);
        showDragWidth(nextWidth);
      },
      onEnd: () => {
        endPanelDrag(handle, cover);
        setPanelDragPhase('idle');
        const committed = clampWidth(nextWidth, kind);
        // React renders this width next; writing it now keeps the frame between in step.
        showDragWidth(committed);
        commitWidth(kind, committed);
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
    <div
      className="panel-resize"
      role="separator"
      tabIndex={0}
      aria-label={translate(side === 'left' ? 'shell.panel.resizeLeft' : 'shell.panel.resizeRight')}
      aria-orientation="vertical"
      aria-valuemin={PANEL_WIDTH_PX_MIN[kind]}
      aria-valuemax={PANEL_WIDTH_PX_MAX}
      aria-valuenow={width}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      title={translate('shell.panel.resizeHint')}
    />
  );
  return { width, handle };
}

// Marks the handle as held, captures the pointer to it, and lays a cover over the
// window, so the drag stays in the editor when the pointer crosses a preview iframe.
// All of it is DOM work, not React state: the drag must not re-render the shell.
function startPanelDrag(handle: HTMLElement, pointerId: number): HTMLElement {
  assert(handle.isConnected, 'A panel drag starts from a mounted handle');
  handle.classList.add('on');
  if (typeof handle.setPointerCapture === 'function') {
    try {
      handle.setPointerCapture(pointerId);
    } catch {
      // A pointer that is already gone cannot be captured; the cover still holds the drag.
    }
  }
  const cover = document.createElement('div');
  cover.className = 'panel-resize-cover';
  document.body.append(cover);
  assert(cover.isConnected, 'The drag cover is in the document');
  return cover;
}

function endPanelDrag(handle: HTMLElement, cover: HTMLElement): void {
  handle.classList.remove('on');
  cover.remove();
  assert(!cover.isConnected, 'The drag cover leaves with the drag');
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

// The settled widths, for a reader outside React, such as an opening layout. A held
// request shows in place of its panel's committed width.
export function currentWidths(): PanelWidths {
  shownWidths ??= requestedWidths(committedPanelWidths());
  return shownWidths;
}

function committedPanelWidths(): PanelWidths {
  committedWidths ??= { left: readWidth('left'), code: readWidth('code'), right: readWidth('right') };
  return committedWidths;
}

// A request is clamped to the panel's own bounds: an app's manifest width range is wider.
function requestedWidths(committed: PanelWidths): PanelWidths {
  const shown = {
    left: shownWidth('left', committed.left),
    code: shownWidth('code', committed.code),
    right: shownWidth('right', committed.right),
  };
  assert(shown.left === clampWidth(shown.left, 'left'), 'A shown left panel width is within bounds');
  return shown;
}

function shownWidth(kind: PanelKind, committed: number): number {
  const requested = requestedPanelWidth(kind);
  return requested === undefined ? committed : clampWidth(requested, kind);
}

function widthsChanged(): void {
  shownWidths = undefined;
  for (const changed of widthListeners) {
    changed();
  }
}

function subscribeWidths(changed: () => void): () => void {
  assert(widthListeners.size < WIDTH_LISTENERS_MAX, 'Panel width listeners exceed their limit');
  widthListeners.add(changed);
  const stopRequests = subscribePanelWidthRequests(() => {
    shownWidths = undefined;
    changed();
  });
  return () => {
    stopRequests();
    widthListeners.delete(changed);
    if (widthListeners.size === 0) {
      // With no panel mounted, the next one reads storage afresh, as a new window would.
      committedWidths = undefined;
      shownWidths = undefined;
    }
  };
}

function commitWidth(kind: PanelKind, width: number): void {
  assert(width === clampWidth(width, kind), 'Committed panel width must be within bounds');
  // A panel showing a requested width takes the user's resize into the request, whose
  // owner remembers it; the user's own stored width is untouched (panelWidthRequests.ts).
  if (!resizeRequestedPanel(kind, width)) {
    committedWidths = { ...committedPanelWidths(), [kind]: width };
    storeWidth(kind, width);
    assert(committedWidths[kind] === width, 'Committed panel width must be readable');
  }
  widthsChanged();
  assert(currentWidths()[kind] === width, 'A committed width is the shown width');
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
