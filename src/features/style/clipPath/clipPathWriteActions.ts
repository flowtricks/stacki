// Writing the shape out, the last stages of the pipeline: the throttled
// writer and its flush to the embed or the designer, timers, starting a point
// edit, marquee, transform or drag, and the geometry the canvas draws
// (ClipPath.tsx).

import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import type { StyleHandle, WebflowApi } from './webflowDesigner';
import {
  type CornerName,
  type ClipShape,
  type HandleTarget,
  type DragTarget,
  type ShapeResizeCorner,
  type ShapeTransformDrag,
  type ShapeFitMode,
} from './clipPathTypes';
import { readWebflowApi, WRITE_THROTTLE_MS, NONE_PRESET } from './clipPathConstants';
import { clampValue } from './clipPathMeasure';
import {
  makeInsetRadii,
  hasRoundedCorners,
  isInsetHandleAffected,
  handlesMatch,
  isPolygonPointHandle,
  previousSurvivingPolygonIndex,
  remapPolygonIndexAfterDelete,
  handleKey,
  handleFromDragTarget,
  HANDLE_COLOR_CLASSES,
  handleColorClass,
  polygonPointColorClass,
  normalizePolygonPointColors,
} from './clipPathHandles';
import { hasContainerQueryUnit } from './shapeFunctionPatterns';
import { shapeCssBounds } from './shapeFunctionModel';
import { PRESETS, PRESET_NAMES, addPreviewVariableFallbacks, previewCssCoordinateToken } from './clipPathFormat';
import { insetRadiusToCanvas } from './clipPathCanvasUnits';
import { isNoneClipPathValue } from './svgContours';
import { presetOptionId } from './clipPathShortcuts';
import { isSpaceKey, stopKeyboardEvent, isArrowKey } from './shapeKeyboard';
import { writeClipPathToStyle, canWriteClipPathValue, getStyleNamePath } from './clipPathStyleRead';
import { styleOptionsForBreakpoint, resolveWritableClipPathStyleForElement, resolveOrCreateStyleForClassPath } from './clipPathStyleWrite';
import { type EditorAfterWindowKeyListeners } from './clipPathSelectionRead';

// Writing the clip-path.
export function useClipPathWrite(editor: EditorAfterWindowKeyListeners) {
  const { styleRef, onApplyRef, css, localWritePendingRef, lastWrittenRef, writeTimerRef } = editor;
  // The flush runs after this render is gone; it reads the editor through this ref.
  const writerRef = useRef(editor);
  writerRef.current = editor;
  useEffect(() => {
    const style = styleRef.current;
    const webflowApi = readWebflowApi();
    const canResolveSelectedStyle = webflowApi !== undefined;
    // Embedded mode (onApply): the parent panel owns the write target, so the tool's own
    // ability to reach a Webflow style handle says nothing about whether the value can be
    // written. Without this the gate below returned early every time outside the
    // Designer — the flush that calls onApply was never reached, so editing a shape did
    // nothing at all.
    if (!onApplyRef.current && !canWriteClipPathValue(style, css) && !canResolveSelectedStyle) {
      localWritePendingRef.current = false;
      return;
    }
    if (lastWrittenRef.current === css) {
      localWritePendingRef.current = false;
      return;
    }
    if (writeTimerRef.current !== undefined) {
      return;
    }
    scheduleClipPathFlush(writerRef, webflowApi);
  }, [css, styleRef, onApplyRef, localWritePendingRef, lastWrittenRef, writeTimerRef]);
}

// What a clip-path write reads and records.
export type ClipPathWriter = EditorAfterWindowKeyListeners;

// Writes the latest CSS once the throttle has passed.
export function scheduleClipPathFlush(writerRef: MutableRefObject<ClipPathWriter>, webflowApi: WebflowApi | undefined): void {
  writerRef.current.writeTimerRef.current = window.setTimeout(() => {
    // Nothing to handle here: the flush catches its own failures, and a failed
    // write is retried by the next change.
    void flushClipPathWrite(writerRef, webflowApi);
  }, WRITE_THROTTLE_MS);
}

// Writes the latest CSS, then schedules another write if it changed meanwhile.
export async function flushClipPathWrite(writerRef: MutableRefObject<ClipPathWriter>, webflowApi: WebflowApi | undefined): Promise<void> {
  const writer = writerRef.current;
  const valueToWrite = writer.latestCssRef.current;
  writer.writeTimerRef.current = undefined;
  if (writer.lastWrittenRef.current === valueToWrite) {
    return;
  }
  const settled = writer.onApplyRef.current ? applyClipPathToEmbed(writer, valueToWrite) : await writeClipPathToWebflow(writer, webflowApi, valueToWrite);
  if (settled === 'stop') {
    return;
  }
  if (writer.latestCssRef.current !== writer.lastWrittenRef.current && writer.writeTimerRef.current === undefined) {
    scheduleClipPathFlush(writerRef, webflowApi);
  }
}

// Embedded mode: the parent style panel owns the write target (the user's selected
// selector + breakpoint), so hand it the raw value and skip all of the tool's own
// class/style resolution.
export function applyClipPathToEmbed(writer: ClipPathWriter, valueToWrite: string): 'continue' {
  const { lastWrittenRef, localWritePendingRef } = writer;
  try {
    if (isNoneClipPathValue(valueToWrite)) {
      writer.onClearRef.current?.();
    } else {
      writer.onApplyRef.current?.(valueToWrite);
    }
  } catch {
    /* parent write failed — next change retries */
  }
  lastWrittenRef.current = valueToWrite;
  writer.setClipPathStyleOrigin(isNoneClipPathValue(valueToWrite) ? 'none' : 'current');
  writer.setAppliedClassName(undefined);
  localWritePendingRef.current = writer.latestCssRef.current !== valueToWrite;
  return 'continue';
}

// Writes to the element's clip-path style in the Designer, resolving (or creating)
// the style first when the one in hand can't take the value. 'stop' when there is
// nothing that can.
export async function writeClipPathToWebflow(writer: ClipPathWriter, webflowApi: WebflowApi | undefined, valueToWrite: string): Promise<'continue' | 'stop'> {
  const { localWritePendingRef, pastedShapeSvgCacheRef, lastWrittenRef } = writer;
  try {
    const targetStyle = await resolveClipPathWriteTarget(writer, webflowApi, valueToWrite);
    if (!canWriteClipPathValue(targetStyle, valueToWrite)) {
      localWritePendingRef.current = false;
      return 'stop';
    }
    if (targetStyle) {
      const shapeSvgCache = writer.matchingPastedSvgCacheForShape(writer.shapeRef.current);
      if (shapeSvgCache) {
        pastedShapeSvgCacheRef.current = shapeSvgCache;
      }
      const styleOptions = styleOptionsForBreakpoint(writer.activeBreakpointRef.current);
      await writeClipPathToStyle(targetStyle, valueToWrite, {
        ...(shapeSvgCache ? { shapeSvgCache } : {}),
        ...(styleOptions ? { styleOptions } : {}),
      });
    }
    lastWrittenRef.current = valueToWrite;
    await recordClipPathWrite(writer, targetStyle, valueToWrite);
    localWritePendingRef.current = writer.latestCssRef.current !== valueToWrite;
  } catch {
    localWritePendingRef.current = false;
    /* swallow — next change will retry */
  }
  return 'continue';
}

// The style a write lands on: the one in hand when it can take the value; else, in
// class-selection mode, the exact selected class/combo (created if it doesn't exist
// — never the element's own combo); else the element's writable clip-path style.
export async function resolveClipPathWriteTarget(
  writer: ClipPathWriter,
  webflowApi: WebflowApi | undefined,
  valueToWrite: string,
): Promise<StyleHandle | undefined> {
  const { styleRef } = writer;
  let targetStyle = styleRef.current;
  const selectedNames = writer.selectedClassNamesRef.current;
  if (selectedNames.length && webflowApi && !canWriteClipPathValue(targetStyle, valueToWrite)) {
    targetStyle = await resolveOrCreateStyleForClassPath(selectedNames, webflowApi);
    if (targetStyle) {
      styleRef.current = targetStyle;
    }
  } else if (!selectedNames.length && !canWriteClipPathValue(targetStyle, valueToWrite) && webflowApi) {
    targetStyle = await resolveWritableClipPathStyleForElement(
      (await webflowApi.getSelectedElement?.()) || undefined,
      webflowApi,
      valueToWrite,
      styleOptionsForBreakpoint(writer.activeBreakpointRef.current),
    );
    if (targetStyle) {
      styleRef.current = targetStyle;
    }
  }
  return targetStyle;
}

// After a write: the label's origin (none, or set at this breakpoint) and the class
// it was written to.
export async function recordClipPathWrite(writer: ClipPathWriter, targetStyle: StyleHandle | undefined, valueToWrite: string): Promise<void> {
  const nextOrigin = isNoneClipPathValue(valueToWrite) && !styleOptionsForBreakpoint(writer.activeBreakpointRef.current) ? 'none' : 'current';
  writer.setClipPathStyleOrigin(nextOrigin);
  if (nextOrigin === 'current' && targetStyle) {
    const writtenStyleNamePath = await getStyleNamePath(targetStyle);
    writer.setAppliedClassName(writtenStyleNamePath[writtenStyleNamePath.length - 1] || undefined);
  } else {
    writer.setAppliedClassName(undefined);
  }
}

// Clearing the timers on unmount, the preset option ids, and handle classes.
export function useTimerCleanup(editor: EditorAfterWindowKeyListeners) {
  const { writeTimerRef, presetTypeaheadTimerRef, codeTransitionTimerRef } = editor;
  const { stopKeyboardMoveLoop, activePreset, shape, activePresetIndex } = editor;
  const { codeHandleColorClasses, polygonPointColors, selectedHandle } = editor;
  const { selectedCodeHandles, activeInsetModifierMode } = editor;
  // The cleanup runs once, on unmount; it stops the loop through the latest render's
  // handler.
  const stopKeyboardMoveLoopRef = useRef(stopKeyboardMoveLoop);
  stopKeyboardMoveLoopRef.current = stopKeyboardMoveLoop;
  useEffect(() => {
    const stopLatestKeyboardMoveLoop = () => stopKeyboardMoveLoopRef.current();
    return () => {
      if (writeTimerRef.current !== undefined) {
        window.clearTimeout(writeTimerRef.current);
        writeTimerRef.current = undefined;
      }
      if (presetTypeaheadTimerRef.current !== undefined) {
        window.clearTimeout(presetTypeaheadTimerRef.current);
        presetTypeaheadTimerRef.current = undefined;
      }
      if (codeTransitionTimerRef.current !== undefined) {
        window.clearTimeout(codeTransitionTimerRef.current);
        codeTransitionTimerRef.current = undefined;
      }
      stopLatestKeyboardMoveLoop();
    };
  }, [writeTimerRef, presetTypeaheadTimerRef, codeTransitionTimerRef]);

  const selectedPresetShape = PRESETS[activePreset] || shape;
  const activePresetOptionName = PRESET_NAMES[activePresetIndex] || PRESET_NAMES[0] || NONE_PRESET;
  const activePresetOptionId = presetOptionId(activePresetOptionName);
  const handleDisplayColorClass = (handle: HandleTarget) => {
    const codeColorClass = codeHandleColorClasses.get(handleKey(handle));
    if (codeColorClass) {
      return codeColorClass;
    }
    if (handle.kind === 'polygon-point') {
      return polygonPointColorClass(handle.index, polygonPointColors);
    }
    if (handle.kind === 'inset-radius' && shape.kind === 'inset' && !hasRoundedCorners(shape.radii)) {
      return HANDLE_COLOR_CLASSES[4];
    }
    return handleColorClass(handle);
  };
  const handleClassName = (handle: HandleTarget, extra?: string) =>
    [
      'clip-path_handle',
      handleDisplayColorClass(handle),
      extra,
      handlesMatch(selectedHandle, handle) || selectedCodeHandles.some((selected) => handlesMatch(selected, handle)) ? 'is-selected' : '',
      isInsetHandleAffected(selectedHandle, handle, activeInsetModifierMode) ? 'is-affected' : '',
    ]
      .filter(Boolean)
      .join(' ');
  const isHandleSelected = (handle: HandleTarget) =>
    handlesMatch(selectedHandle, handle) || selectedCodeHandles.some((selected) => handlesMatch(selected, handle));
  return {
    selectedPresetShape,
    activePresetOptionName,
    activePresetOptionId,
    handleDisplayColorClass,
    handleClassName,
    isHandleSelected,
  };
}

export type EditorAfterTimerCleanup = EditorAfterWindowKeyListeners & ReturnType<typeof useTimerCleanup>;

// Adding and removing polygon points.
export function pointEditActions(editor: EditorAfterTimerCleanup) {
  const { canvasRef, shape, markLocalShapeChange, insertPolygonPointColor, setShape } = editor;
  const { shapeRef, commit, setActivePreset, polygonPointColorsRef, setHandleSelection } = editor;
  const { syncPolygonPointColors, focusSelectedHandle } = editor;
  const onAddPoint = (event: React.MouseEvent) => {
    if (!canvasRef.current || shape.kind !== 'polygon') {
      return;
    }
    markLocalShapeChange();
    const rect = canvasRef.current.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 100;
    const y = ((event.clientY - rect.top) / rect.height) * 100;
    insertPolygonPointColor(shape.points.length, shape.points.length);
    setShape((current) => {
      if (current.kind !== 'polygon') {
        return current;
      }
      const next: ClipShape = { kind: 'polygon', points: [...current.points, { x, y }] };
      shapeRef.current = next;
      commit(next);
      return next;
    });
    setActivePreset('Polygon');
  };

  const onRemovePoint = (index: number) => {
    if (shape.kind !== 'polygon' || shape.points.length <= 3) {
      return;
    }
    const indexesToDelete = new Set([index]);
    const previousOldIndex = previousSurvivingPolygonIndex(shape.points.length, indexesToDelete, index);
    const previousNewIndex = previousOldIndex === undefined ? undefined : remapPolygonIndexAfterDelete(previousOldIndex, indexesToDelete);
    const nextSelectedHandle: HandleTarget | undefined = previousNewIndex === undefined ? undefined : { kind: 'polygon-point', index: previousNewIndex };
    const next: ClipShape = {
      kind: 'polygon',
      points: shape.points.filter((_, i) => i !== index),
    };
    const nextColors = normalizePolygonPointColors(shape.points.length, polygonPointColorsRef.current).filter((_, i) => i !== index);

    markLocalShapeChange();
    setHandleSelection(nextSelectedHandle);
    syncPolygonPointColors(nextColors);
    shapeRef.current = next;
    setShape(next);
    commit(next);
    setActivePreset('Polygon');
    if (nextSelectedHandle) {
      focusSelectedHandle();
    }
  };
  return { onAddPoint, onRemovePoint };
}

export type EditorAfterPointEditActions = EditorAfterTimerCleanup & ReturnType<typeof pointEditActions>;

// Starting a marquee selection.
export function marqueeStartActions(editor: EditorAfterPointEditActions) {
  const { dragTargetRef, polygonSelectionDragRef, shapeRef, canvasPointFromClient } = editor;
  const { cancelPendingSelectionRead, closePresetDropdown, stopCodeTransition } = editor;
  const { stopKeyboardMoveLoop, selectedHandlesRef, setSelectionRect, activePointerIdRef } = editor;
  const { activePointerCaptureRef, finishPolygonSelectionDrag } = editor;
  const beginPolygonSelectionDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    if (dragTargetRef.current || polygonSelectionDragRef.current) {
      return;
    }
    if (shapeRef.current.kind !== 'polygon') {
      return;
    }
    if (event.target instanceof Element && event.target.closest('.clip-path_handle')) {
      return;
    }

    const start = canvasPointFromClient(event.clientX, event.clientY);
    if (!start) {
      return;
    }

    cancelPendingSelectionRead();
    closePresetDropdown();
    stopCodeTransition();
    stopKeyboardMoveLoop();
    const baseHandles = event.shiftKey ? selectedHandlesRef.current.filter(isPolygonPointHandle) : [];

    polygonSelectionDragRef.current = {
      pointerId: event.pointerId,
      start,
      current: start,
      startClient: { x: event.clientX, y: event.clientY },
      didMove: false,
      additive: event.shiftKey,
      baseHandles,
    };
    setSelectionRect(undefined);
    activePointerIdRef.current = event.pointerId;
    activePointerCaptureRef.current = event.currentTarget;

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.addEventListener('lostpointercapture', () => finishPolygonSelectionDrag(false), { once: true });
    } catch {
      /* setPointerCapture can fail if the host has already cancelled the pointer */
    }
  };
  return { beginPolygonSelectionDrag };
}

export type EditorAfterMarqueeStartActions = EditorAfterPointEditActions & ReturnType<typeof marqueeStartActions>;

// Starting a shape move or resize.
export function transformStartActions(editor: EditorAfterMarqueeStartActions) {
  const { dragTargetRef, polygonSelectionDragRef, shapeTransformDragRef, shapeRef } = editor;
  const { shapeFitModeRef, canvasPointFromClient, cancelPendingSelectionRead } = editor;
  const { closePresetDropdown, clearPastedShapeSvgCache, selectHandle } = editor;
  const { stopCodeTransition, stopKeyboardMoveLoop, setShapeTransformSelection } = editor;
  const { currentShapeScaleOptions, activePointerIdRef, activePointerCaptureRef } = editor;
  const { finishShapeTransformDrag } = editor;
  const beginShapeTransformDrag = (mode: ShapeTransformDrag['mode'], corner?: ShapeResizeCorner) => (event: React.PointerEvent<HTMLElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    if (dragTargetRef.current || polygonSelectionDragRef.current || shapeTransformDragRef.current) {
      return;
    }

    const currentShape = shapeRef.current;
    if (currentShape.kind !== 'shape') {
      return;
    }
    if (shapeFitModeRef.current === 'stretch' && !hasContainerQueryUnit(currentShape.value)) {
      return;
    }

    const start = canvasPointFromClient(event.clientX, event.clientY);
    const bounds = shapeCssBounds(currentShape);
    if (!start || !bounds) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    cancelPendingSelectionRead();
    closePresetDropdown();
    clearPastedShapeSvgCache();
    selectHandle(undefined);
    stopCodeTransition();
    stopKeyboardMoveLoop();
    setShapeTransformSelection(true);

    const fitMode: ShapeFitMode = shapeFitModeRef.current === 'contain' || hasContainerQueryUnit(currentShape.value) ? 'contain' : 'stretch';
    shapeTransformDragRef.current = {
      pointerId: event.pointerId,
      mode,
      ...(corner ? { corner } : {}),
      start,
      before: currentShape,
      bounds,
      fitMode,
      scaleOptions: currentShapeScaleOptions(),
    };
    activePointerIdRef.current = event.pointerId;
    activePointerCaptureRef.current = event.currentTarget;

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.addEventListener('lostpointercapture', () => finishShapeTransformDrag(false), { once: true });
    } catch {
      /* setPointerCapture can fail if the host has already cancelled the pointer */
    }
  };
  return { beginShapeTransformDrag };
}

export type EditorAfterTransformStartActions = EditorAfterMarqueeStartActions & ReturnType<typeof transformStartActions>;

// Starting a handle drag.
export function dragStartActions(editor: EditorAfterTransformStartActions) {
  const { canvasPointFromClient, cancelPendingSelectionRead, duplicatePolygonPoint } = editor;
  const { setHandleSelection, selectHandleFromPointer, polygonDisplayProjectionsRef } = editor;
  const { syncInsetModifierMode, stopCodeTransition, dragTargetRef, targetWithDragOrigin } = editor;
  const { activePointerIdRef, activePointerCaptureRef, finishDrag } = editor;
  const beginDrag = (target: DragTarget) => (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    const pointerStart = canvasPointFromClient(event.clientX, event.clientY);
    if (!pointerStart) {
      return;
    }

    event.preventDefault();
    cancelPendingSelectionRead();
    event.currentTarget.focus({ preventScroll: true });
    let handle = handleFromDragTarget(target);
    let dragStartTarget = target;
    let nextSelection: HandleTarget[];

    if (target.kind === 'polygon-point' && event.altKey) {
      const duplicate = duplicatePolygonPoint(target.index, {
        commitChange: false,
        selectDuplicate: false,
      });
      if (duplicate) {
        handle = duplicate.handle;
        dragStartTarget = { ...duplicate.handle, before: duplicate.shape, optionDuplicated: true };
        setHandleSelection(duplicate.handle);
        nextSelection = [duplicate.handle];
      } else {
        nextSelection = selectHandleFromPointer(handle, { additive: event.shiftKey });
      }
    } else {
      nextSelection = selectHandleFromPointer(handle, { additive: event.shiftKey });
    }

    const selectedPolygonIndexes = isPolygonPointHandle(handle) ? nextSelection.filter(isPolygonPointHandle).map((selected) => selected.index) : undefined;
    const nextTarget = selectedPolygonIndexes?.length ? { ...dragStartTarget, polygonPointIndexes: selectedPolygonIndexes } : dragStartTarget;

    if (nextTarget.kind === 'polygon-point') {
      const projectionIndexes = nextTarget.polygonPointIndexes || [nextTarget.index];
      projectionIndexes.forEach((index) => {
        polygonDisplayProjectionsRef.current.delete(index);
      });
    }
    syncInsetModifierMode(event);
    stopCodeTransition();
    dragTargetRef.current = targetWithDragOrigin(nextTarget, pointerStart);
    activePointerIdRef.current = event.pointerId;
    activePointerCaptureRef.current = event.currentTarget;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.addEventListener('lostpointercapture', () => finishDrag(false), {
        once: true,
      });
    } catch {
      /* setPointerCapture can fail if the host has already cancelled the pointer */
    }
  };
  return { beginDrag };
}

export type EditorAfterDragStartActions = EditorAfterTransformStartActions & ReturnType<typeof dragStartActions>;

// The handles' keys, and where the inset handles sit.
export function handleGeometry(editor: EditorAfterDragStartActions) {
  const { handledKeyboardEventsRef, selectHandleForKeyboard, spaceKeyPressedRef } = editor;
  const { pressKeyboardMoveKey, updateKeyboardModifierRefs, releaseKeyboardMoveKey } = editor;
  const { shape } = editor;
  const onHandleKeyDown = (handle: HandleTarget) => (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (isSpaceKey(event.key, event.code)) {
      handledKeyboardEventsRef.current.add(event.nativeEvent);
      stopKeyboardEvent(event);
      selectHandleForKeyboard(handle);
      spaceKeyPressedRef.current = true;
      return;
    }

    if (!isArrowKey(event.key) || event.metaKey || event.ctrlKey) {
      return;
    }
    handledKeyboardEventsRef.current.add(event.nativeEvent);
    stopKeyboardEvent(event);
    pressKeyboardMoveKey(handle, event.key, event);
  };

  const onHandleKeyUp = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (isSpaceKey(event.key, event.code)) {
      handledKeyboardEventsRef.current.add(event.nativeEvent);
      stopKeyboardEvent(event);
      spaceKeyPressedRef.current = false;
      return;
    }

    updateKeyboardModifierRefs(event);
    if (!isArrowKey(event.key)) {
      return;
    }

    handledKeyboardEventsRef.current.add(event.nativeEvent);
    stopKeyboardEvent(event);
    releaseKeyboardMoveKey(event.key, event);
  };

  const insetWidth = shape.kind === 'inset' ? 100 - shape.left - shape.right : 0;
  const insetHeight = shape.kind === 'inset' ? 100 - shape.top - shape.bottom : 0;
  const insetCenterX = shape.kind === 'inset' ? shape.left + insetWidth / 2 : 0;
  const insetCenterY = shape.kind === 'inset' ? shape.top + insetHeight / 2 : 0;
  const insetRadii = shape.kind === 'inset' ? shape.radii : makeInsetRadii(0);
  const insetRadiusHandlePosition = (corner: CornerName) => {
    const radius = insetRadii[corner];
    if (shape.kind !== 'inset') {
      return { x: 0, y: 0 };
    }
    const canvasRadius = insetRadiusToCanvas(shape, radius);
    if (corner === 'topLeft') {
      return { x: shape.left + canvasRadius.x, y: shape.top + canvasRadius.y };
    }
    if (corner === 'topRight') {
      return { x: 100 - shape.right - canvasRadius.x, y: shape.top + canvasRadius.y };
    }
    if (corner === 'bottomRight') {
      return { x: 100 - shape.right - canvasRadius.x, y: 100 - shape.bottom - canvasRadius.y };
    }
    return { x: shape.left + canvasRadius.x, y: 100 - shape.bottom - canvasRadius.y };
  };
  return {
    onHandleKeyDown,
    onHandleKeyUp,
    insetWidth,
    insetHeight,
    insetCenterX,
    insetCenterY,
    insetRadii,
    insetRadiusHandlePosition,
  };
}

export type EditorAfterHandleGeometry = EditorAfterDragStartActions & ReturnType<typeof handleGeometry>;

// Where the circle handle and the shape bounds sit, and the source label.
export function renderGeometry(editor: EditorAfterHandleGeometry) {
  const { shape, circleRadiusAngle, handleBounds, canvasSize, clipPathStyleOrigin } = editor;
  const { selectedClassNames } = editor;
  const circleRadiusHandleX = shape.kind === 'circle' ? shape.cx + Math.cos(circleRadiusAngle) * shape.radius : 0;
  const circleRadiusHandleY = shape.kind === 'circle' ? shape.cy + Math.sin(circleRadiusAngle) * shape.radius : 0;
  const handlePositionStyle = (x: number, y: number) => {
    const nextX = handleBounds && handleBounds.minX <= handleBounds.maxX ? clampValue(x, handleBounds.minX, handleBounds.maxX) : x;
    const nextY = handleBounds && handleBounds.minY <= handleBounds.maxY ? clampValue(y, handleBounds.minY, handleBounds.maxY) : y;
    return { left: `${nextX}%`, top: `${nextY}%` };
  };
  const handleCssPositionStyle = (x: string, y: string) => {
    const previewX = canvasSize ? previewCssCoordinateToken(x, 'x', canvasSize) : addPreviewVariableFallbacks(x);
    const previewY = canvasSize ? previewCssCoordinateToken(y, 'y', canvasSize) : addPreviewVariableFallbacks(y);
    const left = handleBounds && handleBounds.minX <= handleBounds.maxX ? `clamp(${handleBounds.minX}%, ${previewX}, ${handleBounds.maxX}%)` : previewX;
    const top = handleBounds && handleBounds.minY <= handleBounds.maxY ? `clamp(${handleBounds.minY}%, ${previewY}, ${handleBounds.maxY}%)` : previewY;
    return { left, top };
  };
  const activeShapeBounds = shape.kind === 'shape' ? shapeCssBounds(shape) : undefined;
  const shapeBoundsStyle = activeShapeBounds
    ? {
        left: `${activeShapeBounds.left}%`,
        top: `${activeShapeBounds.top}%`,
        width: `${activeShapeBounds.width}%`,
        height: `${activeShapeBounds.height}%`,
      }
    : undefined;

  const clipPathLabelClassName = [
    'clip-path_control-label',
    clipPathStyleOrigin === 'current' ? 'is-current' : '',
    clipPathStyleOrigin === 'inherited' ? 'is-inherited' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const selectedSelector = selectedClassNames.length ? selectedClassNames.map((name) => `.${name}`).join('') : undefined;
  return {
    circleRadiusHandleX,
    circleRadiusHandleY,
    handlePositionStyle,
    handleCssPositionStyle,
    activeShapeBounds,
    shapeBoundsStyle,
    clipPathLabelClassName,
    selectedSelector,
  };
}

export type EditorAfterRenderGeometry = EditorAfterHandleGeometry & ReturnType<typeof renderGeometry>;

// The editor as the view components read it.
export type ClipPathEditor = EditorAfterRenderGeometry;
export type EditorProps = { editor: ClipPathEditor };
