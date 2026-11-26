// Design mode (experimental, removable: docs/design-mode/REMOVE.md): the one channel, `design:session`, between
// the renderer and main.
//
// Design mode is the normal editor on a sandbox: a copy of the project in Stacki's own data folder, which the
// window opens instead of the project while the mode is on. Every panel edits the copy for real, and main's
// fence (electron/lib/designMode/designFence.ts) refuses any request that could reach past it. Frames are
// versions of that copy: the copy shows one at a time, and each keeps its own changed files.
//
// Every value crosses the IPC boundary, so both ends parse it here: main parses requests before it acts, and the
// renderer parses replies before it trusts them.
import { boolean, count, pathText, record, text } from '../core/boundary';

/** The single switch. False: no header button, and main answers every request as if nothing were open. */
export const DESIGN_MODE_ENABLED = true;

export const DESIGN_SESSION_LIMITS = {
  /** Frames at once. Why: each is a version of the whole site, and the board stays readable. */
  framesMax: 8,
  frameNameCharsMax: 60,
  /** The refusal the fence answers with, already in the person's language. */
  refusalCharsMax: 400,
  /** A page's project-relative path. */
  pageCharsMax: 1_000,
  projectNameCharsMax: 400,
  /** Changed files described per frame. */
  changedFilesMax: 400,
  /** The described change of one frame, as text. */
  changesCharsMax: 60_000,
  /** One frame's picture, a PNG data URL. */
  imageCharsMax: 4_000_000,
  /** Every frame picture kept in memory together: the oldest goes first past this. */
  imagesCharsMax: 24_000_000,
  /** What Send to AI carries across the window's reload. */
  handoffTextCharsMax: 200_000,
  handoffImagesMax: 9,
} as const satisfies Record<string, number>;

/** A frame's id: `f1`, `f2`, … */
export type DesignFrameId = `f${number}`;

export interface DesignFrameView {
  readonly id: DesignFrameId;
  readonly name: string;
  /** Files this frame changes against the project as it was copied. */
  readonly changedFiles: number;
}

export type DesignSessionState =
  | { readonly kind: 'off' }
  | {
      readonly kind: 'on';
      readonly projectName: string;
      /** The copy the window has open; every path the panels use is inside it. */
      readonly liveRoot: string;
      /** The page the person was on when the mode began, project-relative, when there was one. */
      readonly page: string | undefined;
      readonly frames: readonly DesignFrameView[];
      readonly active: DesignFrameId;
      /** Drafts came back over a project that changed since they were made. */
      readonly stale: boolean;
    };

/** Why the mode did not begin. */
export const DESIGN_ENTER_REFUSALS = ['not-open', 'too-large', 'outside-link', 'copy-failed', 'busy', 'cancelled'] as const;
export type DesignEnterRefusal = (typeof DESIGN_ENTER_REFUSALS)[number];

/** What Send to AI hands to the AI panel once the window is back on the project. */
export interface DesignHandoff {
  readonly text: string;
  /** PNG data URLs, one per frame that has a picture. */
  readonly images: readonly string[];
  /** Each picture's frame name, in the same order. */
  readonly names: readonly string[];
}

export interface DesignFrameChanges {
  readonly id: DesignFrameId;
  readonly name: string;
  /** Each changed file as a short hunk of removed and added lines. */
  readonly text: string;
  readonly changedFiles: number;
}

export type DesignSessionRequest =
  | { readonly op: 'state' }
  | {
      readonly op: 'enter';
      readonly projectPath: string;
      readonly page: string | undefined;
      /** What the fence says when it refuses, in the person's language. */
      readonly refusal: string;
      /** The first frame's name, in the person's language. */
      readonly frameName: string;
    }
  | { readonly op: 'exit'; readonly handoff: DesignHandoff | undefined }
  /** Stops a copy under way: the enter answers `cancelled` and leaves nothing behind. */
  | { readonly op: 'cancel' }
  | { readonly op: 'take-handoff' }
  | { readonly op: 'frame-duplicate'; readonly name: string }
  | { readonly op: 'frame-switch'; readonly frame: DesignFrameId }
  | { readonly op: 'frame-rename'; readonly frame: DesignFrameId; readonly name: string }
  | { readonly op: 'frame-delete'; readonly frame: DesignFrameId }
  | { readonly op: 'frame-image'; readonly frame: DesignFrameId; readonly image: string }
  | { readonly op: 'frame-images' }
  | { readonly op: 'changes' }
  | { readonly op: 'start-over'; readonly frameName: string };

export type DesignSessionReply =
  | { readonly kind: 'state'; readonly state: DesignSessionState }
  | { readonly kind: 'entered'; readonly liveRoot: string }
  /** `folder`: for too-large, the project's top-level folder holding the most files. */
  | { readonly kind: 'refused'; readonly reason: DesignEnterRefusal; readonly folder: string | undefined }
  | { readonly kind: 'left'; readonly realRoot: string }
  | { readonly kind: 'handoff'; readonly handoff: DesignHandoff | undefined }
  | { readonly kind: 'images'; readonly images: readonly { readonly frame: DesignFrameId; readonly image: string }[] }
  | { readonly kind: 'changes'; readonly frames: readonly DesignFrameChanges[] };

const FRAME_ID = /^f[1-9]\d{0,5}$/;

/** A frame id from the wire. */
export function parseDesignFrameId(input: unknown): DesignFrameId {
  const value = text(input);
  if (!FRAME_ID.test(value)) {
    throw new Error('Design frame id: expected f followed by a number');
  }
  // The pattern above is the template literal type's own shape.
  return value as DesignFrameId;
}

/** The frame id after `frames` ids: one more than the highest. */
export function nextDesignFrameId(frames: readonly { readonly id: DesignFrameId }[]): DesignFrameId {
  const highest = frames.reduce((max, frame) => Math.max(max, Number(frame.id.slice(1))), 0);
  const next = parseDesignFrameId(`f${highest + 1}`);
  if (frames.some((frame) => frame.id === next)) {
    throw new Error('Assertion failed: nextDesignFrameId: a new id is unused');
  }
  return next;
}

function bounded(input: unknown, charsMax: number, what: string): string {
  const value = text(input);
  if (value.length > charsMax) {
    throw new Error(`${what}: exceeds ${charsMax} characters`);
  }
  return value;
}

function frameName(input: unknown): string {
  const value = bounded(input, DESIGN_SESSION_LIMITS.frameNameCharsMax, 'Design frame name').trim();
  if (value.length === 0) {
    throw new Error('Design frame name: expected text');
  }
  return value;
}

function image(input: unknown): string {
  const value = bounded(input, DESIGN_SESSION_LIMITS.imageCharsMax, 'Design frame image');
  if (!value.startsWith('data:image/png;base64,')) {
    throw new Error('Design frame image: expected a PNG data URL');
  }
  return value;
}

function optionalPage(input: unknown): string | undefined {
  if (input === undefined) {
    return undefined;
  }
  return bounded(pathText(input), DESIGN_SESSION_LIMITS.pageCharsMax, 'Design page');
}

function handoff(input: unknown): DesignHandoff {
  const value = record(input);
  const images = value['images'];
  if (!Array.isArray(images)) {
    throw new Error('Design handoff images: expected a list');
  }
  if (images.length > DESIGN_SESSION_LIMITS.handoffImagesMax) {
    throw new Error('Design handoff images: too many');
  }
  const names = value['names'];
  if (!Array.isArray(names) || names.length !== images.length) {
    throw new Error('Design handoff names: one per picture');
  }
  return {
    text: bounded(value['text'], DESIGN_SESSION_LIMITS.handoffTextCharsMax, 'Design handoff text'),
    images: images.map(image),
    names: names.map(frameName),
  };
}

/** A `design:session` request, parsed in main before anything acts on it. */
export function parseDesignSessionRequest(input: unknown): DesignSessionRequest {
  const value = record(input);
  const op = value['op'];
  switch (op) {
    case 'state':
    case 'take-handoff':
    case 'frame-images':
    case 'changes':
    case 'cancel':
      return { op };
    case 'enter':
      return {
        op,
        projectPath: pathText(value['projectPath']),
        page: optionalPage(value['page']),
        refusal: bounded(value['refusal'], DESIGN_SESSION_LIMITS.refusalCharsMax, 'Design refusal'),
        frameName: frameName(value['frameName']),
      };
    case 'exit':
      return { op, handoff: value['handoff'] === undefined ? undefined : handoff(value['handoff']) };
    case 'frame-duplicate':
      return { op, name: frameName(value['name']) };
    case 'frame-switch':
    case 'frame-delete':
      return { op, frame: parseDesignFrameId(value['frame']) };
    case 'frame-rename':
      return { op, frame: parseDesignFrameId(value['frame']), name: frameName(value['name']) };
    case 'frame-image':
      return { op, frame: parseDesignFrameId(value['frame']), image: image(value['image']) };
    case 'start-over':
      return { op, frameName: frameName(value['frameName']) };
    default:
      throw new Error(`Design session: unknown op ${JSON.stringify(op)}`);
  }
}

function frameView(input: unknown): DesignFrameView {
  const value = record(input);
  return { id: parseDesignFrameId(value['id']), name: frameName(value['name']), changedFiles: count(value['changedFiles']) };
}

function parseState(input: unknown): DesignSessionState {
  const value = record(input);
  if (value['kind'] === 'off') {
    return { kind: 'off' };
  }
  if (value['kind'] !== 'on') {
    throw new Error('Design session state: unknown kind');
  }
  const frames = value['frames'];
  if (!Array.isArray(frames)) {
    throw new Error('Design session frames: expected a list');
  }
  if (frames.length === 0) {
    throw new Error('Design session frames: at least one');
  }
  if (frames.length > DESIGN_SESSION_LIMITS.framesMax) {
    throw new Error('Design session frames: too many');
  }
  const parsed = frames.map(frameView);
  const active = parseDesignFrameId(value['active']);
  if (!parsed.some((frame) => frame.id === active)) {
    throw new Error('Design session: the active frame is one of the frames');
  }
  return {
    kind: 'on',
    projectName: bounded(value['projectName'], DESIGN_SESSION_LIMITS.projectNameCharsMax, 'Design project name'),
    liveRoot: pathText(value['liveRoot']),
    page: optionalPage(value['page']),
    frames: parsed,
    active,
    stale: boolean(value['stale']),
  };
}

function frameChanges(input: unknown): DesignFrameChanges {
  const value = record(input);
  return {
    id: parseDesignFrameId(value['id']),
    name: frameName(value['name']),
    text: bounded(value['text'], DESIGN_SESSION_LIMITS.changesCharsMax, 'Design frame changes'),
    changedFiles: count(value['changedFiles']),
  };
}

function boundedList(input: unknown, itemsMax: number, what: string): readonly unknown[] {
  if (!Array.isArray(input)) {
    throw new Error(`${what}: expected a list`);
  }
  if (input.length > itemsMax) {
    throw new Error(`${what}: too many`);
  }
  return input;
}

/** A `design:session` reply, parsed in the renderer before it is trusted. */
export function parseDesignSessionReply(input: unknown): DesignSessionReply {
  const value = record(input);
  const kind = value['kind'];
  switch (kind) {
    case 'state':
      return { kind, state: parseState(value['state']) };
    case 'entered':
      return { kind, liveRoot: pathText(value['liveRoot']) };
    case 'refused': {
      const reason = DESIGN_ENTER_REFUSALS.find((entry) => entry === value['reason']);
      if (reason === undefined) {
        throw new Error('Design session: unknown refusal');
      }
      const folder = value['folder'] === undefined ? undefined : bounded(value['folder'], DESIGN_SESSION_LIMITS.pageCharsMax, 'Design refusal folder');
      return { kind, reason, folder };
    }
    case 'left':
      return { kind, realRoot: pathText(value['realRoot']) };
    case 'handoff':
      return { kind, handoff: value['handoff'] === undefined ? undefined : handoff(value['handoff']) };
    case 'images':
      return {
        kind,
        images: boundedList(value['images'], DESIGN_SESSION_LIMITS.framesMax, 'Design frame images').map((entry) => {
          const item = record(entry);
          return { frame: parseDesignFrameId(item['frame']), image: image(item['image']) };
        }),
      };
    case 'changes':
      return { kind, frames: boundedList(value['frames'], DESIGN_SESSION_LIMITS.framesMax, 'Design changes').map(frameChanges) };
    default:
      throw new Error(`Design session: unknown reply ${JSON.stringify(kind)}`);
  }
}

/** The channel's payload parser, spread into IPC_PAYLOADS (ipcPayloads.ts). */
export const DESIGN_SESSION_PAYLOADS = { 'design:session': parseDesignSessionRequest } as const;

/** The channel's result, joined into IpcResults (ipcResults.ts). */
export interface DesignSessionResults {
  readonly 'design:session': DesignSessionReply;
}
