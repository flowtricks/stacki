// Design mode (experimental, removable: docs/design-mode/REMOVE.md): what each control does.
//
// Entering copies the project in main and opens the copy through the app's own project switch
// (`leaveProject`, which saves what is pending first and reloads the window); leaving opens the project again the
// same way. Both reloads clear undo history, which the person is told in a toast after each one. Everything
// between works on the copy: what the canvas does is in designFrameOps.ts.
import type { ShellView } from '../App';
import {
  DESIGN_SESSION_LIMITS,
  defaultFramePlace,
  type DesignEnterRefusal,
  type DesignFrameId,
  type DesignFrameView,
  type DesignSessionState,
} from '../../../shared/ipc/designSession';
import { cleanError } from '../../lib/cleanError';
import { holdWindow } from '../../ui/busyLock';
import { designSession } from './designBridge';
import { pictureFrame } from './designCapture';
import { flushCaptures } from './designCaptureQueue';
import { framesSettled } from './designFrameOps';
import { livePagePath, requestSnapshot } from './designLiveCanvas';
import { currentReturn, noteReturn } from './designReturn';
import { handoffText } from './designHandoff';
import { clearDesignRole } from './designRole';
import { designView, framePicture, updateDesignView } from './designStore';
import type { DesignWordKey } from './i18n/en';
import type { DesignWords } from './i18n/designWords';

/** How long after a change the canvas may still be drawing it when the mode is left. */
const LEAVE_SETTLE_MS = 400;

export type DesignHostSource = Pick<
  ShellView,
  'project' | 'currentPage' | 'editStack' | 'pageUrlPath' | 'device' | 'scan' | 'selectPage' | 'leaveProject' | 'flushSave' | 'showToast' | 'setLeftTab'
>;

/** What the window says after its next reload; kept in the window's session storage, which a reload keeps. */
export const DESIGN_NOTICE_KEY = 'stacki-design-mode-notice';
export type DesignNotice = 'entered' | 'left' | 'sent';

export function noteForReload(notice: DesignNotice): void {
  try {
    sessionStorage.setItem(DESIGN_NOTICE_KEY, notice);
  } catch {
    // Without storage the toast is skipped; the bar itself still says Design mode is on.
  }
}

const REFUSAL_WORDS: Readonly<Record<DesignEnterRefusal, DesignWordKey>> = {
  'not-open': 'toast.notOpen',
  'too-large': 'toast.tooLarge',
  'outside-link': 'toast.outsideLink',
  'copy-failed': 'toast.copyFailed',
  busy: 'toast.busy',
  cancelled: 'toast.cancelled',
};

const opening: { cancel: 'none' | 'asked' } = { cancel: 'none' };

/** Read through a call: the answer changes while the opening canvas is drawn. */
function cancelAsked(): boolean {
  return opening.cancel === 'asked';
}

export async function enterDesignMode(app: DesignHostSource, words: DesignWords, latestApp: () => DesignHostSource): Promise<void> {
  // A component opened from a page enters on that page.
  const place = currentReturn(app);
  if (place === undefined) {
    app.showToast(words('toast.notOpen'), 'warning');
    return;
  }
  if (designView().phase !== 'idle') {
    return;
  }
  // The canvas is up on the click itself; what it shows is filled in as it is read.
  opening.cancel = 'none';
  showOpening([{ id: 'f1', name: words('frame.original'), at: defaultFramePlace(0), changedFiles: 0 }]);
  const release = holdWindow();
  try {
    // What the editor still holds is saved first, so the copy is the project as the person sees it.
    await app.flushSave();
    // The frames kept from last time, or else the page as the editor shows it now.
    await drawOpening(app.project.path);
    // Cancelled before main had a copy to stop.
    if (cancelAsked()) {
      app.showToast(words('toast.cancelled'), 'info');
      closeOpening();
      return;
    }
    const reply = await designSession({
      op: 'enter',
      projectPath: app.project.path,
      page: place.file,
      refusal: words('fence.refusal'),
      frameName: words('frame.original'),
      // The opening picture is of the preview as it stood, its entrances perhaps unplayed: a new first frame waits
      // for the copy's own, taken once its page has been walked.
      snapshot: undefined,
    });
    if (reply.kind === 'refused') {
      const named = reply.reason === 'too-large' && reply.folder !== undefined;
      app.showToast(
        named ? words('toast.tooLargeFolder', { folder: reply.folder ?? '' }) : words(REFUSAL_WORDS[reply.reason]),
        reply.reason === 'cancelled' ? 'info' : 'warning',
      );
      closeOpening();
      return;
    }
    if (reply.kind !== 'entered') {
      throw new Error('Design mode: main did not begin a session');
    }
    noteForReload('entered');
    noteReturn(currentReturn(latestApp()) ?? place);
    release();
    await app.leaveProject(reply.liveRoot);
  } catch (error: unknown) {
    app.showToast(words('toast.failed', { detail: cleanError(error) }), 'error');
    closeOpening();
  } finally {
    release();
  }
}

function showOpening(frames: readonly DesignFrameView[]): void {
  const pagePath = livePagePath();
  updateDesignView((view) => ({ ...view, phase: 'entering', opening: { frames }, snapshots: new Map(), pagePath, camera: undefined }));
}

function closeOpening(): void {
  updateDesignView((view) => ({ ...view, phase: 'idle', opening: undefined, snapshots: new Map(), camera: undefined }));
}

/**
 * Draws the opening canvas: the kept frames when there are some, else the first frame from the live canvas, which
 * is the person's own preview and so is not walked.
 */
async function drawOpening(projectPath: string): Promise<void> {
  const [kept, live] = await Promise.all([designSession({ op: 'preview', projectPath }), requestSnapshot('held')]);
  const snapshot = live.ok ? live.snapshot : undefined;
  if (kept.kind === 'preview' && kept.frames.length > 0) {
    const snapshots = new Map(kept.snapshots.map((entry) => [entry.frame, entry.snapshot] as const));
    updateDesignView((view) => ({ ...view, opening: { frames: kept.frames }, snapshots, camera: undefined }));
  } else if (snapshot !== undefined) {
    updateDesignView((view) => ({ ...view, snapshots: new Map([['f1', snapshot]]), camera: undefined }));
  }
}

/** Stops a copy under way (the Modes menu row chosen again while it runs). */
export async function cancelDesignMode(): Promise<void> {
  if (designView().phase === 'entering') {
    opening.cancel = 'asked';
    await designSession({ op: 'cancel' });
  }
}

/**
 * Leaves the copy for the project. With `send`, one frame's picture goes to the AI panel's message box first: the
 * frame `asked`, else the one picked on the canvas. A frame with no picture of the open page yet is shown first.
 */
export async function exitDesignMode(app: DesignHostSource, words: DesignWords, send: 'send' | 'keep', asked?: DesignFrameId): Promise<void> {
  const session = designView().session;
  if (session.kind !== 'on' || designView().phase === 'leaving') {
    return;
  }
  try {
    // What the panels still hold, and the shown frame's last picture, are kept before the copy goes.
    await framesSettled();
    await app.flushSave();
    await flushCaptures(LEAVE_SETTLE_MS);
    const current = designView().session;
    const held = current.kind === 'on' ? current : session;
    const chosen = send === 'send' ? chosenFrame(held, asked) : undefined;
    if (chosen !== undefined && framePicture(designView(), held.frames, chosen) === undefined) {
      throw new Error(words('toast.noPicture'));
    }
    updateDesignView((view) => ({ ...view, phase: 'leaving' }));
    const handoff = chosen === undefined ? undefined : await composeHandoff(app, chosen, words);
    const reply = await designSession({ op: 'exit', handoff });
    if (reply.kind !== 'left') {
      throw new Error('Design mode: main did not end the session');
    }
    noteForReload(send === 'send' ? 'sent' : 'left');
    // Back to the page open now, which may not be the one the mode began on.
    noteReturn(currentReturn(app));
    clearDesignRole();
    await app.leaveProject(reply.realRoot);
  } catch (error: unknown) {
    app.showToast(words('toast.failed', { detail: cleanError(error) }), 'error');
    updateDesignView((view) => ({ ...view, phase: 'working' }));
  }
}

/** The chosen frame, shown with a picture of the open page, then pictured whole. */
async function composeHandoff(app: DesignHostSource, chosen: DesignFrameView, words: DesignWords) {
  const pictures = await pictureFrame(app.project.path, chosen);
  if (pictures === undefined) {
    throw new Error(words('toast.noPicture'));
  }
  return {
    text: handoffText(app.pageUrlPath ?? '/', pictures.length, words),
    images: [...pictures],
    names: pictures.map((_, index) =>
      pictures.length === 1 ? chosen.name : `${chosen.name} ${String(index + 1)}`.slice(0, DESIGN_SESSION_LIMITS.frameNameCharsMax),
    ),
  };
}

/** The frame Send to AI sends: the one asked for, else the one picked on the canvas, else the one shown. */
function chosenFrame(session: Extract<DesignSessionState, { kind: 'on' }>, asked: DesignFrameId | undefined): DesignFrameView {
  const selection = designView().selection;
  const wanted = asked ?? (selection.kind === 'none' ? session.active : selection.frame);
  const frame = session.frames.find((entry) => entry.id === wanted) ?? session.frames.find((entry) => entry.id === session.active);
  if (frame === undefined) {
    throw new Error('Assertion failed: chosenFrame: the shown frame is one of the frames');
  }
  return frame;
}
