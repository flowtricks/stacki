// Pointer actions and listeners, the next stages of the pipeline: moving a
// marquee, duplicating while dragging, dragging a handle, pointer move and
// end, window and dismiss listeners, measuring the canvas, keeping the code
// view in sync, and keyboard shortcuts (ClipPath.tsx).

import { useEffect, useLayoutEffect, useRef } from 'react';
import { claimMenuPaste } from '../../../ui/menuPasteClaim';
import { type Point, type PolygonShape, type InsetSideMode, type InsetRadiusMode, type HandleTarget, type DragTarget } from './clipPathTypes';
import { CLIP_PATH_CODE_ID, HANDLE_SIZE_PX, SELECTION_DRAG_THRESHOLD_PX, NONE_PRESET } from './clipPathConstants';
import { rectFromPoints, boundsClose, pointsNearlyEqual, snapDragPointForTarget, offsetDuplicatePoint } from './clipPathMeasure';
import { shapesClose } from './clipPathHandles';
import { formatCodeValue } from './clipPathFormat';
import { parseSvgClipPathPolygon } from './svgContours';
import { matchPreset } from './clipPathShortcuts';
import { updateShapeForDrag } from './shapeDrag';
import { isSpaceKey, isRadiusUnlockKey, isArrowKey } from './shapeKeyboard';
import { isEditableTarget } from './clipPathEditorState';
import { type EditorAfterKeyboardLoopActions, keyboardKeyActions } from './clipPathShapeActions';

export type EditorAfterKeyboardKeyActions = EditorAfterKeyboardLoopActions & ReturnType<typeof keyboardKeyActions>;

// Following a marquee drag.
export function marqueeMoveActions(editor: EditorAfterKeyboardKeyActions) {
  const { polygonSelectionDragRef, canvasPointFromClient, setSelectionRect } = editor;
  const { applyPolygonSelectionRect } = editor;
  const updatePolygonSelectionDrag = (event: PointerEvent) => {
    const selection = polygonSelectionDragRef.current;
    if (!selection) {
      return false;
    }
    if (event.pointerId !== selection.pointerId) {
      return true;
    }

    const point = canvasPointFromClient(event.clientX, event.clientY);
    if (!point) {
      return true;
    }

    selection.current = point;
    const dx = event.clientX - selection.startClient.x;
    const dy = event.clientY - selection.startClient.y;
    if (!selection.didMove && Math.hypot(dx, dy) >= SELECTION_DRAG_THRESHOLD_PX) {
      selection.didMove = true;
    }

    if (selection.didMove) {
      const rect = rectFromPoints(selection.start, selection.current);
      setSelectionRect(rect);
      applyPolygonSelectionRect(selection);
    }

    return true;
  };
  return { updatePolygonSelectionDrag };
}

export type EditorAfterMarqueeMoveActions = EditorAfterKeyboardKeyActions & ReturnType<typeof marqueeMoveActions>;

// Duplicating a polygon point by Option-dragging it.
export function pointDuplicateDragActions(editor: EditorAfterMarqueeMoveActions) {
  const { shapeRef, insertPolygonPointColor, setHandleSelection, setShape, dragTargetRef } = editor;
  // Option-dragging a polygon point leaves a copy behind: the first move with
  // Option held inserts the duplicate, and the drag carries on with that. Returns
  // the new drag target, or undefined when the point is gone.
  const duplicateDraggedPolygonPoint = (index: number, beforeShape: PolygonShape, rawPoint: Point): DragTarget | undefined => {
    const originalPoint = beforeShape.points[index];
    if (!originalPoint) {
      return undefined;
    }
    const currentShape = shapeRef.current;
    const draggedPoint = currentShape.kind === 'polygon' ? currentShape.points[index] || originalPoint : originalPoint;
    const duplicatePoint = pointsNearlyEqual(draggedPoint, originalPoint) ? offsetDuplicatePoint(originalPoint) : draggedPoint;
    const duplicateIndex = index + 1;
    const duplicateShape: PolygonShape = {
      kind: 'polygon',
      points: [...beforeShape.points.slice(0, duplicateIndex), duplicatePoint, ...beforeShape.points.slice(duplicateIndex)],
    };
    const duplicateHandle: HandleTarget = { kind: 'polygon-point', index: duplicateIndex };
    insertPolygonPointColor(duplicateIndex, beforeShape.points.length);
    setHandleSelection(duplicateHandle);
    shapeRef.current = duplicateShape;
    setShape(duplicateShape);
    const target: DragTarget = {
      ...duplicateHandle,
      before: duplicateShape,
      polygonPointIndexes: [duplicateIndex],
      optionDuplicated: true,
      dragOrigin: { pointer: rawPoint, handle: duplicatePoint },
    };
    dragTargetRef.current = target;
    return target;
  };
  return { duplicateDraggedPolygonPoint };
}

export type EditorAfterPointDuplicateDragActions = EditorAfterMarqueeMoveActions & ReturnType<typeof pointDuplicateDragActions>;

// Following a handle drag.
export function handleDragActions(editor: EditorAfterPointDuplicateDragActions) {
  const { dragPointForTarget, shapeRef, circleRadiusAngleRef, setCircleRadiusAngle } = editor;
  const { syncInsetModifierMode, radiusUnlockKeyPressedRef, setShape, showSnapGuides } = editor;
  const { canvasRef, markLocalShapeChange, setActivePreset } = editor;
  // Moves the dragged handle to the pointer (snapped), writing the shape live.
  const dragShapeTo = (target: DragTarget, rawPoint: Point, event: PointerEvent) => {
    const dragPoint = dragPointForTarget(target, rawPoint);
    const snapResult = snapDragPointForTarget(shapeRef.current, target, dragPoint.x, dragPoint.y);
    const snappedPoint = snapResult.point;
    const { x, y } = snappedPoint;
    if (target.kind === 'circle-radius' && shapeRef.current.kind === 'circle') {
      const dx = x - shapeRef.current.cx;
      const dy = y - shapeRef.current.cy;
      if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) {
        const nextAngle = Math.atan2(dy, dx);
        circleRadiusAngleRef.current = nextAngle;
        setCircleRadiusAngle(nextAngle);
      }
    }
    const insetModifierMode = syncInsetModifierMode(event);
    const insetRadiusMode: InsetRadiusMode = insetModifierMode;
    const insetSideMode: InsetSideMode = insetModifierMode;
    const insetRadiusUnlocked = radiusUnlockKeyPressedRef.current;
    setShape((current) => {
      const dragShape =
        target.kind === 'polygon-point' && target.before.kind === 'polygon' && current.kind === 'polygon' && target.before.points.length > current.points.length
          ? target.before
          : current;
      const activeDragPoint = dragPointForTarget(target, rawPoint);
      const activeSnapResult = dragShape === shapeRef.current ? snapResult : snapDragPointForTarget(dragShape, target, activeDragPoint.x, activeDragPoint.y);
      showSnapGuides(activeSnapResult.guides);
      const point = activeSnapResult.point;
      const next = updateShapeForDrag(dragShape, target, point.x, point.y, {
        canvas: canvasRef.current ?? undefined,
        insetRadiusMode,
        insetRadiusUnlocked,
        insetSideMode,
        ellipseScaleProportional: event.shiftKey,
      });
      if (!shapesClose(dragShape, next)) {
        markLocalShapeChange();
        setActivePreset(matchPreset(next) || NONE_PRESET);
      }
      shapeRef.current = next;
      return next;
    });
  };
  return { dragShapeTo };
}

export type EditorAfterHandleDragActions = EditorAfterPointDuplicateDragActions & ReturnType<typeof handleDragActions>;

// The window's pointer moves during any drag.
export function pointerMoveActions(editor: EditorAfterHandleDragActions) {
  const { shapeTransformDragRef, updateShapeTransformDrag, polygonSelectionDragRef } = editor;
  const { updatePolygonSelectionDrag, dragTargetRef, canvasRef, activePointerIdRef } = editor;
  const { finishDrag, duplicateDraggedPolygonPoint, dragShapeTo } = editor;
  const onWindowPointerMove = (event: PointerEvent) => {
    if (shapeTransformDragRef.current && updateShapeTransformDrag(event)) {
      return;
    }
    if (polygonSelectionDragRef.current && updatePolygonSelectionDrag(event)) {
      return;
    }

    let target = dragTargetRef.current;
    if (!target || !canvasRef.current) {
      return;
    }
    if (activePointerIdRef.current !== undefined && event.pointerId !== activePointerIdRef.current) {
      return;
    }
    if (event.pointerType === 'mouse' && event.buttons === 0) {
      finishDrag();
      return;
    }
    const rect = canvasRef.current.getBoundingClientRect();
    const rawX = ((event.clientX - rect.left) / rect.width) * 100;
    const rawY = ((event.clientY - rect.top) / rect.height) * 100;
    const rawPoint = { x: rawX, y: rawY };

    if (target.kind === 'polygon-point' && event.altKey && !target.optionDuplicated && target.before.kind === 'polygon') {
      target = duplicateDraggedPolygonPoint(target.index, target.before, rawPoint) ?? target;
    }
    dragShapeTo(target, rawPoint, event);
  };
  return { onWindowPointerMove };
}

export type EditorAfterPointerMoveActions = EditorAfterHandleDragActions & ReturnType<typeof pointerMoveActions>;

// The window's pointer releases during any drag.
export function pointerEndActions(editor: EditorAfterPointerMoveActions) {
  const { shapeTransformDragRef, updateShapeTransformDrag, finishShapeTransformDrag } = editor;
  const { polygonSelectionDragRef, updatePolygonSelectionDrag } = editor;
  const { finishPolygonSelectionDrag, activePointerIdRef, finishDrag } = editor;
  const onWindowPointerUp = (event: PointerEvent) => {
    const shapeTransform = shapeTransformDragRef.current;
    if (shapeTransform) {
      if (event.pointerId !== shapeTransform.pointerId) {
        return;
      }
      updateShapeTransformDrag(event);
      finishShapeTransformDrag(true);
      return;
    }
    const selection = polygonSelectionDragRef.current;
    if (selection) {
      if (event.pointerId !== selection.pointerId) {
        return;
      }
      updatePolygonSelectionDrag(event);
      finishPolygonSelectionDrag(true);
      return;
    }
    if (activePointerIdRef.current !== undefined && event.pointerId !== activePointerIdRef.current) {
      return;
    }
    finishDrag(true, event);
  };
  const onWindowPointerCancel = (event: PointerEvent) => {
    const shapeTransform = shapeTransformDragRef.current;
    if (shapeTransform) {
      if (event.pointerId !== shapeTransform.pointerId) {
        return;
      }
      finishShapeTransformDrag(false);
      return;
    }
    const selection = polygonSelectionDragRef.current;
    if (selection) {
      if (event.pointerId !== selection.pointerId) {
        return;
      }
      finishPolygonSelectionDrag(false);
      return;
    }
    if (activePointerIdRef.current !== undefined && event.pointerId !== activePointerIdRef.current) {
      return;
    }
    finishDrag(false, event);
  };
  return { onWindowPointerUp, onWindowPointerCancel };
}

export type EditorAfterPointerEndActions = EditorAfterPointerMoveActions & ReturnType<typeof pointerEndActions>;

// The window pointer listeners for drags.
export function useWindowPointerListeners(editor: EditorAfterPointerEndActions) {
  const { shapeTransformDragRef, finishShapeTransformDrag, polygonSelectionDragRef } = editor;
  const { finishPolygonSelectionDrag, finishDrag, onWindowPointerMove, onWindowPointerUp } = editor;
  const { onWindowPointerCancel } = editor;
  const onWindowBlurDuringDrag = () => {
    if (shapeTransformDragRef.current) {
      finishShapeTransformDrag(false);
      return;
    }
    if (polygonSelectionDragRef.current) {
      finishPolygonSelectionDrag(false);
      return;
    }
    finishDrag(false);
  };

  // Window pointer listeners, registered once: they reach the current render's
  // handlers through this ref, so a drag always works with the latest state.
  const windowPointerHandlers = {
    onWindowPointerMove,
    onWindowPointerUp,
    onWindowPointerCancel,
    onWindowBlurDuringDrag,
  };
  const windowPointerRef = useRef(windowPointerHandlers);
  windowPointerRef.current = windowPointerHandlers;
  useEffect(() => {
    const onMove = (event: PointerEvent) => windowPointerRef.current.onWindowPointerMove(event);
    const onUp = (event: PointerEvent) => windowPointerRef.current.onWindowPointerUp(event);
    const onCancel = (event: PointerEvent) => windowPointerRef.current.onWindowPointerCancel(event);
    const onBlur = () => windowPointerRef.current.onWindowBlurDuringDrag();
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onBlur);
    };
  }, []);
  return { onWindowBlurDuringDrag, windowPointerHandlers, windowPointerRef };
}

export type EditorAfterWindowPointerListeners = EditorAfterPointerEndActions & ReturnType<typeof useWindowPointerListeners>;

// The shortcut-help target, and closing the menus and popovers on an outside press.
export function useDismissListeners(editor: EditorAfterWindowPointerListeners) {
  const { setShortcutHelpPortalTarget } = editor;
  useEffect(() => {
    setShortcutHelpPortalTarget(document.getElementById('clip-path_header-shortcuts') ?? undefined);
  }, [setShortcutHelpPortalTarget]);
}

// Clearing the selection on an outside press.
export function useDeselectListener(editor: EditorAfterWindowPointerListeners) {
  const { selectedHandleRef, isShapeTransformSelectedRef, dragTargetRef } = editor;
  const { shapeTransformDragRef, setShapeTransformSelection, selectHandle } = editor;
  const onDocumentPointerDownDeselect = (event: MouseEvent) => {
    if ((!selectedHandleRef.current && !isShapeTransformSelectedRef.current) || dragTargetRef.current || shapeTransformDragRef.current) {
      return;
    }
    const target = event.target;
    if (target instanceof Element && target.closest('.clip-path_handle')) {
      return;
    }
    if (target instanceof Element && target.closest('.clip-path_shape-move')) {
      return;
    }
    if (target instanceof Element && target.closest('.clip-path_shape-resize')) {
      return;
    }
    if (target instanceof Element && target.closest('.code-editor')) {
      return;
    }
    if (isShapeTransformSelectedRef.current) {
      setShapeTransformSelection(false);
    }
    selectHandle(undefined);
  };

  // A press anywhere but a handle, the shape, or the code clears the selection. Registered
  // once; the ref reaches the current render's handler.
  const documentPointerDownRef = useRef(onDocumentPointerDownDeselect);
  documentPointerDownRef.current = onDocumentPointerDownDeselect;
  useEffect(() => {
    const listener = (event: MouseEvent) => documentPointerDownRef.current(event);
    document.addEventListener('mousedown', listener);
    return () => document.removeEventListener('mousedown', listener);
  }, []);
  return { onDocumentPointerDownDeselect, documentPointerDownRef };
}

export type EditorAfterDeselectListener = EditorAfterWindowPointerListeners & ReturnType<typeof useDeselectListener>;

// Measuring the canvas and the space its handles may use.
export function useCanvasMeasure(editor: EditorAfterDeselectListener) {
  const { canvasRef, canvasWrapRef, setCanvasSize, setHandleBounds } = editor;
  useLayoutEffect(() => {
    const updateBounds = () => {
      const canvas = canvasRef.current;
      const wrap = canvasWrapRef.current;
      if (!canvas || !wrap) {
        return;
      }

      const canvasRect = canvas.getBoundingClientRect();
      if (canvasRect.width <= 0 || canvasRect.height <= 0) {
        return;
      }
      const nextSize = { width: canvasRect.width, height: canvasRect.height };
      setCanvasSize((current) =>
        current && Math.abs(current.width - nextSize.width) < 0.1 && Math.abs(current.height - nextSize.height) < 0.1 ? current : nextSize,
      );

      const wrapRect = wrap.getBoundingClientRect();
      const handleRadius = HANDLE_SIZE_PX / 2;
      const nextBounds = {
        minX: ((wrapRect.left - canvasRect.left + handleRadius) / canvasRect.width) * 100,
        maxX: ((wrapRect.right - canvasRect.left - handleRadius) / canvasRect.width) * 100,
        minY: ((wrapRect.top - canvasRect.top + handleRadius) / canvasRect.height) * 100,
        maxY: ((wrapRect.bottom - canvasRect.top - handleRadius) / canvasRect.height) * 100,
      };

      setHandleBounds((current) => (boundsClose(current, nextBounds) ? current : nextBounds));
    };

    updateBounds();

    let observer: ResizeObserver | undefined = undefined;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(updateBounds);
      if (canvasRef.current) {
        observer.observe(canvasRef.current);
      }
      if (canvasWrapRef.current) {
        observer.observe(canvasWrapRef.current);
      }
    }

    window.addEventListener('resize', updateBounds);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateBounds);
    };
  }, [canvasRef, canvasWrapRef, setCanvasSize, setHandleBounds]);
}

// Scrolling the preset list, the code text, and the shortcut keys.
export function useCodeSyncEffects(editor: EditorAfterDeselectListener) {
  const { isPresetOpen, presetListRef, activePreset, codeChangedShapeRef, setCodeValue } = editor;
  const { shape, css, getActivePolygonSelection, deleteSelectedPolygonPoints } = editor;
  const { duplicateSelectedPolygonPoint, undo, redo } = editor;
  useLayoutEffect(() => {
    if (!isPresetOpen) {
      return;
    }

    const list = presetListRef.current;
    const selectedOption = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    selectedOption?.scrollIntoView({ block: 'nearest' });
  }, [activePreset, isPresetOpen, presetListRef]);

  useEffect(() => {
    if (codeChangedShapeRef.current) {
      codeChangedShapeRef.current = false;
      return;
    }

    setCodeValue(formatCodeValue(shape));
  }, [css, shape, codeChangedShapeRef, setCodeValue]);

  const onShortcutKeyDown = (event: KeyboardEvent) => {
    const target = event.target instanceof HTMLElement ? event.target : undefined;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return;
    }
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();

    if (!mod && (key === 'backspace' || key === 'delete')) {
      if (getActivePolygonSelection().length) {
        event.preventDefault();
        deleteSelectedPolygonPoints();
      }
      return;
    }

    if (!mod) {
      return;
    }

    if (key === 'd' && !event.shiftKey) {
      if (duplicateSelectedPolygonPoint()) {
        event.preventDefault();
      }
      return;
    }

    if (key === 'z' && !event.shiftKey) {
      event.preventDefault();
      undo();
    } else if ((key === 'z' && event.shiftKey) || key === 'y') {
      event.preventDefault();
      redo();
    }
  };
  return { onShortcutKeyDown };
}

export type EditorAfterCodeSyncEffects = EditorAfterDeselectListener & ReturnType<typeof useCodeSyncEffects>;

// The keyboard shortcut and paste listeners.
export function useShortcutListeners(editor: EditorAfterCodeSyncEffects) {
  const { onShortcutKeyDown, shapeFitModeRef, parseClipboardSvgShape } = editor;
  const { applyPastedSvgClipPath, clearPastedShapeSvgCache } = editor;
  // Delete, duplicate, undo and redo from the keyboard. Registered once; the ref reaches
  // the current render's handler.
  const shortcutKeyRef = useRef(onShortcutKeyDown);
  shortcutKeyRef.current = onShortcutKeyDown;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => shortcutKeyRef.current(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  const onWindowPaste = (event: ClipboardEvent) => {
    if (!pasteTargetTakesSvg(event.target ?? undefined)) {
      return;
    }
    const text = event.clipboardData?.getData('text/plain') || '';
    const html = event.clipboardData?.getData('text/html') || '';
    const next = parseSvgClipPathPolygon(text) || parseSvgClipPathPolygon(html);
    if (!next) {
      const fitMode = shapeFitModeRef.current;
      const nextShape = parseClipboardSvgShape(text, html, fitMode);
      if (!nextShape) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      applyPastedSvgClipPath(nextShape.shape, {
        cacheUpdate: { cache: nextShape.cache },
        shapeFitMode: fitMode,
      });
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    clearPastedShapeSvgCache();
    applyPastedSvgClipPath(next);
  };

  // Pasting an SVG replaces the shape. Registered once, in the capture phase, so
  // the code editor's own paste never sees an SVG the shape takes; the ref reaches
  // the current render's handler. While the editor is open it claims ⌘V, or the
  // app would paste the copied element instead and no `paste` event would fire
  // with focus on the canvas (menuPasteClaim.ts).
  const windowPasteRef = useRef(onWindowPaste);
  windowPasteRef.current = onWindowPaste;
  useEffect(() => {
    const listener = (event: ClipboardEvent) => windowPasteRef.current(event);
    window.addEventListener('paste', listener, true);
    const releaseMenuPaste = claimMenuPaste();
    return () => {
      releaseMenuPaste();
      window.removeEventListener('paste', listener, true);
    };
  }, []);
  return { shortcutKeyRef, onWindowPaste, windowPasteRef };
}

// Where a pasted SVG becomes the shape: anywhere outside a text field, and in the
// editor's own code field, whose shortcut help has always said "Paste an SVG to make
// it editable". Any other field (the Size and Offset names, the class picker, the
// rest of the Style panel) gets the pasted text as typed text.
export function pasteTargetTakesSvg(target: EventTarget | undefined): boolean {
  if (!(target instanceof Element)) {
    return true;
  }
  if (target.closest(`#${CLIP_PATH_CODE_ID}`)) {
    return true;
  }
  if (target.closest('input, textarea, select, [contenteditable]')) {
    return false;
  }
  return !(target instanceof HTMLElement && target.isContentEditable);
}

export type EditorAfterShortcutListeners = EditorAfterCodeSyncEffects & ReturnType<typeof useShortcutListeners>;

// The window's key presses that move handles.
export function windowKeyDownActions(editor: EditorAfterShortcutListeners) {
  const { handledKeyboardEventsRef, isPresetOpenRef, selectedHandleRef } = editor;
  const { isShapeTransformSelectedRef, dragTargetRef, radiusUnlockKeyPressedRef } = editor;
  const { updateKeyboardModifierRefs, spaceKeyPressedRef, pressKeyboardMoveKey } = editor;
  const { pressShapeMoveKey } = editor;
  const onWindowKeyDown = (event: KeyboardEvent) => {
    if (handledKeyboardEventsRef.current.has(event)) {
      return;
    }
    if (event.metaKey || event.ctrlKey || isPresetOpenRef.current) {
      return;
    }

    const target = event.target instanceof HTMLElement ? event.target : undefined;
    const handle = selectedHandleRef.current;
    const shapeSelected = isShapeTransformSelectedRef.current;
    const shouldIgnore = isEditableTarget(target) && !dragTargetRef.current;
    const isHandleTarget = target instanceof Element && Boolean(target.closest('.clip-path_handle'));

    if (isRadiusUnlockKey(event.key, event.code)) {
      if (!shouldIgnore) {
        radiusUnlockKeyPressedRef.current = true;
        updateKeyboardModifierRefs({
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          radiusUnlocked: true,
        });
      }
      return;
    }

    if ((!handle && !shapeSelected) || shouldIgnore) {
      return;
    }

    if (isHandleTarget && (isSpaceKey(event.key, event.code) || isArrowKey(event.key))) {
      return;
    }

    updateKeyboardModifierRefs(event);

    if (isSpaceKey(event.key, event.code)) {
      event.preventDefault();
      spaceKeyPressedRef.current = true;
      return;
    }

    if (!isArrowKey(event.key)) {
      return;
    }

    event.preventDefault();
    if (handle) {
      pressKeyboardMoveKey(handle, event.key, event);
    } else {
      pressShapeMoveKey(event.key, event);
    }
  };
  return { onWindowKeyDown };
}
