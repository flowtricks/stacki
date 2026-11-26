// Design mode (experimental, removable: docs/design-mode/REMOVE.md): what each frame operation does to a session.
//
// A session is a value: every operation takes one and returns the next, and the only state is the one variable
// designModeHandlers.ts keeps. The file system writes they make (switching frames) all land in the sandbox's
// the live copy copy (designFrames.ts).
import path from 'node:path';
import {
  DESIGN_SESSION_LIMITS,
  nextDesignFrameId,
  type DesignFrameChanges,
  type DesignFrameId,
  type DesignSessionState,
} from '../../../shared/ipc/designSession';
import { readDraft, readDraftImage, removeDraft, removeDraftImage, saveDraft, saveDraftImage } from './designDrafts';
import { applyFrame, captureChanges, describeChanges, type FrameFiles } from './designFrames';
import type { DesignSandbox } from './designSandbox';

export interface Frame {
  readonly id: DesignFrameId;
  readonly name: string;
  readonly files: FrameFiles;
}

export interface Session {
  readonly sandbox: DesignSandbox;
  readonly realRoot: string;
  readonly page: string | undefined;
  readonly frames: readonly Frame[];
  readonly active: DesignFrameId;
  readonly stale: boolean;
  readonly images: ReadonlyMap<DesignFrameId, string>;
}

const NO_FILES: FrameFiles = new Map();

/** A new session on `sandbox`, with last time's frames laid over the copy when a draft was kept. */
export function beginSession(input: {
  readonly appDataRoot: string;
  readonly realRoot: string;
  readonly sandbox: DesignSandbox;
  readonly page: string | undefined;
  readonly frameName: string;
}): Session {
  const { appDataRoot, realRoot, sandbox, page } = input;
  const kept = readDraft({ appDataRoot, realRoot, base: sandbox.base });
  if (kept.kind === 'none') {
    return { sandbox, realRoot, page, frames: [{ id: 'f1', name: input.frameName, files: NO_FILES }], active: 'f1', stale: false, images: new Map() };
  }
  const active = kept.draft.frames.find((frame) => frame.id === kept.draft.active);
  if (active === undefined) {
    throw new Error('Assertion failed: beginSession: a kept draft names one of its frames');
  }
  applyFrame({ base: sandbox.base, live: sandbox.live, from: NO_FILES, to: active.files });
  const images = new Map<DesignFrameId, string>();
  for (const frame of kept.draft.frames) {
    const image = readDraftImage({ appDataRoot, realRoot, frame: frame.id });
    if (image !== undefined) {
      images.set(frame.id, image);
    }
  }
  return { sandbox, realRoot, page, frames: kept.draft.frames, active: active.id, stale: kept.stale, images };
}

export function activeFrame(session: Session): Frame {
  const frame = session.frames.find((entry) => entry.id === session.active);
  if (frame === undefined) {
    throw new Error('Assertion failed: activeFrame: the active frame is one of the frames');
  }
  return frame;
}

function frameById(session: Session, id: DesignFrameId): Frame {
  const frame = session.frames.find((entry) => entry.id === id);
  if (frame === undefined) {
    throw new Error(`Design mode: there is no frame ${id}`);
  }
  return frame;
}

function withFrame(session: Session, id: DesignFrameId, change: (frame: Frame) => Frame): Session {
  frameById(session, id);
  return { ...session, frames: session.frames.map((frame) => (frame.id === id ? change(frame) : frame)) };
}

/** The session with the active frame's files read again from the copy. */
export function capture(session: Session): Session {
  const files = captureChanges(session.sandbox.base, session.sandbox.live, session.sandbox.copiedAtMs);
  return withFrame(session, session.active, (frame) => ({ ...frame, files }));
}

/** Keeps the session's frames as the project's draft. Expects a captured session. */
export function keepDraft(appDataRoot: string, session: Session): void {
  saveDraft({ appDataRoot, realRoot: session.realRoot, base: session.sandbox.base, draft: { frames: session.frames, active: session.active } });
}

export function stateOf(session: Session): DesignSessionState {
  if (session.frames.length === 0) {
    throw new Error('Assertion failed: stateOf: a session has a frame');
  }
  return {
    kind: 'on',
    projectName: path.basename(session.realRoot).slice(0, DESIGN_SESSION_LIMITS.projectNameCharsMax),
    liveRoot: session.sandbox.live,
    page: session.page,
    frames: session.frames.map((frame) => ({ id: frame.id, name: frame.name, changedFiles: frame.files.size })),
    active: session.active,
    stale: session.stale,
  };
}

/** A copy of the active frame, made active. The copy already shows its files, so nothing on disk changes. */
export function duplicateFrame(session: Session, name: string): Session {
  if (session.frames.length >= DESIGN_SESSION_LIMITS.framesMax) {
    throw new Error('Design mode: a session holds at most this many frames');
  }
  const source = activeFrame(session);
  const id = nextDesignFrameId(session.frames);
  const images = new Map(session.images);
  const image = images.get(source.id);
  if (image !== undefined) {
    images.set(id, image);
  }
  return { ...session, frames: [...session.frames, { id, name, files: new Map(source.files) }], active: id, images };
}

/** Shows frame `id`: the copy is rewritten from the active frame's files to its own. Expects a captured session. */
export function switchFrame(session: Session, id: DesignFrameId): Session {
  const target = frameById(session, id);
  if (target.id === session.active) {
    return session;
  }
  applyFrame({ base: session.sandbox.base, live: session.sandbox.live, from: activeFrame(session).files, to: target.files });
  return { ...session, active: target.id };
}

export function renameFrame(session: Session, id: DesignFrameId, name: string): Session {
  return withFrame(session, id, (frame) => ({ ...frame, name }));
}

/** Removes frame `id`, showing another first when it is the one shown. The last frame stays. */
export function deleteFrame(appDataRoot: string, session: Session, id: DesignFrameId): Session {
  frameById(session, id);
  if (session.frames.length <= 1) {
    throw new Error('Design mode: the last frame stays');
  }
  const neighbour = session.frames.find((frame) => frame.id !== id);
  if (neighbour === undefined) {
    throw new Error('Assertion failed: deleteFrame: a second frame exists');
  }
  const shown = session.active === id ? switchFrame(session, neighbour.id) : session;
  const images = new Map(shown.images);
  images.delete(id);
  removeDraftImage({ appDataRoot, realRoot: session.realRoot, frame: id });
  return { ...shown, frames: shown.frames.filter((frame) => frame.id !== id), images };
}

export function setFrameImage(appDataRoot: string, session: Session, id: DesignFrameId, image: string): Session {
  frameById(session, id);
  saveDraftImage({ appDataRoot, realRoot: session.realRoot, frame: id, image });
  return { ...session, images: new Map([...session.images, [id, image]]) };
}

/** Back to one frame showing the project as copied; the kept draft is forgotten. Expects a captured session. */
export function startOver(appDataRoot: string, session: Session, frameName: string): Session {
  applyFrame({ base: session.sandbox.base, live: session.sandbox.live, from: activeFrame(session).files, to: NO_FILES });
  removeDraft(appDataRoot, session.realRoot);
  return { ...session, frames: [{ id: 'f1', name: frameName, files: NO_FILES }], active: 'f1', stale: false, images: new Map() };
}

export function imagesOf(session: Session): readonly { readonly frame: DesignFrameId; readonly image: string }[] {
  return session.frames.flatMap((frame) => {
    const image = session.images.get(frame.id);
    return image === undefined ? [] : [{ frame: frame.id, image }];
  });
}

/** Every frame's changes as text for the AI. Expects a captured session. */
export function changesOf(session: Session): readonly DesignFrameChanges[] {
  return session.frames.map((frame) => ({
    id: frame.id,
    name: frame.name,
    text: describeChanges(session.sandbox.base, frame.files, DESIGN_SESSION_LIMITS.changesCharsMax),
    changedFiles: frame.files.size,
  }));
}
