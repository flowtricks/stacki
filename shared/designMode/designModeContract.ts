// Design mode (experimental, removable: docs/design-mode/REMOVE.md): the messages the renderer and the
// canvas frame exchange, and the body of the dev server's design render route.
//
// Design mode never writes. Its frames are copies of the rendered page that live in the renderer; the canvas
// frame only hands over a copy of its document (`snapshot`) and, because it shares the dev server's origin,
// relays two read-only requests the renderer cannot make itself from a file:// page: a component rendered
// with props (`render`, POST /__avb/design-render) and a component's palette preview (`preview`,
// GET /__avb/preview). Every value crosses a postMessage or an HTTP body, so both ends parse it here.
//
// This folder imports nothing: shared/designMode is not one of the contract layer's areas, so it stands on
// its own and is deleted whole with the feature.

/** The single switch. False: no entry in the AI panel, no frame listener, and an inert dev server plugin. */
export const DESIGN_MODE_ENABLED = true;

export const DESIGN_MODE_LIMITS = {
  nonceCharsMax: 64,
  /** A whole page copied with its stylesheets and fonts inlined. */
  snapshotCharsMax: 48_000_000,
  /** One inlined font file, and all of them together, as base64 characters. */
  fontCharsMax: 8_000_000,
  fontsCharsMax: 32_000_000,
  fontsMax: 64,
  /** The reply of a relayed request (a rendered component, a preview page). */
  replyCharsMax: 12_000_000,
  componentPathCharsMax: 1_000,
  propNameCharsMax: 100,
  propsMax: 200,
  /** A prop's JSON-encoded value. */
  propValueCharsMax: 64_000,
  /** How deep a prop's JSON value may nest, and how many items or keys one level may hold. */
  jsonDepthMax: 8,
  jsonEntriesMax: 1_000,
  slotsMax: 32,
  slotCharsMax: 4_000_000,
  slotNameCharsMax: 100,
  urlCharsMax: 4_096,
  titleCharsMax: 1_000,
  detailCharsMax: 2_000,
  pixelsMax: 100_000,
} as const;

/** Every message the renderer sends the canvas frame for Design mode carries this type. */
export const DESIGN_MODE_REQUEST_TYPE = 'avb:design-mode';
/** And every answer carries this one. */
export const DESIGN_MODE_REPLY_TYPE = 'avb:design-mode-reply';
/** The dev server route a `render` request posts to. */
export const DESIGN_RENDER_ROUTE = '/__avb/design-render';
/** The name every sandbox frame carries, so the preload installs nothing in it (it is the renderer's document). */
export const DESIGN_SANDBOX_FRAME_NAME = 'stacki-design-mode-sandbox';

// eslint-disable-next-line stacki/no-null -- JSON's own null is a value a prop can hold, not absence.
export type DesignJson = string | number | boolean | null | readonly DesignJson[] | { readonly [key: string]: DesignJson };

export interface DesignRenderBody {
  /** Project-relative path of the component file, under src/. */
  readonly component: string;
  readonly props: Readonly<Record<string, DesignJson>>;
  /** Slot name to HTML. `default` is the default slot. */
  readonly slots: Readonly<Record<string, string>>;
}

export type DesignModeRequest =
  | { readonly op: 'snapshot'; readonly nonce: string }
  | { readonly op: 'render'; readonly nonce: string; readonly body: DesignRenderBody }
  | { readonly op: 'preview'; readonly nonce: string; readonly component: string };

export interface DesignSnapshot {
  readonly html: string;
  /** The page's address: the frames resolve its relative URLs against it. */
  readonly url: string;
  readonly title: string;
  readonly viewportWidthPx: number;
  readonly viewportHeightPx: number;
}

export const DESIGN_MODE_FAILURES = ['no-document', 'too-large', 'fetch-failed', 'refused'] as const;
export type DesignModeFailure = (typeof DESIGN_MODE_FAILURES)[number];

export type DesignModeReply =
  | { readonly nonce: string; readonly ok: true; readonly kind: 'snapshot'; readonly snapshot: DesignSnapshot }
  | { readonly nonce: string; readonly ok: true; readonly kind: 'html'; readonly html: string }
  | { readonly nonce: string; readonly ok: false; readonly failure: DesignModeFailure; readonly detail: string };

function check(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error('Assertion failed: ' + message);
  }
}

/** A plain object's own fields, read as unknown and checked one by one by the caller. */
interface Fields {
  readonly keys: readonly string[];
  readonly get: (key: string) => unknown;
}

function fieldsOf(input: unknown): Fields | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return undefined;
  }
  return { keys: Object.keys(input), get: (key): unknown => (Object.hasOwn(input, key) ? (Reflect.get(input, key) as unknown) : undefined) };
}

function boundedString(input: unknown, charsMax: number): string | undefined {
  if (typeof input !== 'string') {
    return undefined;
  }
  return input.length <= charsMax ? input : undefined;
}

const NONCE = /^[A-Za-z0-9-]{8,64}$/;
const PROP_NAME = /^[A-Za-z_$][\w$-]*$/;
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** A component path the render route accepts: a project-relative `.astro` file under src/, outside src/pages, with no `..`. */
export function isDesignComponentPath(input: unknown): input is string {
  if (typeof input !== 'string' || input.length > DESIGN_MODE_LIMITS.componentPathCharsMax) {
    return false;
  }
  if (!/^src\/[A-Za-z0-9_@ ./[\]()-]+\.astro$/.test(input)) {
    return false;
  }
  if (input.startsWith('src/pages/')) {
    return false;
  }
  return input.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** A JSON value from untrusted input, or undefined. Depth is bounded, so the recursion is too. */
function designJson(input: unknown, depth: number): DesignJson | undefined {
  check(depth >= 0, 'designJson: a depth is never negative');
  if (depth > DESIGN_MODE_LIMITS.jsonDepthMax) {
    return undefined;
  }
  if (input === null || typeof input === 'string' || typeof input === 'boolean') {
    return input;
  }
  if (typeof input === 'number') {
    return Number.isFinite(input) ? input : undefined;
  }
  if (Array.isArray(input)) {
    if (input.length > DESIGN_MODE_LIMITS.jsonEntriesMax) {
      return undefined;
    }
    const items: DesignJson[] = [];
    for (const item of input) {
      const value = designJson(item, depth + 1);
      if (value === undefined) {
        return undefined;
      }
      items.push(value);
    }
    return items;
  }
  const fields = fieldsOf(input);
  if (fields === undefined || fields.keys.length > DESIGN_MODE_LIMITS.jsonEntriesMax) {
    return undefined;
  }
  const result: Record<string, DesignJson> = {};
  for (const key of fields.keys) {
    if (FORBIDDEN_KEYS.has(key)) {
      return undefined;
    }
    const value = designJson(fields.get(key), depth + 1);
    if (value === undefined) {
      return undefined;
    }
    result[key] = value;
  }
  return result;
}

function propsOf(input: unknown): Record<string, DesignJson> | undefined {
  const fields = fieldsOf(input);
  if (fields === undefined || fields.keys.length > DESIGN_MODE_LIMITS.propsMax) {
    return undefined;
  }
  const props: Record<string, DesignJson> = {};
  for (const name of fields.keys) {
    if (name.length > DESIGN_MODE_LIMITS.propNameCharsMax || !PROP_NAME.test(name) || FORBIDDEN_KEYS.has(name)) {
      return undefined;
    }
    const value = designJson(fields.get(name), 0);
    if (value === undefined || JSON.stringify(value).length > DESIGN_MODE_LIMITS.propValueCharsMax) {
      return undefined;
    }
    props[name] = value;
  }
  return props;
}

function slotsOf(input: unknown): Record<string, string> | undefined {
  const fields = fieldsOf(input);
  if (fields === undefined || fields.keys.length > DESIGN_MODE_LIMITS.slotsMax) {
    return undefined;
  }
  const slots: Record<string, string> = {};
  for (const name of fields.keys) {
    if (name.length > DESIGN_MODE_LIMITS.slotNameCharsMax || !PROP_NAME.test(name) || FORBIDDEN_KEYS.has(name)) {
      return undefined;
    }
    const html = boundedString(fields.get(name), DESIGN_MODE_LIMITS.slotCharsMax);
    if (html === undefined) {
      return undefined;
    }
    slots[name] = html;
  }
  return slots;
}

/** The render route's body, or undefined when any part of it is not one. */
export function parseDesignRenderBody(input: unknown): DesignRenderBody | undefined {
  const fields = fieldsOf(input);
  if (fields === undefined) {
    return undefined;
  }
  const component = fields.get('component');
  if (!isDesignComponentPath(component)) {
    return undefined;
  }
  const props = propsOf(fields.get('props'));
  const slots = slotsOf(fields.get('slots'));
  if (props === undefined || slots === undefined) {
    return undefined;
  }
  return { component, props, slots };
}

function nonceOf(fields: Fields): string | undefined {
  const nonce = boundedString(fields.get('nonce'), DESIGN_MODE_LIMITS.nonceCharsMax);
  return nonce !== undefined && NONCE.test(nonce) ? nonce : undefined;
}

/** A request from the renderer, as the canvas frame reads it, or undefined when the message is not one. */
export function parseDesignModeRequest(input: unknown): DesignModeRequest | undefined {
  const fields = fieldsOf(input);
  if (fields === undefined || fields.get('type') !== DESIGN_MODE_REQUEST_TYPE) {
    return undefined;
  }
  const nonce = nonceOf(fields);
  if (nonce === undefined) {
    return undefined;
  }
  const op = fields.get('op');
  if (op === 'snapshot') {
    return { op: 'snapshot', nonce };
  }
  if (op === 'render') {
    const body = parseDesignRenderBody(fields.get('body'));
    return body === undefined ? undefined : { op: 'render', nonce, body };
  }
  if (op === 'preview') {
    const component = fields.get('component');
    return isDesignComponentPath(component) ? { op: 'preview', nonce, component } : undefined;
  }
  return undefined;
}

/** The message that carries `request` to the frame. */
export function designModeRequestMessage(request: DesignModeRequest): Readonly<Record<string, unknown>> {
  check(NONCE.test(request.nonce), 'designModeRequestMessage: a nonce of the request grammar');
  const message = { type: DESIGN_MODE_REQUEST_TYPE, ...request };
  check(parseDesignModeRequest(message) !== undefined, 'designModeRequestMessage: the message parses back');
  return message;
}

function pixelsOf(input: unknown): number | undefined {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    return undefined;
  }
  if (input < 0) {
    return undefined;
  }
  return input <= DESIGN_MODE_LIMITS.pixelsMax ? input : undefined;
}

function snapshotOf(input: unknown): DesignSnapshot | undefined {
  const fields = fieldsOf(input);
  if (fields === undefined) {
    return undefined;
  }
  const html = boundedString(fields.get('html'), DESIGN_MODE_LIMITS.snapshotCharsMax);
  const url = boundedString(fields.get('url'), DESIGN_MODE_LIMITS.urlCharsMax);
  const title = boundedString(fields.get('title'), DESIGN_MODE_LIMITS.titleCharsMax);
  const viewportWidthPx = pixelsOf(fields.get('viewportWidthPx'));
  const viewportHeightPx = pixelsOf(fields.get('viewportHeightPx'));
  if (html === undefined || url === undefined || title === undefined) {
    return undefined;
  }
  if (viewportWidthPx === undefined || viewportHeightPx === undefined) {
    return undefined;
  }
  return /^https?:\/\//.test(url) ? { html, url, title, viewportWidthPx, viewportHeightPx } : undefined;
}

/** An answer from the frame, as the renderer reads it, or undefined when the message is not one. */
export function parseDesignModeReply(input: unknown): DesignModeReply | undefined {
  const fields = fieldsOf(input);
  if (fields === undefined || fields.get('type') !== DESIGN_MODE_REPLY_TYPE) {
    return undefined;
  }
  const nonce = nonceOf(fields);
  if (nonce === undefined) {
    return undefined;
  }
  const ok = fields.get('ok');
  if (ok === false) {
    const failureInput = fields.get('failure');
    const failure = DESIGN_MODE_FAILURES.find((candidate) => candidate === failureInput);
    const detail = boundedString(fields.get('detail'), DESIGN_MODE_LIMITS.detailCharsMax);
    return failure === undefined || detail === undefined ? undefined : { nonce, ok: false, failure, detail };
  }
  if (ok !== true) {
    return undefined;
  }
  const kind = fields.get('kind');
  if (kind === 'html') {
    const html = boundedString(fields.get('html'), DESIGN_MODE_LIMITS.replyCharsMax);
    return html === undefined ? undefined : { nonce, ok: true, kind: 'html', html };
  }
  if (kind === 'snapshot') {
    const snapshot = snapshotOf(fields.get('snapshot'));
    return snapshot === undefined ? undefined : { nonce, ok: true, kind: 'snapshot', snapshot };
  }
  return undefined;
}

/** The message that carries `reply` back to the renderer. */
export function designModeReplyMessage(reply: DesignModeReply): Readonly<Record<string, unknown>> {
  check(NONCE.test(reply.nonce), 'designModeReplyMessage: a nonce of the request grammar');
  const message = { type: DESIGN_MODE_REPLY_TYPE, ...reply };
  return message;
}
