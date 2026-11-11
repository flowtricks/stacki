// The apps that are running, their frames, and their overlays: one store per
// editor window, shared by the Apps panel, the floating app windows and the
// canvas overlay layer. Messages from app frames arrive here, are matched to the
// frame's window (never trusted by origin, which is opaque for every app), and
// are answered by the dispatcher (appRpcHost.ts) with the host's commands.
//
// The host (Desktop's shell, or Studio's editor) calls `configureAppsRuntime`
// on every render with its current commands and role, so a request is always
// answered against the editor's state at that moment.
import { useMemo, useSyncExternalStore } from 'react';
import { assert } from '../../../shared/core/assert';
import type { RoleView } from '../../../shared/properties/projectRoles';
import type { AppSummary, AppWindowMode } from '../../../shared/properties/apps';
import {
  APP_RPC_LIMITS,
  eventMessage,
  type AppChangeSource,
  type AppEditOutcome,
  type AppEventData,
  type AppEventName,
  type AppFrameInfo,
  type AppHostMessage,
  type AppOpenFrame,
  type AppCanvasClick,
  type AppNodeRef,
  type AppNodeView,
  type AppOverlayItem,
} from '../../../shared/properties/appsRpc';
import type { AppOverrideSlot } from '../../ui/appOverrideSlot';
import { APP_SHORTCUT_LIMITS } from '../../../shared/properties/appShortcuts';
import { createAppOverrides, overrideSlotOf } from './appOverrides';
import { appBadges } from './appBadges';
import { createCanvasCapture, type CanvasCapture } from './canvasCapture';
import { createOverlayDrag, type OverlayDrag } from './overlayDrag';
import type { RefTargetLookup } from './overlayPlacement';
import { bundleBytesReader } from './appCursorImage';
import { appFrameURL } from '../../ipc/appsBridge';
import { tellCanvas } from '../../editor/canvasQuery';
import { queryCanvasChain } from '../../ui/canvasPointQuery';
import { overlayMeasure } from './overlayMeasure';
import { createNodeRefTargets, type NodeRefHost, type NodeRefTargets } from './nodeRefs';
import { createOutlineModeOwner, type OutlineModeOwner } from './outlineModeOwner';
import { createInsertDrag, type InsertDrag, type InsertDragHit } from './insertDrag';
import { setCanvasHighlight, setCanvasOutlineMode } from '../../ui/canvasOutlineMode';
import {
  answerAppMessage,
  appRoleView,
  eventForSession,
  inFlightCounter,
  pageIndexOf,
  type AppCommandRegistry,
  type AppHighlights,
  type AppCustomFrames,
  type AppEditOriginTracker,
  type AppHostCommands,
  type AppSession,
  type AppShortcutState,
  type AppOverlayMessenger,
} from './appRpcHost';
import { requestAppDetails } from './appDetailsRequests';

/** Frames one window may hold for apps: each running app's own and its overlay frames. */
const FRAMES_MAX = 64;
/** Apps running at once. */
export const RUNNING_APPS_MAX = 8;

export interface RunningApp {
  readonly app: AppSummary;
  /** Docked in the side panel or popped out; the app's frame is the same element in both. */
  readonly mode: AppWindowMode;
  /**
   * Why the app's folder no longer reads as an app, while its last good version keeps
   * running (appFolderChanges.ts); absent while the folder is valid. Its window shows it.
   */
  readonly folderError?: string;
}

/** What a running app's folder read as once it settled: its new summary, or the reason it is broken. */
export type RunningAppFolder = { readonly kind: 'valid'; readonly app: AppSummary } | { readonly kind: 'broken'; readonly message: string };

/** A custom frame an app opened (`ui.openFrame`), drawn by AppWindows.tsx. */
export interface CustomFrame extends AppOpenFrame {
  readonly id: string;
  readonly appId: string;
}

interface Snapshot {
  readonly running: readonly RunningApp[];
  readonly overlays: ReadonlyMap<string, readonly AppOverlayItem[]>;
  readonly frames: readonly CustomFrame[];
}

/** Custom frame ids are `frame-<n>` with at most nine digits (shared/properties/appsRpc.ts parseFrameId). */
const FRAME_SERIAL_MAX = 999_999_999;

let snapshot: Snapshot = { running: [], overlays: new Map(), frames: [] };
const listeners = new Set<() => void>();
const sessions = new Map<MessageEventSource, AppSession>();
let configured: { readonly host: AppHostCommands; readonly role: () => RoleView } | undefined;
let listening = false;
let frameSerial = 0;
/** Each frame's focus and kept shortcuts, as its SDK reports them; a frame that never reported has none. */
const shortcutStates = new WeakMap<AppSession, { readonly editableFocus: boolean; readonly claims: ReadonlySet<string> }>();
const shortcuts: AppShortcutState = {
  noteFocus: (session, editable) => {
    shortcutStates.set(session, { editableFocus: editable, claims: shortcutStates.get(session)?.claims ?? new Set() });
  },
  claim: (session, claims) => {
    assert(claims.length <= APP_SHORTCUT_LIMITS.claimsMax, 'A frame claims a bounded number of shortcuts');
    shortcutStates.set(session, { editableFocus: shortcutStates.get(session)?.editableFocus ?? false, claims: new Set(claims) });
  },
};
let commandRegistry: AppCommandRegistry | undefined;

/** App commands (appCommands.ts) register here, so the runtime does not import them back. */
export function setAppCommandRegistry(registry: AppCommandRegistry | undefined): void {
  commandRegistry = registry;
}
/** The session that opened each custom frame, which hears its `frame.close`. */
const frameOpeners = new Map<string, AppSession>();

const overrides = createAppOverrides({
  post: (session, message) => {
    const source = sourceOf(session);
    if (source !== undefined) {
      post(source, message);
    }
  },
  role: () => configured?.role(),
  running: (appId) => snapshot.running.some((running) => running.app.manifest.id === appId),
  selection: () => configured?.host.selection().nodeId,
  timeoutMs: APP_RPC_LIMITS.overrideTimeoutMs,
});

/** The app that captures canvas clicks, if one does (canvasCapture.ts): one per editor window. */
export const canvasCapture: CanvasCapture = createCanvasCapture({
  emit: (appId, event, data) => emitToApp(appId, event, data),
  running: (appId) => snapshot.running.some((running) => running.app.manifest.id === appId),
});

/** The app whose highlight the canvas draws (`canvas.highlight`), if one does: one shown at a time. */
let highlightOwner: string | undefined;

/** App highlights: the latest app's replaces another's; each app clears only its own. */
export const appHighlights: AppHighlights = {
  show: (appId, highlight) => {
    highlightOwner = appId;
    setCanvasHighlight(highlight);
  },
  clear: (appId) => {
    if (highlightOwner === appId) {
      clearAppHighlight();
    }
  },
};

/** Clears whatever highlight the canvas draws: the panel changed, the outline mode reset, its app stopped. */
export function clearAppHighlight(): void {
  highlightOwner = undefined;
  setCanvasHighlight(undefined);
}

/**
 * The rail panel shown changed: deep outlines and highlights are for the Apps panel, so
 * another panel (or none) puts the canvas back to normal and takes any highlight away.
 */
export function noteLeftPanel(panel: string | undefined): void {
  if (panel !== 'apps') {
    outlineModeOwner.reset('panel');
    clearAppHighlight(); // Also an app's highlight with no deep mode under it.
  }
}

/** The app holding the canvas's deep outline mode, if one does (outlineModeOwner.ts): one per editor window. */
export const outlineModeOwner: OutlineModeOwner = createOutlineModeOwner({
  emit: (appId, event, data) => emitToApp(appId, event, data),
  running: (appId) => snapshot.running.some((running) => running.app.manifest.id === appId),
  apply: (mode) => {
    setCanvasOutlineMode(mode);
    // A highlight belongs to the mode it was drawn in: a reset to normal takes it away too.
    if (mode === 'normal') {
      clearAppHighlight();
    }
  },
});

/** The open file's element under a canvas point, for a drag to insert; useCanvasCapture installs it. */
let insertDropLocator: ((x: number, y: number) => Promise<InsertDragHit | undefined>) | undefined;
/** An editor-window point as a canvas viewport point; the overlay layer installs it, knowing where the canvas is drawn. */
let canvasClientMapper: ((x: number, y: number) => { readonly x: number; readonly y: number } | undefined) | undefined;

/** Installs the host's drop hit test, or removes it with undefined: a drag then takes no drop. */
export function setInsertDropLocator(next: ((x: number, y: number) => Promise<InsertDragHit | undefined>) | undefined): void {
  insertDropLocator = next;
}

/** Installs the overlay layer's point mapping, or removes it with undefined: a drag is then off the canvas. */
export function setCanvasClientMapper(next: ((x: number, y: number) => { readonly x: number; readonly y: number } | undefined) | undefined): void {
  canvasClientMapper = next;
}

/** The drag to insert under way, if one is (insertDrag.ts): one per editor window. */
export const insertDrag: InsertDrag = createInsertDrag({
  toCanvas: (x, y) => canvasClientMapper?.(x, y),
  locate: (x, y) => insertDropLocator?.(x, y) ?? Promise.resolve(undefined),
  running: (appId) => snapshot.running.some((running) => running.app.manifest.id === appId),
});

/** What is under a canvas point, as the host resolves a captured click; useCanvasCapture installs it. */
type CanvasPointLocator = (x: number, y: number) => Promise<AppCanvasClick>;
let canvasPointLocator: CanvasPointLocator | undefined;

/** Installs the host's canvas hit test for overlay drags, or removes it with undefined: a drag then names no element. */
export function setCanvasPointLocator(next: CanvasPointLocator | undefined): void {
  canvasPointLocator = next;
}

/** The page the canvas renders, relative to the project, as the host knows it; useCanvasCapture installs it. */
let canvasPageReader: (() => string | undefined) | undefined;

/** Installs the host's reading of the canvas page, or removes it with undefined: refs then resolve nothing. */
export function setCanvasPageReader(next: (() => string | undefined) | undefined): void {
  canvasPageReader = next;
  nodeRefTargets.refresh();
}

/**
 * How node refs are read back to the canvas (nodeRefs.ts): the configured host's
 * open page and page index, the canvas page, and the frame's chain answer.
 * Undefined until a host with a canvas is configured.
 */
export function appNodeRefHost(): NodeRefHost | undefined {
  const host = configured?.host;
  const readCanvasPage = canvasPageReader;
  if (host === undefined || readCanvasPage === undefined) {
    return undefined;
  }
  return {
    open: () => host.page(),
    canvasPage: readCanvasPage,
    tree: async (file) => (await pageIndexOf(host).getTree(file, host.page()))?.nodes,
    locate: queryCanvasChain,
  };
}

/** The open page's element with an id, as `node.get` answers; undefined before a host is configured. */
export function appHostNode(nodeId: string): AppNodeView | undefined {
  return configured?.host.node(nodeId);
}

/** Where overlay items anchored to refs are drawn: one store per editor window. */
export const nodeRefTargets: NodeRefTargets = createNodeRefTargets({
  host: () => appNodeRefHost(),
  refsMax: RUNNING_APPS_MAX * APP_RPC_LIMITS.overlayAnchorsMax,
});

/** Where overlay anchors on refs are drawn, re-rendering the caller as they resolve. */
export function useRefTargetLookup(): RefTargetLookup {
  const version = useSyncExternalStore(nodeRefTargets.subscribe, nodeRefTargets.version);
  // A new object per version, so a memoized reader sees the change.
  return useMemo(() => ({ version, target: (ref: AppNodeRef) => nodeRefTargets.target(ref) }), [version]);
}

/** The overlay item being pressed or dragged, if one is (overlayDrag.ts): one per editor window. */
export const overlayDrag: OverlayDrag = createOverlayDrag({
  emit: (appId, event, data) => emitToApp(appId, event, data),
  running: (appId) => snapshot.running.some((running) => running.app.manifest.id === appId),
  holds: (appId, itemId) =>
    (snapshot.overlays.get(appId) ?? []).some(
      (item) => item.id === itemId && (item.kind === 'box' || item.kind === 'label' || item.kind === 'pin') && item.draggable,
    ),
  locate: (x, y) => canvasPointLocator?.(x, y) ?? Promise.resolve({ nodeId: undefined, at: undefined, x, y, layers: [] }),
  frame: (step) => {
    const handle = requestAnimationFrame(step);
    return () => cancelAnimationFrame(handle);
  },
});

/** An app's own bundle files, through the URL its frames load them from (an image cursor reads one). */
const bundleReader = bundleBytesReader(appFrameURL);

/** What the pickers ask through (src/ui/appOverrideSlot.ts); AppsHost installs it. */
export const appOverrideSlot: AppOverrideSlot = overrideSlotOf(overrides);

/** The role or the editor changed what apps may answer: indicators update. */
export function overridesChanged(): void {
  overrides.changed();
}

/** The host's commands and role, as of this render. */
export function configureAppsRuntime(host: AppHostCommands, role: () => RoleView): void {
  configured = { host, role };
  listen();
}

function publish(next: Snapshot): void {
  snapshot = next;
  // A request to an app that just stopped answers `default`; owners follow the running apps.
  overrides.changed();
  // An app that stopped releases the canvas it captured.
  canvasCapture.changed();
  // And the outline mode it set.
  outlineModeOwner.changed();
  // And a drag to insert it started.
  insertDrag.changed();
  // And its highlight.
  if (highlightOwner !== undefined && !next.running.some((running) => running.app.manifest.id === highlightOwner)) {
    clearAppHighlight();
  }
  // A drag whose app stopped, or whose item left the overlay, ends cancelled.
  overlayDrag.changed();
  for (const listener of [...listeners]) {
    listener();
  }
}

function subscribeStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAppsRuntime(): Snapshot {
  return useSyncExternalStore(subscribeStore, () => snapshot);
}

export function runningApps(): readonly RunningApp[] {
  return snapshot.running;
}

/**
 * Starts an app in `mode` (or keeps it running, in the mode it already has); its
 * window (AppWindows.tsx) then shows its frame. The caller resolves the mode:
 * the user's remembered choice, else the manifest's (appWindows.ts).
 */
export function launchApp(app: AppSummary, mode: AppWindowMode): AppWindowMode {
  // Another app opened: deep outlines belong to the app the person was using.
  outlineModeOwner.shown(app.manifest.id);
  const current = snapshot.running.find((running) => running.app.manifest.id === app.manifest.id);
  const others = snapshot.running.filter((running) => running.app.manifest.id !== app.manifest.id);
  const kept = others.length >= RUNNING_APPS_MAX ? others.slice(1) : others;
  const started: RunningApp = { app, mode: current?.mode ?? mode };
  // An app pushed out past the bound closes, its custom frames with it.
  const frames = snapshot.frames.filter((frame) => frame.appId === app.manifest.id || kept.some((running) => running.app.manifest.id === frame.appId));
  forgetOpeners(frames);
  publish({ ...snapshot, running: [...kept, started], frames });
  assert(snapshot.running.length <= RUNNING_APPS_MAX, 'Running apps are bounded');
  assert(snapshot.running.at(-1) === started, 'A launched app is the latest running app');
  // Opened again: the deep outlines it last asked for are its again.
  outlineModeOwner.restore(app.manifest.id);
  return started.mode;
}

/**
 * Docks or pops out a running app. Only the mode changes: the app keeps its frame,
 * so it keeps running with its state. A docked app moves last, so it is the one
 * the side panel shows. Returns false when the app is not running.
 */
export function setAppMode(appId: string, mode: AppWindowMode): boolean {
  const current = snapshot.running.find((running) => running.app.manifest.id === appId);
  if (current === undefined) {
    return false;
  }
  const others = snapshot.running.filter((running) => running !== current);
  if (mode === 'panel') {
    outlineModeOwner.shown(appId); // Brought to the panel: another app's deep outlines end.
  }
  const changed: RunningApp = { ...current, mode };
  const running = mode === 'panel' ? [...others, changed] : snapshot.running.map((entry) => (entry === current ? changed : entry));
  publish({ ...snapshot, running });
  assert(snapshot.running.length === others.length + 1, 'Changing a mode neither starts nor stops an app');
  outlineModeOwner.restore(appId); // Docked or popped out, it is the app in front.
  return true;
}

/**
 * A running app's folder settled (appFolderChanges.ts). `valid` swaps in the summary
 * the folder now reads as (a version bump, an edited manifest) and clears any error;
 * `broken` keeps the last good summary running and records why. Neither starts,
 * stops nor reorders an app, so its window, mode, size and panel all stay as they
 * are. Returns false when the app is not running.
 */
export function settleRunningApp(appId: string, folder: RunningAppFolder): boolean {
  const current = snapshot.running.find((running) => running.app.manifest.id === appId);
  if (current === undefined) {
    return false;
  }
  let settled: RunningApp;
  switch (folder.kind) {
    case 'valid':
      assert(folder.app.manifest.id === appId, 'A valid folder reads as the app that is running');
      settled = { app: folder.app, mode: current.mode };
      break;
    case 'broken':
      assert(folder.message.length > 0, 'A broken folder says why');
      settled = { ...current, folderError: folder.message };
      break;
    default: {
      const exhaustive: never = folder;
      return exhaustive;
    }
  }
  const running = snapshot.running.map((entry) => (entry === current ? settled : entry));
  publish({ ...snapshot, running });
  assert(snapshot.running.length === running.length, 'Settling a folder neither starts nor stops an app');
  return true;
}

/** Stops an app: its frames, custom frames included, unmount and its overlay is cleared. */
export function stopApp(appId: string): void {
  const overlays = new Map(snapshot.overlays);
  overlays.delete(appId);
  const frames = snapshot.frames.filter((frame) => frame.appId !== appId);
  forgetOpeners(frames);
  publish({ running: snapshot.running.filter((running) => running.app.manifest.id !== appId), overlays, frames });
  nodeRefTargets.want(anchoredRefs(overlays));
}

/**
 * How long after an app's edit answered the page change it made still counts as
 * its own: the editor renders and announces the change within a frame or two of
 * the save, so a second is generous, and a teammate's change a second later is
 * heard as theirs.
 */
const EDIT_ORIGIN_GRACE_MS = 1000;

/** The app whose page edit is running or just finished; one at a time, the latest. */
let editAuthor: { readonly appId: string; readonly finishedAtMs: number | undefined } | undefined;

const editOrigin: AppEditOriginTracker = {
  begin: (appId) => {
    const mark = { appId, finishedAtMs: undefined };
    editAuthor = mark;
    return () => {
      if (editAuthor === mark) {
        editAuthor = { appId, finishedAtMs: Date.now() };
      }
    };
  },
};

/**
 * The app whose edit made the page change announced now, or undefined for a
 * change from anywhere else. An edit still running is its app's; a finished one
 * is used once, within EDIT_ORIGIN_GRACE_MS.
 */
function takePageChangeAuthor(): string | undefined {
  const author = editAuthor;
  if (author === undefined) {
    return undefined;
  }
  if (author.finishedAtMs === undefined) {
    return author.appId;
  }
  editAuthor = undefined;
  const ageMs = Date.now() - author.finishedAtMs;
  assert(ageMs >= 0, 'An edit finished in the past');
  return ageMs <= EDIT_ORIGIN_GRACE_MS ? author.appId : undefined;
}

/**
 * Sends `project.change` to every subscribed frame: `self` to the app whose
 * edit made a page change, `other` to everyone else. `paths` past
 * APP_RPC_LIMITS.changePathsMax, or empty, is left out: many, or unknown.
 */
export function emitProjectChange(source: AppChangeSource, paths: readonly string[]): void {
  // An app's page edit and its file calls (appAccessRpc.ts) both mark their app as the author, so the page
  // or file change they make reaches it as its own.
  const author = source === 'page' || source === 'files' ? takePageChangeAuthor() : undefined;
  const named = paths.length > 0 && paths.length <= APP_RPC_LIMITS.changePathsMax ? { paths: [...new Set(paths)] } : {};
  if (configured === undefined) {
    return;
  }
  const role = configured.role();
  for (const [frame, session] of sessions) {
    const origin = session.app.manifest.id === author ? 'self' : 'other';
    const message = eventForSession(session, role, 'project.change', { source, ...named, origin });
    if (message !== undefined) {
      post(frame, message);
    }
  }
}

/** Stops every app: a project closed, or its apps changed under them. */
export function stopAllApps(): void {
  frameOpeners.clear();
  publish({ running: [], overlays: new Map(), frames: [] });
  for (const session of sessions.values()) {
    overrides.drop(session);
  }
  sessions.clear();
}

/** An app frame loaded: messages from its window are now this app's. Returns the detach. */
export function attachAppFrame(source: MessageEventSource, app: AppSummary, frame?: AppFrameInfo, overlayItem?: string): () => void {
  if (sessions.size >= FRAMES_MAX) {
    throw new Error('Too many app frames are open');
  }
  const session: AppSession = { app, subscriptions: new Set(), frame, overlayItem, ...inFlightCounter() };
  sessions.set(source, session);
  assert(sessions.size <= FRAMES_MAX, 'App frames are bounded');
  return () => {
    if (sessions.get(source) === session) {
      sessions.delete(source);
    }
    // A frame that goes mid-request (closed, crashed, unmounted) leaves Stacki's own picker to answer.
    overrides.drop(session);
  };
}

/**
 * An app frame loaded a document again (it navigated or reloaded): the old
 * document's registrations, focus and kept shortcuts went with it.
 */
export function appFrameReloaded(source: MessageEventSource): void {
  const session = sessions.get(source);
  if (session === undefined) {
    return;
  }
  overrides.drop(session);
  shortcutStates.delete(session);
}

/** Where a menu shortcut goes when focus is in an element: a Stacki command, a text field in an app, or the app itself. */
export type AppShortcutRoute = 'stacki' | 'native' | 'app';

/**
 * The route for a menu shortcut (canonical text, `Mod+Z`) while `active` has
 * focus. Desktop's Edit menu takes ⌘Z, ⇧⌘Z and ⌘E before a focused frame sees
 * them, so the menu asks here: a text field in the app undoes its own typing, an
 * app that claims the key (manifest or `shortcuts.claim`) hears `shortcut.press`,
 * and anything else is Stacki's. Synchronous: the claims are known before the key.
 */
export function appShortcutRoute(shortcut: string, active: Element | undefined): AppShortcutRoute {
  if (typeof HTMLIFrameElement === 'undefined' || !(active instanceof HTMLIFrameElement)) {
    return 'stacki';
  }
  const source = active.contentWindow ?? undefined;
  const session = source === undefined ? undefined : sessions.get(source);
  if (source === undefined || session === undefined) {
    return 'stacki'; // A canvas frame, or an app frame not yet attached: Stacki's, as before.
  }
  const state = shortcutStates.get(session);
  if (session.app.manifest.shortcutClaims.includes(shortcut) || state?.claims.has(shortcut) === true) {
    const message = configured === undefined ? undefined : eventForSession(session, configured.role(), 'shortcut.press', { shortcut });
    if (message !== undefined) {
      post(source, message);
    }
    return 'app';
  }
  if (state?.editableFocus === true) {
    return 'native';
  }
  return 'stacki';
}

/** Closes a custom frame; its opener hears `frame.close` with the result (undefined when the person closed it). */
export function closeCustomFrame(frameId: string, result: string | undefined): void {
  const frame = snapshot.frames.find((entry) => entry.id === frameId);
  if (frame === undefined) {
    return;
  }
  const opener = frameOpeners.get(frameId);
  frameOpeners.delete(frameId);
  publish({ ...snapshot, frames: snapshot.frames.filter((entry) => entry.id !== frameId) });
  const source = opener === undefined ? undefined : sourceOf(opener);
  if (source !== undefined) {
    post(source, eventMessage('frame.close', { frameId, result }));
  }
}

const customFrames: AppCustomFrames = {
  open: (session, frame) => {
    const appId = session.app.manifest.id;
    if (!snapshot.running.some((running) => running.app.manifest.id === appId)) {
      throw new Error('Only a running app opens frames');
    }
    if (snapshot.frames.filter((entry) => entry.appId === appId).length >= APP_RPC_LIMITS.customFramesMax) {
      throw new Error(`An app has at most ${APP_RPC_LIMITS.customFramesMax} frames open; close one first`);
    }
    assert(frameSerial < FRAME_SERIAL_MAX, 'Custom frame ids stay within nine digits');
    frameSerial += 1;
    const id = `frame-${frameSerial}`;
    frameOpeners.set(id, session);
    publish({ ...snapshot, frames: [...snapshot.frames, { ...frame, id, appId }] });
    assert(frameOpeners.size <= FRAMES_MAX, 'Custom frames are bounded by the frames a window holds');
    return { frameId: id };
  },
  close: (session, frameId, result): AppEditOutcome => {
    const id = frameId ?? session.frame?.id;
    if (id === undefined) {
      return { applied: false, reason: 'Name the frame to close: this is not a custom frame' };
    }
    const frame = snapshot.frames.find((entry) => entry.id === id);
    if (frame === undefined || frame.appId !== session.app.manifest.id) {
      return { applied: false, reason: 'This app has no open frame with that id' };
    }
    closeCustomFrame(id, result);
    return { applied: true };
  },
};

/**
 * `overlay.post`: an app's message goes to the overlay frame drawing the item it
 * names, a frame's to its app's other frames (its window and custom frames),
 * each as `overlay.message`. Only frames of the same app hear it, and only those
 * that listen; the answer says how many did, so an app can tell a frame that
 * has not loaded yet from one that heard.
 */
export const overlayMessages: AppOverlayMessenger = {
  post: (sender, message) => {
    const appId = sender.app.manifest.id;
    const fromOverlay = sender.overlayItem !== undefined;
    const itemId = sender.overlayItem ?? message.itemId;
    assert(itemId !== undefined, 'An overlay message names its frame item');
    if (configured === undefined) {
      return 0;
    }
    const role = configured.role();
    let reached = 0;
    for (const [source, session] of sessions) {
      const sameApp = session.app.manifest.id === appId;
      const addressed = fromOverlay ? session.overlayItem === undefined : session.overlayItem === itemId;
      if (sameApp && addressed && session !== sender) {
        const data = { itemId, data: message.data, from: fromOverlay ? ('overlay' as const) : ('app' as const) };
        const event = eventForSession(session, role, 'overlay.message', data);
        if (event !== undefined) {
          post(source, event);
          reached += 1;
        }
      }
    }
    assert(reached <= FRAMES_MAX, 'A message reaches at most every frame');
    return reached;
  },
};

/**
 * The interactive overlay item under the pointer, per app, sent as
 * `overlay.hover` at most once per animation frame: the last change in a frame
 * wins, and a change back to what the app last heard sends nothing.
 */
const hoverHeard = new Map<string, string | undefined>();
const hoverPending = new Map<string, string | undefined>();
let hoverFrame: number | undefined;

export function noteOverlayHover(appId: string, itemId: string | undefined): void {
  hoverPending.set(appId, itemId);
  assert(hoverPending.size <= RUNNING_APPS_MAX + FRAMES_MAX, 'Pending hovers are bounded by the apps that draw');
  if (hoverFrame !== undefined || typeof requestAnimationFrame === 'undefined') {
    return;
  }
  hoverFrame = requestAnimationFrame(() => {
    hoverFrame = undefined;
    flushOverlayHover();
  });
}

/** Sends the hovers noted since the last frame; the frame callback runs it, and tests call it directly. */
export function flushOverlayHover(): void {
  const pending = [...hoverPending];
  hoverPending.clear();
  for (const [appId, itemId] of pending) {
    if (hoverHeard.has(appId) && hoverHeard.get(appId) === itemId) {
      continue;
    }
    hoverHeard.set(appId, itemId);
    emitToApp(appId, 'overlay.hover', { itemId });
  }
  // Apps that stopped are forgotten, so the map holds running apps only.
  for (const appId of [...hoverHeard.keys()]) {
    if (!snapshot.running.some((running) => running.app.manifest.id === appId)) {
      hoverHeard.delete(appId);
    }
  }
}

/** Sends an event to every app frame that subscribed to it and may hear it. */
export function emitAppEvent<E extends AppEventName>(event: E, data: AppEventData[E]): void {
  if (configured === undefined) {
    return;
  }
  const role = configured.role();
  for (const [source, session] of sessions) {
    const message = eventForSession(session, role, event, data);
    if (message !== undefined) {
      post(source, message);
    }
  }
}

/** Sends `role.change` to every subscribed frame, each with its own app's permissions resolved for the current role. */
export function emitRoleChange(): void {
  if (configured === undefined) {
    return;
  }
  const role = configured.role();
  for (const [source, session] of sessions) {
    // Resolved only for frames that listen: the permissions are per app, so each costs its own resolution.
    if (!session.subscriptions.has('role.change')) {
      continue;
    }
    const message = eventForSession(session, role, 'role.change', appRoleView(role, session.app.manifest));
    if (message !== undefined) {
      post(source, message);
    }
  }
}

/** Sends an event to one app's frames only (an overlay click belongs to the app that drew it). Returns how many frames it reached. */
export function emitToApp<E extends AppEventName>(appId: string, event: E, data: AppEventData[E]): number {
  if (configured === undefined) {
    return 0;
  }
  const role = configured.role();
  let reached = 0;
  for (const [source, session] of sessions) {
    if (session.app.manifest.id === appId) {
      const message = eventForSession(session, role, event, data);
      if (message !== undefined) {
        post(source, message);
        reached += 1;
      }
    }
  }
  return reached;
}

const subscribedListeners = new Set<(appId: string) => void>();

/** Hears each answered request of an app's frame, so a queued event (a command run) can go once the frame subscribes. */
export function onAppSubscribed(listener: (appId: string) => void): () => void {
  subscribedListeners.add(listener);
  return () => {
    subscribedListeners.delete(listener);
  };
}

/** Hears every change of the running apps, overlays and frames. */
export function onAppsRuntimeChange(listener: () => void): () => void {
  return subscribeStore(listener);
}

function setOverlay(appId: string, items: readonly AppOverlayItem[] | undefined): void {
  const overlays = new Map(snapshot.overlays);
  if (items === undefined || items.length === 0) {
    overlays.delete(appId);
  } else {
    overlays.set(appId, items);
  }
  publish({ ...snapshot, overlays });
  nodeRefTargets.want(anchoredRefs(overlays));
}

// Every ref the overlays anchor to, for the targets store to keep resolved.
function anchoredRefs(overlays: ReadonlyMap<string, readonly AppOverlayItem[]>): readonly AppNodeRef[] {
  const refs: AppNodeRef[] = [];
  for (const items of overlays.values()) {
    for (const item of items) {
      if ('ref' in item.anchor) {
        refs.push(item.anchor.ref);
      }
    }
  }
  return refs;
}

function listen(): void {
  if (listening || typeof window === 'undefined') {
    return;
  }
  listening = true;
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    const source = event.source;
    if (source === null) {
      return;
    }
    const session = sessions.get(source);
    if (session === undefined || configured === undefined) {
      return; // Not an app frame: the canvas and other frames have their own listeners.
    }
    const context = {
      host: configured.host,
      role: configured.role,
      setOverlay,
      overrides,
      frames: customFrames,
      shortcuts,
      commands: commandRegistry,
      badges: appBadges,
      editOrigin,
      capture: canvasCapture,
      measure: overlayMeasure,
      readBundle: bundleReader,
      tellCanvas,
      overlayMessages,
      openDetails: (appId: string) => requestAppDetails(appId, 'settings'),
      writeClipboard: (text: string) => navigator.clipboard.writeText(text),
      nodeRefs: appNodeRefHost(),
      outlineMode: outlineModeOwner,
      insertDrag,
      highlight: appHighlights,
      frameOrigin: () => frameOriginOf(source),
    };
    void answerAppMessage(session, event.data, context).then((answer) => {
      if (answer !== undefined) {
        post(source, answer);
      }
      if (session.subscriptions.has('command.run')) {
        for (const listener of [...subscribedListeners]) {
          listener(session.app.manifest.id);
        }
      }
    });
  });
}

// Where an app frame sits in the editor window: the iframe whose window sent the message.
function frameOriginOf(source: MessageEventSource): { readonly left: number; readonly top: number } | undefined {
  for (const element of Array.from(document.querySelectorAll('iframe')).slice(0, FRAMES_MAX * 2)) {
    if (element.contentWindow === source) {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top };
    }
  }
  return undefined;
}

function sourceOf(session: AppSession): MessageEventSource | undefined {
  for (const [source, candidate] of sessions) {
    if (candidate === session) {
      return source;
    }
  }
  return undefined;
}

function forgetOpeners(kept: readonly CustomFrame[]): void {
  for (const id of [...frameOpeners.keys()]) {
    if (!kept.some((frame) => frame.id === id)) {
      frameOpeners.delete(id);
    }
  }
}

function post(source: MessageEventSource, message: AppHostMessage): void {
  // An app frame's origin is opaque ("null"), so '*' is the only target that
  // reaches it; the message goes to that one window, never broadcast.
  if ('postMessage' in source && typeof source.postMessage === 'function') {
    try {
      source.postMessage(message, { targetOrigin: '*' });
    } catch {
      // The frame went away between the request and the answer.
    }
  }
}

/** The app whose frame `source` is, when it is one: the outline mode follows the app the person is in. */
export function appIdOfFrame(source: MessageEventSource): string | undefined {
  return sessions.get(source)?.app.manifest.id;
}

/** For tests: subscribes an attached frame to an event, as its SDK's `events.subscribe` would. */
export function subscribeAppFrameForTests(source: MessageEventSource, event: AppEventName): void {
  const session = sessions.get(source);
  assert(session !== undefined, 'Only an attached frame subscribes');
  session.subscriptions.add(event);
}

/** For tests: forget every frame and app. */
export function resetAppsRuntime(): void {
  editAuthor = undefined;
  hoverHeard.clear();
  hoverPending.clear();
  for (const session of sessions.values()) {
    overrides.drop(session);
  }
  sessions.clear();
  frameOpeners.clear();
  configured = undefined;
  publish({ running: [], overlays: new Map(), frames: [] });
}
