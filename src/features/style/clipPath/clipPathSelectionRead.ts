// Reading the selected element into the editor: starting a read while a
// write may be in flight, its clip-path and styles, the classes it carries and
// which of their styles holds clip-path, and following the default selection
// (ClipPath.tsx).

import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import type { StyleHandle, StyleTargetOptions, WebflowApi } from './webflowDesigner';
import { type ClipShape, type ShapeScaleOptions, type ClipPathStyleOrigin, type SelectionReadOptions, type PastedShapeSvgCache } from './clipPathTypes';
import { DEFAULT_SHAPE_OFFSET_LEFT_VARIABLE_NAME, DEFAULT_SHAPE_OFFSET_TOP_VARIABLE_NAME, CLIP_PATH_DEBUG, NONE_SHAPE } from './clipPathConstants';
import { shapesClose } from './clipPathHandles';
import { shapeOffsetVariableNamesFromValue, shapeScaleVariableNameFromValue } from './shapeFunctionPatterns';
import { cacheFromShapeFitVariants, normalizeShapeFitCache } from './shapeFunctionModel';
import { normalizeClipPathValue } from './svgContours';
import { matchPreset } from './clipPathShortcuts';
import { isSpaceKey, isRadiusUnlockKey, isArrowKey } from './shapeKeyboard';
import {
  debugClipPath,
  selectedElementKey,
  getElementPrimaryStyleHandles,
  getElementClassNames,
  getStyleLookupCandidates,
  getStyleNamePath,
  getClassStyleHandlesWithDiagnostics,
} from './clipPathStyleRead';
import {
  hasClipPathDeclaration,
  styleOptionsForBreakpoint,
  clipPathStyleOriginFromSource,
  readClipPathDeclarationWithSource,
  readPastedShapeMetadata,
  findClipPathStyle,
  debugStyleSummary,
  debugStyleSummaries,
  findStyleForClassPath,
  resolveCascadeWinnerClipPathStyle,
} from './clipPathStyleWrite';
import { type EditorAfterShortcutListeners, windowKeyDownActions } from './clipPathPointerActions';

export type EditorAfterWindowKeyDownActions = EditorAfterShortcutListeners & ReturnType<typeof windowKeyDownActions>;

// The window key listeners that move handles.
export function useWindowKeyListeners(editor: EditorAfterWindowKeyDownActions) {
  const { handledKeyboardEventsRef, radiusUnlockKeyPressedRef } = editor;
  const { updateKeyboardModifierRefs, spaceKeyPressedRef, selectedHandleRef } = editor;
  const { isShapeTransformSelectedRef, releaseKeyboardMoveKey, keyboardModifiersRef } = editor;
  const { stopKeyboardMoveLoop, setActiveInsetModifierMode, onWindowKeyDown } = editor;
  const onWindowKeyUp = (event: KeyboardEvent) => {
    if (handledKeyboardEventsRef.current.has(event)) {
      return;
    }
    const target = event.target instanceof HTMLElement ? event.target : undefined;
    const isHandleTarget = target instanceof Element && Boolean(target.closest('.clip-path_handle'));

    if (isRadiusUnlockKey(event.key, event.code)) {
      radiusUnlockKeyPressedRef.current = false;
      updateKeyboardModifierRefs({
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        radiusUnlocked: false,
      });
      return;
    }

    if (isHandleTarget && (isSpaceKey(event.key, event.code) || isArrowKey(event.key))) {
      return;
    }

    if (isSpaceKey(event.key, event.code)) {
      spaceKeyPressedRef.current = false;
      if (selectedHandleRef.current || isShapeTransformSelectedRef.current) {
        event.preventDefault();
      }
      return;
    }

    updateKeyboardModifierRefs(event);
    if (!isArrowKey(event.key)) {
      return;
    }

    releaseKeyboardMoveKey(event.key, event);
  };

  const onWindowKeyBlur = () => {
    spaceKeyPressedRef.current = false;
    radiusUnlockKeyPressedRef.current = false;
    keyboardModifiersRef.current = { altKey: false, shiftKey: false, radiusUnlocked: false };
    stopKeyboardMoveLoop();
    setActiveInsetModifierMode('single');
  };

  // Window key listeners, registered once: they reach the current render's
  // handlers through this ref.
  const windowKeyHandlers = { onWindowKeyDown, onWindowKeyUp, onWindowKeyBlur };
  const windowKeyRef = useRef(windowKeyHandlers);
  windowKeyRef.current = windowKeyHandlers;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => windowKeyRef.current.onWindowKeyDown(event);
    const onKeyUp = (event: KeyboardEvent) => windowKeyRef.current.onWindowKeyUp(event);
    const onBlur = () => windowKeyRef.current.onWindowKeyBlur();
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);
  return { onWindowKeyUp, onWindowKeyBlur, windowKeyHandlers, windowKeyRef };
}

export type EditorAfterWindowKeyListeners = EditorAfterWindowKeyDownActions & ReturnType<typeof useWindowKeyListeners>;

// What a selection read reads and records.
export type SelectionReader = EditorAfterWindowKeyListeners;

// One subscription to the Designer's selection, cancelled when the editor unmounts.
// The reader is the latest render's editor.
export type SelectionSession = {
  cancelled: boolean;
  readonly webflowApi: WebflowApi;
  readonly readerRef: MutableRefObject<SelectionReader>;
};

// The bookkeeping of one read: its sequence number, whether it was forced, and
// whether it is logged.
export type SelectionRead = { readSeq: number; force: boolean; debugRead: boolean };

// The styles an element carries and the clip-path style found among them.
export type FoundClipPathStyle = Awaited<ReturnType<typeof findClipPathStyle>>;
export type ElementStyles = {
  styles: StyleHandle[];
  classNames: string[];
  selectedStyle: FoundClipPathStyle;
  styleOptions: StyleTargetOptions | undefined;
};

// Whether this read still counts: not cancelled, and not superseded by a later one.
export function isCurrentRead(session: SelectionSession, read: SelectionRead): boolean {
  if (session.cancelled) {
    return false;
  }
  return read.readSeq === session.readerRef.current.selectionReadSeqRef.current;
}

// No clip-path on the selection: forget the style and show none. Embedded in
// the Style panel, the shape on screen stays: the panel's value was loaded.
export function loadNoneIfChanged(reader: SelectionReader, { force }: { force: boolean }): void {
  const { styleRef } = reader;
  styleRef.current = undefined;
  showNoClipPathSource(reader);
  if (reader.onApplyRef.current !== undefined) {
    return; // Embedded: the panel's value is loaded (ClipPath usePanelValue); a lookup that sees no CSS says nothing.
  }
  if (shouldReloadNone(reader, { force })) {
    reader.loadShapeFromSelection(NONE_SHAPE, 'none');
  }
}

// No clip-path on the selection, which a later write can go to `style`.
export function loadNoneForWritableStyle(reader: SelectionReader, style: StyleHandle | undefined, { force }: { force: boolean }): void {
  const { styleRef } = reader;
  styleRef.current = style || undefined;
  showNoClipPathSource(reader);
  if (reader.onApplyRef.current !== undefined) {
    return; // Embedded: the panel's value is loaded (ClipPath usePanelValue); a lookup that sees no CSS says nothing.
  }
  if (shouldReloadNone(reader, { force })) {
    reader.loadShapeFromSelection(NONE_SHAPE, 'none');
  }
}

export function showNoClipPathSource(reader: SelectionReader): void {
  reader.setClipPathStyleOrigin('none');
  reader.setAppliedClassName(undefined);
  reader.setClipPathSourceSelector([]);
  reader.setClipPathSourceBreakpoint(undefined);
  reader.setIsClipPathLabelMenuOpen(false);
}

export function shouldReloadNone(reader: SelectionReader, { force }: { force: boolean }): boolean {
  return force || reader.lastWrittenRef.current !== 'none' || !shapesClose(reader.shapeRef.current, NONE_SHAPE);
}

export async function readSelectedElement(session: SelectionSession, element: unknown, options: SelectionReadOptions = {}): Promise<void> {
  const read = startSelectionRead(session, element, options);
  if (!read) {
    return;
  }
  try {
    await readElementClipPath(session, read, element);
  } catch (error: unknown) {
    if (read.debugRead) {
      debugClipPath('readSelectedElement:error', error);
    }
    if (isCurrentRead(session, read)) {
      if (read.force) {
        loadNoneIfChanged(session.readerRef.current, { force: read.force });
      }
    }
  } finally {
    const reader = session.readerRef.current;
    if (read.readSeq === reader.selectionReadSeqRef.current) {
      reader.selectionReadInProgressRef.current = false;
    }
  }
}

// Claims the read and handles what needs no styles: a read already running, a
// write about to land, a new element, no element at all. Undefined when the read
// is over.
export function startSelectionRead(session: SelectionSession, element: unknown, options: SelectionReadOptions): SelectionRead | undefined {
  const reader = session.readerRef.current;
  const force = options.force ?? false;
  if (reader.selectionReadInProgressRef.current && !force && !options.resetStyle) {
    return undefined;
  }
  reader.selectionReadInProgressRef.current = true;
  const readSeq = ++reader.selectionReadSeqRef.current;
  const nextElementKey = selectedElementKey(element);
  const selectionChanged = nextElementKey !== reader.selectedElementKeyRef.current;
  const debugRead = Boolean(CLIP_PATH_DEBUG && (force || options.resetStyle || selectionChanged));
  if (debugRead) {
    debugClipPath('readSelectedElement:start', {
      activeBreakpoint: reader.activeBreakpointRef.current,
      elementKey: nextElementKey,
      force,
      resetStyle: Boolean(options.resetStyle),
      selectionChanged,
    });
  }
  if (selectionChanged) {
    forgetPreviousElement(reader, nextElementKey);
  }
  if (options.resetStyle) {
    reader.clearPendingWrite();
    reader.localWritePendingRef.current = false;
    reader.styleRef.current = undefined;
  } else if (!selectionChanged && writeInFlight(reader)) {
    reader.selectionReadInProgressRef.current = false;
    return undefined;
  }
  const read = { readSeq, force, debugRead };
  if (!element) {
    finishEmptySelectionRead(session, read);
    return undefined;
  }
  return read;
}

// A write (or a drag that will write) is pending; a read now would undo it.
export function writeInFlight(reader: SelectionReader): boolean {
  return Boolean(reader.localWritePendingRef.current || reader.writeTimerRef.current !== undefined || reader.dragTargetRef.current);
}

// A different element: its classes, selection, and pending write start over.
export function forgetPreviousElement(reader: SelectionReader, nextElementKey: string | undefined): void {
  const { selectedElementKeyRef, selectedClassNamesRef, selectionIsDefaultRef } = reader;
  const { cascadeWinnerCacheRef, localWritePendingRef } = reader;
  selectedElementKeyRef.current = nextElementKey;
  selectedClassNamesRef.current = [];
  selectionIsDefaultRef.current = true;
  cascadeWinnerCacheRef.current = undefined;
  reader.setSelectedClassNames([]);
  reader.clearPendingWrite();
  localWritePendingRef.current = false;
  loadNoneIfChanged(reader, { force: true });
}

// Nothing selected: no classes, and no clip-path.
export function finishEmptySelectionRead(session: SelectionSession, read: SelectionRead): void {
  const reader = session.readerRef.current;
  if (read.debugRead) {
    debugClipPath('readSelectedElement:no-element');
  }
  if (isCurrentRead(session, read)) {
    reader.setElementClassNames([]);
    reader.selectedClassNamesRef.current = [];
    reader.selectionIsDefaultRef.current = true;
    reader.setSelectedClassNames([]);
    loadNoneIfChanged(reader, { force: read.force });
  }
  if (read.readSeq === reader.selectionReadSeqRef.current) {
    reader.selectionReadInProgressRef.current = false;
  }
}

// Reads the element's clip-path — from its own styles, its classes, the cascade
// winner, or the classes picked in the tags — and loads it into the editor.
export async function readElementClipPath(session: SelectionSession, read: SelectionRead, element: unknown): Promise<void> {
  const found = await readElementStyles(session, read, element);
  if (!found) {
    return;
  }
  const defaultStyle = await followDefaultSelection(session, read, found);
  if (defaultStyle === 'stale') {
    return;
  }
  const target = await targetSelectedClasses(session, read, {
    ...found,
    selectedStyle: defaultStyle,
  });
  if (target.kind === 'done') {
    return;
  }
  const selectedStyle = await applySelectedStyle(session, read, found, target);
  if (!selectedStyle) {
    return;
  }
  await loadSelectedShape(session, read, found, {
    selectedStyle,
    refineKey: target.inheritedWinnerRefineKey,
  });
}

// The element's styles and class names, and the style its clip-path comes from:
// its own styles first, then its classes' styles. Undefined when the read is stale.
export async function readElementStyles(session: SelectionSession, read: SelectionRead, element: unknown): Promise<ElementStyles | undefined> {
  const reader = session.readerRef.current;
  const styleOptions = styleOptionsForBreakpoint(reader.activeBreakpointRef.current);
  const styles = await getElementPrimaryStyleHandles(element);
  if (!isCurrentRead(session, read)) {
    return undefined;
  }
  let selectedStyle = await findClipPathStyle(styles, styleOptions);
  const classNames = await getElementClassNames(element, styles);
  if (isCurrentRead(session, read)) {
    reader.setElementClassNames(classNames);
  }
  dropRemovedSelectedClasses(session, read, classNames);
  if (read.debugRead) {
    debugClipPath('readSelectedElement:primary-styles', {
      classNames,
      lookupCandidates: getStyleLookupCandidates(classNames),
      styles: await debugStyleSummaries(styles, styleOptions),
      selectedStyle: selectedStyle ? await debugStyleSummary(selectedStyle.style, styleOptions) : undefined,
      selectedRaw: selectedStyle?.raw || undefined,
      selectedBreakpoint: selectedStyle?.breakpoint || undefined,
    });
  }
  const found = { styles, classNames, selectedStyle, styleOptions };
  if (!hasClipPathDeclaration(selectedStyle?.raw)) {
    const fromClasses = await lookupClassClipPathStyle(session, read, found);
    if (fromClasses === 'stale') {
      return undefined;
    }
    selectedStyle = fromClasses;
  }
  if (!isCurrentRead(session, read)) {
    return undefined;
  }
  return { ...found, selectedStyle };
}

// Drop any manually selected classes that are no longer on the element (e.g.
// removed in the Designer) so we don't keep resolving their style globally and
// showing a stale preview.
export function dropRemovedSelectedClasses(session: SelectionSession, read: SelectionRead, classNames: string[]): void {
  const reader = session.readerRef.current;
  if (!reader.selectedClassNamesRef.current.some((name) => !classNames.includes(name))) {
    return;
  }
  const stillPresent = reader.selectedClassNamesRef.current.filter((name) => classNames.includes(name));
  reader.selectedClassNamesRef.current = stillPresent;
  if (isCurrentRead(session, read)) {
    reader.setSelectedClassNames(stillPresent);
  }
}

// The element's own styles declare no clip-path: look through its classes' styles.
export async function lookupClassClipPathStyle(
  session: SelectionSession,
  read: SelectionRead,
  { styles, classNames, selectedStyle, styleOptions }: ElementStyles,
): Promise<FoundClipPathStyle | 'stale'> {
  if (read.debugRead) {
    debugClipPath('readSelectedElement:class-lookup-start', {
      classNames,
      lookupCandidates: getStyleLookupCandidates(classNames),
    });
  }
  const classLookup = await getClassStyleHandlesWithDiagnostics(classNames, session.webflowApi);
  const classStyles = classLookup.styles;
  if (!isCurrentRead(session, read)) {
    return 'stale';
  }
  let classSelectedStyle: FoundClipPathStyle = undefined;
  let nextSelectedStyle = selectedStyle;
  if (classStyles.length) {
    classSelectedStyle = await findClipPathStyle([...classStyles, ...styles], styleOptions);
    if (hasClipPathDeclaration(classSelectedStyle?.raw) || !selectedStyle) {
      nextSelectedStyle = classSelectedStyle;
    }
  }
  if (read.debugRead) {
    debugClipPath('readSelectedElement:class-styles', {
      lookupResults: classLookup.diagnostics,
      classStyles: await debugStyleSummaries(classStyles, styleOptions),
      classSelectedStyle: classSelectedStyle ? await debugStyleSummary(classSelectedStyle.style, styleOptions) : undefined,
      classSelectedRaw: classSelectedStyle?.raw || undefined,
      classSelectedBreakpoint: classSelectedStyle?.breakpoint || undefined,
      finalSelectedRaw: nextSelectedStyle?.raw || undefined,
      finalSelectedBreakpoint: nextSelectedStyle?.breakpoint || undefined,
    });
  }
  return nextSelectedStyle;
}

// While the selection is still the auto-default (user hasn't manually picked a
// class), keep it locked to the current cascade winner — the clip-path that
// actually renders: highest specificity, then latest stylesheet position — so it
// follows style resets and class add/remove on the same element, not just on
// element change.
export async function followDefaultSelection(session: SelectionSession, read: SelectionRead, found: ElementStyles): Promise<FoundClipPathStyle | 'stale'> {
  const reader = session.readerRef.current;
  if (!reader.selectionIsDefaultRef.current) {
    return found.selectedStyle;
  }
  const winner = hasClipPathDeclaration(found.selectedStyle?.raw)
    ? await resolveCascadeWinnerClipPathStyle(found.classNames, found.styles, found.styleOptions, session.webflowApi)
    : undefined;
  if (!isCurrentRead(session, read)) {
    return 'stale';
  }
  const defaultSelection = winner ? winner.namePath.filter((name) => found.classNames.includes(name)) : [];
  const current = reader.selectedClassNamesRef.current;
  const changed = defaultSelection.length !== current.length || defaultSelection.some((name, index) => name !== current[index]);
  if (changed) {
    reader.selectedClassNamesRef.current = defaultSelection;
    reader.setSelectedClassNames(defaultSelection);
  }
  return winner ? { style: winner.style, raw: winner.raw, breakpoint: winner.breakpoint } : found.selectedStyle;
}

// Where the read lands for the classes picked in the tags, or 'done' when it has
// already settled on none.
export type SelectedClassTarget =
  | { kind: 'done' }
  | {
      kind: 'style';
      selectedStyle: FoundClipPathStyle;
      selectedNames: string[];
      writeStyleHandle: StyleHandle | undefined;
      originOverride: ClipPathStyleOrigin | undefined;
      appliedNameOverride: { name: string | undefined } | undefined;
      // Set when an inherited class showed its cheap effective value and still needs
      // the exact cascade winner resolved (in the background) afterward.
      inheritedWinnerRefineKey: string | undefined;
    };
export type ClassStyleTarget = Extract<SelectedClassTarget, { kind: 'style' }>;

// When classes are picked in the tags, target them for reading and writing. If
// they have no clip-path of their own, show the effective (cascade-winner) value
// and mark it inherited — like a larger-breakpoint inheritance.
export async function targetSelectedClasses(session: SelectionSession, read: SelectionRead, found: ElementStyles): Promise<SelectedClassTarget> {
  const reader = session.readerRef.current;
  const selectedNames = reader.selectedClassNamesRef.current;
  const untargeted: ClassStyleTarget = {
    kind: 'style',
    selectedStyle: found.selectedStyle,
    selectedNames,
    writeStyleHandle: undefined,
    originOverride: undefined,
    appliedNameOverride: undefined,
    inheritedWinnerRefineKey: undefined,
  };
  if (!selectedNames.length) {
    return untargeted;
  }
  // Resolve the exact standalone class (`.clip-path`) for a single selection, or
  // the exact combo (`.hero.clip-path`) for several — path-verified so we never
  // grab a combo whose leaf name merely matches, and never the element's own
  // most-specific combo handle.
  const targetStyle = await findStyleForClassPath(selectedNames, session.webflowApi);
  if (!isCurrentRead(session, read)) {
    return { kind: 'done' };
  }
  const targetDeclaration = targetStyle ? await readClipPathDeclarationWithSource(targetStyle, found.styleOptions) : undefined;
  if (!isCurrentRead(session, read)) {
    return { kind: 'done' };
  }
  if (targetStyle && targetDeclaration && hasClipPathDeclaration(targetDeclaration.value)) {
    return {
      ...untargeted,
      writeStyleHandle: targetStyle,
      selectedStyle: {
        style: targetStyle,
        raw: targetDeclaration.value,
        breakpoint: targetDeclaration.breakpoint,
      },
      appliedNameOverride: { name: selectedNames[selectedNames.length - 1] ?? undefined },
    };
  }
  if (hasClipPathDeclaration(found.selectedStyle?.raw)) {
    return inheritForSelectedClasses(session, read, found, {
      ...untargeted,
      writeStyleHandle: targetStyle,
    });
  }
  // Nothing renders → none on the (writable) selected class.
  loadNoneForWritableStyle(reader, targetStyle, { force: read.force });
  return { kind: 'done' };
}

// The selected class has no clip-path of its own, but the element shows an
// effective one → inherited. Paint the orange label + the cheap effective value
// INSTANTLY; resolve the exact cascade winner (slower) afterward and only re-read
// if it actually differs.
export function inheritForSelectedClasses(session: SelectionSession, read: SelectionRead, found: ElementStyles, target: ClassStyleTarget): ClassStyleTarget {
  const reader = session.readerRef.current;
  if (isCurrentRead(session, read)) {
    reader.setClipPathStyleOrigin('inherited');
  }
  const inherited: ClassStyleTarget = { ...target, originOverride: 'inherited' };
  const winnerKey = `${found.classNames.join('\u0000')}|` + `${found.selectedStyle?.style?.id ?? ''}|${found.selectedStyle?.raw ?? ''}`;
  const cached = reader.cascadeWinnerCacheRef.current;
  if (cached && cached.key === winnerKey) {
    // Exact winner already known — use it directly (no flash).
    if (!cached.winner) {
      return inherited;
    }
    return {
      ...inherited,
      selectedStyle: {
        style: cached.winner.style,
        raw: cached.winner.raw,
        breakpoint: cached.winner.breakpoint,
      },
    };
  }
  // Show the cheap effective value now; refine after this read.
  return { ...inherited, inheritedWinnerRefineKey: winnerKey };
}

// Points the editor at the style the value comes from and fills in the source
// label. Undefined when there is no clip-path to load (none has been shown).
export async function applySelectedStyle(
  session: SelectionSession,
  read: SelectionRead,
  found: ElementStyles,
  target: ClassStyleTarget,
): Promise<NonNullable<FoundClipPathStyle> | undefined> {
  const reader = session.readerRef.current;
  const { selectedStyle } = target;
  if (!selectedStyle) {
    if (read.debugRead) {
      debugClipPath('readSelectedElement:result-none-no-style');
    }
    loadNoneIfChanged(reader, { force: read.force });
    return undefined;
  }
  if (!hasClipPathDeclaration(selectedStyle.raw)) {
    if (read.debugRead) {
      debugClipPath('readSelectedElement:result-none-writable-style', {
        style: await debugStyleSummary(selectedStyle.style, found.styleOptions),
      });
    }
    loadNoneForWritableStyle(reader, selectedStyle.style, { force: read.force });
    return undefined;
  }
  // In class-selection mode never fall back to the element's combo handle; an
  // undefined target here means "create the selected class/combo on write".
  reader.styleRef.current = target.selectedNames.length ? target.writeStyleHandle : target.writeStyleHandle || selectedStyle.style;
  reader.setClipPathStyleOrigin(target.originOverride || clipPathStyleOriginFromSource(selectedStyle.breakpoint, reader.activeBreakpointRef.current));
  // The selector + breakpoint the rendered value actually comes from, for the
  // "Value comes from:" popover on the inherited (orange) label.
  const sourceNamePath = await getStyleNamePath(selectedStyle.style);
  if (isCurrentRead(session, read)) {
    const sourceClasses = sourceNamePath.filter((name) => found.classNames.includes(name));
    reader.setClipPathSourceSelector(sourceClasses.length ? sourceClasses : sourceNamePath);
    reader.setClipPathSourceBreakpoint(selectedStyle.breakpoint);
    reader.setAppliedClassName(target.appliedNameOverride ? target.appliedNameOverride.name : sourceNamePath[sourceNamePath.length - 1] || undefined);
  }
  return selectedStyle;
}

// Loads the selected style's clip-path into the editor, with its pasted-SVG
// variants when it has them.
export async function loadSelectedShape(
  session: SelectionSession,
  read: SelectionRead,
  found: ElementStyles,
  { selectedStyle, refineKey }: { selectedStyle: NonNullable<FoundClipPathStyle>; refineKey: string | undefined },
): Promise<void> {
  const reader = session.readerRef.current;
  const normalized = normalizeClipPathValue(selectedStyle.raw);
  if (read.debugRead) {
    debugClipPath('readSelectedElement:result-detected', {
      raw: selectedStyle.raw,
      normalizedCss: normalized.css,
      preset: matchPreset(normalized.shape),
      sourceBreakpoint: selectedStyle.breakpoint,
      style: await debugStyleSummary(selectedStyle.style, found.styleOptions),
    });
  }
  const loadedShapeScaleOptions = loadedShapeScaleOptionsFor(reader, normalized.shape);
  let rawShapeSvgCache: PastedShapeSvgCache | undefined = undefined;
  if (normalized.shape.kind === 'shape') {
    rawShapeSvgCache =
      reader.matchingPastedSvgCacheForShape(normalized.shape, loadedShapeScaleOptions) ||
      (await readPastedShapeMetadata(selectedStyle.style, found.styleOptions)) ||
      cacheFromShapeFitVariants(normalized.shape, loadedShapeScaleOptions);
  }
  const shapeSvgCache = normalizeShapeFitCache(rawShapeSvgCache, loadedShapeScaleOptions);
  const loadedShape =
    normalized.shape.kind === 'shape' && rawShapeSvgCache && shapeSvgCache && shapesClose(normalized.shape, rawShapeSvgCache.contain)
      ? shapeSvgCache.contain
      : normalized.shape;
  if (!isCurrentRead(session, read)) {
    return;
  }
  if (refineKey) {
    // Best effort: the lookups behind it swallow their own failures, and a winner
    // it cannot resolve leaves the effective value already on screen.
    void refineInheritedWinner(session, read, found, refineKey);
  }
  // Skip the reload when the value is unchanged from what we already have — even
  // on a forced re-read. `loadShapeFromSelection` wipes the undo stack, and a forced
  // re-read can fire right after applying to a NEW class (the createStyle triggers a
  // selection event), which would otherwise destroy the just-created undo step.
  // styleRef/origin/source are already set above, so this only avoids the needless
  // reload.
  const unchanged = reader.lastWrittenRef.current === normalized.css && shapesClose(reader.shapeRef.current, loadedShape);
  if (!unchanged) {
    reader.loadShapeFromSelection(loadedShape, normalized.css);
  }
  if (shapeSvgCache && reader.shapeMatchesPastedSvgCache(loadedShape, shapeSvgCache)) {
    reader.pastedShapeSvgCacheRef.current = shapeSvgCache;
  }
}

// The scale options a loaded shape was written with: its own variables, or the
// editor's current ones without a variable for a shape that names none.
export function loadedShapeScaleOptionsFor(reader: SelectionReader, shape: ClipShape): ShapeScaleOptions {
  const loadedScaleVariableName = shape.kind === 'shape' ? shapeScaleVariableNameFromValue(shape.value) : undefined;
  const loadedOffsetNames = shape.kind === 'shape' ? shapeOffsetVariableNamesFromValue(shape.value) : undefined;
  if (!loadedScaleVariableName) {
    return reader.currentShapeScaleOptions({ useVariable: false });
  }
  return {
    useVariable: true,
    variableName: loadedScaleVariableName,
    offsetLeftVariableName: loadedOffsetNames?.offsetLeftVar || DEFAULT_SHAPE_OFFSET_LEFT_VARIABLE_NAME,
    offsetTopVariableName: loadedOffsetNames?.offsetTopVar || DEFAULT_SHAPE_OFFSET_TOP_VARIABLE_NAME,
  };
}

// An inherited class just painted its cheap effective value. Resolve the exact
// cascade winner in the background; cache it and, if it actually differs from what
// we showed, re-read (which now hits the cache and loads the winner through the
// normal shape-aware path).
export async function refineInheritedWinner(session: SelectionSession, read: SelectionRead, found: ElementStyles, refineKey: string): Promise<void> {
  const winner = await resolveCascadeWinnerClipPathStyle(found.classNames, found.styles, found.styleOptions, session.webflowApi);
  if (!isCurrentRead(session, read)) {
    return;
  }
  const reader = session.readerRef.current;
  reader.cascadeWinnerCacheRef.current = { key: refineKey, winner };
  const winnerCss = winner ? normalizeClipPathValue(winner.raw).css : undefined;
  if (winnerCss && winnerCss !== reader.lastWrittenRef.current) {
    reader.refreshSelectedElementRef.current?.({ force: true });
  }
}
