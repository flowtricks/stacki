import { frameContextPoint, type ContextPoint } from './contextPosition';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import type { CanvasFeedback, OverlayInfo, RectMap, SpacingMap } from './PreviewOverlays';
import type { PreviewDevice } from './PreviewToolbar';
import type { PreviewMessage, PreviewReloadReason } from './previewMessages';
import type { GuideMetrics } from './guideModel';
import { parsePreviewMessage } from './previewMessages';
import { outlineBoxPath, sameCopy } from './outlineBoxes';
import { useFeedbackReveal } from './feedbackReveal';
import { setModifiers } from '../../editor/heldModifiers';
import { noteCanvasReady, receiveCanvasReply, setCanvasFrame } from '../../editor/canvasQuery';
import type { Digest } from '../../../shared/core/brand';
import {
  judgeEventToken,
  type PreviewRender,
  type PreviewVerdict,
} from '../../../shared/page/previewToken';
import type { CanvasEventRequest } from '../../editor/canvasClick';

/** Whether a click or double-click on the canvas may select what it names
 * (src/features/preview/previewGate.ts). Hover needs only the token to be the latest. */
export type JudgeCanvasEvent = (
  token: Digest | undefined,
  render: PreviewRender | undefined,
  request: CanvasEventRequest,
) => Promise<PreviewVerdict>;

export interface PreviewRuntimeProps {
  readonly selPath: string | undefined;
  readonly navigatorSelectionTick?: number;
  readonly navHoverPath?: string | undefined;
  readonly overlayInfo?: ((path: string) => OverlayInfo | undefined) | undefined;
  /** The Feedback tab is open: clicks annotate, and the pins and the note box
   * are measured (the frame measures only what it tracks). */
  readonly feedback?: CanvasFeedback | undefined;
  readonly focusPath?: string | undefined;
  readonly focusOcc?: number | undefined;
  readonly pathScope?: string;
  readonly refreshKey?: string | number;
  readonly device: PreviewDevice;
  readonly onSelectPath?: (path: string | undefined, info: { readonly outside: boolean }) => void;
  readonly onContextPath?: (
    path: string | undefined,
    point: ContextPoint & {
      readonly outside: boolean;
      readonly occurrence: number;
    },
  ) => void;
  readonly onOpenPath?: (path: string | undefined, occurrence: number) => void;
  readonly onSelectedClasses?: (classes: readonly string[]) => void;
  readonly onRenderedPaths?: (paths: readonly string[]) => void;
  readonly onNodeStates?: (states: {
    readonly hidden: readonly string[];
    readonly inert: readonly string[];
  }) => void;
  readonly onNodeClasses?: (classes: Readonly<Record<string, readonly string[]>>) => void;
  /** The preview-token gate (step 7): an event from a stale rendering never
   * selects, and the refusal is shown, never swallowed. */
  readonly judgeEvent: JudgeCanvasEvent;
  readonly onStaleEvent: (verdict: Extract<PreviewVerdict, { readonly tag: 'stale' }>) => void;
  /** The canvas reloaded instead of patching (step 7): past a cap, it says so. */
  readonly onPreviewReload?: (reason: PreviewReloadReason) => void;
}

export interface PreviewRuntime {
  readonly iframeRef: React.RefObject<HTMLIFrameElement>;
  readonly rects: RectMap;
  readonly spacing: SpacingMap;
  readonly selOcc: number | undefined;
  readonly hoverPath: string | undefined;
  readonly hoverOcc: number | undefined;
  /** What the column guide is drawn from; undefined until the frame reports. */
  readonly guide: GuideMetrics | undefined;
  readonly registerFrame: () => void;
  readonly sendTrack: () => void;
  /** Sends a message to the current frame. */
  readonly post: (message: unknown) => void;
  /** Calls the listener each time a frame registers; returns the unsubscribe. */
  readonly subscribeLoad: (listener: () => void) => () => void;
}

export function usePreviewRuntime(
  props: PreviewRuntimeProps,
  url: string | undefined,
): PreviewRuntime {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [rects, setRects] = useState<RectMap>({});
  const [spacing, setSpacing] = useState<SpacingMap>({});
  const [canvasHover, setCanvasHover] = useState<string | undefined>(undefined);
  const [selectedOccurrence, setSelectedOccurrence] = useState<number | undefined>(undefined);
  const [hoverOcc, setHoverOcc] = useState(0);
  const [guide, setGuide] = useState<GuideMetrics | undefined>(undefined);
  const hoverPath = props.navHoverPath ?? canvasHover;
  const selectedBoxPath = props.selPath
    ? outlineBoxPath(props.selPath, props.overlayInfo?.(props.selPath)?.nodeKind)
    : undefined;
  const hoverBoxPath = hoverPath
    ? outlineBoxPath(hoverPath, props.overlayInfo?.(hoverPath)?.nodeKind)
    : undefined;
  const refs = useRuntimeRefs(props, selectedOccurrence);
  const setters = useMemo(
    () => ({
      setRects,
      setSpacing,
      setCanvasHover,
      setSelectedOccurrence,
      setHoverOcc,
      setGuide,
    }),
    [],
  );
  useOccurrenceSelection(props, refs, setSelectedOccurrence);
  useMessageListener(iframeRef, refs, setters);
  // The frame measures only tracked paths, so both hover sources must use
  // the same active path for measurement requests and outline rendering.
  const trackPaths = useTrackPaths(props, [hoverPath, selectedBoxPath, hoverBoxPath]);
  const link = useFrameLink(iframeRef);
  const registerFrame = useCallback((): void => {
    const frame = iframeRef.current?.contentWindow;
    setCanvasFrame(frame ?? undefined);
    // The frame may have announced its rendering before this listener mounted.
    // The load handler repeats this handshake after the preload is ready.
    frame?.postMessage({ type: 'avb:request-render' }, '*');
    link.notify();
  }, [link]);
  // A flag, not the object: the object is new every render, and re-tracking
  // makes the frame report rects, which renders again.
  const annotating = props.feedback !== undefined;
  const sendTrack = useCallback((): void => {
    link.post({
      type: 'avb:track',
      paths: trackPaths,
      scope: props.pathScope ?? '',
      focus: props.focusPath ?? '',
      focusOcc: props.focusOcc ?? 0,
      annotate: annotating,
    });
  }, [annotating, link, props.focusOcc, props.focusPath, props.pathScope, trackPaths]);
  useFrameRegistration(props, url, registerFrame, sendTrack);
  useSelectionScroll(props, iframeRef, refs);
  useResetOnReload(props, url, refs, setters);
  useFeedbackReveal(props.feedback, rects, url, link.post);
  return {
    iframeRef,
    rects,
    spacing,
    selOcc: selectedOccurrence,
    hoverPath,
    hoverOcc: props.navHoverPath ? 0 : hoverOcc,
    guide,
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
}

function useRuntimeRefs(
  props: PreviewRuntimeProps,
  selectedOccurrence: number | undefined,
): RuntimeRefs {
  const propsRef = useRef(props);
  propsRef.current = props;
  const selectedOccurrenceRef = useRef(selectedOccurrence);
  selectedOccurrenceRef.current = selectedOccurrence;
  const selectedClasses = useRef<string | undefined>(undefined);
  const clickPending = useRef(false);
  const lastClick = useRef<{ readonly path: string | undefined } | undefined>(undefined);
  const cameFrom = useRef<string | undefined>(undefined);
  const render = useRef<PreviewRender | undefined>(undefined);
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
    const {
      cameFrom: cameFromRef,
      lastClick: lastClickRef,
      selectedOccurrence: selectedOccurrenceRef,
      selectedClasses: selectedClassesRef,
    } = refs;
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

interface RuntimeSetters {
  readonly setRects: React.Dispatch<React.SetStateAction<RectMap>>;
  readonly setSpacing: React.Dispatch<React.SetStateAction<SpacingMap>>;
  readonly setCanvasHover: React.Dispatch<React.SetStateAction<string | undefined>>;
  readonly setSelectedOccurrence: React.Dispatch<React.SetStateAction<number | undefined>>;
  readonly setHoverOcc: React.Dispatch<React.SetStateAction<number>>;
  readonly setGuide: React.Dispatch<React.SetStateAction<GuideMetrics | undefined>>;
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

function useMessageListener(
  iframeRef: React.RefObject<HTMLIFrameElement>,
  refs: RuntimeRefs,
  setters: RuntimeSetters,
): void {
  const settersRef = useRef(setters);
  settersRef.current = setters;
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>): void => {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) {
        return;
      }
      const message = parsePreviewMessage(event.data);
      if (message) {
        applyMessage(message, refs, settersRef.current, iframeRef.current);
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [iframeRef, refs]);
}

function applyMessage(
  message: PreviewMessage,
  refs: RuntimeRefs,
  setters: RuntimeSetters,
  frame: HTMLIFrameElement,
): void {
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
      refs.props.current.onNodeStates?.({ hidden: message.hidden, inert: message.inert });
      break;
    case 'modifiers':
      setModifiers({ shiftKey: message.shiftKey, altKey: message.altKey });
      break;
    case 'hover-node':
      applyHover(message, refs, setters);
      break;
    case 'context-node':
      applyContextMenu(message, refs, setters, frame);
      break;
    case 'annotate-node':
      // A note's trail is read from the files: the rendering has to be them.
      gateEvent(message.token, refs, { kind: 'open' }, () =>
        refs.props.current.feedback?.onAnnotate(message),
      );
      break;
    case 'click-node':
      gateEvent(
        message.token,
        refs,
        { kind: 'click', path: message.path, outside: message.outside },
        () => applyClick(message, refs, setters),
      );
      break;
    case 'render':
      announceRender(refs.render, message.render);
      break;
    case 'preview-reload':
      announceRender(refs.render, undefined); // The reloaded page announces its own.
      refs.props.current.onPreviewReload?.(message.reason);
      break;
    case 'canvas-ready':
      noteCanvasReady();
      break;
    case 'guide':
      setters.setGuide(message.metrics);
      break;
    case 'query-result':
      receiveCanvasReply(message.input);
      break;
    case 'open-node':
      gateEvent(message.token, refs, { kind: 'open' }, () =>
        refs.props.current.onOpenPath?.(message.path ?? undefined, message.occurrence),
      );
      break;
  }
}

// A picture, not a selection: only the rendering has to be the latest.
function applyHover(
  message: Extract<PreviewMessage, { readonly kind: 'hover-node' }>,
  refs: RuntimeRefs,
  setters: RuntimeSetters,
): void {
  if (judgeEventToken(message.token, refs.render.current).tag === 'current') {
    setters.setCanvasHover(message.path);
    setters.setHoverOcc(message.occurrence);
  } else {
    setters.setCanvasHover(undefined);
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
    });
  });
}

function announceRender(
  renderRef: React.MutableRefObject<PreviewRender | undefined>,
  render: PreviewRender | undefined,
): void {
  renderRef.current = render;
}

// The gate answers after main has read the stamped files; the rendering judged
// is the one the event named, and `apply` runs only on `current`.
function gateEvent(
  token: Digest | undefined,
  refs: RuntimeRefs,
  request: CanvasEventRequest,
  apply: () => void,
): void {
  const render = refs.render.current;
  refs.props.current.judgeEvent(token, render, request).then(
    (verdict) => {
      if (verdict.tag === 'current') {
        apply();
      } else {
        refs.props.current.onStaleEvent(verdict);
      }
    },
    (error: unknown) => {
      // The check itself failed (main unreachable): nothing vouches for the
      // rendering, so the event does not select — and says why.
      console.error('[stacki] preview check failed:', error);
      refs.props.current.onStaleEvent({ tag: 'stale', reason: 'no-render', file: undefined });
    },
  );
}

function publishSelectedClasses(
  classes: Readonly<Record<string, readonly (readonly string[])[]>>,
  refs: RuntimeRefs,
): void {
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

function applyClick(
  message: Extract<PreviewMessage, { readonly kind: 'click-node' }>,
  refs: RuntimeRefs,
  setters: RuntimeSetters,
): void {
  const { clickPending: clickPendingRef, lastClick: lastClickRef } = refs;
  const path = message.path;
  clickPendingRef.current = true;
  lastClickRef.current = { path };
  setters.setSelectedOccurrence(message.occurrence);
  refs.props.current.onSelectPath?.(path, { outside: message.outside });
}

function useFrameRegistration(
  props: PreviewRuntimeProps,
  url: string | undefined,
  registerFrame: () => void,
  sendTrack: () => void,
): void {
  const canvasMode = props.device === 'canvas';
  useEffect(() => {
    registerFrame();
    return () => setCanvasFrame(undefined);
  }, [canvasMode, props.refreshKey, registerFrame, url]);
  useEffect(() => {
    sendTrack();
  }, [props.navigatorSelectionTick, props.refreshKey, sendTrack, url]);
}

function useSelectionScroll(
  props: PreviewRuntimeProps,
  iframeRef: React.RefObject<HTMLIFrameElement>,
  refs: RuntimeRefs,
): void {
  const previousContext = useRef({
    focusPath: props.focusPath,
    pathScope: props.pathScope,
    navigatorSelectionTick: props.navigatorSelectionTick,
  });
  useEffect(() => {
    const frame = iframeRef.current?.contentWindow;
    const previous = previousContext.current;
    const contextChanged =
      previous.focusPath !== props.focusPath || previous.pathScope !== props.pathScope;
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
      // The frame reads a missing occurrence as the first copy.
      frame.postMessage(
        {
          type: 'avb:scroll-to',
          path: props.selPath,
          occ: navigatorSelected ? 0 : refs.selectedOccurrence.current,
        },
        '*',
      );
    }
  }, [
    iframeRef,
    props.focusPath,
    props.navigatorSelectionTick,
    props.pathScope,
    props.selPath,
    refs,
  ]);
}

function useResetOnReload(
  props: PreviewRuntimeProps,
  url: string | undefined,
  refs: RuntimeRefs,
  setters: RuntimeSetters,
): void {
  const canvasMode = props.device === 'canvas';
  useEffect(() => {
    const {
      selectedClasses: selectedClassesRef,
      clickPending: clickPendingRef,
      lastClick: lastClickRef,
    } = refs;
    setters.setRects({});
    setters.setCanvasHover(undefined);
    setters.setSpacing({});
    setters.setSelectedOccurrence(undefined);
    setters.setHoverOcc(0);
    selectedClassesRef.current = undefined;
    clickPendingRef.current = false;
    lastClickRef.current = undefined;
    announceRender(refs.render, undefined); // A reloaded frame announces its rendering again.
  }, [canvasMode, props.refreshKey, refs, setters, url]);
}

// The paths the frame measures: the selection, the hover, the focus, their
// outline boxes, and the Feedback pins.
function useTrackPaths(
  props: PreviewRuntimeProps,
  [hoverPath, selectedBoxPath, hoverBoxPath]: readonly (string | undefined)[],
): readonly string[] {
  const { feedback } = props;
  const pinPaths = [...(feedback?.pins ?? []), ...(feedback?.composer ? [feedback.composer] : [])]
    .map((pin) => pin.path)
    .join('\n');
  const { focusPath, selPath: selectionPath } = props;
  return useMemo(
    () =>
      trackedPaths(
        selectionPath,
        hoverPath,
        focusPath,
        selectedBoxPath,
        hoverBoxPath,
        ...pinPaths.split('\n'),
      ),
    [focusPath, hoverPath, hoverBoxPath, selectionPath, selectedBoxPath, pinPaths],
  );
}

function trackedPaths(...paths: readonly (string | undefined)[]): readonly string[] {
  return [...new Set(paths.filter((path): path is string => Boolean(path)))];
}
