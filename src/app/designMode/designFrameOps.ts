// Design mode (experimental, removable: docs/design-mode/REMOVE.md): what the canvas's gestures do.
//
// A frame operation shows on the canvas at once and is then carried out by main, one at a time in the order made.
// Selecting something in a frame shows that frame in the site's copy first (main rewrites the files the two frames
// differ in); the real panels get the selection once the editor has read the shown frame's page, so they never edit
// one frame while another is selected.
import type { ShellView } from '../App';
import { selectCanvasPath } from '../shell/AppPanes';
import {
  DESIGN_SESSION_LIMITS,
  nextDesignFrameId,
  type DesignFrameId,
  type DesignFrameView,
  type DesignPlace,
  type DesignSessionReply,
  type DesignSessionRequest,
  type DesignSessionState,
} from '../../../shared/ipc/designSession';
import { cleanError } from '../../lib/cleanError';
import { inlineStyleWrite } from '../../features/style/model/inlineTarget';
import type { DesignNodeAt } from '../../../shared/ipc/designSnapshot';
import type { StyleChange } from './designElementDrag';
import { designSession } from './designBridge';
import { dropCapture, flushCaptures, noteCanvasChange } from './designCaptureQueue';
import { designView, updateDesignView, type DesignSelection } from './designStore';
import type { DesignWords } from './i18n/designWords';

export interface DesignOpsContext {
  /** The editor as it is now: read again after every wait. */
  readonly app: () => ShellView;
  readonly words: () => DesignWords;
}

export type OnSession = Extract<DesignSessionState, { kind: 'on' }>;

const READ_WAIT_MS_MAX = 8_000;
const READ_POLL_MS = 20;
/** How long after a change the canvas may still be drawing it, when a frame is about to be left. */
const SETTLE_MS = 400;

let queue: Promise<unknown> = Promise.resolve();
/** Operations asked and not yet carried out. */
let waiting = 0;

/** Runs `work` after everything asked before it; a failure is told and leaves the queue running. */
function enqueue(context: DesignOpsContext, work: () => Promise<void>): Promise<void> {
  waiting += 1;
  const run = queue
    .then(work)
    .catch(async (error: unknown) => {
      context.app().showToast(context.words()('toast.failed', { detail: cleanError(error) }), 'error');
      // What the canvas showed ahead of main may be wrong: main's answer replaces it.
      updateDesignView((view) => ({ ...view, switching: undefined }));
      installState(await designSession({ op: 'state' }));
    })
    .finally(() => {
      waiting -= 1;
    });
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Records what main answered. While later operations wait, the canvas already shows what they will make: the answer
 * to an earlier one must not undo that (a frame just removed would come back), so it only says which frame is shown.
 */
export function installState(reply: DesignSessionReply): void {
  if (reply.kind !== 'state' && reply.kind !== 'shown') {
    return;
  }
  updateDesignView((view) => ({ ...view, session: mergedState(view.session, reply.state, waiting > 1 ? 'ahead' : 'current') }));
}

function mergedState(shownNow: DesignSessionState, answered: DesignSessionState, canvas: 'ahead' | 'current'): DesignSessionState {
  if (canvas === 'current' || shownNow.kind !== 'on' || answered.kind !== 'on') {
    return answered;
  }
  const frames = shownNow.frames.map((frame) => {
    const known = answered.frames.find((entry) => entry.id === frame.id);
    return known === undefined ? frame : { ...frame, changedFiles: known.changedFiles };
  });
  return { ...answered, frames };
}

/** Changes the frames the canvas shows, ahead of main. */
function editFrames(change: (frames: readonly DesignFrameView[]) => readonly DesignFrameView[]): void {
  updateDesignView((view) => (view.session.kind === 'on' ? { ...view, session: { ...view.session, frames: change(view.session.frames) } } : view));
}

function onSession(): OnSession | undefined {
  const session = designView().session;
  return session.kind === 'on' ? session : undefined;
}

function openPagePath(context: DesignOpsContext): string | undefined {
  const page = context.app().currentPage;
  return page === undefined || page.kind === 'route' ? undefined : page.path;
}

/** Waits until the editor has read the page as the shown frame holds it. */
async function pageRead(context: DesignOpsContext, source: string | undefined): Promise<void> {
  if (source === undefined) {
    return;
  }
  const deadline = performance.now() + READ_WAIT_MS_MAX;
  while (context.app().pageState?.source !== source) {
    // Going on would let the panels edit the page of the frame that was left.
    if (performance.now() >= deadline) {
      throw new Error(context.words()('toast.frameUnread'));
    }
    await new Promise((resolve) => window.setTimeout(resolve, READ_POLL_MS));
  }
}

/** Shows frame `frame` in the site's copy. */
async function activate(context: DesignOpsContext, frame: DesignFrameId): Promise<void> {
  const session = onSession();
  if (session === undefined || session.active === frame || !session.frames.some((entry) => entry.id === frame)) {
    return;
  }
  // What the panels still hold is saved into the frame being left, and pictured, before the copy changes.
  await context.app().flushSave();
  await flushCaptures(SETTLE_MS);
  updateDesignView((view) => ({ ...view, switching: frame }));
  context.app().setSelectedId(undefined);
  const reply = await designSession({ op: 'frame-switch', frame, page: openPagePath(context) });
  if (reply.kind !== 'shown') {
    throw new Error('Design mode: main did not show the frame');
  }
  installState(reply);
  await pageRead(context, reply.pageSource);
  updateDesignView((view) => ({ ...view, switching: undefined }));
}

/** Gives the real panels the element picked on the canvas, if it is still the pick and its frame is shown. */
function applyElement(context: DesignOpsContext, selection: Extract<DesignSelection, { kind: 'element' }>): void {
  const view = designView();
  const session = onSession();
  if (session === undefined || view.selection !== selection || session.active !== selection.frame) {
    return;
  }
  selectCanvasPath(context.app(), selection.path, { outside: false, occurrence: selection.copy });
}

export function selectElement(context: DesignOpsContext, frame: DesignFrameId, path: string, copy: number): void {
  const selection = { kind: 'element', frame, path, copy } as const;
  updateDesignView((view) => ({ ...view, selection }));
  const session = onSession();
  if (session?.active === frame && designView().switching === undefined) {
    applyElement(context, selection);
    return;
  }
  void enqueue(context, async () => {
    await activate(context, frame);
    // The editor re-renders with the page it has just read before the path is looked up in it.
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    applyElement(context, selection);
  });
}

export function selectFrame(context: DesignOpsContext, frame: DesignFrameId): void {
  updateDesignView((view) => ({ ...view, selection: { kind: 'frame', frame } }));
  context.app().setSelectedId(undefined);
  void enqueue(context, () => activate(context, frame));
}

export function clearSelection(context: DesignOpsContext): void {
  updateDesignView((view) => ({ ...view, selection: { kind: 'none' } }));
  context.app().setSelectedId(undefined);
}

/** How long the panels may take to take up a pick whose frame is already shown. */
const PICK_WAIT_MS_MAX = 3_000;

/**
 * Writes a drag's change as the picked element's inline style, in its frame's version of the page: the frame is
 * shown first when it is not, and the write is the editor's own, so undo takes it back. `refused` is called when
 * nothing could be written, so the canvas puts the frame back as it was.
 */
export function writeElementStyle(context: DesignOpsContext, frame: DesignFrameId, node: DesignNodeAt, change: StyleChange, refused: () => void): void {
  const selected = designView().selection;
  if (selected.kind !== 'element' || selected.frame !== frame || selected.path !== node.path) {
    selectElement(context, frame, node.path, node.copy);
  }
  void enqueue(context, async () => {
    const deadline = performance.now() + PICK_WAIT_MS_MAX;
    while (context.app().pathFor(context.app().selectedId) !== node.path) {
      if (performance.now() >= deadline) {
        refused();
        throw new Error(context.words()('toast.frameUnread'));
      }
      await new Promise((resolve) => window.setTimeout(resolve, READ_POLL_MS));
    }
    const app = context.app();
    const target = app.selectedNode;
    if (target === undefined || (target.kind !== 'element' && target.kind !== 'component')) {
      refused();
      app.showToast(context.words()('toast.styleIsCode'), 'warning');
      return;
    }
    const next = styleAfter(target.props?.['style'], change);
    if (next === undefined) {
      refused();
      app.showToast(context.words()('toast.styleIsCode'), 'warning');
      return;
    }
    app.setProp(target.id, 'style', { type: 'string', value: next }, true, app.pathFor(target.id));
  });
}

/** The style attribute's next text, or undefined when it is code or cannot be edited a declaration at a time. */
function styleAfter(attribute: { readonly type: string; readonly value?: string } | undefined, change: StyleChange): string | undefined {
  if (attribute !== undefined && attribute.type !== 'string') {
    return undefined;
  }
  let text = attribute?.value ?? '';
  for (const [property, value] of change) {
    const written = inlineStyleWrite(text, [property], { tag: 'set', value });
    if (written.tag !== 'write' || written.next === undefined) {
      return undefined;
    }
    text = written.next;
  }
  return text;
}

/** The id the next duplicate gets, which the canvas uses for it before main answers. */
export function nextFrameId(session: OnSession): DesignFrameId {
  return nextDesignFrameId(session.frames);
}

/** The place right of the rightmost frame. */
export function placeBeside(session: OnSession, source: DesignFrameId, widthPx: number): DesignPlace {
  const at = session.frames.find((frame) => frame.id === source)?.at ?? { x: 0, y: 0 };
  const right = session.frames.reduce((max, frame) => Math.max(max, frame.at.x), at.x);
  return { x: Math.round(right + widthPx + DESIGN_FRAME_GAP_PX), y: at.y };
}

export const DESIGN_FRAME_GAP_PX = 80;

export function clampPlace(at: DesignPlace): DesignPlace {
  const clamp = (value: number): number => Math.max(-DESIGN_SESSION_LIMITS.placePxMax, Math.min(DESIGN_SESSION_LIMITS.placePxMax, Math.round(value)));
  return { x: clamp(at.x), y: clamp(at.y) };
}

/** Whether another frame may be made; says why not. */
export function mayDuplicate(context: DesignOpsContext): boolean {
  const session = onSession();
  if (session === undefined) {
    return false;
  }
  if (session.frames.length >= DESIGN_SESSION_LIMITS.framesMax) {
    context.app().showToast(context.words()('toast.frameLimit', { count: DESIGN_SESSION_LIMITS.framesMax }), 'warning');
    return false;
  }
  return true;
}

/** A copy of `source` at `at`: on the canvas at once, then selected. */
export function duplicateFrame(context: DesignOpsContext, source: DesignFrameId, at: DesignPlace): void {
  const session = onSession();
  const original = session?.frames.find((frame) => frame.id === source);
  if (session === undefined || original === undefined || !mayDuplicate(context)) {
    return;
  }
  const id = nextFrameId(session);
  const name = context.words()('frame.copy', { name: original.name }).slice(0, DESIGN_SESSION_LIMITS.frameNameCharsMax);
  const place = clampPlace(at);
  const picture = designView().snapshots.get(source);
  updateDesignView((view) => ({
    ...view,
    snapshots: picture === undefined ? view.snapshots : new Map(view.snapshots).set(id, picture),
    selection: { kind: 'frame', frame: id },
  }));
  editFrames((frames) => [...frames, { id, name, at: place, changedFiles: original.changedFiles }]);
  context.app().setSelectedId(undefined);
  void enqueue(context, async () => {
    // The source's last edit goes into the copy.
    await context.app().flushSave();
    await flushCaptures(SETTLE_MS);
    installState(await designSession({ op: 'frame-duplicate', source, name, at: place }));
    await activate(context, id);
  });
}

export function removeFrame(context: DesignOpsContext, frame: DesignFrameId): void {
  const session = onSession();
  if (session === undefined || !session.frames.some((entry) => entry.id === frame)) {
    return;
  }
  if (session.frames.length <= 1) {
    context.app().showToast(context.words()('toast.lastFrame'), 'info');
    return;
  }
  context.app().setSelectedId(undefined);
  updateDesignView((view) => {
    const snapshots = new Map(view.snapshots);
    snapshots.delete(frame);
    return { ...view, snapshots, selection: { kind: 'none' } };
  });
  editFrames((frames) => frames.filter((entry) => entry.id !== frame));
  void enqueue(context, async () => {
    await context.app().flushSave();
    dropCapture(frame);
    await flushCaptures(SETTLE_MS);
    // Main shows another frame first when this one is shown: until that is read, nothing is pictured.
    const held = onSession();
    const shown = held !== undefined && held.active === frame;
    if (shown) {
      updateDesignView((view) => ({ ...view, switching: frame }));
    }
    const reply: DesignSessionReply = await designSession({ op: 'frame-delete', frame, page: openPagePath(context) });
    if (reply.kind !== 'shown') {
      throw new Error('Design mode: main did not remove the frame');
    }
    installState(reply);
    if (shown) {
      await pageRead(context, reply.pageSource);
      updateDesignView((view) => ({ ...view, switching: undefined }));
    }
  });
}

function send(context: DesignOpsContext, request: DesignSessionRequest): void {
  void enqueue(context, async () => {
    installState(await designSession(request));
  });
}

export function moveFrame(context: DesignOpsContext, frame: DesignFrameId, at: DesignPlace): void {
  const place = clampPlace(at);
  editFrames((frames) => frames.map((entry) => (entry.id === frame ? { ...entry, at: place } : entry)));
  send(context, { op: 'frame-move', frame, at: place });
}

export function renameFrame(context: DesignOpsContext, frame: DesignFrameId, name: string): void {
  editFrames((frames) => frames.map((entry) => (entry.id === frame ? { ...entry, name } : entry)));
  send(context, { op: 'frame-rename', frame, name });
}

export function startOver(context: DesignOpsContext): void {
  clearSelection(context);
  void enqueue(context, async () => {
    await context.app().flushSave();
    await flushCaptures(SETTLE_MS);
    updateDesignView((view) => ({ ...view, switching: 'f1' }));
    const reply = await designSession({ op: 'start-over', frameName: context.words()('frame.original'), page: openPagePath(context) });
    if (reply.kind !== 'shown') {
      throw new Error('Design mode: main did not start over');
    }
    installState(reply);
    await pageRead(context, reply.pageSource);
    updateDesignView((view) => ({ ...view, switching: undefined, snapshots: new Map(), camera: undefined }));
    noteCanvasChange();
  });
}

/** Resolves once every operation asked so far has run. */
export function framesSettled(): Promise<unknown> {
  return queue;
}
