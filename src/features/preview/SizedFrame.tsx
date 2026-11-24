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
import type { ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import type { PreviewSizing } from './usePreviewSizing';
import { CanvasScrollbar } from './CanvasScrollbar';
import { FLUID_FRAME_WIDTH } from './previewViewport';
import './previewViewport.css';

export interface SizedFrameProps {
  readonly sizing: PreviewSizing;
  /** Frames this wide and wider keep Chromium's scrollbar (Settings, `canvasScrollbar`); undefined: the canvas draws its own everywhere. */
  readonly chromiumFromPx: number | undefined;
  readonly children: ReactNode;
}

/** The frame, sized and scaled to the canvas, its page clipped to the rounded corners, the page's scrollbar and the handles. */
export function SizedFrame({ sizing, chromiumFromPx, children }: SizedFrameProps) {
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
          ? { width: FLUID_FRAME_WIDTH, height: '100%', bottom: 'auto', transform: 'translateX(-50%)' }
          : { width: sizing.viewport.width, height: sizing.viewport.height, bottom: 'auto', transform: `translateX(-50%) scale(${scale})` }
      }
    >
      <div className="frame-clip">{children}</div>
      <CanvasScrollbar frameRef={sizing.frameRef} scale={scale} chromiumFromPx={chromiumFromPx} />
      <ResizeHandles sizing={sizing} />
    </div>
  );
}

/** The preview mode's stage: the area below the title bar, the frame centred in it as on the canvas. */
export function PreviewModeStage({ sizing, chromiumFromPx, children }: SizedFrameProps) {
  return (
    <div className="preview-mode preview-mode-stage" dir="ltr" ref={sizing.wrapRef}>
      <SizedFrame sizing={sizing} chromiumFromPx={chromiumFromPx}>
        {children}
      </SizedFrame>
    </div>
  );
}

// The width handles on the left and right edges, the height handle on the bottom edge, and
// the size readout while one is dragged. A left or right drag widens both sides, because the
// frame stays centred (usePreviewSizing resizeFrame).
function ResizeHandles({ sizing }: { readonly sizing: PreviewSizing }) {
  const edges = ['w', 'e', 's'] as const;
  assert(edges.length === 3, 'Two width handles and one height handle');
  return (
    <>
      {edges.map((edge) => (
        <div key={edge} className={`rz-handle rz-${edge}`} onPointerDown={sizing.startResize(edge)} />
      ))}
      {sizing.resizing && (
        <div className="rz-readout">
          {Math.round(sizing.viewport.width)} × {Math.round(sizing.viewport.height)}
        </div>
      )}
    </>
  );
}
