// Design mode (experimental, removable: docs/design-mode/REMOVE.md): what each frame operation does to a session.
//
// A session is a value: every operation takes one and returns the next, and the only state is the one variable
// designModeHandlers.ts keeps. The file system writes they make (switching frames) all land in the sandbox's
// the live copy copy (designFrames.ts).
import fs from 'node:fs';
import path from 'node:path';
import { isPathWithin } from '../../lib/platform';
import {
  DESIGN_SESSION_LIMITS,
  defaultFramePlace,
  nextDesignFrameId,
  type DesignFrameChanges,
  type DesignFrameId,
  type DesignPlace,
  type DesignSessionState,
} from '../../../shared/ipc/designSession';
import type { DesignSnapshot } from '../../../shared/ipc/designSnapshot';
import { readDraft, removeDraft, saveDraft } from './designDrafts';
import { copySnapshot, readSnapshot, removeSnapshot, saveSnapshot } from './designSnapshots';
import { applyFrame, captureChanges, describeChanges, type FrameFiles } from './designFrames';
import type { DesignSandbox } from './designSandbox';

export interface Frame {
  readonly id: DesignFrameId;
  readonly name: string;
  readonly at: DesignPlace;
  readonly files: FrameFiles;
}

export interface Session {
  readonly sandbox: DesignSandbox;
  readonly realRoot: string;
  readonly page: string | undefined;
  readonly frames: readonly Frame[];
  readonly active: DesignFrameId;
  readonly stale: boolean;
}

const NO_FILES: FrameFiles = new Map();

function firstFrame(name: string): Frame {
  return { id: 'f1', name, at: defaultFramePlace(0), files: NO_FILES };
}

/**
 * The frames kept for the project, read before a session begins: the canvas draws them at once, while the copy is
 * made. Reads Stacki's own data folder only. `frames` is empty when nothing is kept.
 */
export async function keptFrames(appDataRoot: string, realRoot: string) {
  const kept = readDraft({ appDataRoot, realRoot, base: realRoot });
  if (kept.kind === 'none') {
    return { frames: [], snapshots: [] };
  }
  const frames = kept.draft.frames.map((frame) => ({ id: frame.id, name: frame.name, at: frame.at, changedFiles: frame.files.size }));
  const snapshots: { readonly frame: DesignFrameId; readonly snapshot: DesignSnapshot }[] = [];
  for (const frame of kept.draft.frames) {
    const snapshot = await readSnapshot({ appDataRoot, realRoot, frame: frame.id });
    if (snapshot !== undefined) {
      snapshots.push({ frame: frame.id, snapshot });
    }
  }
  return { frames, snapshots };
}

/** A new session on `sandbox`, with last time's frames laid over the copy when a draft was kept. */
export async function beginSession(input: {
  readonly appDataRoot: string;
  readonly realRoot: string;
  readonly sandbox: DesignSandbox;
  readonly page: string | undefined;
  readonly frameName: string;
  /** The canvas as the person last saw it, for the first frame of a new session. */
  readonly snapshot: DesignSnapshot | undefined;
}): Promise<Session> {
  const { appDataRoot, realRoot, sandbox, page, snapshot } = input;
  const kept = readDraft({ appDataRoot, realRoot, base: sandbox.base });
  if (kept.kind === 'none') {
    // Whatever an unfinished session left in the draft folder belongs to no frame of this one.
    removeDraft(appDataRoot, realRoot);
    if (snapshot !== undefined) {
      await saveSnapshot({ appDataRoot, realRoot, frame: 'f1' }, snapshot);
    }
    return { sandbox, realRoot, page, frames: [firstFrame(input.frameName)], active: 'f1', stale: false };
  }
  const active = kept.draft.frames.find((frame) => frame.id === kept.draft.active);
  if (active === undefined) {
    throw new Error('Assertion failed: beginSession: a kept draft names one of its frames');
  }
  await applyFrame({ base: sandbox.base, live: sandbox.live, from: NO_FILES, to: active.files });
  return { sandbox, realRoot, page, frames: kept.draft.frames, active: active.id, stale: kept.stale };
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
export async function capture(session: Session): Promise<Session> {
  const files = await captureChanges(session.sandbox.base, session.sandbox.live, session.sandbox.copiedAtMs);
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
    frames: session.frames.map((frame) => ({ id: frame.id, name: frame.name, at: frame.at, changedFiles: frame.files.size })),
    active: session.active,
    stale: session.stale,
  };
}

/**
 * A copy of frame `source` placed at `at`. The copy of the site keeps showing the active frame, so nothing there
 * changes. Expects a captured session, so a copy of the active frame has what it shows now.
 */
export async function duplicateFrame(
  appDataRoot: string,
  session: Session,
  input: { readonly source: DesignFrameId; readonly name: string; readonly at: DesignPlace },
): Promise<Session> {
  if (session.frames.length >= DESIGN_SESSION_LIMITS.framesMax) {
    throw new Error('Design mode: a session holds at most this many frames');
  }
  const source = frameById(session, input.source);
  const id = nextDesignFrameId(session.frames);
  await copySnapshot({ appDataRoot, realRoot: session.realRoot }, source.id, id);
  return { ...session, frames: [...session.frames, { id, name: input.name, at: input.at, files: new Map(source.files) }] };
}

/** Shows frame `id`: the copy is rewritten from the active frame's files to its own. Expects a captured session. */
export async function switchFrame(session: Session, id: DesignFrameId): Promise<Session> {
  const target = frameById(session, id);
  if (target.id === session.active) {
    return session;
  }
  await applyFrame({ base: session.sandbox.base, live: session.sandbox.live, from: activeFrame(session).files, to: target.files });
  return { ...session, active: target.id };
}

/**
 * Tells the window which files a change of shown frame rewrote. The project watcher cannot be left to: it takes a
 * file holding exactly the bytes the editor last saved for the editor's own save, and showing a frame again writes
 * just those bytes, so the editor would go on editing the other frame's page.
 */
export function announceShown(live: string, rewritten: readonly string[], send: (channel: string, payload: unknown) => void): void {
  if (rewritten.length === 0) {
    return;
  }
  send('fs:changed', { files: rewritten.map((rel) => path.join(live, rel)) });
  if (rewritten.some((rel) => /\.(astro|css)$/i.test(rel))) {
    send('css:changed', {});
  }
  if (rewritten.some((rel) => /\.json$/i.test(rel))) {
    send('cms:changed', {});
  }
}

/** The files either frame changes: what showing one after the other may rewrite. */
export function filesBetween(from: Session, to: Session): readonly string[] {
  const before = activeFrame(from).files;
  const after = activeFrame(to).files;
  return before === after ? [] : [...new Set([...before.keys(), ...after.keys()])];
}

/**
 * The text the copy now holds for `page`, so the window can tell when it has read the shown frame's version.
 * Undefined for no page, a page outside the copy, one that is gone, or one too long to compare.
 */
export async function pageSourceOf(session: Session, page: string | undefined): Promise<string | undefined> {
  if (page === undefined || !isPathWithin(session.sandbox.live, path.resolve(page))) {
    return undefined;
  }
  try {
    const stat = await fs.promises.stat(page);
    if (stat.size > DESIGN_SESSION_LIMITS.pageSourceCharsMax) {
      return undefined;
    }
    return await fs.promises.readFile(page, 'utf8');
  } catch {
    return undefined;
  }
}

export function renameFrame(session: Session, id: DesignFrameId, name: string): Session {
  return withFrame(session, id, (frame) => ({ ...frame, name }));
}

export function moveFrame(session: Session, id: DesignFrameId, at: DesignPlace): Session {
  return withFrame(session, id, (frame) => ({ ...frame, at }));
}

/** Removes frame `id`, showing another first when it is the one shown. The last frame stays. */
export async function deleteFrame(appDataRoot: string, session: Session, id: DesignFrameId): Promise<Session> {
  frameById(session, id);
  if (session.frames.length <= 1) {
    throw new Error('Design mode: the last frame stays');
  }
  const neighbour = session.frames.find((frame) => frame.id !== id);
  if (neighbour === undefined) {
    throw new Error('Assertion failed: deleteFrame: a second frame exists');
  }
  const shown = session.active === id ? await switchFrame(session, neighbour.id) : session;
  await removeSnapshot({ appDataRoot, realRoot: session.realRoot, frame: id });
  return { ...shown, frames: shown.frames.filter((frame) => frame.id !== id) };
}

export async function keepSnapshot(appDataRoot: string, session: Session, id: DesignFrameId, snapshot: DesignSnapshot): Promise<void> {
  frameById(session, id);
  await saveSnapshot({ appDataRoot, realRoot: session.realRoot, frame: id }, snapshot);
}

/** Every frame's kept snapshot, read one at a time. */
export async function snapshotsOf(
  appDataRoot: string,
  session: Session,
): Promise<readonly { readonly frame: DesignFrameId; readonly snapshot: DesignSnapshot }[]> {
  const found: { readonly frame: DesignFrameId; readonly snapshot: DesignSnapshot }[] = [];
  for (const frame of session.frames) {
    const snapshot = await readSnapshot({ appDataRoot, realRoot: session.realRoot, frame: frame.id });
    if (snapshot !== undefined) {
      found.push({ frame: frame.id, snapshot });
    }
  }
  return found;
}

/** Back to one frame showing the project as copied; the kept draft is forgotten. Expects a captured session. */
export async function startOver(appDataRoot: string, session: Session, frameName: string): Promise<Session> {
  await applyFrame({ base: session.sandbox.base, live: session.sandbox.live, from: activeFrame(session).files, to: NO_FILES });
  removeDraft(appDataRoot, session.realRoot);
  return { ...session, frames: [firstFrame(frameName)], active: 'f1', stale: false };
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
