// The canvas the shape is edited on: its guides and bounds, and the handles
// for each kind of shape, strict and raw (ClipPath.tsx).

import type { CSSProperties } from 'react';
import { type CornerName, type HandleTarget } from './clipPathTypes';
import { CORNERS } from './clipPathConstants';
import { polygonHandleDisplayPoint } from './clipPathMeasure';
import { cornerLabel } from './clipPathHandles';
import { shapeResizeCornerPoint } from './shapeFunctionModel';
import { formatCssCoordinateValueForPreview } from './clipPathPreview';
import { rawEditableHandleCssPoint } from './clipPathCanvasUnits';
import { HANDLE_ADJUST_HINT, POINT_HANDLE_HINT, INSET_EDGE_HANDLE_HINT, INSET_RADIUS_HANDLE_HINT } from './clipPathStyleWrite';
import { type EditorProps } from './clipPathWriteActions';

// The shortcuts for the current shape, grouped.
export function ShortcutHelpGroups({ editor }: EditorProps) {
  const { shortcutHelpGroups } = editor;
  return (
    <div className="clip-path_shortcuts-body">
      {shortcutHelpGroups.map((group) => (
        <section className="clip-path_shortcuts-group" key={group.title}>
          <h3>{group.title}</h3>
          <dl>
            {group.items.map((item) => (
              <div key={`${group.title}-${item.keys}`}>
                <dt>
                  {item.keys.split(' + ').map((key, index) => (
                    <kbd className="clip-path_shortcuts-key" key={index}>
                      {key}
                    </kbd>
                  ))}
                </dt>
                <dd>{item.description}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

// The canvas: the clipped preview, the drag guides and marquee, and the handles.
export function ClipPathCanvas({ editor }: EditorProps) {
  const { canvasWrapRef, beginPolygonSelectionDrag, isCodeTransitioning, canvasRef } = editor;
  const { shape, onAddPoint, previewCss } = editor;
  return (
    <div className="clip-path_canvas-wrap" ref={canvasWrapRef} onPointerDown={beginPolygonSelectionDrag}>
      <div
        className={['clip-path_canvas', isCodeTransitioning ? 'is-code-transitioning' : ''].filter(Boolean).join(' ')}
        ref={canvasRef}
        onDoubleClick={shape.kind === 'polygon' ? onAddPoint : undefined}
      >
        <div
          className={['clip-path_preview', isCodeTransitioning ? 'is-code-transitioning' : ''].filter(Boolean).join(' ')}
          style={{ clipPath: previewCss, WebkitClipPath: previewCss }}
        />
        <CanvasGuides editor={editor} />
        <ShapeBoundsControls editor={editor} />
        <RawPolygonHandles editor={editor} />
        <RawCircleHandles editor={editor} />
        <RawEllipseHandles editor={editor} />
        <RawInsetHandles editor={editor} />
        <PolygonHandles editor={editor} />
        <CircleHandles editor={editor} />
        <EllipseHandles editor={editor} />
        <InsetHandles editor={editor} />
      </div>
    </div>
  );
}

// The snap guides of a drag in progress, and the marquee.
export function CanvasGuides({ editor }: EditorProps) {
  const { snapGuides, selectionRect } = editor;
  return (
    <>
      {snapGuides ? (
        <>
          {snapGuides.x.map((x) => (
            <div key={`x-${x}`} className="clip-path_snap-guide is-x" style={{ left: `${x}%` }} />
          ))}
          {snapGuides.y.map((y) => (
            <div key={`y-${y}`} className="clip-path_snap-guide is-y" style={{ top: `${y}%` }} />
          ))}
        </>
      ) : undefined}
      {selectionRect ? (
        <div
          className="clip-path_selection-box"
          style={{
            left: `${selectionRect.left}%`,
            top: `${selectionRect.top}%`,
            width: `${selectionRect.width}%`,
            height: `${selectionRect.height}%`,
          }}
        />
      ) : undefined}
    </>
  );
}

// A scaled shape's bounding box: drag inside it to move, drag a corner to resize.
export function ShapeBoundsControls({ editor }: EditorProps) {
  const { shape, activeShapeBounds, shapeFitMode, isShapeTransformSelected } = editor;
  const { shapeBoundsStyle, beginShapeTransformDrag, handlePositionStyle } = editor;
  if (shape.kind !== 'shape' || !activeShapeBounds || shapeFitMode !== 'contain') {
    return undefined;
  }
  return (
    <>
      <div
        className={['clip-path_shape-bounds', isShapeTransformSelected ? 'is-selected' : ''].filter(Boolean).join(' ')}
        style={shapeBoundsStyle}
        aria-hidden="true"
      />
      <div
        className="clip-path_shape-move"
        style={shapeBoundsStyle}
        onPointerDown={beginShapeTransformDrag('move')}
        aria-label="Move shape"
        role="button"
        tabIndex={-1}
      />
      {CORNERS.map((corner) => {
        const point = shapeResizeCornerPoint(activeShapeBounds, corner);
        return (
          <button
            key={corner}
            type="button"
            className={['clip-path_shape-resize', `is-${corner}`, isShapeTransformSelected ? 'is-selected' : ''].filter(Boolean).join(' ')}
            style={handlePositionStyle(point.x, point.y)}
            onPointerDown={beginShapeTransformDrag('resize', corner)}
            aria-label={`Resize shape from ${cornerLabel(corner)} corner`}
          />
        );
      })}
    </>
  );
}

// One canvas handle: placed, selectable, draggable, and moved by the arrow keys.
export function HandleButton({
  editor,
  handle,
  extra,
  style,
  label,
  onDoubleClick,
}: EditorProps & {
  handle: HandleTarget;
  extra?: string;
  style: CSSProperties;
  label: string;
  onDoubleClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const { shape, handleClassName, beginDrag, onHandleKeyDown, onHandleKeyUp } = editor;
  const { isHandleSelected } = editor;
  return (
    <button
      className={handleClassName(handle, extra)}
      style={style}
      onPointerDown={beginDrag({ ...handle, before: shape })}
      onKeyDown={onHandleKeyDown(handle)}
      onKeyUp={onHandleKeyUp}
      onDoubleClick={onDoubleClick}
      aria-pressed={isHandleSelected(handle)}
      aria-label={label}
    />
  );
}

// The points of a polygon written in units the canvas cannot place as plain
// percentages.
export function RawPolygonHandles({ editor }: EditorProps) {
  const { shape, handleCssPositionStyle } = editor;
  if (shape.kind !== 'raw' || shape.editable?.kind !== 'polygon') {
    return undefined;
  }
  return shape.editable.points.map((point, index) => {
    const handle: HandleTarget = { kind: 'polygon-point', index };
    return (
      <HandleButton
        key={index}
        editor={editor}
        handle={handle}
        style={handleCssPositionStyle(formatCssCoordinateValueForPreview(point.x), formatCssCoordinateValueForPreview(point.y))}
        label={`Point ${index + 1}. Drag or use arrow keys to move.`}
      />
    );
  });
}

// The centre and radius of a circle written in raw CSS units.
export function RawCircleHandles({ editor }: EditorProps) {
  const { shape, handleCssPositionStyle } = editor;
  if (shape.kind !== 'raw' || shape.editable?.kind !== 'circle') {
    return undefined;
  }
  const center: HandleTarget = { kind: 'circle-center' };
  const radius: HandleTarget = { kind: 'circle-radius' };
  const centerPoint = rawEditableHandleCssPoint(shape.editable, center);
  const radiusPoint = rawEditableHandleCssPoint(shape.editable, radius);
  return (
    <>
      {centerPoint ? (
        <HandleButton
          editor={editor}
          handle={center}
          extra="is-center"
          style={handleCssPositionStyle(centerPoint.x, centerPoint.y)}
          label="Circle center. Drag or use arrow keys to move."
        />
      ) : undefined}
      {radiusPoint ? (
        <HandleButton
          editor={editor}
          handle={radius}
          style={handleCssPositionStyle(radiusPoint.x, radiusPoint.y)}
          label="Circle radius. Drag or use arrow keys to resize."
        />
      ) : undefined}
    </>
  );
}

// The centre and radii of an ellipse written in raw CSS units.
export function RawEllipseHandles({ editor }: EditorProps) {
  const { shape, handleCssPositionStyle } = editor;
  if (shape.kind !== 'raw' || shape.editable?.kind !== 'ellipse') {
    return undefined;
  }
  const editable = shape.editable;
  const handles: HandleTarget[] = [{ kind: 'ellipse-center' }, { kind: 'ellipse-rx' }, { kind: 'ellipse-ry' }];
  return handles.map((handle) => {
    const point = rawEditableHandleCssPoint(editable, handle);
    if (!point) {
      return undefined;
    }
    const handleLabel =
      handle.kind === 'ellipse-center' ? 'Ellipse center' : handle.kind === 'ellipse-rx' ? 'Ellipse horizontal radius' : 'Ellipse vertical radius';
    return (
      <HandleButton
        key={handle.kind}
        editor={editor}
        handle={handle}
        {...(handle.kind === 'ellipse-center' ? { extra: 'is-center' } : {})}
        style={handleCssPositionStyle(point.x, point.y)}
        label={`${handleLabel}. ${HANDLE_ADJUST_HINT}`}
      />
    );
  });
}

// The edges and corner radii of an inset written in raw CSS units.
export function RawInsetHandles({ editor }: EditorProps) {
  const { shape, handleCssPositionStyle } = editor;
  if (shape.kind !== 'raw' || shape.editable?.kind !== 'inset') {
    return undefined;
  }
  const editable = shape.editable;
  const sides: HandleTarget[] = [{ kind: 'inset-top' }, { kind: 'inset-right' }, { kind: 'inset-bottom' }, { kind: 'inset-left' }];
  const cornerHandle = (corner: CornerName): HandleTarget => ({ kind: 'inset-radius', corner });
  return (
    <>
      {sides.map((handle) => {
        const point = rawEditableHandleCssPoint(editable, handle);
        if (!point) {
          return undefined;
        }
        return (
          <HandleButton
            key={handle.kind}
            editor={editor}
            handle={handle}
            extra="is-inset-side"
            style={handleCssPositionStyle(point.x, point.y)}
            label="Inset edge. Drag or use arrow keys to resize."
          />
        );
      })}
      {editable.radii
        ? CORNERS.map((corner) => {
            const point = rawEditableHandleCssPoint(editable, cornerHandle(corner));
            if (!point) {
              return undefined;
            }
            return (
              <HandleButton
                key={corner}
                editor={editor}
                handle={cornerHandle(corner)}
                extra="is-radius"
                style={handleCssPositionStyle(point.x, point.y)}
                label={`Inset ${cornerLabel(corner)} corner radius. ${HANDLE_ADJUST_HINT}`}
              />
            );
          })
        : undefined}
    </>
  );
}

// A polygon's points. A point outside the canvas is drawn on its edge; the side it
// was projected to is remembered so the handle doesn't jump between sides.
export function PolygonHandles({ editor }: EditorProps) {
  const { shape, handleBounds, polygonDisplayProjectionsRef, handlePositionStyle } = editor;
  const { onRemovePoint } = editor;
  if (shape.kind !== 'polygon') {
    return undefined;
  }
  return shape.points.map((point, i) => {
    const handle: HandleTarget = { kind: 'polygon-point', index: i };
    const display = polygonHandleDisplayPoint(shape.points, i, handleBounds, polygonDisplayProjectionsRef.current.get(i));
    if (display.projection) {
      polygonDisplayProjectionsRef.current.set(i, display.projection);
    } else {
      polygonDisplayProjectionsRef.current.delete(i);
    }
    return (
      <HandleButton
        key={i}
        editor={editor}
        handle={handle}
        style={handlePositionStyle(display.point.x, display.point.y)}
        onDoubleClick={(event) => {
          event.stopPropagation();
          onRemovePoint(i);
        }}
        label={`Point ${i + 1}. ${POINT_HANDLE_HINT}`}
      />
    );
  });
}

// A circle's centre and radius.
export function CircleHandles({ editor }: EditorProps) {
  const { shape, handlePositionStyle, circleRadiusHandleX, circleRadiusHandleY } = editor;
  if (shape.kind !== 'circle') {
    return undefined;
  }
  return (
    <>
      <HandleButton
        editor={editor}
        handle={{ kind: 'circle-center' }}
        extra="is-center"
        style={handlePositionStyle(shape.cx, shape.cy)}
        label="Circle center. Drag or use arrow keys to move."
      />
      <HandleButton
        editor={editor}
        handle={{ kind: 'circle-radius' }}
        style={handlePositionStyle(circleRadiusHandleX, circleRadiusHandleY)}
        label="Circle radius. Drag or use arrow keys to resize."
      />
    </>
  );
}

// An ellipse's centre and its two radii.
export function EllipseHandles({ editor }: EditorProps) {
  const { shape, handlePositionStyle } = editor;
  if (shape.kind !== 'ellipse') {
    return undefined;
  }
  return (
    <>
      <HandleButton
        editor={editor}
        handle={{ kind: 'ellipse-center' }}
        extra="is-center"
        style={handlePositionStyle(shape.cx, shape.cy)}
        label="Ellipse center. Drag or use arrow keys to move."
      />
      <HandleButton
        editor={editor}
        handle={{ kind: 'ellipse-rx' }}
        style={handlePositionStyle(shape.cx + shape.rx, shape.cy)}
        label="Ellipse horizontal radius. Drag or use any arrow key to resize."
      />
      <HandleButton
        editor={editor}
        handle={{ kind: 'ellipse-ry' }}
        style={handlePositionStyle(shape.cx, shape.cy + shape.ry)}
        label="Ellipse vertical radius. Drag or use any arrow key to resize."
      />
    </>
  );
}

// An inset's four edges and its corner radii.
export function InsetHandles({ editor }: EditorProps) {
  const { shape, handlePositionStyle, insetCenterX, insetCenterY } = editor;
  const { insetRadiusHandlePosition } = editor;
  if (shape.kind !== 'inset') {
    return undefined;
  }
  const edges: Array<{ handle: HandleTarget; x: number; y: number; name: string }> = [
    { handle: { kind: 'inset-top' }, x: insetCenterX, y: shape.top, name: 'top' },
    { handle: { kind: 'inset-right' }, x: 100 - shape.right, y: insetCenterY, name: 'right' },
    { handle: { kind: 'inset-bottom' }, x: insetCenterX, y: 100 - shape.bottom, name: 'bottom' },
    { handle: { kind: 'inset-left' }, x: shape.left, y: insetCenterY, name: 'left' },
  ];
  return (
    <>
      {edges.map((edge) => (
        <HandleButton
          key={edge.name}
          editor={editor}
          handle={edge.handle}
          extra="is-inset-side"
          style={handlePositionStyle(edge.x, edge.y)}
          label={`Inset ${edge.name} edge. ${INSET_EDGE_HANDLE_HINT}`}
        />
      ))}
      {CORNERS.map((corner) => {
        const position = insetRadiusHandlePosition(corner);
        return (
          <HandleButton
            key={corner}
            editor={editor}
            handle={{ kind: 'inset-radius', corner }}
            extra="is-radius"
            style={handlePositionStyle(position.x, position.y)}
            label={`Inset ${cornerLabel(corner)} corner radius. ${INSET_RADIUS_HANDLE_HINT}`}
          />
        );
      })}
    </>
  );
}
