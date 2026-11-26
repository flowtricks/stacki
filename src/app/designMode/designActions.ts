// Design mode (experimental, removable: docs/design-mode/REMOVE.md): what each control does.
//
// Entering copies the project in main and opens the copy through the app's own project switch
// (`leaveProject`, which saves what is pending first and reloads the window); leaving opens the project again the
// same way. Both reloads clear undo history, which the person is told in a toast after each one. Everything
// between works on the copy: what the canvas does is in designFrameOps.ts.
import type { ShellView } from '../App';
import type { DesignEnterRefusal, DesignSessionState } from '../../../shared/ipc/designSession';
import type { DesignSnapshot } from '../../../shared/ipc/designSnapshot';
import { cleanError } from '../../lib/cleanError';
import { holdWindow } from '../../ui/busyLock';
import { designSession } from './designBridge';
import { pictureFrames } from './designCapture';
import { flushCaptures } from './designCaptureQueue';
import { framesSettled } from './designFrameOps';
import { requestSnapshot } from './designLiveCanvas';
import { handoffText } from './designHandoff';
import { clearDesignRole } from './designRole';
import { designView, updateDesignView } from './designStore';
import type { DesignWordKey } from './i18n/en';
import type { DesignWords } from './i18n/designWords';

/** How long after a change the canvas may still be drawing it when the mode is left. */
const LEAVE_SETTLE_MS = 400;

export type DesignHostSource = Pick<ShellView, 'project' | 'currentPage' | 'scan' | 'selectPage' | 'leaveProject' | 'flushSave' | 'showToast' | 'setLeftTab'>;

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

export async function enterDesignMode(app: DesignHostSource, words: DesignWords): Promise<void> {
  const page = app.currentPage;
  if (page === undefined || page.kind !== 'page' || page.path.includes('/.stacki/')) {
    app.showToast(words('toast.notOpen'), 'warning');
    return;
  }
  if (designView().phase !== 'idle') {
    return;
  }
  updateDesignView((view) => ({ ...view, phase: 'entering' }));
  const release = holdWindow();
  try {
    // What the editor still holds is saved first, so the copy is the project as the person sees it.
    await app.flushSave();
    app.showToast(words('toast.copying'), 'info');
    // The canvas as it is now, so the first frame is drawn before the copy's dev server is up.
    const snapshot = await seedSnapshot();
    const reply = await designSession({
      op: 'enter',
      projectPath: app.project.path,
      page: page.name,
      refusal: words('fence.refusal'),
      frameName: words('frame.original'),
      snapshot,
    });
    if (reply.kind === 'refused') {
      const named = reply.reason === 'too-large' && reply.folder !== undefined;
      app.showToast(
        named ? words('toast.tooLargeFolder', { folder: reply.folder ?? '' }) : words(REFUSAL_WORDS[reply.reason]),
        reply.reason === 'cancelled' ? 'info' : 'warning',
      );
      updateDesignView((view) => ({ ...view, phase: 'idle' }));
      return;
    }
    if (reply.kind !== 'entered') {
      throw new Error('Design mode: main did not begin a session');
    }
    noteForReload('entered');
    release();
    await app.leaveProject(reply.liveRoot);
  } catch (error: unknown) {
    app.showToast(words('toast.failed', { detail: cleanError(error) }), 'error');
    updateDesignView((view) => ({ ...view, phase: 'idle' }));
  } finally {
    release();
  }
}

async function seedSnapshot(): Promise<DesignSnapshot | undefined> {
  const result = await requestSnapshot();
  return result.ok ? result.snapshot : undefined;
}

/** Stops a copy under way (the Modes menu row chosen again while it runs). */
export async function cancelDesignMode(): Promise<void> {
  if (designView().phase === 'entering') {
    await designSession({ op: 'cancel' });
  }
}

/** Leaves the copy for the project. With `send`, every frame's picture and changes go to the AI panel first. */
export async function exitDesignMode(app: DesignHostSource, words: DesignWords, send: 'send' | 'keep'): Promise<void> {
  const session = designView().session;
  if (session.kind !== 'on' || designView().phase === 'leaving') {
    return;
  }
  try {
    // What the panels still hold, and the shown frame's last picture, are kept before the copy goes.
    await framesSettled();
    await app.flushSave();
    await flushCaptures(LEAVE_SETTLE_MS);
    updateDesignView((view) => ({ ...view, phase: 'leaving' }));
    const handoff = send === 'send' ? await composeHandoff(app, session, words) : undefined;
    const reply = await designSession({ op: 'exit', handoff });
    if (reply.kind !== 'left') {
      throw new Error('Design mode: main did not end the session');
    }
    noteForReload(send === 'send' ? 'sent' : 'left');
    clearDesignRole();
    await app.leaveProject(reply.realRoot);
  } catch (error: unknown) {
    app.showToast(words('toast.failed', { detail: cleanError(error) }), 'error');
    updateDesignView((view) => ({ ...view, phase: 'working' }));
  }
}

async function composeHandoff(app: DesignHostSource, session: Extract<DesignSessionState, { kind: 'on' }>, words: DesignWords) {
  const pictures = await pictureFrames(app.project.path, session);
  const changes = await designSession({ op: 'changes' });
  if (changes.kind !== 'changes') {
    throw new Error('Design mode: main did not describe the frames');
  }
  const active = session.frames.find((frame) => frame.id === session.active)?.name ?? '';
  return {
    text: handoffText(changes.frames, active, words),
    images: pictures.map((picture) => picture.image),
    names: pictures.map((picture) => picture.name),
  };
}
