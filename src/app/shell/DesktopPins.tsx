// Desktop's side of comment pins (src/features/ai/pins/): what only the shell knows. While comment mode is on, a
// canvas click is a pin's (canvasClickSlot.ts's interceptor, ahead of any Stacki app) and the frame shows a
// crosshair; the click's element is read from the open file's tree for the pin's names and fingerprint, and the
// pinned area is photographed for the pin's crop. Each render resolves where every pin's element is now
// (pinModel.ts resolveAnchor) so pins follow their element through edits and hot reloads, and the canvas measures
// those elements (`extraTrackPaths`) so markers follow scrolling, zoom and resizing. Going to a pin opens its page,
// sets the canvas to the width it was pinned at and selects its element, as the Audits panel's go-to does.
//
// The host registers comment mode's header button in the AI panel while it is mounted and the role may use the panel.
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import { PIN_LIMITS } from '../../../shared/properties/ai/commentPinBrief';
import type { CommentPin, PinAnchor, PinId, PinPlace } from '../../../shared/properties/ai/commentPins';
import type { PageNode } from '../../../shared/page/pageNodeTypes';
import type { Translator } from '../../lib/i18n/localeContext';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { pageDisplayLabel } from '../../lib/pageName';
import { projectRelativePath } from '../../lib/projectPath';
import { nodeAtPath } from '../../editor/editorTree';
import { setCanvasClickInterceptor, type CanvasClickReport } from '../../ui/canvasClickSlot';
import { queryCanvasPoint } from '../../ui/canvasPointQuery';
import { describeNode } from '../../ui/navigatorLabel';
import { reportErrorToast } from '../../ui/errorNotices';
import { registerPanelMode } from '../../features/ai/panelModes';
import { COMMENT_PANEL_MODE } from '../../features/ai/pins/commentMode';
import { PinBar } from '../../features/ai/pins/PinBar';
import { PinOverlay, type PlacedPin } from '../../features/ai/pins/PinOverlay';
import { cropRect, normalizedWords, pointInBox, resolveAnchor, type CanvasBox, type CanvasNow } from '../../features/ai/pins/pinModel';
import {
  capturePinCrop,
  closePinBox,
  closePins,
  dropPin,
  followChats,
  followPinElement,
  loadPins,
  movePin,
  pinState,
  progressOf,
  setDetachedPins,
  setPinHistory,
  setPinMover,
  setPinNavigator,
  startMovingPin,
  usePinState,
} from '../../features/ai/pins/pinStore';
import { setPanelMode } from '../../features/ai/panelModes';
import { COMMENT_MODE_ID } from '../../features/ai/pins/commentMode';
import { trailOf } from '../model/pageGestures';
import type { ShellView } from '../App';
import { useAiAvailable } from './DesktopAi';
import { selectFromPanel } from './panelSelection';

/** Elements of the open file a pin's lost element is looked for among. Why: a page holds far fewer; a bad tree must not hang the canvas. */
const SEARCH_NODES_MAX = 20_000;

/** The geometry the last frame of the canvas measured, read when a crop is taken. */
interface CanvasFrame {
  readonly rects: Readonly<Record<string, readonly CanvasBox[] | undefined>>;
  readonly scale: number;
}

let lastFrame: CanvasFrame = { rects: {}, scale: 1 };

/** A go-to waiting for its page: the pin, until the canvas shows that page. */
let pendingReveal: CommentPin | undefined;

/** Mounted with the shell: loads the project's pins, registers comment mode, takes canvas clicks while it is on. */
export function PinsHost({ app }: { readonly app: ShellView }) {
  const translate = useTranslate();
  const available = useAiAvailable();
  const pins = usePinState();
  const appRef = useRef(app);
  appRef.current = app;
  const translateRef = useRef(translate);
  translateRef.current = translate;
  const projectPath = app.project.path;
  useEffect(() => {
    void loadPins(projectPath);
    return () => void closePins();
  }, [projectPath]);
  useEffect(() => (available ? registerPanelMode(COMMENT_PANEL_MODE) : undefined), [available]);
  useEffect(() => followChats(), []);
  useEffect(() => {
    setPinNavigator({ reveal: (pin) => revealPin(appRef.current, pin) });
    setPinMover((id, point, translate) => moveDraggedPin(appRef.current, id, point, translate));
    // Removing a pin is a step of the app's one history, so Undo and Redo keep their order with page edits.
    setPinHistory((step) => appRef.current.pushCommand(step));
    return () => {
      setPinNavigator(undefined);
      setPinMover(undefined);
      setPinHistory(undefined);
    };
  }, []);
  // Leaving the panel's role, or the project, ends the mode.
  useEffect(() => {
    if (!available) {
      setPanelMode(COMMENT_MODE_ID, 'off');
    }
  }, [available]);
  const on = pins.mode === 'on';
  useEffect(() => {
    if (!on) {
      return undefined;
    }
    setCanvasClickInterceptor({ capturing: () => pinState().mode === 'on', take: (click) => takeClick(appRef.current, click, translateRef.current) });
    sendCanvasCursor('crosshair');
    // Escape ends a move first, then the mode; a popover, a menu or a text field that used the key keeps it.
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || pinState().open !== undefined) {
        return;
      }
      if (event.target instanceof HTMLElement && event.target.matches('input, textarea, [contenteditable], [contenteditable] *')) {
        return;
      }
      event.preventDefault();
      if (pinState().moving === undefined) {
        setPanelMode(COMMENT_MODE_ID, 'off');
      } else {
        startMovingPin(undefined);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      setCanvasClickInterceptor(undefined);
      sendCanvasCursor('none');
    };
  }, [on]);
  // A go-to that opened another page selects the pin's element once the canvas has rendered it.
  const shownPage = canvasPage(app);
  // Another page on the canvas: a box open on a pin of the page left behind is kept (saved when it has content),
  // never lost with the page.
  useEffect(() => {
    const open = pinState().open;
    const pin = open === undefined ? undefined : pinState().board.pins.find((candidate) => candidate.id === open);
    if (pin !== undefined && shownPage !== undefined && pin.place.page !== shownPage && pendingReveal?.id !== pin.id) {
      closePinBox('keep', translateRef.current);
    }
  }, [shownPage]);
  const rendered = app.renderedPaths !== undefined;
  useEffect(() => {
    const wanted = pendingReveal;
    if (wanted === undefined || shownPage !== wanted.place.page || !rendered) {
      return;
    }
    pendingReveal = undefined;
    selectPinElement(appRef.current, wanted);
  }, [shownPage, rendered]);
  return undefined;
}

/** What CanvasPane adds for comment pins: the paths to measure, the markers over the canvas, and the mode's bar. */
export function usePinCanvas(app: ShellView): {
  readonly trackPaths: readonly string[];
  readonly overlay: (frame: CanvasFrame) => ReactNode;
  readonly bar: ReactNode;
} {
  const translate = useTranslate();
  const pins = usePinState();
  const now = useCanvasNow(app);
  const resolved = useMemo(() => {
    const placed: PlacedPin[] = [];
    const detached = new Set<PinId>();
    const moved: { readonly id: PinId; readonly path: string }[] = [];
    for (const pin of pins.board.pins) {
      const anchor = resolveAnchor(pin, now);
      if (anchor.kind === 'attached') {
        placed.push({ pin, path: anchor.path });
        if (anchor.moved) {
          moved.push({ id: pin.id, path: anchor.path });
        }
      } else if (anchor.kind === 'detached') {
        detached.add(pin.id);
      }
    }
    return { placed, detached, moved };
  }, [pins.board.pins, now]);
  // A pin whose element moved keeps following it; the detached ones are listed as such.
  useEffect(() => {
    for (const entry of resolved.moved) {
      followPinElement(entry.id, entry.path);
    }
    setDetachedPins(resolved.detached);
  }, [resolved]);
  const trackPaths = useMemo(() => (pins.mode === 'on' ? [...new Set(resolved.placed.map((entry) => entry.path))] : []), [pins.mode, resolved.placed]);
  const overlay = (frame: CanvasFrame): ReactNode => {
    lastFrame = frame;
    return (
      <PinOverlay
        rects={frame.rects}
        scale={frame.scale}
        placed={resolved.placed}
        detached={resolved.detached}
        progressOf={progressOf}
        recapture={(id) => {
          const entry = resolved.placed.find((candidate) => candidate.pin.id === id);
          return entry === undefined ? undefined : () => cropPlaced(entry, translate);
        }}
      />
    );
  };
  return { trackPaths, overlay, bar: <PinBar /> };
}

// ---------------------------------------------------------------------------
// The canvas now
// ---------------------------------------------------------------------------

function useCanvasNow(app: ShellView): CanvasNow {
  const page = canvasPage(app);
  const scope = app.editedRel === undefined || app.editedRel === '' ? undefined : app.editedRel;
  const renderedPaths = app.renderedPaths;
  const model = app.model;
  return useMemo(() => {
    const prefix = scope === undefined ? '' : `${scope}|`;
    const owns = (path: string): boolean => path.startsWith(prefix) && !path.slice(prefix.length).includes('|');
    const nodes = model?.nodes;
    return {
      page,
      scope,
      rendered: renderedPaths === undefined ? undefined : new Set(renderedPaths),
      owns,
      elementAt: (path) => {
        if (!owns(path)) {
          return undefined;
        }
        const node = nodeAtPath<PageNode>(nodes, trailOf(path));
        return node === undefined ? undefined : fingerprint(node);
      },
      find: (tag, text) => findElements(nodes, tag, text, prefix),
    };
  }, [page, scope, renderedPaths, model]);
}

// A page Stacki generates and removes again (the component canvas's, the defaults editor's), with whatever is opened
// from it: a pin there would send the agent to a file that is gone once the canvas closes.
function isScratchPage(page: string): boolean {
  return page.startsWith('.stacki/');
}

function canvasPage(app: ShellView): string | undefined {
  const path = (app.editStack[0] ?? app.currentPage)?.path;
  return path === undefined ? undefined : projectRelativePath(app.project.path, path, window.avb.platform);
}

/** A node's tag (or component name) and its own words, cut and folded as a pin keeps them. */
function fingerprint(node: PageNode): { readonly tag: string; readonly text: string | undefined } | undefined {
  if (node.kind !== 'element' && node.kind !== 'component') {
    return undefined;
  }
  const words = normalizedWords(
    (node.children ?? [])
      .slice(0, 64)
      .map((child) => (child.kind === 'text' ? child.value : ''))
      .join(' '),
  );
  return { tag: node.name, text: words === '' ? undefined : words };
}

// The paths of the open file's elements with this tag and words, depth first in document order, bounded.
function findElements(nodes: readonly PageNode[] | undefined, tag: string, text: string | undefined, prefix: string): readonly string[] {
  const found: string[] = [];
  const stack = (nodes ?? []).map((node, index) => ({ node, trail: String(index) })).reverse();
  let visited = 0;
  while (stack.length > 0 && visited < SEARCH_NODES_MAX) {
    const entry = stack.pop();
    assert(entry !== undefined, 'findElements: the stack holds an entry');
    visited += 1;
    const print = fingerprint(entry.node);
    if (print !== undefined && print.tag === tag && (text === undefined || print.text === text)) {
      found.push(`${prefix}${entry.trail}`);
    }
    const children = 'children' in entry.node ? (entry.node.children ?? []) : [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) {
        stack.push({ node: child, trail: `${entry.trail}.${index}` });
      }
    }
  }
  assert(visited <= SEARCH_NODES_MAX, 'findElements: the walk is bounded');
  return found;
}

// ---------------------------------------------------------------------------
// A click in comment mode
// ---------------------------------------------------------------------------

function takeClick(app: ShellView, click: CanvasClickReport, translate: Translator): void {
  const path = click.path;
  const page = canvasPage(app);
  if (page !== undefined && isScratchPage(page)) {
    reportErrorToast(translate('ai.pins.notAPage'));
    return;
  }
  if (path === undefined || page === undefined || path.length > PIN_LIMITS.canvasPathCharsMax) {
    reportErrorToast(translate('ai.pins.noElement'));
    return;
  }
  const drop = pinTarget(app, path, page, click, translate);
  if (drop === undefined) {
    reportErrorToast(translate('ai.pins.noElement'));
    return;
  }
  const id = dropPin(drop, translate);
  const box = click.box;
  if (id !== undefined && box !== undefined) {
    void cropAt(id, box, drop.anchor, translate);
  }
}

/** The anchor and place of a click: the element, its names, its file and locator, the page and the width. */
function pinTarget(
  app: ShellView,
  path: string,
  page: string,
  click: CanvasClickReport,
  translate: Translator,
): { readonly anchor: PinAnchor; readonly place: PinPlace } | undefined {
  const scope = app.editedRel === undefined || app.editedRel === '' ? undefined : app.editedRel;
  const bar = path.lastIndexOf('|');
  const file = bar < 0 ? (scope ?? page) : path.slice(0, bar);
  const locator = path.slice(bar + 1);
  if (!/^\d+(?:\.\d+)*$/u.test(locator)) {
    return undefined;
  }
  const prefix = scope === undefined ? '' : `${scope}|`;
  const owned = path.startsWith(prefix) && !path.slice(prefix.length).includes('|');
  const node = owned ? nodeAtPath<PageNode>(app.model?.nodes, trailOf(path)) : undefined;
  const print = node === undefined ? undefined : fingerprint(node);
  const tag = print?.tag ?? 'element';
  const words = print?.text;
  const described =
    node === undefined ? translate('ai.pins.elementIn', { file: file.split('/').pop() ?? file }) : describeNode(node, undefined, translate).label;
  const label =
    words === undefined || described.includes(words) ? described : translate('ai.pins.elementWithText', { element: described, text: shortWords(words) });
  const componentFile = node?.kind === 'component' ? app.scan.components.find((component) => component.name === node.name)?.file : undefined;
  const scanPage = app.scan.pages.find((candidate) => projectRelativePath(app.project.path, candidate.path, window.avb.platform) === page);
  const box = click.box ?? { x: 0, y: 0, w: 0, h: 0 };
  const width = app.canvasWidthPx;
  return {
    anchor: {
      path,
      occurrence: Math.min(click.occurrence, PIN_LIMITS.occurrenceMax),
      at: pointInBox(box, { x: click.x ?? box.x, y: click.y ?? box.y }),
      tag: tag.slice(0, PIN_LIMITS.tagCharsMax),
      text: words,
    },
    place: {
      page,
      pageLabel: (scanPage === undefined ? (page.split('/').pop() ?? page) : pageDisplayLabel(scanPage, translate)).slice(0, PIN_LIMITS.labelCharsMax),
      scope,
      file,
      locator,
      elementLabel: label.slice(0, PIN_LIMITS.labelCharsMax),
      componentFile,
      breakpointPx: width === undefined || width < 1 ? undefined : Math.min(Math.round(width), PIN_LIMITS.breakpointPxMax),
    },
  };
}

/** Characters of an element's words in its label. */
const LABEL_WORDS_CHARS_MAX = 40;

function shortWords(words: string): string {
  return words.length > LABEL_WORDS_CHARS_MAX ? `${words.slice(0, LABEL_WORDS_CHARS_MAX - 1).trimEnd()}…` : words;
}

// The crop of a pin's area: where the canvas is on screen and at what zoom, from the frame it last drew.
async function cropAt(id: PinId, box: CanvasBox, anchor: PinAnchor, translate: Translator): Promise<void> {
  const layer = document.querySelector<HTMLElement>('.preview-overlay-layer')?.getBoundingClientRect();
  const clip = document.querySelector<HTMLElement>('.frame-clip')?.getBoundingClientRect();
  if (layer === undefined || clip === undefined) {
    return;
  }
  const rect = cropRect({
    box,
    at: anchor.at,
    scale: lastFrame.scale,
    origin: { x: layer.left, y: layer.top },
    clip: { x: clip.left, y: clip.top, width: clip.width, height: clip.height },
  });
  if (rect !== undefined) {
    await capturePinCrop(id, rect, translate);
  }
}

function cropPlaced(entry: PlacedPin, translate: Translator): void {
  const box = lastFrame.rects[entry.path]?.[entry.pin.anchor.occurrence] ?? lastFrame.rects[entry.path]?.[0];
  if (box !== undefined) {
    void cropAt(entry.pin.id, box, entry.pin.anchor, translate);
  }
}

// A marker dragged and released at `point` (canvas CSS pixels): the element under it takes the pin, with its words,
// images and unsaved changes; its crop is taken again there, unless the person had removed it. Nothing under the
// point (off the page) leaves the pin where it was.
async function moveDraggedPin(app: ShellView, id: PinId, point: { readonly x: number; readonly y: number }, translate: Translator): Promise<void> {
  const pin = pinState().board.pins.find((candidate) => candidate.id === id);
  const page = canvasPage(app);
  if (pin === undefined || page === undefined || isScratchPage(page) || pin.delivery.kind === 'sent') {
    return;
  }
  const hit = await queryCanvasPoint(point.x, point.y);
  if (hit?.path === undefined || hit.path.length > PIN_LIMITS.canvasPathCharsMax) {
    return;
  }
  const target = pinTarget(app, hit.path, page, { ...hit, x: point.x, y: point.y }, translate);
  if (target === undefined || !movePin(id, target, translate)) {
    return;
  }
  const hadCrop = (pin.edit ?? pin).images.some((image) => image.kind === 'crop');
  if (hadCrop && hit.box !== undefined) {
    // After the marker has landed and its box steps back in, so the crop shows the pin in its new place.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await cropAt(id, hit.box, target.anchor, translate);
  }
}

// The cursor the canvas frame shows while comment mode takes its clicks (electron/preload/frameAppCursor.ts).
function sendCanvasCursor(cursor: 'crosshair' | 'none'): void {
  const frame = document.querySelector<HTMLIFrameElement>('.frame-clip iframe')?.contentWindow ?? undefined;
  frame?.postMessage({ type: 'avb:app-cursor', cursor }, '*');
}

// ---------------------------------------------------------------------------
// Going to a pin
// ---------------------------------------------------------------------------

function revealPin(app: ShellView, pin: CommentPin): void {
  const width = pin.place.breakpointPx;
  if (width !== undefined && app.canvasWidthPx !== undefined && Math.round(app.canvasWidthPx) !== width) {
    app.requestCanvasWidth(width);
  }
  if (canvasPage(app) === pin.place.page) {
    selectPinElement(app, pin);
    return;
  }
  const page = app.scan.pages.find((candidate) => projectRelativePath(app.project.path, candidate.path, window.avb.platform) === pin.place.page);
  if (page === undefined) {
    return; // The page is gone: the pin stays in the list, detached.
  }
  pendingReveal = pin;
  app.onSelectPage(page);
}

// Selects the pin's element as a panel does, so the canvas scrolls it into view; a pin of another file's markup is only shown.
function selectPinElement(app: ShellView, pin: CommentPin): void {
  const path = pin.anchor.path;
  const scope = app.editedRel === undefined || app.editedRel === '' ? '' : `${app.editedRel}|`;
  if (!path.startsWith(scope) || path.slice(scope.length).includes('|')) {
    return;
  }
  const node = nodeAtPath(app.model?.nodes, trailOf(path));
  if (node !== undefined) {
    selectFromPanel(app, node.id);
  }
}
