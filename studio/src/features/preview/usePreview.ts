import { usePreviewContextMenu } from './usePreviewContextMenu';
import {
  canvasClickBox,
  canvasClicksCaptured,
  coordinateOf,
  takeCanvasClick,
  noteCanvasOpen,
  observeCanvasClick,
  type CanvasClickReport,
} from '../../../vendor/stacki/src/ui/canvasClickSlot';
import { receiveCanvasPoint } from '../../../vendor/stacki/src/ui/canvasPointQuery';
import { resendCanvasOutlineMode } from '../../../vendor/stacki/src/ui/canvasOutlineMode';
import { isCanvasPage } from '../../../vendor/stacki/shared/properties/defaultsCanvas';
import { usePreviewSource } from '../../../vendor/stacki/src/features/preview/usePreviewSource';
import { emptyOutlines, parseOutlines, type OutlineState } from './outlineState';
import { receivePreviewKey } from './previewKeys';
import { receiveStyleModifiers } from './styleModifiers';
import { receiveCanvasReply, setCanvasFrame, noteCanvasReady } from '../../../vendor/stacki/src/editor/canvasQuery';
import { NO_TEXT_MARKS, parsePreviewMessage, parseShortcutMessage, type TextMarks } from '../../../vendor/stacki/src/features/preview/previewMessages';
import { runShortcutCommand } from '../../../vendor/stacki/src/features/apps/appCommands';
import type { GuideMetrics } from '../../../vendor/stacki/src/features/preview/guideModel';
import { useCallback, useEffect, useRef, useState } from 'react';
import { request } from '../project/projectClient';
import { useCanvasRoute } from '../pages/templateEntryStore';
import { record, string } from '../../shared/validation';

export function usePreview(
  file: string,
  onSelect: (id: string, occurrence?: number) => void,
  report: (error: unknown) => void,
  enabled = true,
  onOpen?: (id: string, occurrence: number) => void,
) {
  const [outlines, setOutlines] = useState(emptyOutlines);
  // What the column guide is drawn from; undefined until the page reports.
  const [guide, setGuide] = useState<GuideMetrics | undefined>(undefined);
  // Text of the selected instance the pointer is on, or that was clicked (frameTextMarks.ts).
  const [textMarks, setTextMarks] = useState<TextMarks>(NO_TEXT_MARKS);
  const frame = useRef<HTMLIFrameElement>(null);
  const loadListeners = useRef(new Set<() => void>());
  const subscribeLoad = useCallback((listener: () => void) => {
    loadListeners.current.add(listener);
    listener();
    return () => {
      loadListeners.current.delete(listener);
    };
  }, []);
  const reveal = useRef<{ type: string; id: string; occurrence: number }>();
  const { subscribeOutside, onOutside } = useOutsideListeners();
  const callbacks = useRef({ onSelect, onOpen, report, onOutside });
  callbacks.current = { onSelect, onOpen, report, onOutside };
  const { target, retry } = usePreviewTarget(file, enabled, callbacks);
  const send = (message: unknown) => postToFrame(frame.current, target?.origin, message);
  const source = usePreviewSource(target?.url, send);
  usePreviewMessages(frame, target, callbacks, { setOutlines, setGuide, setTextMarks });
  const contextMenu = usePreviewContextMenu(frame, target?.origin, file, onSelect);

  return {
    retry,
    contextMenu,
    frame,
    outlines,
    guide,
    textMarks,
    subscribeLoad,
    subscribeOutside,
    // A follow is kept and sent again once the peer's page has loaded here. A
    // Navigator pick is not: the page is already there, and replaying it after a
    // later reload would pull the page back from wherever the person scrolled.
    reveal: (id: string, occurrence = 0, options: { readonly replayOnLoad?: boolean } = {}) => {
      const message = { type: 'studio:reveal', id, occurrence };
      reveal.current = options.replayOnLoad === false ? undefined : message;
      postToFrame(frame.current, target?.origin, message);
    },
    loaded: (options: { readonly preserveNavigation?: boolean } = {}) => {
      if (!options.preserveNavigation) {
        source.loaded();
      }
      setCanvasFrame({
        postMessage: (message: unknown) => postToFrame(frame.current, target?.origin, message),
      });
      noteCanvasReady();
      resendCanvasOutlineMode(); // A new document starts in the editor's own mode.
      // React calls this for the current iframe, including replacements with the same URL.
      for (const listener of loadListeners.current) {
        listener();
      }
      if (reveal.current && !options.preserveNavigation) {
        postToFrame(frame.current, target?.origin, reveal.current);
      }
    },
    // Outlines measured on a document that has gone: a frame that left the site
    // must not keep the old page's boxes over whatever replaced it.
    clearOverlays: () => {
      setOutlines(emptyOutlines);
      setTextMarks(NO_TEXT_MARKS);
    },
    url: source.url,
    renderURL: target?.url,
    send,
  };
}
// Defaults editing and component editing both dismiss through the canvas. Neither
// subscriber may replace the other when React mounts their effects.
function useOutsideListeners() {
  const outside = useRef(new Set<() => void>());
  const subscribeOutside = useCallback((listener: () => void) => {
    if (outside.current.size >= 8) {
      throw new Error('Too many preview dismissal listeners.');
    }
    outside.current.add(listener);
    return () => {
      outside.current.delete(listener);
    };
  }, []);
  const onOutside = () => {
    for (const listener of outside.current) {
      listener();
    }
  };
  return { subscribeOutside, onOutside };
}

function usePreviewMessages(
  frame: React.RefObject<HTMLIFrameElement>,
  target: { url: string; origin: string } | undefined,
  callbacks: React.MutableRefObject<{
    onSelect: (id: string, occurrence?: number) => void;
    onOutside: () => void;
    onOpen: ((id: string, occurrence: number) => void) | undefined;
    report: (error: unknown) => void;
  }>,
  setters: MeasurementSetters,
) {
  const { setOutlines, setGuide, setTextMarks } = setters;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const patch = (event?: Event) => {
      clearTimeout(timer);
      if (requestStructuralPreview(event, frame.current, target?.origin)) {
        return;
      }
      timer = setTimeout(() => {
        if (target) {
          frame.current?.contentWindow?.postMessage({ type: 'avb:patch-now' }, target.origin);
        }
      }, 32);
    };
    const receive = (event: MessageEvent) => {
      if (!target || event.origin !== target.origin || event.source !== frame.current?.contentWindow) {
        return;
      }
      receiveMeasurements(event.data, { setOutlines, setGuide, setTextMarks });
      receiveStudioSignals(event.data, patch);
      if (isMessage(event.data, 'avb:query-result')) {
        receiveCanvasReply(event.data);
      }
      if (isMessage(event.data, 'avb:point-result')) {
        receiveCanvasPoint(event.data);
      }
      if (isMessage(event.data, 'studio:open')) {
        noteCanvasOpen(); // A double click: the observed click it began with is no placement.
      }
      if (isMessage(event.data, 'studio:open') && !canvasClicksCaptured()) {
        const data = record(event.data);
        callbacks.current.onOpen?.(string(data['id'], 500), messageOccurrence(data));
      }
      if (isMessage(event.data, 'studio:outside-focus')) {
        callbacks.current.onOutside();
      }
      // While a Stacki app captures canvas clicks, a click is the app's, not a selection (canvasClickSlot.ts).
      if (!takeCapturedClick(event.data)) {
        // An observing app hears the click too, after the double-click window; Studio selects as always.
        observeSelectionClick(event.data);
        receiveSelection(event.data, callbacks.current.onSelect);
      }
    };
    const variant = (event: Event) => {
      if (event instanceof CustomEvent) {
        postToFrame(frame.current, target?.origin, {
          type: 'studio:variant',
          command: event.detail as unknown,
        });
      }
    };
    window.addEventListener('studio:variant-command', variant);
    window.addEventListener('studio:source-updated', patch);
    window.addEventListener('message', receive);
    return () => {
      clearTimeout(timer);
      setCanvasFrame(undefined);
      window.removeEventListener('studio:variant-command', variant);
      window.removeEventListener('studio:source-updated', patch);
      window.removeEventListener('message', receive);
    };
  }, [target, frame, callbacks, setOutlines, setGuide, setTextMarks]);
}
function requestStructuralPreview(event: Event | undefined, frame: HTMLIFrameElement | null, origin: string | undefined): boolean {
  if (!(event instanceof CustomEvent) || event.detail !== 'structure' || !origin) {
    return false;
  }
  // This follows the accepted disk write. The frame uses the existing push
  // when connected and falls back to a pull when the push is unavailable.
  frame?.contentWindow?.postMessage({ type: 'avb:patch-now' }, origin);
  return true;
}
// What the page measured: the outlines it draws, and what the column guide is
// drawn from, read through the shared parser.
interface MeasurementSetters {
  readonly setOutlines: (state: OutlineState) => void;
  readonly setGuide: (metrics: GuideMetrics) => void;
  readonly setTextMarks: (marks: TextMarks) => void;
}
function receiveMeasurements(data: unknown, setters: MeasurementSetters) {
  const outlines = parseOutlines(data);
  if (outlines) {
    setters.setOutlines(outlines);
  }
  const message = parsePreviewMessage(data);
  if (message?.kind === 'guide') {
    setters.setGuide(message.metrics);
  }
  if (message?.kind === 'text-marks') {
    setters.setTextMarks({ hover: message.hover, picked: message.picked });
  }
}
function messageOccurrence(data: Record<string, unknown>) {
  const value = data['occurrence'];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < 10_000 ? value : 0;
}
function receiveStudioSignals(data: unknown, patch: () => void) {
  receiveStyleModifiers(data);
  if (isMessage(data, 'avb:canvas-ready') || isMessage(data, 'studio:css-changed')) {
    noteCanvasReady();
  }
  if (isMessage(data, 'studio:key')) {
    receivePreviewKey(data);
  }
  // A key in the app command range, pressed while the canvas had focus (previewKeys.ts).
  const shortcut = parseShortcutMessage(data);
  if (shortcut?.name === 'appCommand') {
    runShortcutCommand(shortcut.shortcut);
  }
  if (isMessage(data, 'studio:interaction')) {
    window.dispatchEvent(new Event('studio:interaction'));
  }
  if (isMessage(data, 'studio:css-changed') || isMessage(data, 'studio:cms-changed')) {
    window.dispatchEvent(new Event('studio:source-updated'));
  }
  if (isMessage(data, 'studio:invalidate')) {
    window.dispatchEvent(new Event('studio:project-updated'));
    patch();
  }
}
function usePreviewTarget(file: string, enabled: boolean, callbacks: React.MutableRefObject<{ report: (error: unknown) => void }>) {
  const [target, setTarget] = useState<{ url: string; origin: string }>();
  const [revision, setRevision] = useState(0);
  // A template page shows the entry chosen for it; until there is one, there is nothing to load.
  const route = useCanvasRoute(file, enabled);
  const retry = useCallback(() => {
    // Hosted entry URLs expire. A retry needs a fresh grant, not another iframe
    // pointed at the expired URL. Removing the old target also resets readiness.
    setTarget(undefined);
    setRevision((value) => value + 1);
  }, []);
  useEffect(() => {
    let active = true;
    if (!enabled || !isCanvasPage(file) || route === undefined) {
      setTarget(undefined);
      return;
    }
    void request('/studio/api/preview-url?page=' + encodeURIComponent(route))
      .then((value) => {
        const target = parsePreviewTarget(value);
        if (active) {
          setTarget(target);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          callbacks.current.report(error);
        }
      });
    return () => {
      active = false;
    };
  }, [file, route, enabled, callbacks, revision]);
  return { target, retry };
}

function postToFrame(frame: HTMLIFrameElement | null, origin: string | undefined, message: unknown) {
  if (origin) {
    frame?.contentWindow?.postMessage(message, origin);
  }
}

export function parsePreviewTarget(value: unknown) {
  const data = record(value);
  const url = string(data['url'], 4000);
  const origin = string(data['origin'], 500);
  const parsed = new URL(url, location.origin);
  if (parsed.origin !== origin || !['https:', 'http:'].includes(parsed.protocol)) {
    throw new Error('Invalid preview address');
  }
  return { url: parsed.href, origin };
}

function selectionID(data: unknown): string | undefined {
  if (data && typeof data === 'object' && 'type' in data && data.type === 'studio:select' && 'id' in data && typeof data.id === 'string') {
    return data.id;
  }
  return undefined;
}

// A `studio:select` as the click report an app hears.
function selectionClick(value: unknown): CanvasClickReport | undefined {
  const id = selectionID(value);
  if (id === undefined) {
    return undefined;
  }
  const data = record(value);
  return {
    path: id,
    occurrence: messageOccurrence(data),
    x: coordinateOf(data['x']),
    y: coordinateOf(data['y']),
    box: canvasClickBox(data['box']),
  };
}

// A `studio:select` the observing app hears as well (canvasClickSlot.ts observeCanvasClick).
function observeSelectionClick(value: unknown): void {
  const click = selectionClick(value);
  if (click !== undefined) {
    observeCanvasClick(click);
  }
}

// A `studio:select` handed to the app capturing canvas clicks; false when none captures, or it is another message.
function takeCapturedClick(value: unknown): boolean {
  const id = selectionID(value);
  if (id === undefined || !canvasClicksCaptured()) {
    return false;
  }
  const data = record(value);
  return takeCanvasClick({
    path: id,
    occurrence: messageOccurrence(data),
    x: coordinateOf(data['x']),
    y: coordinateOf(data['y']),
    box: canvasClickBox(data['box']),
  });
}

function isMessage(value: unknown, type: string): boolean {
  return !!value && typeof value === 'object' && 'type' in value && value.type === type;
}

function receiveSelection(value: unknown, select: (id: string, occurrence: number) => void): void {
  const id = selectionID(value);
  if (id !== undefined) {
    select(id, messageOccurrence(record(value)));
  }
}
