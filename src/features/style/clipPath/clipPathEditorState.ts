// The editor's state, the first stages of its pipeline: the shape and its
// history, the selected handles, the fit mode, the style source, the refs the
// canvas and writes read, the code view's highlights, and syncing a shape in
// (ClipPath.tsx). Each stage takes the editor built so far and returns it with
// its own fields added; ClipPath.tsx composes them in order.

import { type MutableRefObject, useMemo, useRef, useState } from 'react';
import { assert } from '../../../../shared/core/assert';
import { type CodeEditorTokenHighlight } from '../components/CssCodeEditor';
import type { BreakpointId, StyleHandle } from './webflowDesigner';
import {
  type ClipShape,
  type InsetModifierMode,
  type KeyboardModifiers,
  type ArrowKey,
  type HandleTarget,
  type DragTarget,
  type CanvasSize,
  type CanvasHandleBounds,
  type PolygonDisplayProjection,
  type SelectionRect,
  type SnapGuides,
  type PolygonSelectionDrag,
  type ShapeTransformDrag,
  type ShapeFitMode,
  type ShapeScaleOptions,
  type ShapeScaleOptionOverrides,
  type ClipPathStyleOrigin,
  type SelectionReadOptions,
  type PastedShapeSvgCache,
} from './clipPathTypes';
import {
  DEFAULT_SHAPE_SCALE_VARIABLE_NAME,
  DEFAULT_SHAPE_OFFSET_LEFT_VARIABLE_NAME,
  DEFAULT_SHAPE_OFFSET_TOP_VARIABLE_NAME,
  NONE_PRESET,
  NONE_SHAPE,
} from './clipPathConstants';
import { normalizeSnapGuides, sanitizeShapeScaleVariableName, shapeVariableFieldText } from './clipPathMeasure';
import {
  insetModifierModeFromKeys,
  shapesClose,
  handlesMatch,
  isPolygonPointHandle,
  handleListIncludes,
  uniqueHandles,
  handleKey,
  normalizePolygonPointColors,
  nextPolygonPointColor,
} from './clipPathHandles';
import { shapeOffsetVariableNamesFromValue, hasContainerQueryUnit, shapeScaleVariableNameFromValue } from './shapeFunctionPatterns';
import { normalizeShapeFitCache } from './shapeFunctionModel';
import { PRESET_NAMES, formatClipPath, formatCodeValue } from './clipPathFormat';
import { formatClipPathForPreview, type ClipPathCodeHighlight, buildClipPathCodeHighlights } from './clipPathPreview';
import { parseSvgClipPathShape } from './svgContours';
import { clipPathShortcutGroups, matchPreset } from './clipPathShortcuts';
import { resolveCascadeWinnerClipPathStyle } from './clipPathStyleWrite';

// A field the user types into: the canvas's keyboard shortcuts leave it alone.
export function isEditableTarget(target: HTMLElement | undefined) {
  return Boolean(target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA' || target.isContentEditable));
}

// The props of the editor when it is embedded in the Style panel.
export type ClipPathProps = {
  /** When provided (embedded in the Style panel's Effects popup), clip-path is
      persisted through these — the panel's own writers, which target the user's
      selected selector — instead of the tool resolving its own class style, and the
      class-picker tags are hidden. onApply gets a ready-to-use `clip-path` value. */
  onApply?: (value: string) => void;
  onClear?: () => void;
  hideClassPicker?: boolean;
  /** The clip-path the Style panel shows for its selected selector. Embedded, the
      tool's own style lookup sees only native class styles, so a clip-path written
      in a <style> or stylesheet read as none and the editor opened cleared: this
      is what it opens on instead. */
  initialValue?: string | undefined;
};

// The shape being edited, its code text, and the preset menu.
export function useShapeState() {
  const [shape, setShape] = useState<ClipShape>(NONE_SHAPE);
  const [codeValue, setCodeValue] = useState(formatCodeValue(NONE_SHAPE));
  const [activePreset, setActivePreset] = useState<string>(NONE_PRESET);
  const [isPresetOpen, setIsPresetOpen] = useState(false);
  const [isCodeTransitioning, setIsCodeTransitioning] = useState(false);
  const [circleRadiusAngle, setCircleRadiusAngle] = useState(0);
  return {
    shape,
    setShape,
    codeValue,
    setCodeValue,
    activePreset,
    setActivePreset,
    isPresetOpen,
    setIsPresetOpen,
    isCodeTransitioning,
    setIsCodeTransitioning,
    circleRadiusAngle,
    setCircleRadiusAngle,
  };
}

export type EditorAfterShapeState = ClipPathProps & ReturnType<typeof useShapeState>;

// Which handles are selected, and what the canvas measures.
export function useHandleSelectionState() {
  const [selectedHandle, setSelectedHandle] = useState<HandleTarget | undefined>(undefined);
  const [selectedCodeHandles, setSelectedCodeHandles] = useState<HandleTarget[]>([]);
  const [isShapeTransformSelected, setIsShapeTransformSelected] = useState(false);
  const [activeInsetModifierMode, setActiveInsetModifierMode] = useState<InsetModifierMode>('single');
  const [activePresetIndex, setActivePresetIndex] = useState(PRESET_NAMES.indexOf(NONE_PRESET));
  const [handleBounds, setHandleBounds] = useState<CanvasHandleBounds | undefined>(undefined);
  const [canvasSize, setCanvasSize] = useState<CanvasSize | undefined>(undefined);
  const [polygonPointColors, setPolygonPointColors] = useState<string[]>([]);
  return {
    selectedHandle,
    setSelectedHandle,
    selectedCodeHandles,
    setSelectedCodeHandles,
    isShapeTransformSelected,
    setIsShapeTransformSelected,
    activeInsetModifierMode,
    setActiveInsetModifierMode,
    activePresetIndex,
    setActivePresetIndex,
    handleBounds,
    setHandleBounds,
    canvasSize,
    setCanvasSize,
    polygonPointColors,
    setPolygonPointColors,
  };
}

export type EditorAfterHandleSelectionState = EditorAfterShapeState & ReturnType<typeof useHandleSelectionState>;

// How a pasted shape fits the element, and the drag guides.
export function useShapeFitState() {
  const [shapeFitMode, setShapeFitMode] = useState<ShapeFitMode>('contain');
  const [shapeScaleUseVariable, setShapeScaleUseVariable] = useState(false);
  const [shapeScaleVariableName, setShapeScaleVariableName] = useState(DEFAULT_SHAPE_SCALE_VARIABLE_NAME);
  const [shapeOffsetLeftVariableName, setShapeOffsetLeftVariableName] = useState(DEFAULT_SHAPE_OFFSET_LEFT_VARIABLE_NAME);
  const [shapeOffsetTopVariableName, setShapeOffsetTopVariableName] = useState(DEFAULT_SHAPE_OFFSET_TOP_VARIABLE_NAME);
  const [selectionRect, setSelectionRect] = useState<SelectionRect | undefined>(undefined);
  const [snapGuides, setSnapGuides] = useState<SnapGuides | undefined>(undefined);
  return {
    shapeFitMode,
    setShapeFitMode,
    shapeScaleUseVariable,
    setShapeScaleUseVariable,
    shapeScaleVariableName,
    setShapeScaleVariableName,
    shapeOffsetLeftVariableName,
    setShapeOffsetLeftVariableName,
    shapeOffsetTopVariableName,
    setShapeOffsetTopVariableName,
    selectionRect,
    setSelectionRect,
    snapGuides,
    setSnapGuides,
  };
}

export type EditorAfterShapeFitState = EditorAfterHandleSelectionState & ReturnType<typeof useShapeFitState>;

// Where the clip-path is read from and written to, and the popovers over it.
export function useStyleSourceState() {
  const [clipPathStyleOrigin, setClipPathStyleOrigin] = useState<ClipPathStyleOrigin>('none');
  const [elementClassNames, setElementClassNames] = useState<string[]>([]);
  const [appliedClassName, setAppliedClassName] = useState<string | undefined>(undefined);
  const [selectedClassNames, setSelectedClassNames] = useState<string[]>([]);
  // Where the rendered clip-path actually comes from (for the orange "inherited"
  // label's "Value comes from:" popover) — its selector classes and breakpoint.
  const [clipPathSourceSelector, setClipPathSourceSelector] = useState<string[]>([]);
  const [clipPathSourceBreakpoint, setClipPathSourceBreakpoint] = useState<BreakpointId | undefined>(undefined);
  const [isClipPathLabelMenuOpen, setIsClipPathLabelMenuOpen] = useState(false);
  const [isShortcutHelpOpen, setIsShortcutHelpOpen] = useState(false);
  const [shortcutHelpPortalTarget, setShortcutHelpPortalTarget] = useState<HTMLElement | undefined>(undefined);
  return {
    clipPathStyleOrigin,
    setClipPathStyleOrigin,
    elementClassNames,
    setElementClassNames,
    appliedClassName,
    setAppliedClassName,
    selectedClassNames,
    setSelectedClassNames,
    clipPathSourceSelector,
    setClipPathSourceSelector,
    clipPathSourceBreakpoint,
    setClipPathSourceBreakpoint,
    isClipPathLabelMenuOpen,
    setIsClipPathLabelMenuOpen,
    isShortcutHelpOpen,
    setIsShortcutHelpOpen,
    shortcutHelpPortalTarget,
    setShortcutHelpPortalTarget,
  };
}

export type EditorAfterStyleSourceState = EditorAfterShapeFitState & ReturnType<typeof useStyleSourceState>;

// Mutable state of the canvas: its elements, and the drags in flight.
export function useCanvasRefs() {
  // Memoized cascade-winner per (classNames + cheap effective value) so a refining
  // re-read can reuse the existing shape-cache-aware load path instead of blocking
  // the first paint. Keyed so it auto-invalidates when the situation changes.
  const cascadeWinnerCacheRef = useRef<
    | {
        key: string;
        winner: Awaited<ReturnType<typeof resolveCascadeWinnerClipPathStyle>>;
      }
    | undefined
  >(undefined);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const clipPathLabelRef = useRef<HTMLDivElement>(null);
  const shortcutHelpRef = useRef<HTMLDivElement>(null);
  const presetDropdownRef = useRef<HTMLDivElement>(null);
  const presetButtonRef = useRef<HTMLButtonElement>(null);
  const presetListRef = useRef<HTMLDivElement>(null);
  const presetTypeaheadRef = useRef('');
  const presetTypeaheadTimerRef = useRef<number | undefined>(undefined);
  const dragTargetRef = useRef<DragTarget | undefined>(undefined);
  const polygonSelectionDragRef = useRef<PolygonSelectionDrag | undefined>(undefined);
  const shapeTransformDragRef = useRef<ShapeTransformDrag | undefined>(undefined);
  const activePointerIdRef = useRef<number | undefined>(undefined);
  const activePointerCaptureRef = useRef<HTMLElement | undefined>(undefined);
  return {
    cascadeWinnerCacheRef,
    canvasWrapRef,
    canvasRef,
    clipPathLabelRef,
    shortcutHelpRef,
    presetDropdownRef,
    presetButtonRef,
    presetListRef,
    presetTypeaheadRef,
    presetTypeaheadTimerRef,
    dragTargetRef,
    polygonSelectionDragRef,
    shapeTransformDragRef,
    activePointerIdRef,
    activePointerCaptureRef,
  };
}

export type EditorAfterCanvasRefs = EditorAfterStyleSourceState & ReturnType<typeof useCanvasRefs>;

// Mutable state of the write path and of the keyboard. `startingCss` is what
// counts as already written when the editor opens: embedded in the Style panel,
// the editor's own starting `none` is not a value to write, or opening it
// cleared the selector's clip-path before its shape had loaded.
export function useWriteRefs(startingCss: string | undefined) {
  const styleRef = useRef<StyleHandle | undefined>(undefined);
  const latestCssRef = useRef<string>('');
  const lastWrittenRef = useRef<string | undefined>(startingCss);
  const writeTimerRef = useRef<number | undefined>(undefined);
  const localWritePendingRef = useRef(false);
  const selectedHandleRef = useRef<HandleTarget | undefined>(undefined);
  const selectedHandlesRef = useRef<HandleTarget[]>([]);
  const isShapeTransformSelectedRef = useRef(false);
  const handleBoundsRef = useRef<CanvasHandleBounds | undefined>(undefined);
  const polygonPointColorsRef = useRef<string[]>([]);
  const spaceKeyPressedRef = useRef(false);
  const radiusUnlockKeyPressedRef = useRef(false);
  const keyboardModifiersRef = useRef<KeyboardModifiers>({
    altKey: false,
    shiftKey: false,
    radiusUnlocked: false,
  });
  const pressedArrowKeysRef = useRef<Set<ArrowKey>>(new Set());
  const handledKeyboardEventsRef = useRef<WeakSet<Event>>(new WeakSet());
  return {
    styleRef,
    latestCssRef,
    lastWrittenRef,
    writeTimerRef,
    localWritePendingRef,
    selectedHandleRef,
    selectedHandlesRef,
    isShapeTransformSelectedRef,
    handleBoundsRef,
    polygonPointColorsRef,
    spaceKeyPressedRef,
    radiusUnlockKeyPressedRef,
    keyboardModifiersRef,
    pressedArrowKeysRef,
    handledKeyboardEventsRef,
  };
}

export type EditorAfterWriteRefs = EditorAfterCanvasRefs & ReturnType<typeof useWriteRefs>;

// Timers and bookkeeping for keyboard moves, the code transition, and selection reads.
export function useSelectionRefs() {
  const keyboardMoveDelayTimerRef = useRef<number | undefined>(undefined);
  const keyboardMoveTimerRef = useRef<number | undefined>(undefined);
  const polygonDisplayProjectionsRef = useRef<Map<number, PolygonDisplayProjection>>(new Map());
  const isPresetOpenRef = useRef(false);
  const circleRadiusAngleRef = useRef(0);
  const codeChangedShapeRef = useRef(false);
  const codeTransitionTimerRef = useRef<number | undefined>(undefined);
  const selectionReadSeqRef = useRef(0);
  const selectionReadInProgressRef = useRef(false);
  const selectionReadTimerRef = useRef<number | undefined>(undefined);
  const selectedElementKeyRef = useRef<string | undefined>(undefined);
  const selectedClassNamesRef = useRef<string[]>([]);
  // True while the selection is the auto-derived cascade winner (not a manual
  // click) — lets it keep following the winner as styles/classes change.
  const selectionIsDefaultRef = useRef(true);
  const refreshSelectedElementRef = useRef<((options?: SelectionReadOptions) => void) | undefined>(undefined);
  return {
    keyboardMoveDelayTimerRef,
    keyboardMoveTimerRef,
    polygonDisplayProjectionsRef,
    isPresetOpenRef,
    circleRadiusAngleRef,
    codeChangedShapeRef,
    codeTransitionTimerRef,
    selectionReadSeqRef,
    selectionReadInProgressRef,
    selectionReadTimerRef,
    selectedElementKeyRef,
    selectedClassNamesRef,
    selectionIsDefaultRef,
    refreshSelectedElementRef,
  };
}

export type EditorAfterSelectionRefs = EditorAfterWriteRefs & ReturnType<typeof useSelectionRefs>;

// Mirrors of the latest shape settings and embed callbacks, and the undo history.
export function useShapeRefs(editor: EditorAfterSelectionRefs) {
  const { onApply, onClear } = editor;
  const shapeRef = useRef<ClipShape>(NONE_SHAPE);
  const shapeFitModeRef = useRef<ShapeFitMode>('contain');
  const shapeScaleUseVariableRef = useRef(false);
  const shapeScaleVariableNameRef = useRef(DEFAULT_SHAPE_SCALE_VARIABLE_NAME);
  const shapeOffsetLeftVariableNameRef = useRef(DEFAULT_SHAPE_OFFSET_LEFT_VARIABLE_NAME);
  const shapeOffsetTopVariableNameRef = useRef(DEFAULT_SHAPE_OFFSET_TOP_VARIABLE_NAME);
  const pastedShapeSvgCacheRef = useRef<PastedShapeSvgCache | undefined>(undefined);
  const activeBreakpointRef = useRef<BreakpointId>('main');
  // Mirror the embed callbacks into refs so the write effect (keyed on [css]) always
  // sees the latest without re-subscribing.
  const onApplyRef = useRef(onApply);
  const onClearRef = useRef(onClear);
  onApplyRef.current = onApply;
  onClearRef.current = onClear;

  const historyRef = useRef<ClipShape[]>([NONE_SHAPE]);
  const historyIndexRef = useRef<number>(0);
  return {
    shapeRef,
    shapeFitModeRef,
    shapeScaleUseVariableRef,
    shapeScaleVariableNameRef,
    shapeOffsetLeftVariableNameRef,
    shapeOffsetTopVariableNameRef,
    pastedShapeSvgCacheRef,
    activeBreakpointRef,
    onApplyRef,
    onClearRef,
    historyRef,
    historyIndexRef,
  };
}

export type EditorAfterShapeRefs = EditorAfterSelectionRefs & ReturnType<typeof useShapeRefs>;

// The CSS the shape writes, and the code editor's token colours.
export function useCodeHighlights(editor: EditorAfterShapeRefs) {
  const { shape, canvasSize, codeValue, polygonPointColors } = editor;
  const css = useMemo(() => formatClipPath(shape), [shape]);
  const previewCss = useMemo(() => formatClipPathForPreview(shape, css, canvasSize), [canvasSize, css, shape]);
  const codeTokenHighlights = useMemo(() => buildClipPathCodeHighlights(shape, codeValue, polygonPointColors), [shape, codeValue, polygonPointColors]);
  const codeHandleColorClasses = useMemo(() => {
    const colorClasses = new Map<string, string>();
    codeTokenHighlights.forEach((highlight) => {
      highlight.handles.forEach((handle) => colorClasses.set(handleKey(handle), highlight.colorClass));
    });
    return colorClasses;
  }, [codeTokenHighlights]);
  return { css, previewCss, codeTokenHighlights, codeHandleColorClasses };
}

export type EditorAfterCodeHighlights = EditorAfterShapeRefs & ReturnType<typeof useCodeHighlights>;

// The code tokens of the selected handles, drawn over the rest.
export function useSelectedCodeHighlights(editor: EditorAfterCodeHighlights) {
  const { selectedCodeHandles, selectedHandle, codeTokenHighlights, codeValue } = editor;
  const selectedCodeTokenHighlights = useMemo<CodeEditorTokenHighlight[]>(() => {
    const selectedHandles = selectedCodeHandles.length ? selectedCodeHandles : selectedHandle ? [selectedHandle] : [];
    if (!selectedHandles.length) {
      return codeTokenHighlights;
    }

    const selectionHighlights: CodeEditorTokenHighlight[] = [];
    const seenRanges = new Set<string>();

    selectedHandles.forEach((selected) => {
      const ranges = codeTokenHighlights
        .filter((highlight) => highlight.handles.some((handle) => handlesMatch(selected, handle)))
        .sort((left, right) => left.from - right.from || left.to - right.to);

      let group: ClipPathCodeHighlight[] = [];
      const flushGroup = () => {
        const first = group[0];
        const last = group[group.length - 1];
        if (!first || !last) {
          return;
        }
        const from = first.from;
        const to = last.to;
        const colorClass = first.colorClass;
        const key = `${from}:${to}:${colorClass}`;
        if (!seenRanges.has(key)) {
          seenRanges.add(key);
          selectionHighlights.push({
            from,
            to,
            className: `clip-path_code-token-selection ${colorClass}`,
          });
        }
        group = [];
      };

      ranges.forEach((range) => {
        const previous = group[group.length - 1];
        if (previous && !/^\s*$/.test(codeValue.slice(previous.to, range.from))) {
          flushGroup();
        }
        group.push(range);
      });
      flushGroup();
    });

    return [...selectionHighlights, ...codeTokenHighlights];
  }, [codeTokenHighlights, codeValue, selectedCodeHandles, selectedHandle]);
  return { selectedCodeTokenHighlights };
}

export type EditorAfterSelectedCodeHighlights = EditorAfterCodeHighlights & ReturnType<typeof useSelectedCodeHighlights>;

// The shortcut help, and the refs that mirror this render's state for the listeners
// registered once.
export function useLatestMirrors(editor: EditorAfterSelectedCodeHighlights) {
  const { shape, shapeFitMode, latestCssRef, css, shapeRef, shapeFitModeRef } = editor;
  const { shapeScaleUseVariableRef, shapeScaleUseVariable, shapeScaleVariableNameRef } = editor;
  const { shapeScaleVariableName, shapeOffsetLeftVariableNameRef } = editor;
  const { shapeOffsetLeftVariableName, shapeOffsetTopVariableNameRef } = editor;
  const { shapeOffsetTopVariableName, isShapeTransformSelectedRef } = editor;
  const { isShapeTransformSelected, handleBoundsRef, handleBounds, isPresetOpenRef } = editor;
  const { isPresetOpen, circleRadiusAngleRef, circleRadiusAngle } = editor;
  const shortcutHelpGroups = useMemo(() => clipPathShortcutGroups(shape, shapeFitMode), [shape, shapeFitMode]);
  latestCssRef.current = css;
  shapeRef.current = shape;
  shapeFitModeRef.current = shapeFitMode;
  shapeScaleUseVariableRef.current = shapeScaleUseVariable;
  shapeScaleVariableNameRef.current = shapeScaleVariableName;
  shapeOffsetLeftVariableNameRef.current = shapeOffsetLeftVariableName;
  shapeOffsetTopVariableNameRef.current = shapeOffsetTopVariableName;
  isShapeTransformSelectedRef.current = isShapeTransformSelected;
  handleBoundsRef.current = handleBounds;
  isPresetOpenRef.current = isPresetOpen;
  circleRadiusAngleRef.current = circleRadiusAngle;
  return { shortcutHelpGroups };
}

export type EditorAfterLatestMirrors = EditorAfterSelectedCodeHighlights & ReturnType<typeof useLatestMirrors>;

// Keeping presets, pending writes, and point colours in step with the shape.
export function shapeSyncActions(editor: EditorAfterLatestMirrors) {
  const { setActivePreset, setActivePresetIndex, writeTimerRef, selectionReadSeqRef } = editor;
  const { selectionReadTimerRef, localWritePendingRef, polygonPointColorsRef } = editor;
  const { setPolygonPointColors } = editor;
  const syncPresetForShape = (next: ClipShape) => {
    const matchedPreset = matchPreset(next);
    const nextPreset = matchedPreset || NONE_PRESET;
    setActivePreset(nextPreset);
    setActivePresetIndex(PRESET_NAMES.indexOf(nextPreset));
  };

  const clearPendingWrite = () => {
    if (writeTimerRef.current !== undefined) {
      window.clearTimeout(writeTimerRef.current);
      writeTimerRef.current = undefined;
    }
  };

  const cancelPendingSelectionRead = () => {
    selectionReadSeqRef.current += 1;
    if (selectionReadTimerRef.current !== undefined) {
      window.clearTimeout(selectionReadTimerRef.current);
      selectionReadTimerRef.current = undefined;
    }
  };

  const markLocalShapeChange = () => {
    localWritePendingRef.current = true;
    cancelPendingSelectionRead();
  };

  const syncPolygonPointColors = (colors: string[]) => {
    polygonPointColorsRef.current = colors;
    setPolygonPointColors(colors);
  };

  const syncPolygonPointColorsForShape = (next: ClipShape, colors = polygonPointColorsRef.current) => {
    syncPolygonPointColors(next.kind === 'polygon' ? normalizePolygonPointColors(next.points.length, colors) : []);
  };
  return {
    syncPresetForShape,
    clearPendingWrite,
    cancelPendingSelectionRead,
    markLocalShapeChange,
    syncPolygonPointColors,
    syncPolygonPointColorsForShape,
  };
}

export type EditorAfterShapeSyncActions = EditorAfterLatestMirrors & ReturnType<typeof shapeSyncActions>;

// Keeping the shape-scale options and fit mode in step with a loaded shape.
export function shapeScaleSyncActions(editor: EditorAfterShapeSyncActions) {
  const { shapeScaleUseVariableRef, shapeScaleVariableNameRef } = editor;
  const { shapeOffsetLeftVariableNameRef, shapeOffsetTopVariableNameRef } = editor;
  const { setShapeScaleUseVariable, setShapeScaleVariableName } = editor;
  const { setShapeOffsetLeftVariableName, setShapeOffsetTopVariableName, shapeFitModeRef } = editor;
  const { setShapeFitMode } = editor;
  const currentShapeScaleOptions = (overrides: ShapeScaleOptionOverrides = {}): ShapeScaleOptions => ({
    useVariable: overrides.useVariable ?? shapeScaleUseVariableRef.current,
    variableName: overrides.variableName ?? shapeScaleVariableNameRef.current,
    offsetLeftVariableName: overrides.offsetLeftVariableName ?? shapeOffsetLeftVariableNameRef.current,
    offsetTopVariableName: overrides.offsetTopVariableName ?? shapeOffsetTopVariableNameRef.current,
  });

  const syncShapeScaleOptionsForLoadedShape = (next: ClipShape) => {
    if (next.kind !== 'shape') {
      return;
    }
    const variableName = shapeScaleVariableNameFromValue(next.value);
    const offsetNames = shapeOffsetVariableNamesFromValue(next.value);
    const nextUseVariable = Boolean(variableName);
    shapeScaleUseVariableRef.current = nextUseVariable;
    setShapeScaleUseVariable(nextUseVariable);

    // A loaded variable shows as a reference, so it draws as a chip the way the
    // panel shows any other bound value. A field that already names it keeps its
    // text: the shape being loaded may be the one the field's own typing just wrote.
    const syncField = (ref: MutableRefObject<string>, name: string | undefined, set: (text: string) => void) => {
      if (!name) {
        return;
      }
      if (sanitizeShapeScaleVariableName(ref.current) === name) {
        return;
      }
      const fieldText = shapeVariableFieldText(name);
      assert(sanitizeShapeScaleVariableName(fieldText) === name, 'syncShapeScaleOptionsForLoadedShape: the field names the loaded variable');
      ref.current = fieldText;
      set(fieldText);
    };
    syncField(shapeScaleVariableNameRef, variableName, setShapeScaleVariableName);
    syncField(shapeOffsetLeftVariableNameRef, offsetNames?.offsetLeftVar, setShapeOffsetLeftVariableName);
    syncField(shapeOffsetTopVariableNameRef, offsetNames?.offsetTopVar, setShapeOffsetTopVariableName);
  };

  const syncShapeFitModeForLoadedShape = (next: ClipShape, fallbackMode?: ShapeFitMode) => {
    if (next.kind !== 'shape') {
      return;
    }
    if (fallbackMode !== 'stretch') {
      syncShapeScaleOptionsForLoadedShape(next);
    }
    const nextMode: ShapeFitMode = fallbackMode || (hasContainerQueryUnit(next.value) ? 'contain' : 'stretch');
    shapeFitModeRef.current = nextMode;
    setShapeFitMode(nextMode);
  };
  return {
    currentShapeScaleOptions,
    syncShapeScaleOptionsForLoadedShape,
    syncShapeFitModeForLoadedShape,
  };
}

export type EditorAfterShapeScaleSyncActions = EditorAfterShapeSyncActions & ReturnType<typeof shapeScaleSyncActions>;

// The pasted-SVG cache, point colours, the keyboard move loop, and snap guides.
export function pastedCacheActions(editor: EditorAfterShapeScaleSyncActions) {
  const { pastedShapeSvgCacheRef, currentShapeScaleOptions, polygonPointColorsRef } = editor;
  const { syncPolygonPointColors, setActiveInsetModifierMode, keyboardMoveDelayTimerRef } = editor;
  const { keyboardMoveTimerRef, pressedArrowKeysRef, setSnapGuides } = editor;
  const clearPastedShapeSvgCache = () => {
    pastedShapeSvgCacheRef.current = undefined;
  };

  const shapeMatchesPastedSvgCache = (next: ClipShape, cache = pastedShapeSvgCacheRef.current) =>
    next.kind === 'shape' && Boolean(cache && (shapesClose(next, cache.stretch) || shapesClose(next, cache.contain)));

  const matchingPastedSvgCacheForShape = (next: ClipShape, options: ShapeScaleOptions = currentShapeScaleOptions()) => {
    const cache = normalizeShapeFitCache(pastedShapeSvgCacheRef.current, options);
    return next.kind === 'shape' && cache && shapeMatchesPastedSvgCache(next, cache) ? cache : undefined;
  };

  const cacheFromPastedShapeSvgSource = (source: string): PastedShapeSvgCache | undefined => {
    const stretch = parseSvgClipPathShape(source, 'stretch');
    const contain = parseSvgClipPathShape(source, 'contain', currentShapeScaleOptions());
    return normalizeShapeFitCache(stretch && contain ? { source, stretch, contain } : undefined, currentShapeScaleOptions());
  };

  const insertPolygonPointColor = (insertIndex: number, pointCount: number) => {
    const colors = normalizePolygonPointColors(pointCount, polygonPointColorsRef.current);
    const nextColor = nextPolygonPointColor(colors, insertIndex);
    const nextColors = [...colors.slice(0, insertIndex), nextColor, ...colors.slice(insertIndex)];
    syncPolygonPointColors(nextColors);
    return nextColors;
  };

  const syncInsetModifierMode = (modifiers: KeyboardModifiers) => {
    const next = insetModifierModeFromKeys(modifiers);
    setActiveInsetModifierMode((current) => (current === next ? current : next));
    return next;
  };

  const stopKeyboardMoveLoop = (clearKeys = true) => {
    if (keyboardMoveDelayTimerRef.current !== undefined) {
      window.clearTimeout(keyboardMoveDelayTimerRef.current);
      keyboardMoveDelayTimerRef.current = undefined;
    }
    if (keyboardMoveTimerRef.current !== undefined) {
      window.clearInterval(keyboardMoveTimerRef.current);
      keyboardMoveTimerRef.current = undefined;
    }
    if (clearKeys) {
      pressedArrowKeysRef.current.clear();
    }
  };

  const showSnapGuides = (guides: SnapGuides) => {
    setSnapGuides(normalizeSnapGuides(guides));
  };

  const clearSnapGuides = () => {
    setSnapGuides(undefined);
  };
  return {
    clearPastedShapeSvgCache,
    shapeMatchesPastedSvgCache,
    matchingPastedSvgCacheForShape,
    cacheFromPastedShapeSvgSource,
    insertPolygonPointColor,
    syncInsetModifierMode,
    stopKeyboardMoveLoop,
    showSnapGuides,
    clearSnapGuides,
  };
}

export type EditorAfterPastedCacheActions = EditorAfterShapeScaleSyncActions & ReturnType<typeof pastedCacheActions>;

// Selecting handles, and reading the polygon selection.
export function handleSelectionActions(editor: EditorAfterPastedCacheActions) {
  const { isShapeTransformSelectedRef, setIsShapeTransformSelected, selectedHandleRef } = editor;
  const { stopKeyboardMoveLoop, clearSnapGuides, selectedHandlesRef, setSelectedHandle } = editor;
  const { setSelectedCodeHandles, setActiveInsetModifierMode, spaceKeyPressedRef } = editor;
  const setShapeTransformSelection = (selected: boolean) => {
    isShapeTransformSelectedRef.current = selected;
    setIsShapeTransformSelected(selected);
    if (!selected) {
      if (!selectedHandleRef.current) {
        stopKeyboardMoveLoop();
      }
      clearSnapGuides();
      return;
    }

    selectedHandleRef.current = undefined;
    selectedHandlesRef.current = [];
    setSelectedHandle(undefined);
    setSelectedCodeHandles([]);
    setActiveInsetModifierMode('single');
  };

  const setHandleSelection = (handle: HandleTarget | undefined, handles = handle ? [handle] : []) => {
    if (isShapeTransformSelectedRef.current) {
      isShapeTransformSelectedRef.current = false;
      setIsShapeTransformSelected(false);
    }
    const nextHandles = handle ? uniqueHandles(handles.length ? handles : [handle]) : [];
    selectedHandleRef.current = handle;
    selectedHandlesRef.current = nextHandles;
    setSelectedHandle(handle);
    setSelectedCodeHandles(nextHandles);
    if (!handle) {
      spaceKeyPressedRef.current = false;
      stopKeyboardMoveLoop();
      clearSnapGuides();
      setActiveInsetModifierMode('single');
    }
  };

  const selectHandle = (handle: HandleTarget | undefined) => {
    setHandleSelection(handle);
  };

  const getPolygonSelection = (handle: HandleTarget) => {
    if (!isPolygonPointHandle(handle)) {
      return [];
    }

    const selectedPolygonHandles = selectedHandlesRef.current.filter(isPolygonPointHandle);
    return handleListIncludes(selectedPolygonHandles, handle) ? selectedPolygonHandles : [handle];
  };

  const getPolygonSelectionIndexes = (handle: HandleTarget) => getPolygonSelection(handle).map((selected) => selected.index);

  const getActivePolygonSelection = () => {
    const selectedPolygonHandles = selectedHandlesRef.current.filter(isPolygonPointHandle);
    if (selectedPolygonHandles.length) {
      return selectedPolygonHandles;
    }

    const selectedHandle = selectedHandleRef.current;
    return isPolygonPointHandle(selectedHandle) ? [selectedHandle] : [];
  };
  return {
    setShapeTransformSelection,
    setHandleSelection,
    selectHandle,
    getPolygonSelection,
    getPolygonSelectionIndexes,
    getActivePolygonSelection,
  };
}
