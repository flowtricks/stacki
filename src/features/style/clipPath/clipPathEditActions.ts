// Editing actions, the next stages of the pipeline: pointer and polygon
// selection, drag support and finishing, transforms, loading a selection,
// history, deleting and duplicating points, choosing a preset or breakpoint,
// and edits typed in the code view (ClipPath.tsx).

import { type Point, type ClipShape, type KeyboardModifiers, type HandleTarget, type PolygonSelectionDrag, type ShapeTransformDrag } from './clipPathTypes';
import {
  DEFAULT_SHAPE_SCALE_VARIABLE_NAME,
  DEFAULT_SHAPE_OFFSET_LEFT_VARIABLE_NAME,
  DEFAULT_SHAPE_OFFSET_TOP_VARIABLE_NAME,
  DEFAULT_SHAPE_SCALE_OPTIONS,
  HISTORY_LIMIT,
  SVG_POINT_EPSILON,
  NONE_SHAPE,
} from './clipPathConstants';
import { clampValue, rectFromPoints, pointInRect, snappedShapeMoveDelta, polygonHandleDisplayPoint, offsetDuplicatePoint } from './clipPathMeasure';
import {
  isInsetHandle,
  shapesClose,
  isPolygonPointHandle,
  handleListIncludes,
  uniqueHandles,
  previousSurvivingPolygonIndex,
  remapPolygonIndexAfterDelete,
  normalizePolygonPointColors,
} from './clipPathHandles';
import {
  containModelFromShape,
  shapeFromContainModel,
  moveContainModel,
  resizeContainModel,
  cacheFromShapeFitVariants,
  transformShapeCanvasPoints,
  shapeResizeCornerPoint,
  oppositeShapeResizeCorner,
  parseClipPathInput,
} from './shapeFunctionModel';
import { PRESETS, PRESET_NAMES, formatClipPath, formatCodeValue } from './clipPathFormat';
import { writePastedShapeMetadata } from './clipPathStyleRead';
import { styleOptionsForBreakpoint } from './clipPathStyleWrite';
import { type EditorAfterPastedCacheActions, handleSelectionActions } from './clipPathEditorState';

export type EditorAfterHandleSelectionActions = EditorAfterPastedCacheActions & ReturnType<typeof handleSelectionActions>;

// Selecting handles from the pointer and the keyboard.
export function pointerSelectionActions(editor: EditorAfterHandleSelectionActions) {
  const { selectedHandlesRef, setHandleSelection, selectedHandleRef, setSelectedHandle } = editor;
  const { selectHandle, canvasRef } = editor;
  const selectHandleFromPointer = (handle: HandleTarget, { additive }: { additive: boolean }) => {
    if (isPolygonPointHandle(handle)) {
      const selectedPolygonHandles = selectedHandlesRef.current.filter(isPolygonPointHandle);
      if (additive) {
        const nextHandles = uniqueHandles([...selectedPolygonHandles, handle]);
        setHandleSelection(handle, nextHandles);
        return nextHandles;
      }

      if (selectedPolygonHandles.length > 1 && handleListIncludes(selectedPolygonHandles, handle)) {
        setHandleSelection(handle, selectedPolygonHandles);
        return selectedPolygonHandles;
      }
    }

    setHandleSelection(handle);
    return [handle];
  };

  const selectHandleForKeyboard = (handle: HandleTarget) => {
    if (handleListIncludes(selectedHandlesRef.current, handle)) {
      selectedHandleRef.current = handle;
      setSelectedHandle(handle);
      return;
    }

    selectHandle(handle);
  };

  const canvasPointFromClient = (clientX: number, clientY: number): Point | undefined => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return undefined;
    }
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return undefined;
    }
    return {
      x: ((clientX - rect.left) / rect.width) * 100,
      y: ((clientY - rect.top) / rect.height) * 100,
    };
  };
  return { selectHandleFromPointer, selectHandleForKeyboard, canvasPointFromClient };
}

export type EditorAfterPointerSelectionActions = EditorAfterHandleSelectionActions & ReturnType<typeof pointerSelectionActions>;

// The marquee selection of polygon points.
export function polygonSelectionActions(editor: EditorAfterPointerSelectionActions) {
  const { handleBoundsRef, polygonDisplayProjectionsRef, shapeRef, setHandleSelection } = editor;
  const polygonDisplayPointForSelection = (points: Point[], index: number): Point => {
    const display = polygonHandleDisplayPoint(points, index, handleBoundsRef.current, polygonDisplayProjectionsRef.current.get(index)).point;
    const bounds = handleBoundsRef.current;
    if (!bounds || bounds.minX > bounds.maxX || bounds.minY > bounds.maxY) {
      return display;
    }
    return {
      x: clampValue(display.x, bounds.minX, bounds.maxX),
      y: clampValue(display.y, bounds.minY, bounds.maxY),
    };
  };

  const applyPolygonSelectionRect = (selection: PolygonSelectionDrag) => {
    const current = shapeRef.current;
    if (current.kind !== 'polygon') {
      return;
    }

    const rect = rectFromPoints(selection.start, selection.current);
    const selectedByRect = current.points
      .map((_, index) => ({ kind: 'polygon-point' as const, index }))
      .filter((handle) => pointInRect(polygonDisplayPointForSelection(current.points, handle.index), rect));
    const validBaseHandles = selection.baseHandles.filter((handle) => handle.index >= 0 && handle.index < current.points.length);
    const nextHandles = selection.additive ? uniqueHandles([...validBaseHandles, ...selectedByRect]) : selectedByRect;
    const nextPrimary = selectedByRect[selectedByRect.length - 1] || nextHandles[nextHandles.length - 1] || undefined;

    setHandleSelection(nextPrimary, nextHandles);
  };

  const focusSelectedHandle = () => {
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>('.clip-path_handle.is-selected')?.focus({ preventScroll: true });
    });
  };
  return { polygonDisplayPointForSelection, applyPolygonSelectionRect, focusSelectedHandle };
}

export type EditorAfterPolygonSelectionActions = EditorAfterPointerSelectionActions & ReturnType<typeof polygonSelectionActions>;

// Pointer capture, the undo commit, and closing what a drag leaves open.
export function dragSupportActions(editor: EditorAfterPolygonSelectionActions) {
  const { activePointerIdRef, activePointerCaptureRef, historyRef, historyIndexRef } = editor;
  const { setIsPresetOpen, codeTransitionTimerRef, setIsCodeTransitioning } = editor;
  const releaseActivePointerCapture = () => {
    const pointerId = activePointerIdRef.current;
    const captureTarget = activePointerCaptureRef.current;
    if (pointerId !== undefined && captureTarget?.hasPointerCapture?.(pointerId)) {
      try {
        captureTarget.releasePointerCapture(pointerId);
      } catch {
        /* pointer capture can already be gone after pointerup/cancel */
      }
    }
    activePointerIdRef.current = undefined;
    activePointerCaptureRef.current = undefined;
  };
  const commit = (next: ClipShape) => {
    const current = historyRef.current[historyIndexRef.current];
    if (current && shapesClose(current, next)) {
      return;
    }
    const truncated = historyRef.current.slice(0, historyIndexRef.current + 1);
    truncated.push(next);
    if (truncated.length > HISTORY_LIMIT) {
      truncated.shift();
    }
    historyRef.current = truncated;
    historyIndexRef.current = truncated.length - 1;
  };

  const closePresetDropdown = () => {
    setIsPresetOpen(false);
  };

  const stopCodeTransition = () => {
    if (codeTransitionTimerRef.current !== undefined) {
      window.clearTimeout(codeTransitionTimerRef.current);
      codeTransitionTimerRef.current = undefined;
    }
    setIsCodeTransitioning(false);
  };
  return { releaseActivePointerCapture, commit, closePresetDropdown, stopCodeTransition };
}

export type EditorAfterDragSupportActions = EditorAfterPolygonSelectionActions & ReturnType<typeof dragSupportActions>;

// Ending a handle drag and a marquee drag.
export function dragFinishActions(editor: EditorAfterDragSupportActions) {
  const { keyboardModifiersRef, dragTargetRef, setShape, commit, clearSnapGuides } = editor;
  const { releaseActivePointerCapture, radiusUnlockKeyPressedRef, selectedHandleRef } = editor;
  const { syncInsetModifierMode, setActiveInsetModifierMode, focusSelectedHandle } = editor;
  const { polygonSelectionDragRef, applyPolygonSelectionRect, selectHandle } = editor;
  const { setSelectionRect } = editor;
  const finishDrag = (focusHandle = true, modifiers: KeyboardModifiers = keyboardModifiersRef.current) => {
    const target = dragTargetRef.current;
    if (target) {
      setShape((current) => {
        commit(current);
        return current;
      });
    }
    dragTargetRef.current = undefined;
    clearSnapGuides();
    releaseActivePointerCapture();
    keyboardModifiersRef.current = {
      altKey: modifiers.altKey,
      shiftKey: modifiers.shiftKey,
      radiusUnlocked: radiusUnlockKeyPressedRef.current,
    };
    if (isInsetHandle(selectedHandleRef.current)) {
      syncInsetModifierMode(keyboardModifiersRef.current);
    } else {
      setActiveInsetModifierMode('single');
    }
    if (target && focusHandle) {
      focusSelectedHandle();
    }
  };

  const finishPolygonSelectionDrag = (applySelection = true) => {
    const selection = polygonSelectionDragRef.current;
    if (!selection) {
      return;
    }

    if (applySelection && selection.didMove) {
      applyPolygonSelectionRect(selection);
    } else if (applySelection && !selection.additive) {
      selectHandle(undefined);
    }

    polygonSelectionDragRef.current = undefined;
    setSelectionRect(undefined);
    clearSnapGuides();
    releaseActivePointerCapture();
  };
  return { finishDrag, finishPolygonSelectionDrag };
}

export type EditorAfterDragFinishActions = EditorAfterDragSupportActions & ReturnType<typeof dragFinishActions>;

// Moving and resizing a whole shape by its bounding box.
export function transformDragActions(editor: EditorAfterDragFinishActions) {
  const { keyboardModifiersRef, showSnapGuides, clearSnapGuides } = editor;
  const shapeFromTransformDrag = (drag: ShapeTransformDrag, point: Point, modifiers: KeyboardModifiers = keyboardModifiersRef.current) => {
    const containModel = drag.fitMode === 'contain' ? containModelFromShape(drag.before) : undefined;

    if (drag.mode === 'move') {
      const rawDx = point.x - drag.start.x;
      const rawDy = point.y - drag.start.y;
      const { dx, dy, guides } = snappedShapeMoveDelta(drag.bounds, rawDx, rawDy, { sticky: true });
      showSnapGuides(guides);
      if (containModel) {
        return shapeFromContainModel(drag.before, moveContainModel(containModel, dx, dy));
      }
      return transformShapeCanvasPoints(drag.before, drag.fitMode, drag.scaleOptions, (currentPoint) => ({ x: currentPoint.x + dx, y: currentPoint.y + dy }));
    }

    if (!drag.corner) {
      return undefined;
    }
    // Resize toward the opposite corner by default (it stays pinned). Hold Option/Alt to resize
    // from the shape's center instead.
    const anchor = modifiers.altKey
      ? {
          x: drag.bounds.left + drag.bounds.width / 2,
          y: drag.bounds.top + drag.bounds.height / 2,
        }
      : shapeResizeCornerPoint(drag.bounds, oppositeShapeResizeCorner(drag.corner));
    const startHandle = shapeResizeCornerPoint(drag.bounds, drag.corner);
    const startVector = { x: startHandle.x - anchor.x, y: startHandle.y - anchor.y };
    const nextVector = { x: point.x - anchor.x, y: point.y - anchor.y };
    const startLengthSquared = startVector.x ** 2 + startVector.y ** 2;
    if (startLengthSquared <= SVG_POINT_EPSILON) {
      return undefined;
    }

    const rawScale = (nextVector.x * startVector.x + nextVector.y * startVector.y) / startLengthSquared;
    const scale = Math.max(0, rawScale);
    clearSnapGuides();
    if (containModel) {
      return shapeFromContainModel(drag.before, resizeContainModel(containModel, anchor, scale));
    }
    return transformShapeCanvasPoints(drag.before, drag.fitMode, drag.scaleOptions, (currentPoint) => ({
      x: anchor.x + (currentPoint.x - anchor.x) * scale,
      y: anchor.y + (currentPoint.y - anchor.y) * scale,
    }));
  };
  return { shapeFromTransformDrag };
}

export type EditorAfterTransformDragActions = EditorAfterDragFinishActions & ReturnType<typeof transformDragActions>;

// Ending a shape drag, and loading a shape read from the selection.
export function selectionLoadActions(editor: EditorAfterTransformDragActions) {
  const { shapeTransformDragRef, setShape, commit, clearSnapGuides } = editor;
  const { releaseActivePointerCapture, clearPendingWrite, localWritePendingRef } = editor;
  const { shapeMatchesPastedSvgCache, clearPastedShapeSvgCache, dragTargetRef } = editor;
  const { polygonSelectionDragRef, setSelectionRect, selectHandle, codeChangedShapeRef } = editor;
  const { closePresetDropdown, stopCodeTransition, shapeRef } = editor;
  const { syncPolygonPointColorsForShape, syncPresetForShape } = editor;
  const { syncShapeFitModeForLoadedShape, setCodeValue, lastWrittenRef, historyRef } = editor;
  const { historyIndexRef } = editor;
  const finishShapeTransformDrag = (commitChange = true) => {
    const drag = shapeTransformDragRef.current;
    if (drag && commitChange) {
      setShape((current) => {
        commit(current);
        return current;
      });
    }
    shapeTransformDragRef.current = undefined;
    clearSnapGuides();
    releaseActivePointerCapture();
  };

  const loadShapeFromSelection = (next: ClipShape, lastWritten = formatClipPath(next)) => {
    clearPendingWrite();
    localWritePendingRef.current = false;
    if (!shapeMatchesPastedSvgCache(next)) {
      clearPastedShapeSvgCache();
    }
    dragTargetRef.current = undefined;
    polygonSelectionDragRef.current = undefined;
    shapeTransformDragRef.current = undefined;
    setSelectionRect(undefined);
    clearSnapGuides();
    releaseActivePointerCapture();
    selectHandle(undefined);
    codeChangedShapeRef.current = false;
    closePresetDropdown();
    stopCodeTransition();
    if (!shapesClose(shapeRef.current, next)) {
      setShape(next);
    }
    syncPolygonPointColorsForShape(next, []);
    syncPresetForShape(next);
    syncShapeFitModeForLoadedShape(next);
    setCodeValue(formatCodeValue(next));
    lastWrittenRef.current = lastWritten;
    historyRef.current = [next];
    historyIndexRef.current = 0;
  };
  return { finishShapeTransformDrag, loadShapeFromSelection };
}

export type EditorAfterSelectionLoadActions = EditorAfterTransformDragActions & ReturnType<typeof selectionLoadActions>;

// Undo and redo.
export function historyActions(editor: EditorAfterSelectionLoadActions) {
  const { historyIndexRef, markLocalShapeChange, clearPastedShapeSvgCache, historyRef } = editor;
  const { setShape, syncPolygonPointColorsForShape, syncPresetForShape } = editor;
  const undo = () => {
    if (historyIndexRef.current <= 0) {
      return;
    }
    markLocalShapeChange();
    clearPastedShapeSvgCache();
    historyIndexRef.current -= 1;
    const previous = historyRef.current[historyIndexRef.current];
    if (!previous) {
      throw new Error('Clip path invariant failed: undo history entry is missing');
    }
    setShape(previous);
    syncPolygonPointColorsForShape(previous);
    syncPresetForShape(previous);
  };

  const redo = () => {
    if (historyIndexRef.current >= historyRef.current.length - 1) {
      return;
    }
    markLocalShapeChange();
    clearPastedShapeSvgCache();
    historyIndexRef.current += 1;
    const next = historyRef.current[historyIndexRef.current];
    if (!next) {
      throw new Error('Clip path invariant failed: redo history entry is missing');
    }
    setShape(next);
    syncPolygonPointColorsForShape(next);
    syncPresetForShape(next);
  };
  return { undo, redo };
}

export type EditorAfterHistoryActions = EditorAfterSelectionLoadActions & ReturnType<typeof historyActions>;

// Deleting the selected polygon points.
export function pointDeleteActions(editor: EditorAfterHistoryActions) {
  const { shapeRef, getActivePolygonSelection, selectedHandleRef, polygonPointColorsRef } = editor;
  const { markLocalShapeChange, setHandleSelection, syncPolygonPointColors, setShape } = editor;
  const { commit, syncPresetForShape, focusSelectedHandle } = editor;
  const deleteSelectedPolygonPoints = () => {
    const current = shapeRef.current;
    if (current.kind !== 'polygon') {
      return false;
    }

    const selectedIndexes = Array.from(
      new Set(
        getActivePolygonSelection()
          .map((handle) => handle.index)
          .filter((index) => index >= 0 && index < current.points.length),
      ),
    ).sort((left, right) => left - right);
    if (!selectedIndexes.length || current.points.length - selectedIndexes.length < 3) {
      return false;
    }

    const indexesToDelete = new Set(selectedIndexes);
    const activeIndex =
      selectedHandleRef.current?.kind === 'polygon-point' && indexesToDelete.has(selectedHandleRef.current.index)
        ? selectedHandleRef.current.index
        : selectedIndexes[0];
    if (activeIndex === undefined) {
      return false;
    }
    const previousOldIndex = previousSurvivingPolygonIndex(current.points.length, indexesToDelete, activeIndex);
    const previousNewIndex = previousOldIndex === undefined ? undefined : remapPolygonIndexAfterDelete(previousOldIndex, indexesToDelete);
    const nextSelectedHandle: HandleTarget | undefined = previousNewIndex === undefined ? undefined : { kind: 'polygon-point', index: previousNewIndex };
    const next: ClipShape = {
      kind: 'polygon',
      points: current.points.filter((_, index) => !indexesToDelete.has(index)),
    };
    const nextColors = normalizePolygonPointColors(current.points.length, polygonPointColorsRef.current).filter((_, index) => !indexesToDelete.has(index));

    markLocalShapeChange();
    setHandleSelection(nextSelectedHandle);
    shapeRef.current = next;
    syncPolygonPointColors(nextColors);
    setShape(next);
    commit(next);
    syncPresetForShape(next);
    if (nextSelectedHandle) {
      focusSelectedHandle();
    }
    return true;
  };
  return { deleteSelectedPolygonPoints };
}

export type EditorAfterPointDeleteActions = EditorAfterHistoryActions & ReturnType<typeof pointDeleteActions>;

// Duplicating polygon points, and opening the preset menu.
export function pointDuplicateActions(editor: EditorAfterPointDeleteActions) {
  const { shapeRef, markLocalShapeChange, insertPolygonPointColor, setShape, commit } = editor;
  const { syncPresetForShape, setHandleSelection, getActivePolygonSelection } = editor;
  const { presetListRef, activePreset, setActivePresetIndex, setIsPresetOpen } = editor;
  const duplicatePolygonPoint = (index: number, options: { commitChange?: boolean; selectDuplicate?: boolean } = {}) => {
    const current = shapeRef.current;
    if (current.kind !== 'polygon') {
      return undefined;
    }

    const point = current.points[index];
    if (!point) {
      return undefined;
    }

    const duplicateIndex = index + 1;
    const next: ClipShape = {
      kind: 'polygon',
      points: [...current.points.slice(0, duplicateIndex), offsetDuplicatePoint(point), ...current.points.slice(duplicateIndex)],
    };
    const duplicateHandle: HandleTarget = { kind: 'polygon-point', index: duplicateIndex };

    markLocalShapeChange();
    insertPolygonPointColor(duplicateIndex, current.points.length);
    shapeRef.current = next;
    setShape(next);
    if (options.commitChange ?? true) {
      commit(next);
    }
    syncPresetForShape(next);
    if (options.selectDuplicate ?? true) {
      setHandleSelection(duplicateHandle);
    }

    return { shape: next, handle: duplicateHandle };
  };

  const duplicateSelectedPolygonPoint = () => {
    const [firstSelectedPoint] = getActivePolygonSelection();
    if (!firstSelectedPoint) {
      return false;
    }
    return Boolean(duplicatePolygonPoint(firstSelectedPoint.index));
  };

  const focusPresetList = () => {
    window.requestAnimationFrame(() => presetListRef.current?.focus());
  };

  const openPresetDropdown = (index = PRESET_NAMES.indexOf(activePreset)) => {
    const nextIndex = index >= 0 ? index : 0;
    setActivePresetIndex(nextIndex);
    setIsPresetOpen(true);
    focusPresetList();
  };
  return {
    duplicatePolygonPoint,
    duplicateSelectedPolygonPoint,
    focusPresetList,
    openPresetDropdown,
  };
}

export type EditorAfterPointDuplicateActions = EditorAfterPointDeleteActions & ReturnType<typeof pointDuplicateActions>;

// Choosing a preset shape.
export function presetChoiceActions(editor: EditorAfterPointDuplicateActions) {
  const { markLocalShapeChange, clearPastedShapeSvgCache, selectHandle, clearSnapGuides } = editor;
  const { setCircleRadiusAngle, shapeScaleUseVariableRef, shapeScaleVariableNameRef } = editor;
  const { shapeOffsetLeftVariableNameRef, shapeOffsetTopVariableNameRef } = editor;
  const { setShapeScaleUseVariable, setShapeScaleVariableName } = editor;
  const { setShapeOffsetLeftVariableName, setShapeOffsetTopVariableName } = editor;
  const { pastedShapeSvgCacheRef, shapeFitModeRef, setShapeFitMode, setActivePreset } = editor;
  const { shapeRef, setCodeValue, setShape, syncPolygonPointColorsForShape, commit } = editor;
  const { setIsPresetOpen, presetButtonRef } = editor;
  const choosePreset = (name: string) => {
    const preset = PRESETS[name];
    if (!preset) {
      return;
    }
    let nextPreset = preset;
    markLocalShapeChange();
    clearPastedShapeSvgCache();
    selectHandle(undefined);
    clearSnapGuides();
    if (preset.kind === 'circle') {
      setCircleRadiusAngle(0);
    }
    if (preset.kind === 'shape') {
      shapeScaleUseVariableRef.current = false;
      shapeScaleVariableNameRef.current = DEFAULT_SHAPE_SCALE_VARIABLE_NAME;
      shapeOffsetLeftVariableNameRef.current = DEFAULT_SHAPE_OFFSET_LEFT_VARIABLE_NAME;
      shapeOffsetTopVariableNameRef.current = DEFAULT_SHAPE_OFFSET_TOP_VARIABLE_NAME;
      setShapeScaleUseVariable(false);
      setShapeScaleVariableName(DEFAULT_SHAPE_SCALE_VARIABLE_NAME);
      setShapeOffsetLeftVariableName(DEFAULT_SHAPE_OFFSET_LEFT_VARIABLE_NAME);
      setShapeOffsetTopVariableName(DEFAULT_SHAPE_OFFSET_TOP_VARIABLE_NAME);
      const cache = cacheFromShapeFitVariants(preset, DEFAULT_SHAPE_SCALE_OPTIONS);
      if (cache) {
        pastedShapeSvgCacheRef.current = cache;
        nextPreset = cache.contain;
      }
      shapeFitModeRef.current = 'contain';
      setShapeFitMode('contain');
    }
    setActivePreset(name);
    shapeRef.current = nextPreset;
    setCodeValue(formatCodeValue(nextPreset));
    setShape(nextPreset);
    syncPolygonPointColorsForShape(nextPreset, []);
    commit(nextPreset);
    setIsPresetOpen(false);
    window.requestAnimationFrame(() => presetButtonRef.current?.focus());
  };
  return { choosePreset };
}

export type EditorAfterPresetChoiceActions = EditorAfterPointDuplicateActions & ReturnType<typeof presetChoiceActions>;

// Resetting the breakpoint's clip-path, class selection, and the source label.
export function breakpointActions(editor: EditorAfterPresetChoiceActions) {
  const { onClearRef, setIsClipPathLabelMenuOpen, clearPendingWrite } = editor;
  const { localWritePendingRef, lastWrittenRef, setClipPathStyleOrigin, styleRef } = editor;
  const { cancelPendingSelectionRead, activeBreakpointRef, refreshSelectedElementRef } = editor;
  const { selectedClassNamesRef, selectionIsDefaultRef, setSelectedClassNames } = editor;
  const { closePresetDropdown, clipPathStyleOrigin } = editor;
  const resetCurrentBreakpointClipPath = async () => {
    // Embedded mode: the parent owns the write target, so clear through it.
    if (onClearRef.current) {
      setIsClipPathLabelMenuOpen(false);
      clearPendingWrite();
      localWritePendingRef.current = false;
      onClearRef.current();
      lastWrittenRef.current = undefined;
      setClipPathStyleOrigin('none');
      return;
    }
    const style = styleRef.current;
    if (!style) {
      return;
    }

    setIsClipPathLabelMenuOpen(false);
    clearPendingWrite();
    localWritePendingRef.current = false;
    cancelPendingSelectionRead();

    const styleOptions = styleOptionsForBreakpoint(activeBreakpointRef.current);
    try {
      await style.removeProperty?.('clip-path', styleOptions);
      await writePastedShapeMetadata(style, undefined, styleOptions);
      lastWrittenRef.current = undefined;
      setClipPathStyleOrigin('none');
      refreshSelectedElementRef.current?.({ force: true, resetStyle: true });
    } catch {
      refreshSelectedElementRef.current?.({ force: true, resetStyle: true });
    }
  };

  // Toggle/order logic now lives in the shared ClassPicker; this just applies the
  // resulting selection and re-reads the style for the new selector.
  const handleClassSelectionChange = (next: string[]) => {
    selectedClassNamesRef.current = next;
    selectionIsDefaultRef.current = false;
    setSelectedClassNames(next);
    setIsClipPathLabelMenuOpen(false);
    closePresetDropdown();
    refreshSelectedElementRef.current?.({ force: true, resetStyle: true });
  };

  const onClipPathLabelClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    // Current → reset menu (Option-click resets immediately). Inherited → a
    // read-only "Value comes from:" popover. None → nothing.
    if (clipPathStyleOrigin === 'none') {
      return;
    }

    if (clipPathStyleOrigin === 'current' && event.altKey) {
      void resetCurrentBreakpointClipPath();
      return;
    }

    setIsClipPathLabelMenuOpen((isOpen) => !isOpen);
  };
  return { resetCurrentBreakpointClipPath, handleClassSelectionChange, onClipPathLabelClick };
}

export type EditorAfterBreakpointActions = EditorAfterPresetChoiceActions & ReturnType<typeof breakpointActions>;

// Editing the shape as code.
export function codeEditActions(editor: EditorAfterBreakpointActions) {
  const { codeTransitionTimerRef, setIsCodeTransitioning, setCodeValue, shape } = editor;
  const { markLocalShapeChange, clearPastedShapeSvgCache, selectHandle } = editor;
  const { codeChangedShapeRef, setShape, syncPolygonPointColorsForShape, commit } = editor;
  const { syncPresetForShape, setCircleRadiusAngle, syncShapeFitModeForLoadedShape } = editor;
  const startCodeTransition = () => {
    if (codeTransitionTimerRef.current !== undefined) {
      window.clearTimeout(codeTransitionTimerRef.current);
    }
    setIsCodeTransitioning(true);
    codeTransitionTimerRef.current = window.setTimeout(() => {
      setIsCodeTransitioning(false);
      codeTransitionTimerRef.current = undefined;
    }, 420);
  };

  const onCodeChange = (nextValue: string) => {
    setCodeValue(nextValue);
    if (!nextValue.trim()) {
      if (shape.kind === 'none') {
        return;
      }

      markLocalShapeChange();
      clearPastedShapeSvgCache();
      selectHandle(undefined);
      codeChangedShapeRef.current = true;
      startCodeTransition();
      setShape(NONE_SHAPE);
      syncPolygonPointColorsForShape(NONE_SHAPE);
      commit(NONE_SHAPE);
      syncPresetForShape(NONE_SHAPE);
      return;
    }

    const parsed = parseClipPathInput(nextValue);
    if (!parsed) {
      return;
    }

    if (shapesClose(shape, parsed)) {
      return;
    }
    markLocalShapeChange();
    clearPastedShapeSvgCache();
    selectHandle(undefined);
    codeChangedShapeRef.current = true;
    startCodeTransition();
    if (parsed.kind === 'none') {
      setCodeValue('');
    }
    if (parsed.kind === 'circle' && shape.kind !== 'circle') {
      setCircleRadiusAngle(0);
    }
    syncShapeFitModeForLoadedShape(parsed);
    setShape(parsed);
    syncPolygonPointColorsForShape(parsed);
    commit(parsed);
    syncPresetForShape(parsed);
  };
  return { startCodeTransition, onCodeChange };
}
