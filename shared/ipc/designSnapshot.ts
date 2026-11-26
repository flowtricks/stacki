// Design mode (experimental, removable: docs/design-mode/REMOVE.md): what the app asks the live canvas frame.
//
// A frame on Design mode's canvas is a snapshot of the page the one live canvas draws. The renderer cannot read
// that page (it is the dev server's origin), so it asks the frame's preload, over postMessage:
// `stacki:design-snapshot` answers with a copy of the document as drawn now, each element that stands for a node
// of the open file marked with that node's path; `stacki:design-watch` makes the frame say when its styles change;
// `stacki:design-page-html` answers with the page as the dev server renders it now, markers and all, which is what
// unlinking a component reads (src/app/designMode/designUnlink.ts).
// Both ends parse what they receive: the page on the canvas is the person's own site, and may post anything.
import { count, record, text } from '../core/boundary';

export const DESIGN_SNAPSHOT_LIMITS = {
  /** Elements one frame holds. A page past this is refused: eight of them would not fit the memory budget. */
  elementsMax: 20_000,
  /** One frame's document, in characters, fonts included. */
  htmlCharsMax: 10_000_000,
  /** A page's own pictures copied into one snapshot, together and each, in characters. */
  assetsCharsMax: 5_000_000,
  assetCharsMax: 900_000,
  /** What one report of a live preview names. */
  liveSheetsMax: 400,
  liveElementsMax: 400,
  /** Every frame's document together, as the canvas holds them. */
  totalCharsMax: 48_000_000,
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

/** On each element and stylesheet of a snapshot: the id a live preview's report names it by. */
export const DESIGN_ID_ATTRIBUTE = 'data-dm-id';

export interface DesignLiveSheet {
  readonly id: number;
  readonly css: string;
}

export interface DesignLiveElement {
  readonly id: number;
  readonly style: string | undefined;
  readonly className: string | undefined;
}

/** `window.name` of a canvas frame's iframe, which the preload reads to install nothing in it. */
export const DESIGN_FRAME_WINDOW_NAME = 'stacki-design-frame';

/** An element's nodes, space separated marks (designNodeMark). The copy numbers a node drawn once per loop item. */
export const DESIGN_NODE_ATTRIBUTE = 'data-dm-node';

/** One mark: the node's path, encoded because a component's file name may hold spaces, then the copy. */
export function designNodeMark(path: string, copy: number): string {
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

export type DesignSnapshotRequest =
  | { readonly type: 'stacki:design-snapshot'; readonly nonce: string }
  | { readonly type: 'stacki:design-page-html'; readonly nonce: string }
  | { readonly type: 'stacki:design-watch' };

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

/** Why the page's rendered text could not be read: the dev server's answer was not a page, too long, or failed. */
export const DESIGN_PAGE_HTML_FAILURES = ['not-a-page', 'too-large', 'failed'] as const;
export type DesignPageHtmlFailure = (typeof DESIGN_PAGE_HTML_FAILURES)[number];
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
  /** What a live preview changed on the page: rules and variable overrides, and elements' own styles and classes. */
  | {
      readonly type: 'stacki:design-live';
      readonly sheets: readonly DesignLiveSheet[];
      readonly elements: readonly DesignLiveElement[];
      readonly variables: string;
    }
  /** The page as the dev server renders it now: its text, unchanged, markers and all. */
  | { readonly type: 'stacki:design-page-html-reply'; readonly nonce: string; readonly ok: true; readonly html: string }
  | { readonly type: 'stacki:design-page-html-reply'; readonly nonce: string; readonly ok: false; readonly failure: DesignPageHtmlFailure }
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
  if ((input.type !== 'stacki:design-snapshot' && input.type !== 'stacki:design-page-html') || !('nonce' in input)) {
    return undefined;
  }
  const { nonce } = input;
  if (typeof nonce !== 'string' || nonce.length > DESIGN_SNAPSHOT_LIMITS.nonceCharsMax) {
    return undefined;
  }
  return { type: input.type, nonce };
}

function parseDesignLive(value: Readonly<Record<string, unknown>>): DesignCanvasMessage {
  const listed = (input: unknown, itemsMax: number, what: string): readonly Readonly<Record<string, unknown>>[] => {
    if (!Array.isArray(input) || input.length > itemsMax) {
      throw new Error(`${what}: expected a bounded list`);
    }
    return input.map((entry: unknown) => record(entry));
  };
  const optionalText = (input: unknown, what: string): string | undefined =>
    input === undefined ? undefined : bounded(input, DESIGN_SNAPSHOT_LIMITS.assetCharsMax, what);
  return {
    type: 'stacki:design-live',
    sheets: listed(value['sheets'], DESIGN_SNAPSHOT_LIMITS.liveSheetsMax, 'Design live sheets').map((sheet) => ({
      id: count(sheet['id']),
      css: bounded(sheet['css'], DESIGN_SNAPSHOT_LIMITS.htmlCharsMax, 'Design live sheet'),
    })),
    elements: listed(value['elements'], DESIGN_SNAPSHOT_LIMITS.liveElementsMax, 'Design live elements').map((element) => ({
      id: count(element['id']),
      style: optionalText(element['style'], 'Design live style'),
      className: optionalText(element['className'], 'Design live class'),
    })),
    variables: bounded(value['variables'], DESIGN_SNAPSHOT_LIMITS.assetCharsMax, 'Design live variables'),
  };
}

/** A message from the canvas frame, parsed; undefined for the editor's other messages and for a malformed one. */
export function parseDesignCanvasMessage(input: unknown): DesignCanvasMessage | undefined {
  if (typeof input !== 'object' || !input || !('type' in input)) {
    return undefined;
  }
  if (input.type === 'stacki:design-changed') {
    return { type: input.type };
  }
  if (input.type === 'stacki:design-live') {
    try {
      return parseDesignLive(record(input));
    } catch {
      return undefined;
    }
  }
  if (input.type === 'stacki:design-page-html-reply') {
    return parsePageHtmlReply(input);
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

function parsePageHtmlReply(input: object): DesignCanvasMessage | undefined {
  try {
    const value = record(input);
    const nonce = bounded(value['nonce'], DESIGN_SNAPSHOT_LIMITS.nonceCharsMax, 'Design nonce');
    if (value['ok'] === true) {
      const html = bounded(value['html'], DESIGN_SNAPSHOT_LIMITS.htmlCharsMax, 'Design page text');
      return { type: 'stacki:design-page-html-reply', nonce, ok: true, html };
    }
    const failure = DESIGN_PAGE_HTML_FAILURES.find((entry) => entry === value['failure']) ?? 'failed';
    return { type: 'stacki:design-page-html-reply', nonce, ok: false, failure };
  } catch {
    return undefined;
  }
}
