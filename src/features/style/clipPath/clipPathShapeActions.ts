// Shape actions, the next stages of the pipeline: selection in the code view,
// fit mode and scale, snap guides, dragging a point, the preset list and its
// typeahead, and the keyboard's handle, shape and key handling (ClipPath.tsx).

import {
  type Point,
  type ClipShape,
  type InsetSideMode,
  type InsetRadiusMode,
  type KeyboardModifiers,
  type ArrowKey,
  type HandleTarget,
  type DragTarget,
  type ShapeFitMode,
  type ShapeScaleOptions,
  type PastedShapeSvgCache,
} from './clipPathTypes';
import {
  DEFAULT_SHAPE_SCALE_VARIABLE_NAME,
  DEFAULT_SHAPE_OFFSET_LEFT_VARIABLE_NAME,
  DEFAULT_SHAPE_OFFSET_TOP_VARIABLE_NAME,
  KEYBOARD_STEP,
  KEYBOARD_FAST_STEP,
  KEYBOARD_REPEAT_DELAY_MS,
  KEYBOARD_REPEAT_MS,
  ARROW_KEYS,
} from './clipPathConstants';
import { sanitizeShapeScaleVariableName, emptySnapGuides, pointAlignmentGuides, mergeSnapGuides, shapeSnapGuidesForBounds, insetBox } from './clipPathMeasure';
import { isInsetHandle, shapesClose, shapesEqual, isPolygonPointHandle, handleFromDragTarget } from './clipPathHandles';
import { hasContainerQueryUnit } from './shapeFunctionPatterns';
import {
  shapeCssBounds,
  containModelFromShape,
  shapeFromContainModel,
  moveContainModel,
  convertShapeFitMode,
  cacheFromShapeFitVariants,
  normalizeContainShapeCoordinates,
  normalizeShapeFitCache,
  transformShapeCanvasPoints,
  shapeFromPastedSvgCache,
} from './shapeFunctionModel';
import { PRESET_NAMES, formatClipPath, formatCodeValue } from './clipPathFormat';
import { insetRadiusToCanvas, rawEditableHandlePoint } from './clipPathCanvasUnits';
import { isArrowKey, arrowDelta, updateShapeForKeyboard } from './shapeKeyboard';
import { type EditorAfterBreakpointActions, codeEditActions } from './clipPathEditActions';

export type EditorAfterCodeEditActions = EditorAfterBreakpointActions & ReturnType<typeof codeEditActions>;

// Selecting in the code, and applying a pasted SVG.
export function codeSelectionActions(editor: EditorAfterCodeEditActions) {
  const { dragTargetRef, codeTokenHighlights, selectHandle, setHandleSelection } = editor;
  const { pastedShapeSvgCacheRef, currentShapeScaleOptions } = editor;
  const { syncShapeFitModeForLoadedShape, shapeRef, markLocalShapeChange } = editor;
  const { codeChangedShapeRef, startCodeTransition, syncPolygonPointColorsForShape } = editor;
  const { setCodeValue, setShape, commit, syncPresetForShape } = editor;
  const onCodeSelectionChange = (position: number) => {
    if (dragTargetRef.current) {
      return;
    }
    const activeElement = document.activeElement;
    if (!(activeElement instanceof Element) || !activeElement.closest('.code-editor')) {
      return;
    }

    const match = codeTokenHighlights.find((highlight) => position >= highlight.from && position <= highlight.to);
    if (!match) {
      selectHandle(undefined);
      return;
    }

    const [primaryHandle] = match.handles;
    setHandleSelection(primaryHandle || undefined, match.handles);
  };

  const applyPastedSvgClipPath = (
    next: ClipShape,
    // `cacheUpdate` replaces the pasted-SVG cache — with nothing, when its `cache` is
    // absent — and leaving it out keeps the cache as it is.
    options: {
      cacheUpdate?: { cache: PastedShapeSvgCache | undefined };
      shapeFitMode?: ShapeFitMode;
    } = {},
  ) => {
    if (options.cacheUpdate !== undefined) {
      pastedShapeSvgCacheRef.current = normalizeShapeFitCache(options.cacheUpdate.cache, currentShapeScaleOptions());
    }
    syncShapeFitModeForLoadedShape(next, options.shapeFitMode);

    const current = shapeRef.current;
    if (shapesClose(current, next)) {
      return;
    }

    markLocalShapeChange();
    selectHandle(undefined);
    codeChangedShapeRef.current = false;
    startCodeTransition();
    shapeRef.current = next;
    syncPolygonPointColorsForShape(next, []);
    setCodeValue(formatCodeValue(next));
    setShape(next);
    commit(next);
    syncPresetForShape(next);
  };
  return { onCodeSelectionChange, applyPastedSvgClipPath };
}

export type EditorAfterCodeSelectionActions = EditorAfterCodeEditActions & ReturnType<typeof codeSelectionActions>;

// Reading a pasted SVG, and switching how a shape fits.
export function shapeFitActions(editor: EditorAfterCodeSelectionActions) {
  const { cacheFromPastedShapeSvgSource, shapeFitModeRef, shapeRef } = editor;
  const { currentShapeScaleOptions, matchingPastedSvgCacheForShape, setShapeFitMode } = editor;
  const { pastedShapeSvgCacheRef, applyPastedSvgClipPath } = editor;
  const parseClipboardSvgShape = (text: string, html: string, fitMode: ShapeFitMode) => {
    const textCache = cacheFromPastedShapeSvgSource(text);
    if (textCache) {
      return { shape: shapeFromPastedSvgCache(textCache, fitMode), cache: textCache };
    }

    const htmlCache = cacheFromPastedShapeSvgSource(html);
    return htmlCache ? { shape: shapeFromPastedSvgCache(htmlCache, fitMode), cache: htmlCache } : undefined;
  };

  const setShapeFitModeFromControl = (nextMode: ShapeFitMode) => {
    if (nextMode === shapeFitModeRef.current) {
      return;
    }
    const currentShape = shapeRef.current;
    if (currentShape.kind !== 'shape') {
      return;
    }

    const shapeScaleOptions = currentShapeScaleOptions();
    const cache = matchingPastedSvgCacheForShape(currentShape) || cacheFromShapeFitVariants(currentShape, shapeScaleOptions);
    const nextShape = cache ? shapeFromPastedSvgCache(cache, nextMode) : convertShapeFitMode(currentShape, nextMode, shapeScaleOptions);
    if (!nextShape) {
      return;
    }

    setShapeFitMode(nextMode);
    shapeFitModeRef.current = nextMode;

    if (cache) {
      pastedShapeSvgCacheRef.current = cache;
    }
    applyPastedSvgClipPath(nextShape, { cacheUpdate: { cache }, shapeFitMode: nextMode });
  };
  return { parseClipboardSvgShape, setShapeFitModeFromControl };
}

export type EditorAfterShapeFitActions = EditorAfterCodeSelectionActions & ReturnType<typeof shapeFitActions>;

// The shape-scale variables, and moving through the presets.
export function shapeScaleActions(editor: EditorAfterShapeFitActions) {
  const { shapeRef, currentShapeScaleOptions, shapeOffsetLeftVariableNameRef } = editor;
  const { shapeOffsetTopVariableNameRef, shapeScaleUseVariableRef } = editor;
  const { shapeScaleVariableNameRef, setShapeScaleUseVariable, setShapeScaleVariableName } = editor;
  const { setShapeOffsetLeftVariableName, setShapeOffsetTopVariableName } = editor;
  const { matchingPastedSvgCacheForShape, pastedShapeSvgCacheRef, shapeFitModeRef } = editor;
  const { applyPastedSvgClipPath, setActivePresetIndex } = editor;
  const setShapeScaleOptionsFromControl = (nextOptions: ShapeScaleOptions) => {
    const currentShape = shapeRef.current;
    const previousOptions = currentShapeScaleOptions();
    // The contain encoding always uses variables now; sanitize for emit, but keep the raw typed
    // strings in state so the inputs stay editable. Empty fields fall back to the defaults.
    const rawSize = nextOptions.variableName;
    const rawLeft = nextOptions.offsetLeftVariableName ?? shapeOffsetLeftVariableNameRef.current;
    const rawTop = nextOptions.offsetTopVariableName ?? shapeOffsetTopVariableNameRef.current;
    const normalizedOptions: ShapeScaleOptions = {
      useVariable: true,
      variableName: sanitizeShapeScaleVariableName(rawSize) || DEFAULT_SHAPE_SCALE_VARIABLE_NAME,
      offsetLeftVariableName: sanitizeShapeScaleVariableName(rawLeft) || DEFAULT_SHAPE_OFFSET_LEFT_VARIABLE_NAME,
      offsetTopVariableName: sanitizeShapeScaleVariableName(rawTop) || DEFAULT_SHAPE_OFFSET_TOP_VARIABLE_NAME,
    };

    shapeScaleUseVariableRef.current = true;
    shapeScaleVariableNameRef.current = rawSize;
    shapeOffsetLeftVariableNameRef.current = rawLeft;
    shapeOffsetTopVariableNameRef.current = rawTop;
    setShapeScaleUseVariable(true);
    setShapeScaleVariableName(rawSize);
    setShapeOffsetLeftVariableName(rawLeft);
    setShapeOffsetTopVariableName(rawTop);

    if (currentShape.kind !== 'shape') {
      return;
    }

    const currentCache = matchingPastedSvgCacheForShape(currentShape, previousOptions) || cacheFromShapeFitVariants(currentShape, previousOptions);
    const nextCache = currentCache ? normalizeShapeFitCache(currentCache, normalizedOptions) : undefined;
    if (nextCache) {
      pastedShapeSvgCacheRef.current = nextCache;
    }

    if (shapeFitModeRef.current !== 'contain') {
      return;
    }

    const nextShape = nextCache?.contain || normalizeContainShapeCoordinates(currentShape, normalizedOptions);
    applyPastedSvgClipPath(nextShape, {
      cacheUpdate: { cache: nextCache },
      shapeFitMode: 'contain',
    });
  };

  const moveActivePreset = (nextIndex: number) => {
    const wrappedIndex = (nextIndex + PRESET_NAMES.length) % PRESET_NAMES.length;
    setActivePresetIndex(wrappedIndex);
  };
  return { setShapeScaleOptionsFromControl, moveActivePreset };
}

export type EditorAfterShapeScaleActions = EditorAfterShapeFitActions & ReturnType<typeof shapeScaleActions>;

// The alignment guide a handle snaps to.
export function guideActions(editor: EditorAfterShapeScaleActions) {
  const { circleRadiusAngleRef, canvasRef } = editor;
  const guidePointForHandle = (targetShape: ClipShape, handle: HandleTarget, circleAngle = circleRadiusAngleRef.current): Point | undefined => {
    if (targetShape.kind === 'raw' && targetShape.editable && canvasRef.current) {
      return rawEditableHandlePoint(targetShape.editable, handle, canvasRef.current);
    }

    if (handle.kind === 'polygon-point' && targetShape.kind === 'polygon') {
      return targetShape.points[handle.index] || undefined;
    }

    if (handle.kind === 'circle-center' && targetShape.kind === 'circle') {
      return { x: targetShape.cx, y: targetShape.cy };
    }

    if (handle.kind === 'circle-radius' && targetShape.kind === 'circle') {
      return {
        x: targetShape.cx + Math.cos(circleAngle) * targetShape.radius,
        y: targetShape.cy + Math.sin(circleAngle) * targetShape.radius,
      };
    }

    if (handle.kind === 'ellipse-center' && targetShape.kind === 'ellipse') {
      return { x: targetShape.cx, y: targetShape.cy };
    }

    if (handle.kind === 'ellipse-rx' && targetShape.kind === 'ellipse') {
      return { x: targetShape.cx + targetShape.rx, y: targetShape.cy };
    }

    if (handle.kind === 'ellipse-ry' && targetShape.kind === 'ellipse') {
      return { x: targetShape.cx, y: targetShape.cy + targetShape.ry };
    }

    if (targetShape.kind !== 'inset') {
      return undefined;
    }

    const { x0, y0, x1, y1, width, height } = insetBox(targetShape);
    if (handle.kind === 'inset-top') {
      return { x: x0 + width / 2, y: targetShape.top };
    }
    if (handle.kind === 'inset-right') {
      return { x: 100 - targetShape.right, y: y0 + height / 2 };
    }
    if (handle.kind === 'inset-bottom') {
      return { x: x0 + width / 2, y: 100 - targetShape.bottom };
    }
    if (handle.kind === 'inset-left') {
      return { x: targetShape.left, y: y0 + height / 2 };
    }

    if (handle.kind === 'inset-radius') {
      const radius = targetShape.radii[handle.corner];
      const canvasRadius = insetRadiusToCanvas(targetShape, radius);
      if (handle.corner === 'topLeft') {
        return { x: targetShape.left + canvasRadius.x, y: targetShape.top + canvasRadius.y };
      }
      if (handle.corner === 'topRight') {
        return { x: x1 - canvasRadius.x, y: targetShape.top + canvasRadius.y };
      }
      if (handle.corner === 'bottomRight') {
        return { x: x1 - canvasRadius.x, y: y1 - canvasRadius.y };
      }
      return { x: targetShape.left + canvasRadius.x, y: y1 - canvasRadius.y };
    }

    return undefined;
  };
  return { guidePointForHandle };
}

export type EditorAfterGuideActions = EditorAfterShapeScaleActions & ReturnType<typeof guideActions>;

// Where a drag puts its handle, and the guides a keyboard move shows.
export function dragPointActions(editor: EditorAfterGuideActions) {
  const { guidePointForHandle, circleRadiusAngleRef } = editor;
  const targetWithDragOrigin = (target: DragTarget, pointer: Point): DragTarget => {
    const handlePoint = guidePointForHandle(target.before, handleFromDragTarget(target));
    return handlePoint ? { ...target, dragOrigin: { pointer, handle: handlePoint } } : target;
  };

  const dragPointForTarget = (target: DragTarget, rawPoint: Point) => {
    const origin = target.dragOrigin;
    if (!origin) {
      return rawPoint;
    }

    return {
      x: origin.handle.x + rawPoint.x - origin.pointer.x,
      y: origin.handle.y + rawPoint.y - origin.pointer.y,
    };
  };

  const keyboardGuidesForHandles = (targetShape: ClipShape, handles: HandleTarget[], circleAngle = circleRadiusAngleRef.current) => {
    const guides = handles.map((handle) => {
      const point = guidePointForHandle(targetShape, handle, circleAngle);
      if (!point) {
        return emptySnapGuides();
      }

      if (targetShape.kind === 'inset' && handle.kind === 'inset-radius') {
        const { x0, y0, x1, y1, width, height } = insetBox(targetShape);
        return pointAlignmentGuides(point, [0, x0, x0 + width / 2, 50, x1, 100], [0, y0, y0 + height / 2, 50, y1, 100]);
      }

      return pointAlignmentGuides(point, [0, 50, 100], [0, 50, 100]);
    });

    return mergeSnapGuides(...guides);
  };
  return { targetWithDragOrigin, dragPointForTarget, keyboardGuidesForHandles };
}

export type EditorAfterDragPointActions = EditorAfterGuideActions & ReturnType<typeof dragPointActions>;

// Typing a preset's name to jump to it.
export function presetTypeaheadActions(editor: EditorAfterDragPointActions) {
  const { presetTypeaheadTimerRef, presetTypeaheadRef, activePresetIndex } = editor;
  const { setActivePresetIndex } = editor;
  const handlePresetTypeahead = (key: string) => {
    if (key.length !== 1) {
      return false;
    }

    if (presetTypeaheadTimerRef.current !== undefined) {
      window.clearTimeout(presetTypeaheadTimerRef.current);
    }

    const query = `${presetTypeaheadRef.current}${key}`.toLowerCase();
    presetTypeaheadRef.current = query;
    presetTypeaheadTimerRef.current = window.setTimeout(() => {
      presetTypeaheadRef.current = '';
      presetTypeaheadTimerRef.current = undefined;
    }, 700);

    const startIndex = (activePresetIndex + 1) % PRESET_NAMES.length;
    const orderedNames = [...PRESET_NAMES.slice(startIndex), ...PRESET_NAMES.slice(0, startIndex)];
    const match = orderedNames.find((name) => name.toLowerCase().startsWith(query));
    if (!match) {
      return true;
    }

    setActivePresetIndex(PRESET_NAMES.indexOf(match));
    return true;
  };
  return { handlePresetTypeahead };
}

export type EditorAfterPresetTypeaheadActions = EditorAfterDragPointActions & ReturnType<typeof presetTypeaheadActions>;

// The preset button's keys.
export function presetButtonActions(editor: EditorAfterPresetTypeaheadActions) {
  const { openPresetDropdown, handlePresetTypeahead, setIsPresetOpen, focusPresetList } = editor;
  const onPresetButtonKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      openPresetDropdown();
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      openPresetDropdown(PRESET_NAMES.length - 1);
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openPresetDropdown();
      return;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      openPresetDropdown(0);
      return;
    }

    if (event.key === 'End') {
      event.preventDefault();
      openPresetDropdown(PRESET_NAMES.length - 1);
      return;
    }

    if (handlePresetTypeahead(event.key)) {
      event.preventDefault();
      setIsPresetOpen(true);
      focusPresetList();
    }
  };
  return { onPresetButtonKeyDown };
}

export type EditorAfterPresetButtonActions = EditorAfterPresetTypeaheadActions & ReturnType<typeof presetButtonActions>;

// The preset list's keys.
export function presetListActions(editor: EditorAfterPresetButtonActions) {
  const { moveActivePreset, activePresetIndex, setActivePresetIndex, choosePreset } = editor;
  const { closePresetDropdown, presetButtonRef, handlePresetTypeahead } = editor;
  const onPresetListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActivePreset(activePresetIndex + 1);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActivePreset(activePresetIndex - 1);
      return;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      setActivePresetIndex(0);
      return;
    }

    if (event.key === 'End') {
      event.preventDefault();
      setActivePresetIndex(PRESET_NAMES.length - 1);
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const presetName = PRESET_NAMES[activePresetIndex];
      if (presetName) {
        choosePreset(presetName);
      }
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      closePresetDropdown();
      presetButtonRef.current?.focus();
      return;
    }

    if (event.key === 'Tab') {
      closePresetDropdown();
      return;
    }

    if (handlePresetTypeahead(event.key)) {
      event.preventDefault();
    }
  };
  return { onPresetListKeyDown };
}

export type EditorAfterPresetListActions = EditorAfterPresetButtonActions & ReturnType<typeof presetListActions>;

// Moving a handle with the keyboard.
export function handleKeyboardActions(editor: EditorAfterPresetListActions) {
  const { shapeRef, latestCssRef, syncInsetModifierMode, radiusUnlockKeyPressedRef } = editor;
  const { getPolygonSelectionIndexes, canvasRef, circleRadiusAngleRef } = editor;
  const { spaceKeyPressedRef, markLocalShapeChange, cancelPendingSelectionRead } = editor;
  const { setCircleRadiusAngle, setShape, commit, syncPresetForShape, showSnapGuides } = editor;
  const { keyboardGuidesForHandles } = editor;
  const moveHandleWithKeyboard = (handle: HandleTarget, key: string, modifiers: KeyboardModifiers) => {
    if (!isArrowKey(key)) {
      return false;
    }

    const currentShape = shapeRef.current;
    const currentCss = latestCssRef.current;
    const insetModifierMode = syncInsetModifierMode(modifiers);
    const insetRadiusMode: InsetRadiusMode = insetModifierMode;
    const insetSideMode: InsetSideMode = insetModifierMode;
    const insetRadiusUnlocked = modifiers.radiusUnlocked ?? radiusUnlockKeyPressedRef.current;
    const polygonPointIndexes = getPolygonSelectionIndexes(handle);
    const result = updateShapeForKeyboard(currentShape, handle, key, {
      canvas: canvasRef.current ?? undefined,
      circleRadiusAngle: circleRadiusAngleRef.current,
      insetRadiusMode,
      insetRadiusUnlocked,
      insetSideMode,
      ellipseScaleProportional: modifiers.shiftKey,
      polygonPointIndexes,
      step: spaceKeyPressedRef.current ? KEYBOARD_FAST_STEP : KEYBOARD_STEP,
    });
    const shapeChanged = !shapesEqual(currentShape, result.shape);
    const angleChanged = typeof result.circleRadiusAngle === 'number' && Math.abs(result.circleRadiusAngle - circleRadiusAngleRef.current) > 0.0001;

    if (!shapeChanged && !angleChanged) {
      return false;
    }

    if (formatClipPath(result.shape) !== currentCss) {
      markLocalShapeChange();
    } else {
      cancelPendingSelectionRead();
    }
    if (typeof result.circleRadiusAngle === 'number') {
      circleRadiusAngleRef.current = result.circleRadiusAngle;
      setCircleRadiusAngle(result.circleRadiusAngle);
    }
    if (shapeChanged) {
      shapeRef.current = result.shape;
      setShape(result.shape);
      commit(result.shape);
      syncPresetForShape(result.shape);
    }
    const nextCircleAngle = result.circleRadiusAngle ?? circleRadiusAngleRef.current;
    const guideHandles =
      isPolygonPointHandle(handle) && polygonPointIndexes.length ? polygonPointIndexes.map((index) => ({ kind: 'polygon-point' as const, index })) : [handle];
    showSnapGuides(keyboardGuidesForHandles(result.shape, guideHandles, nextCircleAngle));
    return true;
  };
  return { moveHandleWithKeyboard };
}

export type EditorAfterHandleKeyboardActions = EditorAfterPresetListActions & ReturnType<typeof handleKeyboardActions>;

// Moving the whole shape with the keyboard.
export function shapeKeyboardActions(editor: EditorAfterHandleKeyboardActions) {
  const { shapeRef, spaceKeyPressedRef, shapeFitModeRef, currentShapeScaleOptions } = editor;
  const { showSnapGuides, markLocalShapeChange, clearPastedShapeSvgCache, setShape } = editor;
  const { commit, setActivePreset } = editor;
  const moveShapeWithKeyboard = (key: ArrowKey) => {
    const currentShape = shapeRef.current;
    if (currentShape.kind !== 'shape') {
      return false;
    }

    const bounds = shapeCssBounds(currentShape);
    if (!bounds) {
      return false;
    }

    const delta = arrowDelta(key, spaceKeyPressedRef.current ? KEYBOARD_FAST_STEP : KEYBOARD_STEP);
    if (!delta) {
      return false;
    }

    const fitMode: ShapeFitMode = shapeFitModeRef.current === 'contain' || hasContainerQueryUnit(currentShape.value) ? 'contain' : 'stretch';
    const containModel = fitMode === 'contain' ? containModelFromShape(currentShape) : undefined;
    const next = containModel
      ? shapeFromContainModel(currentShape, moveContainModel(containModel, delta.x, delta.y))
      : transformShapeCanvasPoints(currentShape, fitMode, currentShapeScaleOptions(), (point) => ({
          x: point.x + delta.x,
          y: point.y + delta.y,
        }));
    if (!next || shapesEqual(currentShape, next)) {
      return false;
    }

    const nextBounds = shapeCssBounds(next);
    showSnapGuides(nextBounds ? shapeSnapGuidesForBounds(nextBounds) : emptySnapGuides());
    markLocalShapeChange();
    clearPastedShapeSvgCache();
    shapeRef.current = next;
    setShape(next);
    commit(next);
    setActivePreset('Shape');
    return true;
  };
  return { moveShapeWithKeyboard };
}

export type EditorAfterShapeKeyboardActions = EditorAfterHandleKeyboardActions & ReturnType<typeof shapeKeyboardActions>;

// The repeating keyboard move and the modifier refs it reads.
export function keyboardLoopActions(editor: EditorAfterShapeKeyboardActions) {
  const { selectedHandleRef, isShapeTransformSelectedRef, isPresetOpenRef } = editor;
  const { stopKeyboardMoveLoop, pressedArrowKeysRef, moveHandleWithKeyboard } = editor;
  const { keyboardModifiersRef, moveShapeWithKeyboard, keyboardMoveDelayTimerRef } = editor;
  const { keyboardMoveTimerRef, radiusUnlockKeyPressedRef, syncInsetModifierMode } = editor;
  const runKeyboardMoveTick = () => {
    const handle = selectedHandleRef.current;
    const shapeSelected = isShapeTransformSelectedRef.current;
    if ((!handle && !shapeSelected) || isPresetOpenRef.current) {
      stopKeyboardMoveLoop();
      return;
    }

    const keys = ARROW_KEYS.filter((key) => pressedArrowKeysRef.current.has(key));
    if (!keys.length) {
      stopKeyboardMoveLoop(false);
      return;
    }

    keys.forEach((key) => {
      if (handle) {
        moveHandleWithKeyboard(handle, key, keyboardModifiersRef.current);
      } else if (shapeSelected) {
        moveShapeWithKeyboard(key);
      }
    });
  };

  const startKeyboardMoveLoop = () => {
    if (keyboardMoveDelayTimerRef.current !== undefined || keyboardMoveTimerRef.current !== undefined) {
      return;
    }
    keyboardMoveDelayTimerRef.current = window.setTimeout(() => {
      keyboardMoveDelayTimerRef.current = undefined;
      runKeyboardMoveTick();
      keyboardMoveTimerRef.current = window.setInterval(runKeyboardMoveTick, KEYBOARD_REPEAT_MS);
    }, KEYBOARD_REPEAT_DELAY_MS);
  };

  const updateKeyboardModifierRefs = (modifiers: KeyboardModifiers) => {
    keyboardModifiersRef.current = {
      altKey: modifiers.altKey,
      shiftKey: modifiers.shiftKey,
      radiusUnlocked: modifiers.radiusUnlocked ?? radiusUnlockKeyPressedRef.current,
    };
    if (isInsetHandle(selectedHandleRef.current)) {
      syncInsetModifierMode(keyboardModifiersRef.current);
    }
  };
  return { runKeyboardMoveTick, startKeyboardMoveLoop, updateKeyboardModifierRefs };
}

export type EditorAfterKeyboardLoopActions = EditorAfterShapeKeyboardActions & ReturnType<typeof keyboardLoopActions>;

// Pressing and releasing move keys, and following a shape drag.
export function keyboardKeyActions(editor: EditorAfterKeyboardLoopActions) {
  const { updateKeyboardModifierRefs, selectHandleForKeyboard, pressedArrowKeysRef } = editor;
  const { moveHandleWithKeyboard, keyboardModifiersRef, startKeyboardMoveLoop } = editor;
  const { setShapeTransformSelection, moveShapeWithKeyboard, stopKeyboardMoveLoop } = editor;
  const { shapeTransformDragRef, canvasPointFromClient, shapeFromTransformDrag, shapeRef } = editor;
  const { markLocalShapeChange, setShape, setActivePreset } = editor;
  const pressKeyboardMoveKey = (handle: HandleTarget, key: ArrowKey, modifiers: KeyboardModifiers) => {
    updateKeyboardModifierRefs(modifiers);
    selectHandleForKeyboard(handle);
    const wasPressed = pressedArrowKeysRef.current.has(key);
    pressedArrowKeysRef.current.add(key);
    if (!wasPressed) {
      moveHandleWithKeyboard(handle, key, keyboardModifiersRef.current);
    }
    startKeyboardMoveLoop();
  };

  const pressShapeMoveKey = (key: ArrowKey, modifiers: KeyboardModifiers) => {
    updateKeyboardModifierRefs(modifiers);
    setShapeTransformSelection(true);
    const wasPressed = pressedArrowKeysRef.current.has(key);
    pressedArrowKeysRef.current.add(key);
    if (!wasPressed) {
      moveShapeWithKeyboard(key);
    }
    startKeyboardMoveLoop();
  };

  const releaseKeyboardMoveKey = (key: ArrowKey, modifiers: KeyboardModifiers) => {
    updateKeyboardModifierRefs(modifiers);
    pressedArrowKeysRef.current.delete(key);
    if (!pressedArrowKeysRef.current.size) {
      stopKeyboardMoveLoop(false);
    }
  };

  const updateShapeTransformDrag = (event: PointerEvent) => {
    const drag = shapeTransformDragRef.current;
    if (!drag) {
      return false;
    }
    if (event.pointerId !== drag.pointerId) {
      return true;
    }

    const point = canvasPointFromClient(event.clientX, event.clientY);
    if (!point) {
      return true;
    }

    updateKeyboardModifierRefs(event);
    const next = shapeFromTransformDrag(drag, point, keyboardModifiersRef.current);
    if (!next || shapesEqual(shapeRef.current, next)) {
      return true;
    }

    markLocalShapeChange();
    shapeRef.current = next;
    setShape(next);
    setActivePreset('Shape');
    return true;
  };
  return {
    pressKeyboardMoveKey,
    pressShapeMoveKey,
    releaseKeyboardMoveKey,
    updateShapeTransformDrag,
  };
}
