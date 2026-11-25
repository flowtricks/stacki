// What Design mode draws over the frames, in canvas coordinates: the hovered element's outline, the selection's
// boxes with their size and resize handles, snapping guides with gap distances, the insertion line of a drag
// in the flow, and the box being drawn. Line widths and handles are divided by the zoom, so they stay the same
// size on screen at any zoom.
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { FlowDrop } from '../model/designDrop';
import { RESIZE_HANDLES, type Box, type GapHint, type ResizeHandle, type SnapGuide } from '../model/designSnap';
import type { DesignFrameRecord, FrameId } from '../model/designTypes';
import { designState, selectedElements, useDesignState } from '../runtime/designSession';

export interface CanvasMarks {
  readonly hover: { readonly frame: FrameId; readonly element: Element } | undefined;
  readonly guides: readonly { readonly frame: FrameId; readonly guide: SnapGuide }[];
  readonly gaps: readonly { readonly frame: FrameId; readonly gap: GapHint }[];
  readonly drop: { readonly frame: FrameId; readonly drop: FlowDrop } | undefined;
  readonly draw: { readonly frame: FrameId; readonly box: Box } | undefined;
}

function frameOf(id: FrameId): DesignFrameRecord | undefined {
  return designState().frames.find((frame) => frame.id === id);
}

function boxIn(frame: DesignFrameRecord, element: Element): Box {
  const rect = element.getBoundingClientRect();
  return { xPx: frame.xPx + rect.left, yPx: frame.yPx + rect.top, widthPx: rect.width, heightPx: rect.height };
}

export function DesignSelectionLayer({
  marks,
  scale,
  onResizeStart,
}: {
  readonly marks: CanvasMarks;
  readonly scale: number;
  readonly onResizeStart: (frame: DesignFrameRecord, element: Element, handle: ResizeHandle, event: ReactPointerEvent) => void;
}) {
  // Read on every revision: a gesture, a measured image or a new width moves what the boxes follow.
  const state = useDesignState();
  const line = 1 / scale;
  const selected = selectedElements();
  const selectionFrame = selected === undefined ? undefined : frameOf(selected.frame);
  const boxes =
    selected === undefined || selectionFrame === undefined
      ? []
      : selected.elements
          .map((element) => ({ element, box: boxIn(selectionFrame, element) }))
          // A hidden element has no box: nothing is drawn at the frame's corner for it (the layers list still shows it).
          .filter((entry) => entry.box.widthPx > 0 || entry.box.heightPx > 0);
  const single = boxes.length === 1 ? boxes[0] : undefined;
  const hoverFrame = marks.hover === undefined ? undefined : frameOf(marks.hover.frame);
  const hoverBox =
    marks.hover === undefined || hoverFrame === undefined || boxes.some((entry) => entry.element === marks.hover?.element)
      ? undefined
      : boxIn(hoverFrame, marks.hover.element);
  const editing = state.editingText !== undefined;
  return (
    <div className="dm-marks" aria-hidden="true" data-revision={state.revision}>
      {hoverBox !== undefined && <div className="dm-mark-hover" style={rectStyle(hoverBox, line)} />}
      {boxes.map(({ box }, index) => (
        <div key={index} className={`dm-mark-selection${editing ? ' is-editing' : ''}`} style={rectStyle(box, line * 1.5)} />
      ))}
      {single !== undefined && selectionFrame !== undefined && !editing && single.element.tagName !== 'BODY' && (
        <>
          {RESIZE_HANDLES.map((handle) => (
            <div
              key={handle}
              className={`dm-handle dm-handle-${handle}`}
              style={handleStyle(single.box, handle, scale)}
              onPointerDown={(event) => onResizeStart(selectionFrame, single.element, handle, event)}
            />
          ))}
          <div className="dm-size-label" style={sizeLabelStyle(single.box, scale)}>
            {Math.round(single.box.widthPx)} × {Math.round(single.box.heightPx)}
          </div>
        </>
      )}
      {marks.guides.map(({ frame, guide }, index) => {
        const record = frameOf(frame);
        return record === undefined ? undefined : <div key={'g' + String(index)} className="dm-mark-guide" style={guideStyle(record, guide, line)} />;
      })}
      {marks.gaps.map(({ frame, gap }, index) => {
        const record = frameOf(frame);
        return record === undefined ? undefined : <GapMark key={'d' + String(index)} frame={record} gap={gap} scale={scale} />;
      })}
      {marks.drop !== undefined && <DropMark frame={frameOf(marks.drop.frame)} drop={marks.drop.drop} scale={scale} />}
      {marks.draw !== undefined && <div className="dm-mark-draw" style={rectStyle(offsetBox(frameOf(marks.draw.frame), marks.draw.box), line)} />}
    </div>
  );
}

function offsetBox(frame: DesignFrameRecord | undefined, box: Box): Box {
  return frame === undefined ? box : { ...box, xPx: box.xPx + frame.xPx, yPx: box.yPx + frame.yPx };
}

function rectStyle(box: Box, borderPx: number): React.CSSProperties {
  return { left: box.xPx, top: box.yPx, width: box.widthPx, height: box.heightPx, outlineWidth: borderPx };
}

function handleStyle(box: Box, handle: ResizeHandle, scale: number): React.CSSProperties {
  const size = 8 / scale;
  const x = handle.includes('w') ? box.xPx : handle.includes('e') ? box.xPx + box.widthPx : box.xPx + box.widthPx / 2;
  const y = handle.includes('n') ? box.yPx : handle.includes('s') ? box.yPx + box.heightPx : box.yPx + box.heightPx / 2;
  return { left: x - size / 2, top: y - size / 2, width: size, height: size, borderWidth: 1 / scale };
}

function sizeLabelStyle(box: Box, scale: number): React.CSSProperties {
  return {
    left: box.xPx + box.widthPx / 2,
    top: box.yPx + box.heightPx + 6 / scale,
    transform: `translateX(-50%) scale(${String(1 / scale)})`,
    transformOrigin: 'top center',
  };
}

function guideStyle(frame: DesignFrameRecord, guide: SnapGuide, line: number): React.CSSProperties {
  return guide.axis === 'x'
    ? { left: frame.xPx + guide.positionPx - line / 2, top: frame.yPx + guide.fromPx, width: line, height: guide.toPx - guide.fromPx }
    : { left: frame.xPx + guide.fromPx, top: frame.yPx + guide.positionPx - line / 2, width: guide.toPx - guide.fromPx, height: line };
}

function GapMark({ frame, gap, scale }: { readonly frame: DesignFrameRecord; readonly gap: GapHint; readonly scale: number }) {
  const line = 1 / scale;
  const style: React.CSSProperties =
    gap.axis === 'x'
      ? { left: frame.xPx + gap.fromPx, top: frame.yPx + gap.atPx - line / 2, width: gap.toPx - gap.fromPx, height: line }
      : { left: frame.xPx + gap.atPx - line / 2, top: frame.yPx + gap.fromPx, width: line, height: gap.toPx - gap.fromPx };
  const middleX = gap.axis === 'x' ? frame.xPx + (gap.fromPx + gap.toPx) / 2 : frame.xPx + gap.atPx;
  const middleY = gap.axis === 'x' ? frame.yPx + gap.atPx : frame.yPx + (gap.fromPx + gap.toPx) / 2;
  return (
    <>
      <div className="dm-mark-gap" style={style} />
      <div className="dm-gap-label" style={{ left: middleX, top: middleY, transform: `translate(-50%, -50%) scale(${String(1 / scale)})` }}>
        {Math.round(gap.distancePx)}
      </div>
    </>
  );
}

function DropMark({ frame, drop, scale }: { readonly frame: DesignFrameRecord | undefined; readonly drop: FlowDrop; readonly scale: number }) {
  if (frame === undefined) {
    return undefined;
  }
  const thickness = 2 / scale;
  const { x1Px, y1Px, x2Px, y2Px } = drop.line;
  const vertical = Math.abs(x1Px - x2Px) < 0.5;
  const parent = drop.parent.getBoundingClientRect();
  return (
    <>
      <div
        className="dm-mark-drop-parent"
        style={{ left: frame.xPx + parent.left, top: frame.yPx + parent.top, width: parent.width, height: parent.height, outlineWidth: 1 / scale }}
      />
      <div
        className="dm-mark-drop"
        style={
          vertical
            ? { left: frame.xPx + x1Px - thickness / 2, top: frame.yPx + y1Px, width: thickness, height: Math.max(thickness, y2Px - y1Px) }
            : { left: frame.xPx + x1Px, top: frame.yPx + y1Px - thickness / 2, width: Math.max(thickness, x2Px - x1Px), height: thickness }
        }
      />
    </>
  );
}
