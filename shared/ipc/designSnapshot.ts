// Design mode (experimental, removable: docs/design-mode/REMOVE.md): what the app asks the live canvas frame.
//
// A frame on Design mode's canvas is a snapshot of the page the one live canvas draws. The renderer cannot read
// that page (it is the dev server's origin), so it asks the frame's preload, over postMessage:
// `stacki:design-snapshot` answers with a copy of the document as drawn now, each element that stands for a node
// of the open file marked with that node's path; `stacki:design-watch` makes the frame say when its styles change.
// Both ends parse what they receive: the page on the canvas is the person's own site, and may post anything.
import { assert } from '../core/assert';
import { count, record, text } from '../core/boundary';

export const DESIGN_SNAPSHOT_LIMITS = {
  /** Elements one frame holds. A page past this is refused: eight of them would not fit the memory budget. */
  elementsMax: 20_000,
  /** One frame's document, in characters, fonts included. */
  htmlCharsMax: 6_000_000,
  /** Every frame's document together, as the canvas holds them. */
  totalCharsMax: 32_000_000,
  /** Web fonts inlined into one snapshot, and their characters together and each. */
  fontsMax: 24,
  fontsCharsMax: 3_000_000,
  fontCharsMax: 1_200_000,
  titleCharsMax: 400,
  urlCharsMax: 2_000,
  nonceCharsMax: 64,
  detailCharsMax: 400,
  pixelsMax: 20_000,
} as const satisfies Record<string, number>;

/** `window.name` of a canvas frame's iframe, which the preload reads to install nothing in it. */
export const DESIGN_FRAME_WINDOW_NAME = 'stacki-design-frame';

/** An element's nodes, space separated marks (designNodeMark). The copy numbers a node drawn once per loop item. */
export const DESIGN_NODE_ATTRIBUTE = 'data-dm-node';

/** One mark: the node's path, encoded because a component's file name may hold spaces, then the copy. */
export function designNodeMark(path: string, copy: number): string {
  assert(Number.isSafeInteger(copy), 'A node copy is counted in whole numbers');
  assert(copy >= 0, 'A node copy is counted from zero');
  return `${encodeURIComponent(path)}:${String(copy)}`;
}

export interface DesignNodeAt {
  readonly path: string;
  readonly copy: number;
}

/** The node an element's marks name for a press on it: the deepest of them. Undefined for none, or a forged one. */
export function deepestDesignNode(attribute: string): DesignNodeAt | undefined {
  let best: DesignNodeAt | undefined = undefined;
  for (const mark of attribute.split(' ').slice(0, 64)) {
    const colon = mark.lastIndexOf(':');
    const copy = Number(mark.slice(colon + 1));
    if (colon <= 0 || !Number.isSafeInteger(copy) || copy < 0) {
      continue;
    }
    let path: string;
    try {
      path = decodeURIComponent(mark.slice(0, colon));
    } catch {
      continue;
    }
    if (best === undefined || path.split('.').length > best.path.split('.').length) {
      best = { path, copy };
    }
  }
  return best;
}

export type DesignSnapshotRequest = { readonly type: 'stacki:design-snapshot'; readonly nonce: string } | { readonly type: 'stacki:design-watch' };

export interface DesignSnapshot {
  /** A whole document: scripts removed, stylesheets and fonts inlined, nodes marked. */
  readonly html: string;
  /** The page's address, without its fragment. */
  readonly url: string;
  readonly title: string;
  readonly viewportWidthPx: number;
  readonly viewportHeightPx: number;
}

export const DESIGN_SNAPSHOT_FAILURES = ['no-document', 'too-many-elements', 'too-large', 'failed'] as const;
export type DesignSnapshotFailure = (typeof DESIGN_SNAPSHOT_FAILURES)[number];

export type DesignCanvasMessage =
  | { readonly type: 'stacki:design-snapshot-reply'; readonly nonce: string; readonly ok: true; readonly snapshot: DesignSnapshot }
  | {
      readonly type: 'stacki:design-snapshot-reply';
      readonly nonce: string;
      readonly ok: false;
      readonly failure: DesignSnapshotFailure;
      readonly detail: string;
    }
  /** The page's styles changed under the watch (a stylesheet replaced by the dev server, a live rule). */
  | { readonly type: 'stacki:design-changed' };

function bounded(input: unknown, charsMax: number, what: string): string {
  const value = text(input);
  if (value.length > charsMax) {
    throw new Error(`${what}: exceeds ${charsMax} characters`);
  }
  return value;
}

function pixels(input: unknown, what: string): number {
  const value = count(input);
  if (value > DESIGN_SNAPSHOT_LIMITS.pixelsMax) {
    throw new Error(`${what}: too large`);
  }
  return value;
}

export function parseDesignSnapshot(input: unknown): DesignSnapshot {
  const value = record(input);
  const html = bounded(value['html'], DESIGN_SNAPSHOT_LIMITS.htmlCharsMax, 'Design snapshot');
  if (html.length === 0) {
    throw new Error('Design snapshot: expected a document');
  }
  return {
    html,
    url: bounded(value['url'], DESIGN_SNAPSHOT_LIMITS.urlCharsMax, 'Design snapshot address'),
    title: bounded(value['title'], DESIGN_SNAPSHOT_LIMITS.titleCharsMax, 'Design snapshot title'),
    viewportWidthPx: pixels(value['viewportWidthPx'], 'Design snapshot width'),
    viewportHeightPx: pixels(value['viewportHeightPx'], 'Design snapshot height'),
  };
}

/** A request as the canvas frame receives it, or undefined for any other message. */
export function parseDesignSnapshotRequest(input: unknown): DesignSnapshotRequest | undefined {
  if (typeof input !== 'object' || !input || !('type' in input)) {
    return undefined;
  }
  if (input.type === 'stacki:design-watch') {
    return { type: input.type };
  }
  if (input.type !== 'stacki:design-snapshot' || !('nonce' in input)) {
    return undefined;
  }
  const { nonce } = input;
  if (typeof nonce !== 'string' || nonce.length > DESIGN_SNAPSHOT_LIMITS.nonceCharsMax) {
    return undefined;
  }
  return { type: input.type, nonce };
}

/** A message from the canvas frame, parsed; undefined for the editor's other messages and for a malformed one. */
export function parseDesignCanvasMessage(input: unknown): DesignCanvasMessage | undefined {
  if (typeof input !== 'object' || !input || !('type' in input)) {
    return undefined;
  }
  if (input.type === 'stacki:design-changed') {
    return { type: input.type };
  }
  if (input.type !== 'stacki:design-snapshot-reply') {
    return undefined;
  }
  try {
    const value = record(input);
    const nonce = bounded(value['nonce'], DESIGN_SNAPSHOT_LIMITS.nonceCharsMax, 'Design nonce');
    if (value['ok'] === true) {
      return { type: input.type, nonce, ok: true, snapshot: parseDesignSnapshot(value['snapshot']) };
    }
    const failure = DESIGN_SNAPSHOT_FAILURES.find((entry) => entry === value['failure']) ?? 'failed';
    const detail = bounded(value['detail'], DESIGN_SNAPSHOT_LIMITS.detailCharsMax, 'Design detail');
    return { type: input.type, nonce, ok: false, failure, detail };
  } catch {
    return undefined;
  }
}
