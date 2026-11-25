// The page frame at the canvas's picked size, with the width and height handles on its edges.
//
//   <SizedFrame sizing={usePreviewSizing(...)}>
//     <iframe ... />
//   </SizedFrame>
//
// Every surface that shows the page at the canvas size draws it through this one frame: the
// design canvas and interact mode (Desktop PreviewPane.tsx, Studio PreviewCanvas.tsx) and the
// preview mode behind the title bar's play button (Desktop AppShell.tsx, Studio
// InteractivePreview.tsx). Why: the handles are the same element with the same classes,
// cursor and drag in each, so a resize in one mode is the size the others open on, and no
// copy can drift from the others.
import type { CSSProperties, ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import type { PreviewSizing } from './usePreviewSizing';
import { CanvasScrollbar } from './CanvasScrollbar';
import './previewViewport.css';

export interface SizedFrameProps {
  readonly sizing: PreviewSizing;
  readonly children: ReactNode;
}

/** The frame, sized and scaled to the canvas, its page clipped to the rounded corners, the page's scrollbar and the handles. */
export function SizedFrame({ sizing, children }: SizedFrameProps) {
  const scale = sizing.viewport.scale;
  assert(scale > 0, 'The canvas scale is positive');
  assert(scale <= 1, 'The canvas never scales a page up');
  const moving = sizing.resizing || sizing.panelSettling;
  // A fluid frame (Desktop, the all-breakpoints canvas) fills the canvas but for a narrow gutter each side, where the
  // scrollbar sits (previewViewport.ts), with no radius or shadow: the handles sit inside it.
  const flush = sizing.width === undefined;
  return (
    <div
      ref={sizing.frameRef}
      className={`frame-sized ${flush ? 'full' : ''} ${moving ? 'resizing' : ''} ${sizing.resizing ? 'dragging' : ''}`}
      // A fluid frame fills the canvas by CSS, so it follows a side-panel drag each frame
      // without a render (usePreviewSizing puts off its measure until release).
      style={
        sizing.width === undefined
          ? { ...sizing.fillStyle, height: '100%', bottom: 'auto', transform: 'translateX(-50%)' }
          : { width: sizing.viewport.width, height: sizing.viewport.height, bottom: 'auto', transform: `translateX(-50%) scale(${scale})` }
      }
    >
      <div className="frame-clip">{children}</div>
      <CanvasScrollbar frameRef={sizing.frameRef} scale={scale} />
      <ResizeHandles sizing={sizing} />
    </div>
  );
}

/** The preview mode's stage: the area below the title bar, the frame centred in it as on the canvas. */
export function PreviewModeStage({ sizing, children }: SizedFrameProps) {
  return (
    <div className="preview-mode preview-mode-stage" dir="ltr" ref={sizing.wrapRef}>
      <SizedFrame sizing={sizing}>{children}</SizedFrame>
    </div>
  );
}

// The width handles on the left and right edges, the height handle on the bottom edge, and
// the size readout while one is dragged. A left or right drag widens both sides, because the
// frame stays centred (usePreviewSizing resizeFrame).
function ResizeHandles({ sizing }: { readonly sizing: PreviewSizing }) {
  const edges = ['w', 'e', 's'] as const;
  assert(edges.length === 3, 'Two width handles and one height handle');
  const scale = sizing.viewport.scale;
  return (
    <>
      {edges.map((edge) => (
        <div
          key={edge}
          className={`rz-handle rz-${edge}`}
          style={handleOffset(edge, { fluid: sizing.width === undefined, scale })}
          onPointerDown={sizing.startResize(edge)}
        />
      ))}
      {sizing.resizing && (
        <div className="rz-readout">
          {Math.round(sizing.viewport.width)} × {Math.round(sizing.viewport.height)}
        </div>
      )}
    </>
  );
}

/** The side handles' offset from a scaled frame's edge, in screen pixels at every zoom. */
export const HANDLE_SCREEN_PX = { side: 12 } as const satisfies Record<string, number>;

// A side handle of a scaled frame sits HANDLE_SCREEN_PX.side screen pixels out, as the stylesheet's 12px does at scale
// 1. Without this, a frame scaled to fit would draw its handles closer in (12px × scale), right over the canvas's
// scrollbar, which keeps its 2px gap and 5px width in screen pixels (CanvasScrollbar.tsx). A fluid frame keeps its
// handles inside the page (styles.css `.frame-sized.full`), and the bottom handle is nowhere near the bar.
function handleOffset(edge: 'w' | 'e' | 's', frame: { readonly fluid: boolean; readonly scale: number }): CSSProperties | undefined {
  assert(frame.scale > 0, 'handleOffset: the frame has a scale');
  if (frame.fluid) {
    return undefined;
  }
  const offsetPx = -HANDLE_SCREEN_PX.side / frame.scale;
  assert(offsetPx <= -HANDLE_SCREEN_PX.side, 'handleOffset: never closer in than at scale 1');
  switch (edge) {
    case 'w':
      return { left: offsetPx }; // physical: canvas frame in preview coordinates
    case 'e':
      return { right: offsetPx }; // physical: canvas frame in preview coordinates
    case 's':
      return undefined;
    default: {
      const exhaustive: never = edge;
      return exhaustive;
    }
  }
}
