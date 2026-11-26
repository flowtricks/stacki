// Design mode (experimental, removable: docs/design-mode/REMOVE.md): the `design:session` channel, and the session
// it drives.
//
// Beginning: the project the window has open is copied into a sandbox (designSandbox.ts), the drafts kept from
// last time are laid over it (designDrafts.ts), and the fence goes up (electron/lib/designMode/designFence.ts).
// The renderer then opens the copy through the app's own project switch, so every panel works on it.
//
// Ending: whenever the window lets go of the copy (`project:close` naming any other folder, or none), the frames
// are kept as drafts, the fence comes down and the sandbox is deleted, with the `.env` it holds. The same happens
// when the app quits, and a sandbox a crash left behind is deleted the next time the app starts. Earlier undo
// history does not survive: the window reloads on the way in and on the way out, as it does for any project switch.
import path from 'node:path';
import { DESIGN_MODE_ENABLED, type DesignHandoff, type DesignSessionReply, type DesignSessionRequest } from '../../../shared/ipc/designSession';
import { lowerDesignFence, observeDesignFence, raiseDesignFence } from '../../lib/designMode/designFence';
import { guardDesignWrites } from '../../lib/designMode/designWriteGuard';
import { isPathWithin } from '../../lib/platform';
import type { MainHost } from '../mainHost';
import { createSandbox, removeSandbox, sweepSandboxes } from './designSandbox';
import {
  beginSession,
  capture,
  changesOf,
  deleteFrame,
  duplicateFrame,
  imagesOf,
  keepDraft,
  renameFrame,
  setFrameImage,
  startOver,
  stateOf,
  switchFrame,
  type Session,
} from './designSessionOps';

export interface DesignModeOptions {
  /** Stacki's own data folder: where sandboxes and drafts live. */
  readonly appDataRoot: string;
  /** Runs `listener` once as the app quits. */
  readonly onQuit: (listener: () => void) => void;
}

export function registerDesignModeHandlers(host: Pick<MainHost, 'ipcMain' | 'openProject'>, options: DesignModeOptions): void {
  // A sandbox still here at startup was left by a crash or a forced quit: its copy of `.env` goes first.
  sweepSandboxes(options.appDataRoot);
  guardDesignWrites();
  const sessions = createDesignSessions(host, options);
  observeDesignFence(sessions.observe);
  options.onQuit(sessions.end);
  host.ipcMain.handle('design:session', (_event, request) => sessions.answer(request));
}

type EnterRequest = Extract<DesignSessionRequest, { op: 'enter' }>;

/** The one session, and every request on it; apart from registration so a test can drive it without Electron. */
export function createDesignSessions(host: Pick<MainHost, 'openProject'>, options: Pick<DesignModeOptions, 'appDataRoot'>) {
  const appDataRoot = options.appDataRoot;
  let session: Session | undefined = undefined;
  let entering: 'no' | 'yes' = 'no';
  let handoff: DesignHandoff | undefined = undefined;

  /** Keeps the drafts, lowers the fence and deletes the sandbox. Safe to call when nothing is on. */
  const end = (): void => {
    const ending = session;
    if (ending === undefined) {
      return;
    }
    session = undefined;
    try {
      keepDraft(appDataRoot, capture(ending));
    } finally {
      lowerDesignFence();
      removeSandbox(ending.sandbox.root);
    }
  };

  const observe = (channel: string, payload: unknown): void => {
    if (channel !== 'project:close' || session === undefined) {
      return;
    }
    // The window opens the copy through project:close too; any other folder, or none, ends the session.
    if (typeof payload === 'string' && isPathWithin(session.sandbox.root, path.resolve(payload))) {
      return;
    }
    end();
  };

  const enter = async (request: EnterRequest): Promise<DesignSessionReply> => {
    const open = host.openProject();
    if (!DESIGN_MODE_ENABLED || open === undefined || path.resolve(open) !== path.resolve(request.projectPath)) {
      return { kind: 'refused', reason: 'not-open' };
    }
    if (session !== undefined || entering === 'yes') {
      return { kind: 'refused', reason: 'busy' };
    }
    entering = 'yes';
    try {
      sweepSandboxes(appDataRoot);
      const created = await createSandbox({ appDataRoot, realRoot: open });
      if (!created.ok) {
        return { kind: 'refused', reason: created.reason };
      }
      session = beginSession({ appDataRoot, realRoot: open, sandbox: created.sandbox, page: request.page, frameName: request.frameName });
      raiseDesignFence({ sandboxRoot: created.sandbox.root, realRoot: open, refusal: request.refusal, appDataRoot });
      return { kind: 'entered', liveRoot: created.sandbox.live };
    } finally {
      entering = 'no';
    }
  };

  const answer = async (request: DesignSessionRequest): Promise<DesignSessionReply> => {
    if (request.op === 'enter') {
      return enter(request);
    }
    if (request.op === 'take-handoff') {
      // Only once the window is back on the project, and only once.
      const taken = session === undefined ? handoff : undefined;
      handoff = session === undefined ? undefined : handoff;
      return { kind: 'handoff', handoff: taken };
    }
    if (session === undefined) {
      return { kind: 'state', state: { kind: 'off' } };
    }
    const captured = capture(session);
    const { next, reply } = operate(appDataRoot, captured, request);
    session = next;
    if (request.op === 'exit') {
      handoff = request.handoff;
    }
    return reply;
  };

  return { answer, end, observe, current: (): Session | undefined => session };
}

type SessionRequest = Exclude<DesignSessionRequest, { op: 'enter' | 'take-handoff' }>;

/** One request on a captured session: the session after it, and the reply. */
function operate(appDataRoot: string, session: Session, request: SessionRequest): { readonly next: Session; readonly reply: DesignSessionReply } {
  const saved = (next: Session) => {
    keepDraft(appDataRoot, next);
    return { next, reply: { kind: 'state', state: stateOf(next) } } as const;
  };
  switch (request.op) {
    case 'state':
      return { next: session, reply: { kind: 'state', state: stateOf(session) } };
    case 'exit':
      // Kept now as well as when the window lets go, so what Send to AI described is what the draft holds.
      keepDraft(appDataRoot, session);
      return { next: session, reply: { kind: 'left', realRoot: session.realRoot } };
    case 'frame-duplicate':
      return saved(duplicateFrame(session, request.name));
    case 'frame-switch':
      return saved(switchFrame(session, request.frame));
    case 'frame-rename':
      return saved(renameFrame(session, request.frame, request.name));
    case 'frame-delete':
      return saved(deleteFrame(appDataRoot, session, request.frame));
    case 'start-over': {
      const next = startOver(appDataRoot, session, request.frameName);
      return { next, reply: { kind: 'state', state: stateOf(next) } };
    }
    case 'frame-image': {
      const next = setFrameImage(appDataRoot, session, request.frame, request.image);
      return { next, reply: { kind: 'images', images: imagesOf(next) } };
    }
    case 'frame-images':
      return { next: session, reply: { kind: 'images', images: imagesOf(session) } };
    case 'changes':
      return { next: session, reply: { kind: 'changes', frames: changesOf(session) } };
    default: {
      const exhaustive: never = request;
      throw new Error(`Assertion failed: operate: ${JSON.stringify(exhaustive)}`);
    }
  }
}
