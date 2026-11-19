// What a drag over the canvas shows on the canvas: the node being moved (tinted, with a chip saying what it is),
// the container the drop lands in (outlined and named), the insertion line or an empty container's placeholder,
// and, when the drop goes nowhere or somewhere else, why. Everything comes from the one decision the drag
// controller publishes (src/editor/canvasDragSession.ts); the Navigator draws the same decision in the same commit.
//
// Coordinates are the frame's CSS pixels, scaled as the outlines are (PreviewOverlays.tsx boxStyle).

import React, { useSyncExternalStore } from 'react';
import { canvasDragView, dropReasonText, subscribeCanvasDrag, type CanvasDragSubject } from '../../editor/canvasDragSession';
import type { DropGuide, DropRect } from '../../editor/canvasDrop';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../lib/i18n/localeContext';
import { outlineIcon, type OverlayInfo } from './PreviewOverlays';
import './canvasDrop.css';

// The chip beside the pointer sits this far from it, so it never hides what the pointer is over.
const REASON_OFFSET_PX = 14;
const LINE_THICKNESS_PX = 2;

export function CanvasDropOverlay({
  scale,
  overlayInfo,
}: {
  readonly scale: number;
  readonly overlayInfo?: ((path: string) => OverlayInfo | undefined) | undefined;
}) {
  const translate = useTranslate();
  const view = useSyncExternalStore(subscribeCanvasDrag, canvasDragView);
  if (view === undefined) {
    return undefined;
  }
  const refused = view.verdict.kind === 'refused';
  const parentInfo = view.parent?.path === undefined ? undefined : overlayInfo?.(view.parent.path);
  const reason = dropReasonText(view, translate);
  return (
    <div className="canvas-drop" data-testid="canvas-drop" data-verdict={view.verdict.kind}>
      {view.dragged.map((box, index) => (
        <div key={`moving-${index}`} className="canvas-drop-moving" style={boxStyle(box, scale)} />
      ))}
      {view.dragged[0] !== undefined && (
        <div className="canvas-drop-chip" style={chipStyle(view.dragged[0], scale)}>
          {subjectText(view.subject, translate)}
        </div>
      )}
      {view.parent !== undefined && !refused && (
        <div className="canvas-drop-parent" data-kind={parentInfo?.kind ?? 'element'} style={boxStyle(view.parent.box, scale)}>
          <span className={`canvas-drop-tag ${view.parent.box.y * scale < 20 ? 'inside' : ''}`}>
            {parentInfo === undefined ? undefined : outlineIcon(parentInfo)}
            {parentInfo?.label ?? translate('preview.drag.page')}
          </span>
        </div>
      )}
      {view.decision.kind === 'refused' && <div className="canvas-drop-refused" data-testid="canvas-drop-refused" style={boxStyle(view.decision.box, scale)} />}
      {view.guide !== undefined && <Guide guide={view.guide} scale={scale} refused={refused} />}
      {reason !== undefined && (
        <div
          className="canvas-drop-reason"
          role="status"
          data-tone={refused ? 'refused' : 'note'}
          style={{ left: view.pointer.x * scale + REASON_OFFSET_PX, top: view.pointer.y * scale + REASON_OFFSET_PX }}
        >
          {reason}
        </div>
      )}
    </div>
  );
}

function Guide({ guide, scale, refused }: { readonly guide: DropGuide; readonly scale: number; readonly refused: boolean }) {
  const translate = useTranslate();
  switch (guide.kind) {
    case 'line': {
      const horizontal = guide.orientation === 'horizontal';
      const style: React.CSSProperties = horizontal
        ? { left: guide.x * scale, top: guide.y * scale - LINE_THICKNESS_PX / 2, width: guide.length * scale, height: LINE_THICKNESS_PX }
        : { left: guide.x * scale - LINE_THICKNESS_PX / 2, top: guide.y * scale, width: LINE_THICKNESS_PX, height: guide.length * scale };
      return (
        <div
          className="canvas-drop-line"
          data-testid="canvas-drop-line"
          data-orientation={guide.orientation}
          {...(refused ? { 'data-refused': '' } : {})}
          style={style}
        />
      );
    }
    case 'empty':
      return (
        <div className="canvas-drop-empty" data-testid="canvas-drop-empty" style={boxStyle(guide.box, scale)}>
          {translate('preview.drag.dropHere')}
        </div>
      );
    default: {
      const exhaustive: never = guide;
      return exhaustive;
    }
  }
}

function subjectText(subject: CanvasDragSubject, translate: Translator): string {
  switch (subject.kind) {
    case 'element':
      return translate('preview.drag.moving.element');
    case 'component':
      return translate('preview.drag.moving.component');
    case 'loop':
      return translate('preview.drag.moving.loop');
    case 'text':
      return translate('preview.drag.moving.text');
    case 'new':
      return translate('preview.drag.adding', { name: subject.label });
    default: {
      const exhaustive: never = subject;
      return exhaustive;
    }
  }
}

function boxStyle(box: DropRect, scale: number): React.CSSProperties {
  return { left: box.x * scale, top: box.y * scale, width: box.w * scale, height: box.h * scale };
}

function chipStyle(box: DropRect, scale: number): React.CSSProperties {
  return { left: (box.x + box.w / 2) * scale, top: (box.y + box.h / 2) * scale };
}
