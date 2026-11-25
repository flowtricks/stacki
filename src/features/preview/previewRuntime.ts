import { frameContextPoint, type ContextPoint } from './contextPosition';
import { panelDragPhase, subscribePanelDragPhase } from '../../ui/panelDragPhase';
import { pseudoPath, type PseudoLayer } from '../../../shared/page/pseudoPath';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type React from 'react';
import type { OverlayInfo, RectMap, SpacingMap } from './PreviewOverlays';
import type { CanvasDragMessage } from './canvasDragMessages';
import type { PreviewDevice } from './PreviewToolbar';
import type { PreviewMessage, PreviewReloadReason, TextMarks } from './previewMessages';
import { NO_TEXT_MARKS } from './previewMessages';
import type { GuideMetrics } from './guideModel';
import { parsePreviewMessage } from './previewMessages';
import { loopChildPaths, outlineBoxPath, sameCopy, type Box } from './outlineBoxes';
import { assert } from '../../../shared/core/assert';
import { setModifiers } from '../../editor/heldModifiers';
import { noteCanvasReady, noteCanvasRendered, receiveCanvasReply, setCanvasFrame } from '../../editor/canvasQuery';
import type { Digest } from '../../../shared/core/brand';
import type { PreviewIteration } from '../../../shared/page/previewIteration';
import { judgeEventToken, type PreviewRender, type PreviewVerdict } from '../../../shared/page/previewToken';
import type { CanvasSelectionVerdict } from './previewSelection';
import { CanvasClickRetry, type CanvasNoticeEvent } from './canvasClickRetry';
import type { CanvasClickProblem } from './canvasClickRecovery';
import type { CanvasEventRequest } from '../../editor/canvasClick';
import { canvasClicksCaptured, noteCanvasOpen, observeCanvasClick, takeCanvasClick } from '../../ui/canvasClickSlot';
import { receiveCanvasPoint } from '../../ui/canvasPointQuery';
import { reportFrameOverlay } from './canvasRecoveryBus';
import { canvasHighlight, noteDeepHover, resendCanvasOutlineMode, subscribeCanvasHighlight } from '../../ui/canvasOutlineMode';
import { canvasHoverPinned, forgetCanvasHover, rememberCanvasHover, rememberedCanvasHover, subscribeCanvasHoverPin } from '../../ui/canvasHoverPin';

/** Whether a click or double-click on the canvas may select what it names
 * (src/features/preview/previewGate.ts). Hover needs only the token to be the latest. */
export type JudgeCanvasEvent = (token: Digest | undefined, render: PreviewRender | undefined, request: CanvasEventRequest) => Promise<CanvasSelectionVerdict>;

export interface PreviewRuntimeProps {
  readonly selPath: string | undefined;
  readonly navigatorSelectionTick?: number;
  readonly navHoverPath?: string | undefined;
  readonly navHoverPseudo?: PseudoLayer | undefined;
  readonly selPseudo?: PseudoLayer | undefined;
  readonly overlayInfo?: ((path: string) => OverlayInfo | undefined) | undefined;
  readonly focusPath?: string | undefined;
  readonly focusOcc?: number | undefined;
  /** The opened copy: a selection with no copy of its own outlines this one, not every copy. */
  readonly openedOcc?: number | undefined;
  readonly pathScope?: string;
  readonly refreshKey?: string | number;
  readonly device: PreviewDevice;
  readonly onSelectPath?: (path: string | undefined, info: CanvasSelectInfo) => void;
  readonly onContextPath?: (
    path: string | undefined,
    point: ContextPoint & {
      readonly outside: boolean;
      readonly occurrence: number;
      readonly pseudo: PseudoLayer | undefined;
    },
  ) => void;
  readonly onOpenPath?: (path: string | undefined, occurrence: number) => void;
  /** A double click on an image: the marker paths it carries and where, in the editor's viewport, its bottom-left corner is. */
  readonly onEditImage?: ((request: { readonly paths: readonly string[]; readonly point: ContextPoint }) => void) | undefined;
  /** The canvas moved under the image popup (scrolled or resized): it is no longer beside its image. */
  readonly onCloseImage?: (() => void) | undefined;
  readonly onSelectedClasses?: (classes: readonly string[]) => void;
  readonly onRenderedPaths?: (paths: readonly string[]) => void;
  readonly onNodeStates?: (states: {
    readonly hidden: readonly string[];
    readonly inert: readonly string[];
    readonly before: readonly string[];
    readonly after: readonly string[];
  }) => void;
  readonly onNodeClasses?: (classes: Readonly<Record<string, readonly string[]>>) => void;
  /** The preview-token gate (step 7): an event from a stale rendering never
   * selects. A refused click climbs the recovery ladder (canvasClickRecovery.ts);
   * only what the ladder cannot fix reaches the person, once, as a notice. */
  readonly judgeEvent: JudgeCanvasEvent;
  readonly onCanvasNotice: (event: CanvasNoticeEvent) => void;
  /** Reloads the canvas: the ladder's step for a rendering only a fresh one can fix. */
  readonly onRefresh?: (() => void) | undefined;
  /** The canvas reloaded instead of patching (step 7): past a cap, it says so. */
  readonly onPreviewReload?: (reason: PreviewReloadReason) => void;
  /** More paths to measure: the elements app overlays are anchored to (src/features/apps). */
  readonly extraTrackPaths?: readonly string[] | undefined;
  /** A drag on the canvas, or one crossing into it; `reply` posts the editor's answer back to the frame. */
  readonly onCanvasDrag?: ((drag: CanvasDragMessage, reply: (message: unknown) => void) => void) | undefined;
}

/** What a canvas click said besides its path: whether it landed outside the
 * open file, and the ::before or ::after it landed on, if any. */
export interface CanvasSelectInfo {
  readonly outside: boolean;
  readonly pseudo: PseudoLayer | undefined;
  /** Which copy of the node the click landed in: a node in a loop is drawn once per item. */
  readonly occurrence: number;
  /** How many copies the frame drew, when it measured them with the click. */
  readonly copies: number | undefined;
  /** The pass of each loop around the node the clicked copy is in, when the page marks them. */
  readonly iterations: readonly PreviewIteration[] | undefined;
}

// Why bounded: a pending selection is a picture drawn while main judges a click, and a judgement
// that never answers must not leave it on the canvas. Past the bound it is taken away.
const PENDING_SELECTION_MS_MAX = 4000;
// A node renders once per loop item, and the page is capped at 20 000 stamps (docs/canvas-click.md).
const BOXES_PER_NODE_MAX = 20_000;

/**
 * The node a canvas click named, shown as the selection from the moment the frame says so
 * until main has judged the click. Judging reads the disk and the editor then renders the whole
 * Style panel; neither may stand between the press and its outline. It is a picture only:
 * nothing is selected, written or announced until the verdict, and a refusal takes it away.
 */
export interface PendingSelection {
  readonly path: string;
  readonly occurrence: number;
  readonly pseudo: PseudoLayer | undefined;
}

export interface PreviewRuntime {
  readonly iframeRef: React.RefObject<HTMLIFrameElement>;
  readonly rects: RectMap;
  readonly spacing: SpacingMap;
  readonly selOcc: number | undefined;
  readonly hoverPath: string | undefined;
  readonly hoverOcc: number | undefined;
  /** The hovered path's ::before or ::after, when that is what is hovered. */
  readonly hoverPseudo: PseudoLayer | undefined;
  /** The clicked node while its click is being judged; the overlay draws it as the selection. */
  readonly pendingSelection: PendingSelection | undefined;
  /** What the column guide is drawn from; undefined until the frame reports. */
  readonly guide: GuideMetrics | undefined;
  /** Text of the selected instance the pointer is on, or that was clicked. */
  readonly textMarks: TextMarks;
  readonly registerFrame: () => void;
  readonly sendTrack: () => void;
  /** Sends a message to the current frame. */
  readonly post: (message: unknown) => void;
  /** Calls the listener each time a frame registers; returns the unsubscribe. */
  readonly subscribeLoad: (listener: () => void) => () => void;
}

export function usePreviewRuntime(props: PreviewRuntimeProps, url: string | undefined): PreviewRuntime {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [rects, setRects] = useState<RectMap>({});
  const [spacing, setSpacing] = useState<SpacingMap>({});
  const [canvasHover, setCanvasHover] = useState<string | undefined>(undefined);
  // The ::before or ::after of `canvasHover` the pointer is on, if any.
  const [canvasHoverPseudo, setCanvasHoverPseudo] = useState<PseudoLayer | undefined>(undefined);
  const [selectedOccurrence, setSelectedOccurrence] = useState<number | undefined>(undefined);
  const [hoverOcc, setHoverOcc] = useState(0);
  // The node a click named, drawn as the selection while main still judges the click (see receiveClick).
  const [pendingSelection, setPendingSelection] = useState<PendingSelection | undefined>(undefined);
  const [guide, setGuide] = useState<GuideMetrics | undefined>(undefined);
  const [textMarks, setTextMarks] = useState<TextMarks>(NO_TEXT_MARKS);
  const hoverPseudo = hoveredPseudo(props, canvasHover, canvasHoverPseudo);
  // An app's highlight (`canvas.highlight`) is drawn in its own slot (PreviewOverlays.tsx), so the frame measures it too.
  const highlight = useSyncExternalStore(subscribeCanvasHighlight, canvasHighlight);
  const tracked = highlight === undefined ? props : { ...props, extraTrackPaths: [...(props.extraTrackPaths ?? []), highlight.path] };
  const { hoverPath, trackPaths } = useTrackedPaths(tracked, canvasHover, hoverPseudo, pendingSelection?.path);
  const refs = useRuntimeRefs(props, selectedOccurrence);
  const setters = useMemo(
    () => ({
      setRects,
      setSpacing,
      setCanvasHover,
      setCanvasHoverPseudo,
      setSelectedOccurrence,
      setHoverOcc,
      setPendingSelection,
      setGuide,
      setTextMarks,
    }),
    [],
  );
  useOccurrenceSelection(props, refs, setSelectedOccurrence);
  usePinnedHover(setters);
  useClearPendingSelection(props.selPath, setPendingSelection);
  useExpirePendingSelection(pendingSelection, setPendingSelection);
  useClickLadder(iframeRef, refs, setters, url);
  useMessageListener(iframeRef, refs, setters);
  const link = useFrameLink(iframeRef);
  const registerFrame = useCallback((): void => {
    const frame = iframeRef.current?.contentWindow;
    setCanvasFrame(frame ?? undefined);
    // The frame may have announced its rendering before this listener mounted.
    // The load handler repeats this handshake after the preload is ready.
    frame?.postMessage({ type: 'avb:request-render' }, '*');
    link.notify();
  }, [link]);
  const sendTrack = useCallback((): void => {
    link.post({
      type: 'avb:track',
      paths: trackPaths,
      scope: props.pathScope ?? '',
      focus: props.focusPath ?? '',
      focusOcc: props.focusOcc ?? 0,
    });
  }, [link, props.focusOcc, props.focusPath, props.pathScope, trackPaths]);
  useFrameRegistration(props, url, registerFrame, sendTrack);
  useSelectionScroll(props, iframeRef, refs);
  useResetOnReload(props, url, refs, setters);
  return {
    iframeRef,
    rects,
    spacing,
    selOcc: selectedOccurrence ?? props.openedOcc,
    hoverPath,
    hoverOcc: props.navHoverPath ? 0 : hoverOcc,
    hoverPseudo,
    pendingSelection,
    guide,
    textMarks,
    registerFrame,
    sendTrack,
    post: link.post,
    subscribeLoad: link.subscribe,
  };
}

// Every value here is a React ref: the runtime's handlers read and write them
// in place, which is what a ref is for. Functions that write one name it
// `…Ref` where they take it out of this record.
interface RuntimeRefs {
  readonly props: React.MutableRefObject<PreviewRuntimeProps>;
  readonly selectedOccurrence: React.MutableRefObject<number | undefined>;
  readonly selectedClasses: React.MutableRefObject<string | undefined>;
  /** A canvas click selected the current path, so the selection needs no scroll. */
  readonly clickPending: React.MutableRefObject<boolean>;
  /** The path the last canvas click named (undefined when it named nothing). */
  readonly lastClick: React.MutableRefObject<{ readonly path: string | undefined } | undefined>;
  readonly cameFrom: React.MutableRefObject<string | undefined>;
  /** The rendering the frame last announced, and its token. */
  readonly render: React.MutableRefObject<PreviewRender | undefined>;
  /** The click ladder: retries, heals and, last, a notice (canvasClickRetry.ts). */
  readonly clicks: React.MutableRefObject<CanvasClickRetry | undefined>;
}

function useRuntimeRefs(props: PreviewRuntimeProps, selectedOccurrence: number | undefined): RuntimeRefs {
  const propsRef = useRef(props);
  propsRef.current = props;
  const selectedOccurrenceRef = useRef(selectedOccurrence);
  selectedOccurrenceRef.current = selectedOccurrence;
  const selectedClasses = useRef<string | undefined>(undefined);
  const clickPending = useRef(false);
  const lastClick = useRef<{ readonly path: string | undefined } | undefined>(undefined);
  const cameFrom = useRef<string | undefined>(undefined);
  const render = useRef<PreviewRender | undefined>(undefined);
  const clicks = useRef<CanvasClickRetry | undefined>(undefined);
  useEffect(() => {
    selectedClasses.current = undefined;
  }, [props.selPath, selectedOccurrence]);
  return useMemo(
    () => ({
      props: propsRef,
      selectedOccurrence: selectedOccurrenceRef,
      selectedClasses,
      clickPending,
      lastClick,
      cameFrom,
      render,
      clicks,
    }),
    [],
  );
}

function useOccurrenceSelection(
  props: PreviewRuntimeProps,
  refs: RuntimeRefs,
  setSelectedOccurrence: React.Dispatch<React.SetStateAction<number | undefined>>,
): void {
  const previousNavigatorTick = useRef(props.navigatorSelectionTick);
  useEffect(() => {
    const selectedPath = props.selPath;
    const { cameFrom: cameFromRef, lastClick: lastClickRef, selectedOccurrence: selectedOccurrenceRef, selectedClasses: selectedClassesRef } = refs;
    const previous = cameFromRef.current;
    cameFromRef.current = selectedPath;
    const clicked = lastClickRef.current;
    lastClickRef.current = undefined;
    if (previousNavigatorTick.current !== props.navigatorSelectionTick) {
      previousNavigatorTick.current = props.navigatorSelectionTick;
      selectedOccurrenceRef.current = 0;
      selectedClassesRef.current = undefined;
      setSelectedOccurrence(0);
      return;
    }
    if (clicked !== undefined) {
      if (clicked.path === selectedPath) {
        return;
      }
    }
    if (sameCopy(previous, selectedPath)) {
      return;
    }
    setSelectedOccurrence(undefined);
  }, [props.navigatorSelectionTick, props.selPath, refs, setSelectedOccurrence]);
}

// The hovered ::before or ::after, from the same source as the hovered path:
// the navigator's row while one is hovered, else the canvas's pointer.
function hoveredPseudo(props: PreviewRuntimeProps, canvasHover: string | undefined, canvasHoverPseudo: PseudoLayer | undefined): PseudoLayer | undefined {
  if (props.navHoverPath !== undefined) {
    return props.navHoverPseudo;
  }
  return canvasHover === undefined ? undefined : canvasHoverPseudo;
}

// The paths the frame measures. It measures only these, so both hover sources
// must use the same active path for measurement requests and outline rendering.
function useTrackedPaths(props: PreviewRuntimeProps, canvasHover: string | undefined, hoverPseudo: PseudoLayer | undefined, pendingPath: string | undefined) {
  const { hoverPath, selectedBoxPath, hoverBoxPath, loopBoxPaths } = outlinePaths(props, canvasHover);
  // A picked or hovered ::before / ::after is measured on its own (framePseudo.ts).
  const selectedPseudoPath = props.selPath !== undefined && props.selPseudo !== undefined ? pseudoPath(props.selPath, props.selPseudo) : undefined;
  const hoverPseudoPath = hoverPath !== undefined && hoverPseudo !== undefined ? pseudoPath(hoverPath, hoverPseudo) : undefined;
  // App overlay anchors come joined too, for the same reason.
  const extraPaths = (props.extraTrackPaths ?? []).join('\n');
  const trackPaths = useMemo(
    // The loop's child paths come joined as one string, so the list is rebuilt
    // only when they change rather than on every render.
    () =>
      trackedPaths(
        props.selPath,
        hoverPath,
        props.focusPath,
        selectedBoxPath,
        hoverBoxPath,
        selectedPseudoPath,
        hoverPseudoPath,
        ...loopBoxPaths.split('\n'),
        ...extraPaths.split('\n'),
        pendingPath,
      ),
    [props.focusPath, hoverPath, hoverBoxPath, props.selPath, selectedBoxPath, selectedPseudoPath, hoverPseudoPath, loopBoxPaths, extraPaths, pendingPath],
  );
  return { hoverPath, trackPaths };
}

// What the outlines follow: the hovered path (the navigator's wins over the
// canvas's), and the paths whose boxes stand for the selected and hovered nodes.
function outlinePaths(props: PreviewRuntimeProps, canvasHover: string | undefined) {
  const hoverPath = props.navHoverPath ?? canvasHover;
  const boxPath = (path: string | undefined) => (path ? outlineBoxPath(path, props.overlayInfo?.(path)?.nodeKind) : undefined);
  // A loop's outline wraps every child, so each is measured, not the first alone.
  const loopPaths = (path: string | undefined): readonly string[] => {
    const info = path === undefined ? undefined : props.overlayInfo?.(path);
    return path !== undefined && info?.nodeKind === 'map' ? loopChildPaths(path, info.childCount) : [];
  };
  return {
    hoverPath,
    selectedBoxPath: boxPath(props.selPath),
    hoverBoxPath: boxPath(hoverPath),
    loopBoxPaths: [...loopPaths(props.selPath), ...loopPaths(hoverPath)].join('\n'),
  };
}

interface RuntimeSetters {
  readonly setRects: React.Dispatch<React.SetStateAction<RectMap>>;
  readonly setSpacing: React.Dispatch<React.SetStateAction<SpacingMap>>;
  readonly setCanvasHover: React.Dispatch<React.SetStateAction<string | undefined>>;
  readonly setCanvasHoverPseudo: React.Dispatch<React.SetStateAction<PseudoLayer | undefined>>;
  readonly setSelectedOccurrence: React.Dispatch<React.SetStateAction<number | undefined>>;
  readonly setHoverOcc: React.Dispatch<React.SetStateAction<number>>;
  readonly setPendingSelection: React.Dispatch<React.SetStateAction<PendingSelection | undefined>>;
  readonly setGuide: React.Dispatch<React.SetStateAction<GuideMetrics | undefined>>;
  readonly setTextMarks: React.Dispatch<React.SetStateAction<TextMarks>>;
}

// A plain link to the current frame for the features built on the canvas:
// sending to it, and hearing each time a frame registers (a reloaded page
// starts from nothing, so what they told the last one has to be said again).
// The listeners live in a ref, so subscribing never re-renders the canvas.
function useFrameLink(iframeRef: React.RefObject<HTMLIFrameElement>): {
  readonly post: (message: unknown) => void;
  readonly notify: () => void;
  readonly subscribe: (listener: () => void) => () => void;
} {
  const listeners = useRef(new Set<() => void>());
  return useMemo(
    () => ({
      post: (message: unknown) => iframeRef.current?.contentWindow?.postMessage(message, '*'),
      notify: () => {
        for (const listener of listeners.current) {
          listener();
        }
      },
      subscribe: (listener: () => void) => {
        listeners.current.add(listener);
        return () => {
          listeners.current.delete(listener);
        };
      },
    }),
    [iframeRef],
  );
}

function useMessageListener(iframeRef: React.RefObject<HTMLIFrameElement>, refs: RuntimeRefs, setters: RuntimeSetters): void {
  const settersRef = useRef(setters);
  settersRef.current = setters;
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>): void => {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) {
        return;
      }
      const message = parsePreviewMessage(event.data);
      if (message === undefined) {
        return;
      }
      // The frame re-measures on every reflow of a drag, and each answer would render the preview and the shell around it:
      // the drag holds the newest measure (one, never a queue) and the release applies it.
      if (message.kind === 'rects' && panelDragPhase() === 'dragging') {
        held = message;
        return;
      }
      applyMessage(message, refs, settersRef.current, iframeRef.current);
    };
    let held: PreviewMessage | undefined;
    const release = (): void => {
      if (held !== undefined && panelDragPhase() === 'idle' && iframeRef.current) {
        const message = held;
        held = undefined;
        applyMessage(message, refs, settersRef.current, iframeRef.current);
      }
    };
    window.addEventListener('message', receive);
    const stopPhase = subscribePanelDragPhase(release);
    return () => {
      stopPhase();
      window.removeEventListener('message', receive);
    };
  }, [iframeRef, refs]);
}

function applyMessage(message: PreviewMessage, refs: RuntimeRefs, setters: RuntimeSetters, frame: HTMLIFrameElement): void {
  switch (message.kind) {
    case 'rects':
      setters.setRects(message.rects);
      setters.setSpacing(message.spacing);
      publishSelectedClasses(message.classes, refs);
      break;
    case 'node-classes':
      refs.props.current.onNodeClasses?.(message.classes);
      break;
    case 'rendered-nodes':
      refs.props.current.onRenderedPaths?.(message.paths);
      break;
    case 'node-states':
      refs.props.current.onNodeStates?.({ hidden: message.hidden, inert: message.inert, before: message.before, after: message.after });
      break;
    case 'modifiers':
      setModifiers({ shiftKey: message.shiftKey, altKey: message.altKey });
      break;
    case 'hover-node':
      // A picture, not a selection: only the rendering has to be the latest.
      // A frame that has vouched for no rendering at all (still digesting, or
      // it said why it cannot) still shows what the pointer is over: an outline
      // drawn from the frame's own boxes selects nothing.
      if (canvasHoverPinned()) {
        // A capture holds the hover it pinned (src/ui/canvasHoverPin.ts); the pointer is elsewhere and the frame's report is not what the picture shows.
        break;
      }
      if (hoverShown(message.token, refs.render.current)) {
        if (message.path !== undefined) {
          rememberCanvasHover({ path: message.path, pseudo: message.pseudo, occurrence: message.occurrence, deep: message.deep }, Date.now());
        }
        noteDeepHover(message.path, message.deep);
        drawSentBoxes(message.path, message.boxes, setters);
        setters.setCanvasHover(message.path);
        setters.setCanvasHoverPseudo(message.pseudo);
        setters.setHoverOcc(message.occurrence);
      } else {
        setters.setCanvasHover(undefined);
        setters.setCanvasHoverPseudo(undefined);
      }
      break;
    case 'context-node':
      applyContextMenu(message, refs, setters, frame);
      break;
    case 'click-node':
      receiveClick(message, refs, setters);
      break;
    case 'render':
      announceRender(refs.render, message.render);
      noteCanvasRendered(); // The style panel re-asks what the selection matches.
      refs.clicks.current?.rendered();
      break;
    case 'render-problem':
      announceRender(refs.render, undefined);
      refs.clicks.current?.renderFailed(message.problem);
      break;
    case 'preview-reload':
      announceRender(refs.render, undefined); // The reloaded page announces its own.
      refs.props.current.onPreviewReload?.(message.reason);
      break;
    case 'error-overlay':
      // The canvas recovery controller hears it (src/app/state/appLifecycle.ts): the overlay is an error the page's
      // own answer does not show, and the next change that fixes it reloads the canvas.
      reportFrameOverlay(message.shown ? { kind: 'shown', message: message.message } : { kind: 'cleared' });
      break;
    case 'canvas-ready':
      noteCanvasReady();
      resendCanvasOutlineMode(); // A new document starts in the editor's own mode.
      break;
    case 'guide':
      setters.setGuide(message.metrics);
      break;
    case 'query-result':
      receiveCanvasReply(message.input);
      break;
    case 'point-result':
      receiveCanvasPoint(message.input);
      break;
    case 'text-marks':
      setters.setTextMarks({ hover: message.hover, picked: message.picked });
      break;
    case 'canvas-drag':
      refs.props.current.onCanvasDrag?.(message.drag, (reply) => frame.contentWindow?.postMessage(reply, '*'));
      break;
    case 'open-node':
      noteCanvasOpen(); // A double click: the observed click it began with is no placement.
      if (canvasClicksCaptured()) {
        break; // A double click while an app captures is two clicks for the app, never a drill-in.
      }
      gateEvent(message.token, refs, { kind: 'open' }, () => refs.props.current.onOpenPath?.(message.path ?? undefined, message.occurrence));
      break;
    case 'image-close':
      refs.props.current.onCloseImage?.();
      break;
    case 'image-edit': {
      noteCanvasOpen(); // A double click, as above.
      if (canvasClicksCaptured()) {
        break;
      }
      const point = frameContextPoint(frame, message);
      gateEvent(message.token, refs, { kind: 'open' }, () => refs.props.current.onEditImage?.({ paths: message.paths, point }));
      break;
    }
  }
}

function applyContextMenu(
  message: Extract<PreviewMessage, { readonly kind: 'context-node' }>,
  refs: RuntimeRefs,
  setters: RuntimeSetters,
  frame: HTMLIFrameElement,
): void {
  const point = frameContextPoint(frame, message);
  // Context actions always require current source, even outside a focused component.
  gateEvent(message.token, refs, { kind: 'open' }, () => {
    const { clickPending: clickPendingRef, lastClick: lastClickRef } = refs;
    clickPendingRef.current = true;
    lastClickRef.current = { path: message.path };
    setters.setSelectedOccurrence(message.occurrence);
    refs.props.current.onContextPath?.(message.path, {
      ...point,
      outside: message.outside,
      occurrence: message.occurrence,
      pseudo: message.pseudo,
    });
  });
}

function announceRender(renderRef: React.MutableRefObject<PreviewRender | undefined>, render: PreviewRender | undefined): void {
  renderRef.current = render;
}

// The gate answers after main has read the stamped files; the rendering judged
// is the one the event named, and `apply` runs only on `current`. Used by the
// double-click and the right-click, which are not looked at again: a refusal is
// logged, and told only when it is not one the canvas recovers from by itself.
function gateEvent(token: Digest | undefined, refs: RuntimeRefs, request: CanvasEventRequest, apply: (path?: string) => void): void {
  const render = refs.render.current;
  refs.props.current.judgeEvent(token, render, request).then(
    (verdict) => {
      if (verdict.tag === 'current') {
        if (judgeEventToken(token, refs.render.current).tag !== 'current') {
          refs.clicks.current?.refused({ kind: 'stale', reason: 'superseded', file: undefined, stamped: undefined });
          return;
        }
        apply('path' in verdict ? verdict.path : undefined);
      } else {
        refs.clicks.current?.refused(staleProblem(verdict, render));
      }
    },
    (error: unknown) => {
      // The check itself failed (main unreachable): nothing vouches for the
      // rendering, so the event does not select.
      console.error('[stacki] preview check failed:', error);
      refs.clicks.current?.refused({ kind: 'check-failed' });
    },
  );
}

// A click, from the person or as the frame's answer to the ladder's fresh look.
function receiveClick(message: Extract<PreviewMessage, { readonly kind: 'click-node' }>, refs: RuntimeRefs, setters: RuntimeSetters): void {
  const ladder = refs.clicks.current;
  if (ladder === undefined) {
    return; // Unmounted: no canvas to select in.
  }
  let id: number;
  if (message.replay === undefined) {
    // While a Stacki app captures canvas clicks, the click is the app's, not a selection (src/ui/canvasClickSlot.ts).
    if (takeCanvasClick({ path: message.path, occurrence: message.occurrence, x: message.x, y: message.y, box: message.box })) {
      return;
    }
    // An observing app hears the click too, after the double-click window; the editor selects as always.
    observeCanvasClick({ path: message.path, occurrence: message.occurrence, x: message.x, y: message.y, box: message.box });
    id = ladder.begin({ x: message.x, y: message.y });
  } else if (ladder.claimReplay(message.replay)) {
    id = message.replay;
  } else {
    return; // An answer for a click a newer one replaced.
  }
  const request: CanvasEventRequest = { kind: 'click', path: message.path, outside: message.outside };
  showPendingSelection(message, refs, setters);
  refs.props.current.judgeEvent(message.token, refs.render.current, request).then(
    (verdict) => {
      if (!ladder.current(id)) {
        return; // A newer click replaced this one while main read the disk.
      }
      if (verdict.tag !== 'current') {
        setters.setPendingSelection(undefined);
        ladder.failed(id, staleProblem(verdict, refs.render.current));
        return;
      }
      // The frame may have rendered again while main read the disk.
      if (judgeEventToken(message.token, refs.render.current).tag !== 'current') {
        setters.setPendingSelection(undefined);
        ladder.failed(id, { kind: 'stale', reason: 'superseded', file: undefined, stamped: undefined });
        return;
      }
      const path = 'path' in verdict ? verdict.path : undefined;
      ladder.succeeded(id);
      // A pseudo-element belongs to the node the click named; when the gate
      // re-resolved the path to another node, it no longer applies.
      applyClick({ ...message, path: path ?? message.path, pseudo: path === undefined || path === message.path ? message.pseudo : undefined }, refs, setters);
      setters.setPendingSelection(undefined);
    },
    (error: unknown) => {
      console.error('[stacki] preview check failed:', error);
      if (ladder.current(id)) {
        setters.setPendingSelection(undefined);
        ladder.failed(id, { kind: 'check-failed' });
      }
    },
  );
}

// Hands the boxes a hover or click carried to the overlay in the same step as the path, so the
// outline is drawn at once: the frame's later `avb:rects` for the tracked paths replaces them
// with the same boxes (or newer ones, if the page moved in between).
function drawSentBoxes(path: string | undefined, boxes: readonly Box[] | undefined, setters: RuntimeSetters): void {
  if (path === undefined || boxes === undefined) {
    return;
  }
  assert(boxes.length <= BOXES_PER_NODE_MAX, 'drawSentBoxes: a node reports a bounded number of boxes');
  setters.setRects((previous) => ({ ...previous, [path]: boxes }));
}

// A click that names a node of the open file shows that node as the selection now, while main
// judges it. A click outside the file, on nothing, or from a frame that sent no boxes waits for
// the verdict as before.
function showPendingSelection(message: Extract<PreviewMessage, { readonly kind: 'click-node' }>, refs: RuntimeRefs, setters: RuntimeSetters): void {
  if (message.path === undefined || message.outside || message.boxes === undefined || message.pseudo !== undefined) {
    setters.setPendingSelection(undefined);
    return;
  }
  if (judgeEventToken(message.token, refs.render.current).tag !== 'current') {
    return; // A rendering the frame has not vouched for is not drawn as a selection.
  }
  drawSentBoxes(message.path, message.boxes, setters);
  setters.setPendingSelection({ path: message.path, occurrence: message.occurrence, pseudo: undefined });
}

// The real selection takes over from the pending one the moment it changes; a click that selects
// the node already selected changes nothing, so the verdict clears it too (receiveClick).
function useClearPendingSelection(selectionPath: string | undefined, setPendingSelection: RuntimeSetters['setPendingSelection']): void {
  useEffect(() => {
    setPendingSelection(undefined);
  }, [selectionPath, setPendingSelection]);
}

// A judgement that never answers leaves nothing behind on the canvas.
function useExpirePendingSelection(pending: PendingSelection | undefined, setPendingSelection: RuntimeSetters['setPendingSelection']): void {
  useEffect(() => {
    if (pending === undefined) {
      return undefined;
    }
    const timer = setTimeout(() => setPendingSelection(undefined), PENDING_SELECTION_MS_MAX);
    return () => clearTimeout(timer);
  }, [pending, setPendingSelection]);
}

function staleProblem(verdict: Extract<PreviewVerdict, { readonly tag: 'stale' }>, render: PreviewRender | undefined): CanvasClickProblem {
  return { kind: 'stale', reason: verdict.reason, file: verdict.file, stamped: render?.stamps.length };
}

// Whether a hover may be drawn: its rendering is the latest, or the frame has
// vouched for none (the outline is a picture of the frame's own boxes).
function hoverShown(token: Digest | undefined, render: PreviewRender | undefined): boolean {
  if (judgeEventToken(token, render).tag === 'current') {
    return true;
  }
  return token === undefined && render === undefined;
}

// The click ladder lives as long as the canvas: it reaches the frame through
// the iframe ref and the app through the props ref, read when it acts.
function useClickLadder(iframeRef: React.RefObject<HTMLIFrameElement>, refs: RuntimeRefs, setters: RuntimeSetters, url: string | undefined): void {
  const settersRef = useRef(setters);
  settersRef.current = setters;
  useEffect(() => {
    const { clicks: clicksRef } = refs;
    const ladder = new CanvasClickRetry({
      nowMs: () => performance.now(),
      schedule: (delayMs, run) => {
        const timer = setTimeout(run, delayMs);
        return () => clearTimeout(timer);
      },
      query: (id, x, y) => iframeRef.current?.contentWindow?.postMessage({ type: 'avb:click-query', id, x, y }, '*'),
      // What a click on markup the open file does not own selects (canvasClickAction):
      // the page's layout, or nothing while a component is open.
      selectPage: () => applyClick({ path: undefined, occurrence: 0, outside: false, pseudo: undefined }, refs, settersRef.current),
      reloadCanvas: () => refs.props.current.onRefresh?.(),
      notice: (event) => refs.props.current.onCanvasNotice(event),
      requestRender: () => iframeRef.current?.contentWindow?.postMessage({ type: 'avb:request-render' }, '*'),
    });
    clicksRef.current = ladder;
    return () => {
      ladder.dispose();
      if (clicksRef.current === ladder) {
        clicksRef.current = undefined;
      }
    };
  }, [iframeRef, refs]);
  useEffect(() => {
    refs.clicks.current?.documentChanged();
  }, [refs, url]);
}

function publishSelectedClasses(classes: Readonly<Record<string, readonly (readonly string[])[]>>, refs: RuntimeRefs): void {
  const { selectedClasses: selectedClassesRef } = refs;
  const path = refs.props.current.selPath;
  const runs = path ? (classes[path] ?? []) : [];
  const list = runs[refs.selectedOccurrence.current ?? 0] ?? runs[0] ?? [];
  const key = list.join(' ');
  if (key !== selectedClassesRef.current) {
    selectedClassesRef.current = key;
    refs.props.current.onSelectedClasses?.(list);
  }
}

/** What a click says about the copy it landed in, as the editor's selection takes it. */
export function canvasSelectInfoOf(message: ClickedNodeMessage): CanvasSelectInfo {
  return {
    outside: message.outside,
    pseudo: message.pseudo,
    occurrence: message.occurrence,
    copies: message.boxes?.length,
    iterations: message.iterations,
  };
}

type ClickedNodeMessage = Pick<Extract<PreviewMessage, { readonly kind: 'click-node' }>, 'path' | 'occurrence' | 'outside' | 'pseudo'> & {
  readonly boxes?: readonly unknown[] | undefined;
  readonly iterations?: readonly PreviewIteration[] | undefined;
};

function applyClick(message: ClickedNodeMessage, refs: RuntimeRefs, setters: RuntimeSetters): void {
  const { clickPending: clickPendingRef, lastClick: lastClickRef } = refs;
  const path = message.path;
  clickPendingRef.current = true;
  lastClickRef.current = { path };
  setters.setSelectedOccurrence(message.occurrence);
  refs.props.current.onSelectPath?.(path, canvasSelectInfoOf(message));
}

function useFrameRegistration(props: PreviewRuntimeProps, url: string | undefined, registerFrame: () => void, sendTrack: () => void): void {
  const canvasMode = props.device === 'canvas';
  useEffect(() => {
    registerFrame();
    return () => setCanvasFrame(undefined);
  }, [canvasMode, props.refreshKey, registerFrame, url]);
  useEffect(() => {
    sendTrack();
  }, [props.navigatorSelectionTick, props.refreshKey, sendTrack, url]);
}

function useSelectionScroll(props: PreviewRuntimeProps, iframeRef: React.RefObject<HTMLIFrameElement>, refs: RuntimeRefs): void {
  const previousContext = useRef({
    focusPath: props.focusPath,
    pathScope: props.pathScope,
    navigatorSelectionTick: props.navigatorSelectionTick,
  });
  useEffect(() => {
    const frame = iframeRef.current?.contentWindow;
    const previous = previousContext.current;
    const contextChanged = previous.focusPath !== props.focusPath || previous.pathScope !== props.pathScope;
    const navigatorSelected = previous.navigatorSelectionTick !== props.navigatorSelectionTick;
    previousContext.current = {
      focusPath: props.focusPath,
      pathScope: props.pathScope,
      navigatorSelectionTick: props.navigatorSelectionTick,
    };
    if (!frame || !props.selPath) {
      return;
    }
    const { clickPending: clickPendingRef } = refs;
    if (clickPendingRef.current) {
      clickPendingRef.current = false;
      if (!navigatorSelected) {
        return;
      }
    }
    if (!contextChanged) {
      // A picked ::before or ::after is revealed by its own painted box, not its
      // element's: that element can be far taller than the frame. Read from the
      // ref so that a change of pick is not itself a reason to scroll: dropping
      // one must not reveal the element, and a Navigator row bumps the tick.
      const pseudo = refs.props.current.selPseudo;
      // The frame reads a missing occurrence as the first copy.
      frame.postMessage(
        {
          type: 'avb:scroll-to',
          path: pseudo === undefined ? props.selPath : pseudoPath(props.selPath, pseudo),
          occ: navigatorSelected ? 0 : refs.selectedOccurrence.current,
        },
        '*',
      );
    }
  }, [iframeRef, props.focusPath, props.navigatorSelectionTick, props.pathScope, props.selPath, refs]);
}

// While a capture pins the hover, the canvas draws the node the pointer was last on, as the frame reported it. The pin's release
// clears it, so the outline then follows the pointer again; the frame is told the hovered path through the usual tracking.
function usePinnedHover(setters: RuntimeSetters): void {
  const pinned = useSyncExternalStore(subscribeCanvasHoverPin, canvasHoverPinned);
  useEffect(() => {
    if (pinned) {
      const hover = rememberedCanvasHover(Date.now());
      if (hover !== undefined) {
        noteDeepHover(hover.path, hover.deep);
        setters.setCanvasHover(hover.path);
        setters.setCanvasHoverPseudo(hover.pseudo);
        setters.setHoverOcc(hover.occurrence);
      }
      return () => {
        setters.setCanvasHover(undefined);
        setters.setCanvasHoverPseudo(undefined);
        setters.setHoverOcc(0);
      };
    }
    return undefined;
  }, [pinned, setters]);
}

function useResetOnReload(props: PreviewRuntimeProps, url: string | undefined, refs: RuntimeRefs, setters: RuntimeSetters): void {
  const canvasMode = props.device === 'canvas';
  useEffect(() => {
    const { selectedClasses: selectedClassesRef, clickPending: clickPendingRef, lastClick: lastClickRef } = refs;
    setters.setRects({});
    forgetCanvasHover();
    setters.setCanvasHover(undefined);
    setters.setCanvasHoverPseudo(undefined);
    setters.setSpacing({});
    setters.setGuide(undefined);
    setters.setTextMarks(NO_TEXT_MARKS);
    setters.setSelectedOccurrence(undefined);
    setters.setHoverOcc(0);
    selectedClassesRef.current = undefined;
    clickPendingRef.current = false;
    lastClickRef.current = undefined;
    announceRender(refs.render, undefined); // A reloaded frame announces its rendering again.
    refs.clicks.current?.frameReset();
  }, [canvasMode, props.refreshKey, refs, setters, url]);
}

function trackedPaths(...paths: readonly (string | undefined)[]): readonly string[] {
  return [...new Set(paths.filter((path): path is string => Boolean(path)))];
}
