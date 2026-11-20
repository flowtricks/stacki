import { ErrorToast } from '../../ui/ErrorToast';
import { requestSelectorFocus } from './embed/SelectorPicker';
import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useStyleFiles } from './useStyleFiles';
import type { ClassOutcome, HostState, StyleBlockRequest } from './model/host';
import type { ClassPlacement } from '../../editor/classAttr';
import { styleableSelection } from './model/styleTarget';
import { setHost } from './model/host';
import { prefetchComponentSources } from './model/componentSourceCache';
import { computedStylesSettled, prefetchComputedStyles } from './model/computedStyle';
import { assert } from '../../../shared/core/assert';
import { PX_LENGTHS, sameLengthUnit, type LengthUnit } from '../../../shared/properties/lengthUnit';
import EmbedEditor from './EmbedEditor';
import { useTranslate } from '../../lib/i18n/useTranslate';
import './tokens.css';
import './utilities.css';
import './embedEditor.css';
import { readAstroStyleFiles, readStyleFiles } from './stylePanelBridge';
import { clickNote } from '../../ui/sound';
import { SoundHere } from '../../ui/soundScope';
import usePopupOpen from './usePopupOpen';

interface StylePanelProps {
  readonly project: { readonly path: string } | undefined;
  readonly model?: { readonly nodes: HostState['nodes'] } | undefined;
  readonly node?: { readonly id: string } | undefined;
  readonly device?: string;
  /** The canvas's rendered width, which the context dropdown follows (HostState). */
  readonly canvasWidthPx?: number | undefined;
  readonly pathOf?: HostState['pathOf'];
  readonly onWriteStyleNode?: HostState['writeStyleNode'] | undefined;
  readonly onSelectNode?: HostState['selectNode'] | undefined;
  readonly onCanvasWidth?: HostState['setCanvasWidth'] | undefined;
  readonly onDesktopCanvas?: HostState['showDesktopCanvas'] | undefined;
  readonly onRecordUndo?: HostState['recordUndo'] | undefined;
  readonly onOpenStyleTagSettings?: HostState['openStyleTagSettings'];
  // The element writes name the node they are for: the element the panel shows
  // (useShownElementWrites), so a write in flight does not follow the selection.
  readonly onAddClass?: ((className: string, placement: ClassPlacement, nodeId: string) => Promise<ClassOutcome>) | undefined;
  readonly onAddStyleBlock?: ((request: StyleBlockRequest, nodeId: string) => Promise<ClassOutcome>) | undefined;
  readonly onRemoveClass?: ((className: string, nodeId: string) => Promise<ClassOutcome>) | undefined;
  readonly onRemoveAttribute?: ((attributeName: string, nodeId: string) => Promise<ClassOutcome>) | undefined;
  readonly onSetInlineStyle?: HostState['setInlineStyle'] | undefined;
  /** The open page's component files, read ahead for the chips' colours (HostState). */
  readonly pageComponentPaths?: readonly string[] | undefined;
  /** False while the canvas has not yet reported the selection's classes (HostState). Absent → known. */
  readonly renderedClassesKnown?: boolean | undefined;
  readonly onSpacingHover?: HostState['onSpacingHover'];
  readonly renderedClasses?: readonly string[] | undefined;
  readonly projectClasses?: readonly string[] | undefined;
  readonly historyTick?: number;
  readonly openFilePath?: string | undefined;
  readonly openFileKind?: HostState['openFileKind'];
  /** The page a component is being edited on, whose styles reach it (HostState). */
  readonly contextPagePath?: string | undefined;
  /** The component file the selected instance renders (HostState). */
  readonly selectedComponentPath?: string | undefined;
  readonly pseudoRequest?: HostState['pseudoRequest'];
  /** The navigator lists ::before and ::after rows (HostState). */
  readonly pseudoRows?: boolean;
  /** Counts ⌘Enter presses: each new one puts the caret in the selector field. */
  readonly selectorFocus?: number;
  /** The project's length unit, from its scan (HostState). Absent → px. */
  readonly lengthUnit?: LengthUnit | undefined;
}

type StyleFiles = HostState['files'];

const NO_PATHS: readonly string[] = [];

export default function StylePanel(rawProps: StylePanelProps) {
  // A node that puts no element on the page (Fragment, if/else, loop, slot, expression) is no
  // selection here: the empty state shows at once, not the chips of an element beneath it.
  const props = withStyleableNode(rawProps);
  const files = useStyleFiles(props.project?.path, undefined, readStyleFiles);
  const translate = useTranslate();
  const pageComponentPaths = props.pageComponentPaths ?? NO_PATHS;
  // The `.astro` files with a `<style>` are listed again when the page's components change, not only with the open
  // file: Create component puts a new one on the page, possibly with a `<style>` of its own ("Move styles"), and undo
  // takes it off. Without it, the new component's tag stays out of the list until the window next gets focus.
  const astroFilesKey = [props.openFilePath ?? '', ...pageComponentPaths].join('\u0000');
  const astroFiles = useStyleFiles(props.project?.path, astroFilesKey, readAstroStyleFiles);
  const lengthUnit = useStableLengthUnit(props.lengthUnit ?? PX_LENGTHS);
  const renderedClasses = useStableList(props.renderedClasses ?? NO_PATHS);
  const projectClasses = useStableList(props.projectClasses ?? NO_PATHS);
  const selection = useSelectionShown(props, renderedClasses);
  const writes = useShownElementWrites(props, selection);
  const host = hostState(
    { ...props, ...selection.props },
    { files: files.files, astroFiles: astroFiles.files, lengthUnit, renderedClasses: selection.renderedClasses, projectClasses, writes },
  );
  // Children read the bridge during their own effects, which run before the
  // parent's effects. Publishing here ensures their first read is current.
  setHost(host);
  useEffect(() => setHost(host), [host]);
  // Read with the page, not on the first instance picked: that pick then draws its settled colours.
  useEffect(() => prefetchComponentSources(pageComponentPaths), [pageComponentPaths]);
  const hostRef = useRef<HTMLDivElement>(null);
  useSwitchScrollAnchor(hostRef, selection.props.node?.id);
  usePanelBounds(hostRef);
  useSelectorFocus(hostRef, props.selectorFocus ?? 0);
  const popupOpen = usePopupOpen(hostRef);
  if (!props.project) {
    return undefined;
  }
  return (
    <SoundHere>
      <div className={`style-panel-host ${popupOpen ? 'is-locked' : ''}`} ref={hostRef} onClick={playButtonNote}>
        {files.error || astroFiles.error ? (
          <ErrorToast message={translate('style.stylePanel.loadError', { error: files.error || astroFiles.error || '' })} />
        ) : undefined}
        {selection.props.node ? <EmbedEditor /> : <div className="props-empty">{translate('style.stylePanel.selectElement')}</div>}
      </div>
    </SoundHere>
  );
}

function withStyleableNode(props: StylePanelProps): StylePanelProps {
  const node = styleableSelection(props.model, props.node);
  return node === props.node ? props : { ...props, node: undefined };
}

// What the panel is told about the selected element. Everything here describes ONE
// element, so it is published to the host together.
type SelectionProps = Pick<StylePanelProps, 'node' | 'renderedClassesKnown' | 'selectedComponentPath' | 'pseudoRequest'>;
interface ShownSelection {
  readonly props: SelectionProps;
  readonly renderedClasses: string[];
}

function selectionOf(props: StylePanelProps, renderedClasses: string[]): ShownSelection {
  return {
    props: {
      node: props.node,
      renderedClassesKnown: props.renderedClassesKnown,
      selectedComponentPath: props.selectedComponentPath,
      pseudoRequest: props.pseudoRequest,
    },
    renderedClasses,
  };
}

type ElementWrites = Pick<HostState, 'addClass' | 'addStyleBlock' | 'removeClass' | 'removeAttribute' | 'setInlineStyle'>;

/**
 * The element writes the panel makes (classes, a first style block, attributes, the inline
 * style), each addressed to the element the panel shows, which is always the app's selection
 * (useSelectionShown). Naming the node keeps an edit from following the selection: a write
 * still in flight when the person selects another element lands on the one it was made for.
 */
function useShownElementWrites(props: StylePanelProps, selection: ShownSelection): ElementWrites {
  const translate = useTranslate();
  const shownId = selection.props.node?.id;
  const { onAddClass, onAddStyleBlock, onRemoveClass, onRemoveAttribute, onSetInlineStyle } = props;
  return useMemo(() => {
    const guarded = (write: (nodeId: string) => Promise<ClassOutcome>): Promise<ClassOutcome> => {
      if (shownId === undefined) {
        return Promise.resolve({ tag: 'refused', message: translate('shell.refusal.noElement') });
      }
      return write(shownId);
    };
    return {
      addClass: onAddClass === undefined ? undefined : (className, placement) => guarded((nodeId) => onAddClass(className, placement, nodeId)),
      addStyleBlock: onAddStyleBlock === undefined ? undefined : (request) => guarded((nodeId) => onAddStyleBlock(request, nodeId)),
      removeClass: onRemoveClass === undefined ? undefined : (className) => guarded((nodeId) => onRemoveClass(className, nodeId)),
      removeAttribute: onRemoveAttribute === undefined ? undefined : (attributeName) => guarded((nodeId) => onRemoveAttribute(attributeName, nodeId)),
      // Addressed by the node the panel read its style attribute from (useInlineTarget).
      setInlineStyle: onSetInlineStyle,
    };
  }, [onAddClass, onAddStyleBlock, onRemoveClass, onRemoveAttribute, onSetInlineStyle, shownId, translate]);
}

// Which element is selected, in which document: node ids are tree paths, so the page's `0/1`
// and a component's `0/1` are different elements under one id.
function selectionKeyOf(props: StylePanelProps): string {
  return `${props.openFilePath ?? ''}\u0000${props.node?.id ?? ''}`;
}

/**
 * The selection the panel shows: always the app's, in the render that receives it. The panel
 * used to keep the previous element on screen until the next one's answer was in hand, up to
 * 1.5 s; in that time its chips, header and rows belonged to an element the app had already
 * left, and entering or leaving a component (another document, where the next element could
 * not be read ahead at all) showed them for the whole wait, or showed a third element: the
 * held id looked up in the newly opened document's tree. Now the next element is shown at
 * once: an element seen before under the same CSS paints from its last settled answer, and
 * one that is not draws the chip-shaped placeholders until its answer lands whole
 * (useElementReset). The sections never draw placeholders: their real controls are in the
 * first frame, from what the source already says, and the page's computed values are asked
 * for in one batch so they land as soon as the canvas can answer.
 */
function useSelectionShown(props: StylePanelProps, renderedClasses: string[]): ShownSelection {
  const key = selectionKeyOf(props);
  const shownKeyRef = useRef(key);
  const targetId = props.node?.id;
  // Before paint, so no frame draws the fields without their values; the listeners it
  // wakes are other components', which may not be updated while this one renders.
  useLayoutEffect(() => {
    const previousKey = shownKeyRef.current;
    shownKeyRef.current = key;
    if (previousKey === key || targetId === undefined) {
      return;
    }
    if (!computedStylesSettled(targetId)) {
      void prefetchComputedStyles(targetId);
    }
  }, [key, targetId]);
  return selectionOf(props, renderedClasses);
}

// A row the panel can find again after a switch: a field by its property, a dropdown or a
// segmented group by its label, a section by its title. `content` is what the row shows, so
// rows that look the same on both elements can be told from rows that changed.
interface ScrollAnchor {
  readonly key: string;
  readonly content: string;
  readonly offsetPx: number;
}

// The visible rows remembered across a switch, top first, bounded: the panel shows a few
// dozen rows at once.
const SCROLL_ANCHOR_CANDIDATES_MAX = 64;
// Every row the panel can draw, with room: a sanity bound on the scans above.
const SCROLL_ANCHOR_ROWS_MAX = 4096;
const SCROLL_ANCHOR_SELECTOR = '[data-prop], .embed-editor_section-title, button.u-select-button[aria-label], [role="group"][aria-label]';
const SCROLL_RESERVE_PROPERTY = '--switch-scroll-reserve';
// Moves within this of each other are one move: tops are measured to the half pixel.
const SCROLL_MOVE_PX_TOLERANCE = 0.5;

function panelScroller(host: HTMLElement | undefined): HTMLElement | undefined {
  const root = host?.querySelector(':scope > .embed-editor_root');
  return root instanceof HTMLElement ? root : undefined;
}

function anchorKeyOf(element: Element): string {
  const prop = element.getAttribute('data-prop');
  if (prop !== null) {
    return `prop:${prop}`;
  }
  const label = element.getAttribute('aria-label');
  return label === null ? `section:${(element.textContent ?? '').trim()}` : `label:${label}`;
}

function anchorContentOf(element: Element): string {
  const value = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : '';
  const row = element.closest('.embed-editor_varconnect') ?? element;
  return `${value}|${(row.textContent ?? '').trim()}`;
}

// The rows on screen now, top first: the first SCROLL_ANCHOR_CANDIDATES_MAX visible ones.
function visibleAnchors(scroller: HTMLElement): ScrollAnchor[] {
  const topPx = scroller.getBoundingClientRect().top;
  const anchors: ScrollAnchor[] = [];
  const seen = new Set<string>();
  const elements = scroller.querySelectorAll(SCROLL_ANCHOR_SELECTOR);
  assert(elements.length <= SCROLL_ANCHOR_ROWS_MAX, 'visibleAnchors: the panel has a bounded number of rows');
  for (const element of elements) {
    if (anchors.length >= SCROLL_ANCHOR_CANDIDATES_MAX) {
      break;
    }
    const key = anchorKeyOf(element);
    const offsetPx = element.getBoundingClientRect().top - topPx;
    if (offsetPx >= 0 && !seen.has(key)) {
      seen.add(key);
      anchors.push({ key, content: anchorContentOf(element), offsetPx });
    }
  }
  return anchors;
}

// The rows named by `keys`, wherever they are now. Searched in full, not by the first rows:
// a deep scroll's rows come late in the panel's order, and a bounded scan from the top
// found only the rows above the screen, whose moves are not the ones under the pointer.
function anchorsByKey(scroller: HTMLElement, keys: ReadonlySet<string>): ScrollAnchor[] {
  const topPx = scroller.getBoundingClientRect().top;
  const anchors: ScrollAnchor[] = [];
  const seen = new Set<string>();
  const elements = scroller.querySelectorAll(SCROLL_ANCHOR_SELECTOR);
  assert(elements.length <= SCROLL_ANCHOR_ROWS_MAX, 'anchorsByKey: the panel has a bounded number of rows');
  for (const element of elements) {
    const key = anchorKeyOf(element);
    if (keys.has(key) && !seen.has(key)) {
      seen.add(key);
      anchors.push({ key, content: anchorContentOf(element), offsetPx: element.getBoundingClientRect().top - topPx });
    }
  }
  return anchors;
}

/**
 * How far to scroll so the most rows stay where they were. Each row the switch did not
 * change (same key, same content) moved by some amount; rows in a stretch of the panel the
 * switch left alone all moved by the same amount, and that amount, the most common one,
 * holds the most of them still. With no unchanged row, the first row that survived anchors.
 * Undefined when no remembered row is still there.
 */
function anchorMovePx(before: readonly ScrollAnchor[], after: readonly ScrollAnchor[]): number | undefined {
  const afterByKey = new Map(after.map((anchor) => [anchor.key, anchor]));
  let firstSurvivingPx: number | undefined;
  const moves: number[] = [];
  for (const anchor of before) {
    const now = afterByKey.get(anchor.key);
    if (now === undefined) {
      continue;
    }
    const movedPx = now.offsetPx - anchor.offsetPx;
    firstSurvivingPx ??= movedPx;
    if (now.content === anchor.content) {
      moves.push(movedPx);
    }
  }
  let bestPx = firstSurvivingPx;
  let bestCount = 0;
  for (const candidatePx of moves) {
    const count = moves.filter((movedPx) => Math.abs(movedPx - candidatePx) <= SCROLL_MOVE_PX_TOLERANCE).length;
    if (count > bestCount) {
      bestCount = count;
      bestPx = candidatePx;
    }
  }
  assert(bestCount <= moves.length, 'anchorMovePx: a move is counted among the moves');
  return bestPx;
}

/**
 * Keeps the rows under the pointer where they were across an element switch. The
 * sections above Typography differ per element (Layout, Flex child, the header's chips),
 * so the same scrollTop put other rows under the pointer: about 90 px of movement from a
 * plain element to a heading. The browser's own scroll anchoring did not hold it either,
 * because the switch replaces the rows it would anchor to, and a shorter element clamped
 * the scroll. So the switch is anchored here: the visible rows are noted in the render
 * that switches (the previous element is still painted), and before the new one is
 * painted the scroll moves by however far most of the unchanged rows moved (anchorMovePx). A shorter
 * element gets room at the end (SCROLL_RESERVE_PROPERTY) rather than a clamped scroll,
 * until the next switch.
 */
function useSwitchScrollAnchor(hostRef: React.RefObject<HTMLDivElement>, shownId: string | undefined): void {
  const anchoredIdRef = useRef(shownId);
  const pendingRef = useRef<readonly ScrollAnchor[] | undefined>(undefined);
  if (shownId !== anchoredIdRef.current) {
    const scroller = panelScroller(hostRef.current ?? undefined);
    const switching = anchoredIdRef.current !== undefined && shownId !== undefined;
    pendingRef.current = scroller !== undefined && switching && scroller.scrollTop > 0 ? visibleAnchors(scroller) : undefined;
    anchoredIdRef.current = shownId;
  }
  useLayoutEffect(() => {
    const anchors = pendingRef.current;
    pendingRef.current = undefined;
    const scroller = panelScroller(hostRef.current ?? undefined);
    if (anchors === undefined || scroller === undefined) {
      return undefined;
    }
    restoreScrollAnchor(scroller, anchors);
    return holdScrollAnchor(scroller);
  }, [hostRef, shownId]);
}

// How long after a switch the rows stay anchored while the new element's sections settle
// (a refreshed answer, a section's placeholders giving way to its fields), and what ends it
// early: the person scrolling or pressing, after which where the rows go is theirs.
const SCROLL_ANCHOR_HOLD_MS = 2000;
const POPUP_ROLES = '[role="menu"],[role="dialog"],[role="listbox"]';
const SCROLL_ANCHOR_RELEASE_EVENTS = ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const;

/**
 * Keeps the switch's anchor for SCROLL_ANCHOR_HOLD_MS. The switch's first paint is anchored
 * by restoreScrollAnchor, but the element's content still changes height in the commits
 * that follow, and the scroll then clamped or the browser's own anchoring picked a row of a
 * section that had changed: the rows moved 38 px under the pointer a frame later. Each
 * resize of the content is anchored the same way, before it is painted (a ResizeObserver
 * runs after layout, before paint), with the browser's own anchoring off meanwhile so the
 * two never both move the scroll. Returns the cleanup.
 */
function holdScrollAnchor(scroller: HTMLElement): () => void {
  let anchors = visibleAnchors(scroller);
  scroller.style.setProperty('overflow-anchor', 'none');
  const observer = new ResizeObserver(() => {
    // A picker or menu is anchored where it opened, and a scroll of the panel closes it:
    // with one open the rows are left where the layout puts them.
    if (document.querySelector(POPUP_ROLES) === null) {
      restoreScrollAnchor(scroller, anchors);
    }
    anchors = visibleAnchors(scroller);
  });
  for (const child of scroller.children) {
    observer.observe(child);
  }
  const release = () => {
    observer.disconnect();
    window.clearTimeout(timer);
    scroller.style.removeProperty('overflow-anchor');
    for (const type of SCROLL_ANCHOR_RELEASE_EVENTS) {
      scroller.removeEventListener(type, release, true);
    }
  };
  const timer = window.setTimeout(release, SCROLL_ANCHOR_HOLD_MS);
  for (const type of SCROLL_ANCHOR_RELEASE_EVENTS) {
    scroller.addEventListener(type, release, { capture: true, passive: true });
  }
  return release;
}

function restoreScrollAnchor(scroller: HTMLElement, anchors: readonly ScrollAnchor[]): void {
  const movedPx = anchorMovePx(anchors, anchorsByKey(scroller, new Set(anchors.map((anchor) => anchor.key))));
  if (movedPx === undefined) {
    return;
  }
  if (Math.abs(movedPx) <= SCROLL_MOVE_PX_TOLERANCE) {
    return;
  }
  const targetPx = scroller.scrollTop + movedPx;
  // Room for the target when the new element's content ends too soon for it. Measured
  // without the previous switch's room, which this one replaces.
  scroller.style.setProperty(SCROLL_RESERVE_PROPERTY, '0px');
  const scrollMaxPx = scroller.scrollHeight - scroller.clientHeight;
  const reservePx = Math.max(0, Math.ceil(targetPx - scrollMaxPx));
  scroller.style.setProperty(SCROLL_RESERVE_PROPERTY, `${reservePx}px`);
  // Instant, said explicitly: a smooth scroll would show the rows sliding into place.
  scroller.scrollTo({ top: targetPx, behavior: 'instant' });
}

// A rescan builds a new setting object each time; the host compares by identity,
// so the same setting keeps the object it had and wakes no subscriber.
function useStableLengthUnit(next: LengthUnit): LengthUnit {
  const held = useRef(next);
  if (!sameLengthUnit(held.current, next)) {
    held.current = next;
  }
  return held.current;
}

// The same list, by content, keeps the array it had. The host compares every field by
// identity (setHost), and a copy made on each render woke every host subscriber on every
// render of the app around the panel: each computed-value hook in every field re-rendered
// on a hover elsewhere in the app.
function useStableList(next: readonly string[]): string[] {
  const held = useRef<string[]>([...next]);
  const same = held.current.length === next.length && held.current.every((item, index) => item === next[index]);
  if (!same) {
    held.current = [...next];
  }
  return held.current;
}

const NO_NODES: HostState['nodes'] = [];

interface HostInputs {
  readonly files: StyleFiles;
  readonly astroFiles: StyleFiles;
  readonly lengthUnit: LengthUnit;
  readonly renderedClasses: string[];
  readonly projectClasses: string[];
  readonly writes: ElementWrites;
}

function hostState(props: StylePanelProps, inputs: HostInputs): HostState {
  const { files, astroFiles, lengthUnit } = inputs;
  return {
    projectPath: props.project?.path,
    nodes: props.model?.nodes ?? NO_NODES,
    selectedId: props.node?.id,
    pathOf: props.pathOf,
    device: props.device ?? 'desktop',
    canvasWidthPx: props.canvasWidthPx,
    files,
    astroFiles,
    openFilePath: props.openFilePath,
    openFileKind: props.openFileKind,
    contextPagePath: props.contextPagePath,
    selectedComponentPath: props.selectedComponentPath,
    writeStyleNode: props.onWriteStyleNode,
    selectNode: props.onSelectNode,
    setCanvasWidth: props.onCanvasWidth,
    showDesktopCanvas: props.onDesktopCanvas,
    recordUndo: props.onRecordUndo,
    openStyleTagSettings: props.onOpenStyleTagSettings,
    ...inputs.writes,
    pageComponentPaths: props.pageComponentPaths ?? NO_PATHS,
    renderedClassesKnown: props.renderedClassesKnown ?? true,
    onSpacingHover: props.onSpacingHover,
    renderedClasses: inputs.renderedClasses,
    projectClasses: inputs.projectClasses,
    historyTick: props.historyTick ?? 0,
    pseudoRequest: props.pseudoRequest,
    pseudoRows: props.pseudoRows === true,
    lengthUnit,
  };
}

// The ⌘Enter presses already answered: the panel can remount (a new
// project, a reset panel boundary), and an old press must not take the caret again.
let selectorFocusHandled = 0;
const SELECTOR_FOCUS_FRAMES_MAX = 30;

// Puts the caret in the selector field on a new ⌘Enter press, waiting a few
// frames for the field when the panel has only just been shown or mounted.
function useSelectorFocus(hostRef: React.RefObject<HTMLDivElement>, tick: number): void {
  useEffect(() => {
    if (tick <= selectorFocusHandled) {
      return undefined;
    }
    selectorFocusHandled = tick;
    let frames = 0;
    let request = 0;
    // The field's input is only mounted once the well is opened, so the
    // picker is asked to open it; it waits for a picker that has mounted.
    const tryFocus = (): void => {
      if (requestSelectorFocus()) {
        return;
      }
      frames += 1;
      if (frames < SELECTOR_FOCUS_FRAMES_MAX) {
        request = requestAnimationFrame(tryFocus);
      }
    };
    tryFocus();
    return () => cancelAnimationFrame(request);
  }, [hostRef, tick]);
}

function usePanelBounds(hostRef: React.RefObject<HTMLDivElement>): void {
  useEffect(() => {
    const element = hostRef.current;
    if (!element) {
      return;
    }
    const publish = (): void => {
      const bounds = element.getBoundingClientRect();
      const style = document.documentElement.style;
      style.setProperty('--style-panel-left', `${bounds.left}px`);
      style.setProperty('--style-panel-top', `${bounds.top}px`);
      style.setProperty('--style-panel-width', `${bounds.width}px`);
      style.setProperty('--style-panel-height', `${bounds.height}px`);
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    window.addEventListener('resize', publish);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', publish);
    };
  }, [hostRef]);
}

function playButtonNote(event: React.MouseEvent<HTMLDivElement>): void {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  const button = target.closest('button');
  if (button && !button.disabled) {
    clickNote();
  }
}
