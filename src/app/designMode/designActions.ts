// Design mode (experimental, removable: docs/design-mode/REMOVE.md): what each control does.
//
// Entering copies the project in main and opens the copy through the app's own project switch
// (`leaveProject`, which saves what is pending first and reloads the window); leaving opens the project again the
// same way. Both reloads clear undo history, which the person is told in a toast after each one. Everything
// between works on the copy: the frame operations ask main to swap the copy's files, and the editor picks the
// change up as it does any edit made outside the app.
import type { ShellView } from '../App';
import type { DesignEnterRefusal, DesignFrameId, DesignSessionReply, DesignSessionState } from '../../../shared/ipc/designSession';
import { cleanError } from '../../lib/cleanError';
import { holdWindow } from '../../ui/busyLock';
import { designSession } from './designBridge';
import { captureCanvas } from './designCapture';
import { handoffText } from './designHandoff';
import { clearDesignRole } from './designRole';
import { designView, updateDesignView } from './designStore';
import type { DesignWordKey } from './i18n/en';
import type { DesignWords } from './i18n/designWords';

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
    const reply = await designSession({
      op: 'enter',
      projectPath: app.project.path,
      page: page.name,
      refusal: words('fence.refusal'),
      frameName: words('frame.original'),
    });
    if (reply.kind === 'refused') {
      app.showToast(words(REFUSAL_WORDS[reply.reason]), 'warning');
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

/** Leaves the copy for the project. With `send`, every frame's picture and changes go to the AI panel first. */
export async function exitDesignMode(app: DesignHostSource, words: DesignWords, send: 'send' | 'keep'): Promise<void> {
  const session = designView().session;
  if (session.kind !== 'on' || designView().phase === 'leaving') {
    return;
  }
  updateDesignView((view) => ({ ...view, phase: 'leaving', board: 'closed' }));
  try {
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
  await pictureActive(app, session);
  const changes = await designSession({ op: 'changes' });
  if (changes.kind !== 'changes') {
    throw new Error('Design mode: main did not describe the frames');
  }
  const images = designView().images;
  const pictured = session.frames.filter((frame) => images.has(frame.id));
  const active = session.frames.find((frame) => frame.id === session.active)?.name ?? '';
  return {
    text: handoffText(changes.frames, active, words),
    images: pictured.flatMap((frame) => images.get(frame.id) ?? []),
    names: pictured.map((frame) => frame.name),
  };
}

/** Takes the shown frame's picture, for the board and the AI. A canvas that cannot be captured keeps the last one. */
export async function pictureActive(app: Pick<DesignHostSource, 'project'>, session: Extract<DesignSessionState, { kind: 'on' }>): Promise<void> {
  const image = await captureCanvas(app.project.path);
  if (image === undefined) {
    return;
  }
  installReply(await designSession({ op: 'frame-image', frame: session.active, image }));
}

/** Records what main answered: the session's state, or the frames' pictures. */
export function installReply(reply: DesignSessionReply): void {
  if (reply.kind === 'state') {
    updateDesignView((view) => ({ ...view, session: reply.state, board: reply.state.kind === 'on' ? view.board : 'closed' }));
  } else if (reply.kind === 'images') {
    updateDesignView((view) => ({ ...view, images: new Map(reply.images.map((entry) => [entry.frame, entry.image])) }));
  }
}

/** One frame operation, with the shown frame pictured first so the board keeps its last look. */
export async function frameAction(
  app: DesignHostSource,
  words: DesignWords,
  action:
    | { readonly op: 'duplicate' }
    | { readonly op: 'switch' | 'delete'; readonly frame: DesignFrameId }
    | { readonly op: 'rename'; readonly frame: DesignFrameId; readonly name: string }
    | { readonly op: 'start-over' },
): Promise<void> {
  const session = designView().session;
  if (session.kind !== 'on') {
    return;
  }
  try {
    await pictureActive(app, session);
    installReply(await designSession(requestOf(session, words, action)));
    if (action.op === 'start-over') {
      updateDesignView((view) => ({ ...view, images: new Map() }));
    }
  } catch (error: unknown) {
    app.showToast(words('toast.failed', { detail: cleanError(error) }), 'error');
  }
}

function requestOf(session: Extract<DesignSessionState, { kind: 'on' }>, words: DesignWords, action: Parameters<typeof frameAction>[2]) {
  switch (action.op) {
    case 'duplicate': {
      const name = session.frames.find((frame) => frame.id === session.active)?.name ?? words('frame.original');
      return { op: 'frame-duplicate', name: words('frame.copy', { name }).slice(0, 60) } as const;
    }
    case 'switch':
      return { op: 'frame-switch', frame: action.frame } as const;
    case 'delete':
      return { op: 'frame-delete', frame: action.frame } as const;
    case 'rename':
      return { op: 'frame-rename', frame: action.frame, name: action.name } as const;
    case 'start-over':
      return { op: 'start-over', frameName: words('frame.original') } as const;
    default: {
      const exhaustive: never = action;
      throw new Error(`Assertion failed: requestOf: ${JSON.stringify(exhaustive)}`);
    }
  }
}
