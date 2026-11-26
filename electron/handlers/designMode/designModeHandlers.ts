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
import { createSandbox, removeSandboxAsync, removeSandboxAtQuit, stopServersIn, sweepSandboxes } from './designSandbox';
import {
  announceShown,
  beginSession,
  capture,
  deleteFrame,
  duplicateFrame,
  filesBetween,
  keepDraft,
  keepSnapshot,
  keptFrames,
  moveFrame,
  pageSourceOf,
  renameFrame,
  snapshotsOf,
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

export function registerDesignModeHandlers(host: Pick<MainHost, 'ipcMain' | 'openProject' | 'send'>, options: DesignModeOptions): void {
  // A sandbox still here at startup was left by a crash or a forced quit: its dev server is stopped and its copy of
  // `.env` deleted first, in the background, so the app starts at once.
  void sweepSandboxes(options.appDataRoot).catch(() => undefined);
  guardDesignWrites();
  const sessions = createDesignSessions(host, options);
  observeDesignFence(sessions.observe);
  options.onQuit(sessions.endAtQuit);
  host.ipcMain.handle('design:session', (_event, request) => sessions.answer(request));
}

type EnterRequest = Extract<DesignSessionRequest, { op: 'enter' }>;

/** The one session, and every request on it; apart from registration so a test can drive it without Electron. */
export function createDesignSessions(host: Pick<MainHost, 'openProject' | 'send'>, options: Pick<DesignModeOptions, 'appDataRoot'>) {
  const appDataRoot = options.appDataRoot;
  let session: Session | undefined = undefined;
  let entering: { readonly cancelled: () => boolean; readonly cancel: () => void } | undefined = undefined;
  let handoff: DesignHandoff | undefined = undefined;
  // Requests on the session run one at a time, in order: each reads the copy as the last one left it.
  let queue: Promise<unknown> = Promise.resolve();
  let ending: Promise<void> = Promise.resolve();

  /** Lowers the fence at once; keeps the drafts, stops the copy's dev server and deletes the copy in the background. */
  const end = (): Promise<void> => {
    const closing = session;
    if (closing === undefined) {
      return ending;
    }
    session = undefined;
    lowerDesignFence();
    ending = (async () => {
      try {
        keepDraft(appDataRoot, await capture(closing));
      } finally {
        await stopServersIn(closing.sandbox.root);
        await removeSandboxAsync(closing.sandbox.root);
      }
    })().catch(() => undefined);
    return ending;
  };

  /** As the app quits nothing can be awaited: the drafts as last kept stay, and the copy goes in the background. */
  const endAtQuit = (): void => {
    entering?.cancel();
    const closing = session;
    if (closing === undefined) {
      return;
    }
    session = undefined;
    lowerDesignFence();
    removeSandboxAtQuit(closing.sandbox.root);
  };

  const observe = (channel: string, payload: unknown): void => {
    if (channel !== 'project:close' || session === undefined) {
      return;
    }
    // The window opens the copy through project:close too; any other folder, or none, ends the session.
    if (typeof payload === 'string' && isPathWithin(session.sandbox.root, path.resolve(payload))) {
      return;
    }
    void end();
  };

  const enter = async (request: EnterRequest): Promise<DesignSessionReply> => {
    const open = host.openProject();
    if (!DESIGN_MODE_ENABLED || open === undefined || path.resolve(open) !== path.resolve(request.projectPath)) {
      return { kind: 'refused', reason: 'not-open', folder: undefined };
    }
    if (session !== undefined || entering !== undefined) {
      return { kind: 'refused', reason: 'busy', folder: undefined };
    }
    const stop: { state: 'running' | 'stopped' } = { state: 'running' };
    const cancel = {
      cancelled: () => stop.state === 'stopped',
      cancel: () => {
        stop.state = 'stopped';
      },
    };
    entering = cancel;
    try {
      await ending;
      await sweepSandboxes(appDataRoot);
      const created = await createSandbox({ appDataRoot, realRoot: open, cancel });
      if (!created.ok) {
        return { kind: 'refused', reason: created.reason, folder: created.folder };
      }
      const { page, frameName, snapshot } = request;
      session = await beginSession({ appDataRoot, realRoot: open, sandbox: created.sandbox, page, frameName, snapshot });
      raiseDesignFence({ sandboxRoot: created.sandbox.root, realRoot: open, refusal: request.refusal, appDataRoot });
      return { kind: 'entered', liveRoot: created.sandbox.live };
    } finally {
      entering = undefined;
    }
  };

  const onSession = async (request: SessionRequest): Promise<DesignSessionReply> => {
    const current = session;
    if (current === undefined) {
      return { kind: 'state', state: { kind: 'off' } };
    }
    // A snapshot arrives after every change the canvas shows, and a move changes no file: neither reads the copy.
    const captured = CAPTURE_FREE.has(request.op) ? current : await capture(current);
    const { next, reply } = await operate(appDataRoot, captured, request);
    // A frame removed is gone from `next`, so what was rewritten is read from the session as it was.
    announceShown(captured.sandbox.live, filesBetween(captured, next), host.send);
    // A session that ended while this ran is not brought back.
    session = session === current ? next : session;
    if (request.op === 'exit') {
      handoff = request.handoff;
    }
    return reply;
  };

  const answer = async (request: DesignSessionRequest): Promise<DesignSessionReply> => {
    switch (request.op) {
      case 'enter':
        return enter(request);
      case 'preview': {
        const open = host.openProject();
        const asked = session === undefined && open !== undefined && path.resolve(open) === path.resolve(request.projectPath);
        return { kind: 'preview', ...(asked ? await keptFrames(appDataRoot, open) : { frames: [], snapshots: [] }) };
      }
      case 'cancel':
        entering?.cancel();
        return { kind: 'state', state: { kind: 'off' } };
      case 'take-handoff': {
        // Only once the window is back on the project, and only once.
        const taken = session === undefined ? handoff : undefined;
        handoff = session === undefined ? undefined : handoff;
        return { kind: 'handoff', handoff: taken };
      }
      case 'state':
      case 'exit':
      case 'frame-duplicate':
      case 'frame-switch':
      case 'frame-rename':
      case 'frame-delete':
      case 'frame-move':
      case 'frame-snapshot':
      case 'frame-snapshots':
      case 'start-over': {
        const run = queue.then(() => onSession(request));
        queue = run.catch(() => undefined);
        return run;
      }
      default: {
        const exhaustive: never = request;
        throw new Error(`Assertion failed: answer: ${JSON.stringify(exhaustive)}`);
      }
    }
  };

  return { answer, end, endAtQuit, observe, current: (): Session | undefined => session };
}

const CAPTURE_FREE: ReadonlySet<DesignSessionRequest['op']> = new Set(['state', 'frame-move', 'frame-snapshot', 'frame-snapshots', 'frame-rename']);

type SessionRequest = Exclude<DesignSessionRequest, { op: 'enter' | 'take-handoff' | 'cancel' | 'preview' }>;

/** The reply for an operation that may have changed what the copy shows. */
async function shown(appDataRoot: string, next: Session, page: string | undefined) {
  keepDraft(appDataRoot, next);
  return { next, reply: { kind: 'shown', state: stateOf(next), pageSource: await pageSourceOf(next, page) } } as const;
}

/** One request on a captured session: the session after it, and the reply. */
async function operate(
  appDataRoot: string,
  session: Session,
  request: SessionRequest,
): Promise<{ readonly next: Session; readonly reply: DesignSessionReply }> {
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
      return saved(await duplicateFrame(appDataRoot, session, request));
    case 'frame-switch': {
      const next = await switchFrame(session, request.frame);
      return shown(appDataRoot, next, request.page);
    }
    case 'frame-delete': {
      const next = await deleteFrame(appDataRoot, session, request.frame);
      return shown(appDataRoot, next, request.page);
    }
    case 'frame-rename':
      return saved(renameFrame(session, request.frame, request.name));
    case 'frame-move':
      return saved(moveFrame(session, request.frame, request.at));
    case 'start-over': {
      const next = await startOver(appDataRoot, session, request.frameName);
      return shown(appDataRoot, next, request.page);
    }
    case 'frame-snapshot':
      // A frame removed while its picture was on the way is not brought back.
      if (session.frames.some((frame) => frame.id === request.frame)) {
        await keepSnapshot(appDataRoot, session, request.frame, request.snapshot);
      }
      return { next: session, reply: { kind: 'kept' } };
    case 'frame-snapshots':
      return { next: session, reply: { kind: 'snapshots', snapshots: await snapshotsOf(appDataRoot, session) } };
    default: {
      const exhaustive: never = request;
      throw new Error(`Assertion failed: operate: ${JSON.stringify(exhaustive)}`);
    }
  }
}
