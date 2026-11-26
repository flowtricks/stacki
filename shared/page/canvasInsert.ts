// A node chosen in the insert palette appears on the canvas the moment it is chosen.
//
// Measured before this existed (docs/insert-latency.md): the Navigator and the selection took
// the new node at once, and the canvas followed only after the page was written, the dev
// server compiled and rendered it again, and the morph client patched the result in: the time a
// person spends looking at an empty place wondering whether the Enter key did anything. The
// canvas does not need the server to know what a new `<p>` looks like: the editor already built
// the node from the template the writer emits (`insertedNode`), so this module says what a
// stand-in for it is, and where it goes; the frame builds it (electron/preload/framePendingInsert.ts)
// and the rebuilt page replaces it, as it replaces a reorder shown ahead of its write
// (shared/page/canvasMove.ts).
//
// This module is the pure half both products share: the plan (which place, which sibling to
// stand beside), the stand-in's description, how every node path renumbers, and the boundary
// parser for what crosses into the frame. A path is an index trail through the parse (`0.2.1`:
// the root list's first node, its third child, that child's second), so an insert renumbers
// the siblings from the gap on, and everything beneath them. Pure: no I/O, no globals.

import { assert } from '../core/assert';
import { LIMITS } from '../core/limits';
import { twinOf } from './canvasTwin';
import { HTML_VOID_TAGS } from './htmlTags';

/** What the canvas shows ahead of the render: an element built like the writer's, a copy of what the
 * page already rendered, or a component only the server can render (framePendingInsert.ts). */
export type CanvasInsertNode =
  | {
      readonly kind: 'element';
      readonly tag: string;
      readonly attributes: readonly (readonly [string, string])[];
      /** The words the template puts inside; undefined for a void tag and an empty element. */
      readonly text: string | undefined;
    }
  | { readonly kind: 'component'; readonly name: string }
  /** A copy of the elements the node at `from` renders: the frame clones them, subtree and all. A duplicate,
   * or a component the page already holds written the same way (canvasTwin.ts), named in `twinOf`, so
   * the frame can wait for the render when that copy cannot be taken. */
  | { readonly kind: 'clone'; readonly from: readonly number[]; readonly twinOf?: string }
  /** A plain element put around the node at `from`, which becomes its only child (a wrap). */
  | { readonly kind: 'wrap'; readonly tag: string; readonly from: readonly number[] };

/** Where the stand-in's elements go: beside a sibling that renders elements, or inside an empty parent. */
export type CanvasInsertPlacement = 'before' | 'after' | 'inside';

export interface CanvasInsert {
  /** The file prefix of every path in the insert: '' for the page, `file|` for an open component. */
  readonly scope: string;
  /** The parent's path; empty for the root list. Numbered as before the insert. */
  readonly parent: readonly number[];
  /** The gap in the parent's list the node lands in, counted as before the insert. */
  readonly index: number;
  /** The sibling the stand-in is placed beside (numbered as before the insert), or the parent itself for `inside`. */
  readonly anchor: { readonly path: readonly number[]; readonly placement: CanvasInsertPlacement };
  readonly node: CanvasInsertNode;
}

/** The tree an insert is planned over: the editor's model, or Studio's parse. */
export interface CanvasInsertTreeNode extends CanvasInsertSource {
  readonly id?: string | undefined;
  readonly children?: readonly CanvasInsertTreeNode[] | undefined;
}

/** What `planCanvasInsert` reads of the node being inserted: the editor's node fits. */
export interface CanvasInsertSource {
  readonly kind: string;
  readonly name?: string | undefined;
  readonly value?: string | undefined;
  readonly props?: Readonly<Record<string, { readonly type: string; readonly value?: string | undefined }>> | undefined;
  readonly children?: readonly CanvasInsertSource[] | undefined;
}

/** A place on the page: the parent the node goes inside (undefined for the root list) and its gap. */
export interface CanvasInsertPlace {
  readonly parentId: string | undefined;
  readonly index: number;
}

export const CANVAS_INSERT_LIMITS = {
  /** A scope is a file path and a bar; a project path is far shorter. */
  scopeCharsMax: 1_000,
  attributesMax: 32,
  attributeNameCharsMax: 64,
  attributeValueCharsMax: 2_048,
  textCharsMax: 1_024,
  tagCharsMax: 32,
  nameCharsMax: 128,
} as const satisfies Record<string, number>;

/** Kinds whose output is elements the canvas can find by path and stand beside. */
const PLACED_KINDS: ReadonlySet<string> = new Set(['element', 'component']);

/**
 * Tags a stand-in is never built from. Each either runs or loads something the moment it is
 * in the document (`script`, `iframe`, `object`, `embed`, `link`, `style`), changes how the
 * document is read (`meta`, `base`, `title`, `html`, `head`, `body`, `noscript`, `template`), or
 * has a content model of its own the stand-in cannot draw (`svg`, `math`). The rebuilt page shows those.
 */
const UNSAFE_TAGS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'link',
  'meta',
  'base',
  'title',
  'html',
  'head',
  'body',
  'noscript',
  'template',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'slot',
]);

const NODE_PATH = /^\d+(\.\d+)*$/;
const TAG_NAME = /^[a-z][a-z0-9-]*$/;
const ATTRIBUTE_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:.-]*$/;
const COMPONENT_NAME = /^[A-Za-z_$][\w$.-]*$/;

/**
 * The insert a palette pick makes on the canvas, or undefined when the canvas should leave it
 * to the rebuilt page: the node is not something a stand-in can be made of, the place is not
 * an element's own list, or the page has nothing rendered to stand beside. `pathOf` gives a
 * node's canvas path, scope included. Pure: it reads the tree as it was before the insert.
 */
export function planCanvasInsert(
  roots: readonly CanvasInsertTreeNode[],
  place: CanvasInsertPlace,
  source: CanvasInsertSource,
  pathOf: (id: string) => string | undefined,
): CanvasInsert | undefined {
  assert(Number.isSafeInteger(place.index), 'planCanvasInsert: a gap is an integer');
  assert(place.index >= 0, 'planCanvasInsert: a gap is not negative');
  const standIn = standInFor(source);
  if (standIn === undefined) {
    return undefined;
  }
  const destination = destinationOf(roots, place.parentId);
  if (destination === undefined) {
    return undefined;
  }
  const gap = Math.min(place.index, destination.list.length);
  const anchor = anchorBeside(destination.list, gap);
  const scope = scopeOf(destination.list, destination.parent, pathOf);
  if (scope === undefined) {
    return undefined;
  }
  const parent =
    destination.parent === undefined ? { scope: scope.scope, trail: [] as readonly number[] } : splitCanvasPath(pathOf(destination.parent.id ?? ''));
  if (parent === undefined || parent.scope !== scope.scope) {
    return undefined;
  }
  const node = standIn.kind === 'component' ? (copyOfTwin(roots, source, parent.scope, pathOf) ?? standIn) : standIn;
  if (anchor !== undefined) {
    const sibling = destination.list[anchor.index];
    const siblingPath = sibling?.id === undefined ? undefined : splitCanvasPath(pathOf(sibling.id));
    if (siblingPath === undefined || siblingPath.scope !== parent.scope) {
      return undefined;
    }
    assert(siblingPath.trail.at(-1) === anchor.index, 'planCanvasInsert: a sibling path ends at its index in its list');
    return { scope: parent.scope, parent: parent.trail, index: gap, anchor: { path: siblingPath.trail, placement: anchor.placement }, node };
  }
  // Nothing rendered to stand beside: only an element's own box can hold the first child.
  if (destination.parent?.kind !== 'element' || destination.list.some((sibling) => sibling.kind !== 'comment')) {
    return undefined;
  }
  return { scope: parent.scope, parent: parent.trail, index: gap, anchor: { path: parent.trail, placement: 'inside' }, node };
}

// The copy of an instance already rendered on the page, when one is written exactly as `source`, in the same file.
function copyOfTwin(
  roots: readonly CanvasInsertTreeNode[],
  source: CanvasInsertSource,
  scope: string,
  pathOf: (id: string) => string | undefined,
): CanvasInsertNode | undefined {
  const id = twinOf(roots, source);
  const found = id === undefined ? undefined : splitCanvasPath(pathOf(id));
  if (found === undefined || found.scope !== scope || source.name === undefined) {
    return undefined;
  }
  return { kind: 'clone', from: found.trail, twinOf: source.name };
}

/**
 * The insert a duplicate makes: a copy of the node's rendered elements right after the original's.
 * Undefined when the node is not an element or component the canvas can find, or has no path.
 */
export function planCanvasClone(roots: readonly CanvasInsertTreeNode[], nodeId: string, pathOf: (id: string) => string | undefined): CanvasInsert | undefined {
  const pending: { readonly list: readonly CanvasInsertTreeNode[]; readonly parent: CanvasInsertTreeNode | undefined }[] = [{ list: roots, parent: undefined }];
  for (let visited = 0; visited < pending.length; visited += 1) {
    assert(visited < LIMITS.treeNodesMax, 'planCanvasClone: a tree stays inside its node bound');
    const entry = pending[visited];
    assert(entry !== undefined, 'planCanvasClone: the visit index lies inside the queue');
    for (const [index, node] of entry.list.entries()) {
      if (node.id === nodeId) {
        if (!PLACED_KINDS.has(node.kind)) {
          return undefined;
        }
        const own = splitCanvasPath(pathOf(nodeId));
        if (own === undefined || own.trail.at(-1) !== index) {
          return undefined;
        }
        const parent = own.trail.slice(0, -1);
        return { scope: own.scope, parent, index: index + 1, anchor: { path: own.trail, placement: 'after' }, node: { kind: 'clone', from: own.trail } };
      }
      if (node.children !== undefined) {
        pending.push({ list: node.children, parent: node });
      }
    }
  }
  return undefined;
}

/**
 * The insert a wrap makes: a plain element where the node stood, the node inside it as the only child.
 * Undefined for a tag a stand-in is never made of, or a node the canvas cannot find.
 */
export function planCanvasWrap(
  roots: readonly CanvasInsertTreeNode[],
  nodeId: string,
  tag: string,
  pathOf: (id: string) => string | undefined,
): CanvasInsert | undefined {
  if (!TAG_NAME.test(tag) || UNSAFE_TAGS.has(tag) || HTML_VOID_TAGS.has(tag) || tag.length > CANVAS_INSERT_LIMITS.tagCharsMax) {
    return undefined;
  }
  const clone = planCanvasClone(roots, nodeId, pathOf);
  if (clone === undefined || clone.node.kind !== 'clone') {
    return undefined;
  }
  const from = clone.node.from;
  return { scope: clone.scope, parent: clone.parent, index: clone.index - 1, anchor: { path: from, placement: 'before' }, node: { kind: 'wrap', tag, from } };
}

/** Where `token`, numbered as before a wrap of the node at `insert.parent + index`, is numbered after it: everything under the node gains one step. */
export function renumberedWrapPath(token: string, insert: Pick<CanvasInsert, 'scope' | 'parent' | 'index'>): string {
  if (!token.startsWith(insert.scope)) {
    return token;
  }
  const local = token.slice(insert.scope.length);
  if (!NODE_PATH.test(local)) {
    return token;
  }
  const trail = local.split('.').map(Number);
  const at = insert.parent.length;
  for (let step = 0; step < at; step += 1) {
    if (trail[step] !== insert.parent[step]) {
      return token;
    }
  }
  if (trail.length <= at || trail[at] !== insert.index) {
    return token;
  }
  return insert.scope + [...trail.slice(0, at + 1), 0, ...trail.slice(at + 1)].join('.');
}

/** Where `token` (a `data-avb-p` token or marker path), numbered as before the insert, is numbered after it. */
export function renumberedInsertPath(token: string, insert: Pick<CanvasInsert, 'scope' | 'parent' | 'index'>): string {
  if (!token.startsWith(insert.scope)) {
    return token;
  }
  const local = token.slice(insert.scope.length);
  if (!NODE_PATH.test(local)) {
    return token; // Another file's path, or not a node path at all.
  }
  const trail = local.split('.').map(Number);
  const at = insert.parent.length;
  if (trail.length <= at) {
    return token;
  }
  for (let step = 0; step < at; step += 1) {
    if (trail[step] !== insert.parent[step]) {
      return token;
    }
  }
  const index = trail[at] ?? 0;
  if (index < insert.index) {
    return token;
  }
  const renumbered = [...trail.slice(0, at), index + 1, ...trail.slice(at + 1)];
  assert(
    renumbered.every((step) => Number.isSafeInteger(step) && step >= 0),
    'renumberedInsertPath: indexes stay natural numbers',
  );
  return insert.scope + renumbered.join('.');
}

/** The path the new node has once it is inserted. */
export function insertedNodeToken(insert: Pick<CanvasInsert, 'scope' | 'parent' | 'index'>): string {
  return insert.scope + [...insert.parent, insert.index].join('.');
}

/** The boundary parser for an insert crossing into the frame. */
export function parseCanvasInsert(input: unknown): CanvasInsert | undefined {
  const record = recordOf(input);
  if (record === undefined) {
    return undefined;
  }
  const scope = record['scope'];
  const index = record['index'];
  const parent = trailOf(record['parent']);
  const anchor = anchorOf(record['anchor']);
  const node = nodeOf(record['node']);
  if (typeof scope !== 'string' || scope.length > CANVAS_INSERT_LIMITS.scopeCharsMax || (scope !== '' && !scope.endsWith('|'))) {
    return undefined;
  }
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index > LIMITS.treeNodesMax) {
    return undefined;
  }
  if (parent === undefined || anchor === undefined || node === undefined) {
    return undefined;
  }
  return { scope, parent, index, anchor, node };
}

// --- Internals ---------------------------------------------------------------------

function isComponentName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= CANVAS_INSERT_LIMITS.nameCharsMax && COMPONENT_NAME.test(name);
}

// What a stand-in is made of: the template's own tag, its plain string attributes and its
// starting words; a component is only its name.
function standInFor(source: CanvasInsertSource): CanvasInsertNode | undefined {
  const name = source.name;
  if (name === undefined) {
    return undefined;
  }
  if (source.kind === 'component') {
    return isComponentName(name) ? { kind: 'component', name } : undefined;
  }
  if (source.kind !== 'element') {
    return undefined;
  }
  if (!TAG_NAME.test(name) || name.length > CANVAS_INSERT_LIMITS.tagCharsMax || UNSAFE_TAGS.has(name)) {
    return undefined;
  }
  const attributes: (readonly [string, string])[] = [];
  for (const [attribute, value] of Object.entries(source.props ?? {})) {
    if (value.type !== 'string' || value.value === undefined) {
      continue; // An expression has no value until the page renders.
    }
    if (!isSafeAttribute(attribute, value.value)) {
      return undefined;
    }
    attributes.push([attribute, value.value]);
  }
  if (attributes.length > CANVAS_INSERT_LIMITS.attributesMax) {
    return undefined;
  }
  const first = source.children?.[0];
  const text = first?.kind === 'text' && source.children?.length === 1 ? first.value : undefined;
  if (source.children !== undefined && source.children.length > 0 && text === undefined) {
    return undefined; // Children the stand-in cannot draw from the template: the render shows them.
  }
  if (text !== undefined && (HTML_VOID_TAGS.has(name) || text.length > CANVAS_INSERT_LIMITS.textCharsMax)) {
    return undefined;
  }
  return { kind: 'element', tag: name, attributes, text };
}

/** Whether an attribute may be set on a stand-in: no handler, no overlong value, a legal name. */
export function isSafeAttribute(name: string, value: string): boolean {
  if (!ATTRIBUTE_NAME.test(name) || name.length > CANVAS_INSERT_LIMITS.attributeNameCharsMax) {
    return false;
  }
  if (name.toLowerCase().startsWith('on')) {
    return false; // A handler would run on the stand-in; the render's own would run on the real node.
  }
  if (name.toLowerCase().startsWith('data-avb')) {
    return false; // The frame's own marks are the frame's to write.
  }
  return value.length <= CANVAS_INSERT_LIMITS.attributeValueCharsMax;
}

interface Destination {
  readonly list: readonly CanvasInsertTreeNode[];
  readonly parent: CanvasInsertTreeNode | undefined;
}

function destinationOf(roots: readonly CanvasInsertTreeNode[], parentId: string | undefined): Destination | undefined {
  if (parentId === undefined) {
    return { list: roots, parent: undefined };
  }
  const pending: (readonly CanvasInsertTreeNode[])[] = [roots];
  for (let visited = 0; visited < pending.length; visited += 1) {
    assert(visited < LIMITS.treeNodesMax, 'destinationOf: a tree stays inside its node bound');
    const list = pending[visited];
    assert(list !== undefined, 'destinationOf: the visit index lies inside the queue');
    for (const node of list) {
      if (node.id === parentId) {
        // A loop, a condition and a branch add no element of their own: the stand-in cannot say where they render.
        return PLACED_KINDS.has(node.kind) ? { list: node.children ?? [], parent: node } : undefined;
      }
      if (node.children !== undefined) {
        pending.push(node.children);
      }
    }
  }
  return undefined;
}

// The sibling a gap stands beside, skipping comments (they render nothing). Only an element
// or component will do: text or an expression next to the gap leaves the order to the render.
function anchorBeside(list: readonly CanvasInsertTreeNode[], gap: number): { readonly index: number; readonly placement: 'before' | 'after' } | undefined {
  for (let index = gap; index < list.length; index += 1) {
    const kind = list[index]?.kind ?? '';
    if (kind !== 'comment') {
      if (PLACED_KINDS.has(kind)) {
        return { index, placement: 'before' };
      }
      break;
    }
  }
  for (let index = gap - 1; index >= 0; index -= 1) {
    const kind = list[index]?.kind ?? '';
    if (kind !== 'comment') {
      return PLACED_KINDS.has(kind) ? { index, placement: 'after' } : undefined;
    }
  }
  return undefined;
}

// The file prefix of the destination: read off the parent, or, for the root list, off any
// sibling that has a path.
function scopeOf(
  list: readonly CanvasInsertTreeNode[],
  parent: CanvasInsertTreeNode | undefined,
  pathOf: (id: string) => string | undefined,
): { readonly scope: string } | undefined {
  const holder = parent ?? list.find((sibling) => sibling.id !== undefined);
  if (holder?.id === undefined) {
    return undefined;
  }
  const split = splitCanvasPath(pathOf(holder.id));
  return split === undefined ? undefined : { scope: split.scope };
}

function splitCanvasPath(path: string | undefined): { readonly scope: string; readonly trail: readonly number[] } | undefined {
  if (path === undefined) {
    return undefined;
  }
  const bar = path.lastIndexOf('|');
  const scope = bar < 0 ? '' : path.slice(0, bar + 1);
  const local = path.slice(bar + 1);
  if (!NODE_PATH.test(local)) {
    return undefined;
  }
  return { scope, trail: local.split('.').map(Number) };
}

function recordOf(input: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(input));
}

function trailOf(input: unknown): readonly number[] | undefined {
  if (!Array.isArray(input) || input.length > LIMITS.treeDepthMax + 1) {
    return undefined;
  }
  const trail: number[] = [];
  for (const step of input) {
    if (typeof step !== 'number' || !Number.isSafeInteger(step) || step < 0 || step > LIMITS.treeNodesMax) {
      return undefined;
    }
    trail.push(step);
  }
  return trail;
}

function anchorOf(input: unknown): CanvasInsert['anchor'] | undefined {
  const record = recordOf(input);
  if (record === undefined) {
    return undefined;
  }
  const placement = record['placement'];
  const path = trailOf(record['path']);
  if (path === undefined || (placement !== 'before' && placement !== 'after' && placement !== 'inside')) {
    return undefined;
  }
  if (placement !== 'inside' && path.length === 0) {
    return undefined;
  }
  return { path, placement };
}

function nodeOf(input: unknown): CanvasInsertNode | undefined {
  const record = recordOf(input);
  if (record === undefined) {
    return undefined;
  }
  if (record['kind'] === 'wrap') {
    const from = trailOf(record['from']);
    const tag = record['tag'];
    if (from === undefined || from.length === 0 || typeof tag !== 'string' || !TAG_NAME.test(tag) || UNSAFE_TAGS.has(tag) || HTML_VOID_TAGS.has(tag)) {
      return undefined;
    }
    return { kind: 'wrap', tag, from };
  }
  if (record['kind'] === 'clone') {
    const from = trailOf(record['from']);
    const twin = record['twinOf'];
    if (from === undefined || from.length === 0 || (twin !== undefined && !isComponentName(twin))) {
      return undefined;
    }
    return twin === undefined ? { kind: 'clone', from } : { kind: 'clone', from, twinOf: twin };
  }
  if (record['kind'] === 'component') {
    const name = record['name'];
    return isComponentName(name) ? { kind: 'component', name } : undefined;
  }
  if (record['kind'] !== 'element') {
    return undefined;
  }
  const tag = record['tag'];
  const text = record['text'];
  const list = record['attributes'];
  if (typeof tag !== 'string' || !TAG_NAME.test(tag) || tag.length > CANVAS_INSERT_LIMITS.tagCharsMax || UNSAFE_TAGS.has(tag)) {
    return undefined;
  }
  if (text !== undefined && (typeof text !== 'string' || text.length > CANVAS_INSERT_LIMITS.textCharsMax || HTML_VOID_TAGS.has(tag))) {
    return undefined;
  }
  if (!Array.isArray(list) || list.length > CANVAS_INSERT_LIMITS.attributesMax) {
    return undefined;
  }
  const attributes: (readonly [string, string])[] = [];
  for (const entry of list) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      return undefined;
    }
    const name: unknown = entry[0];
    const value: unknown = entry[1];
    if (typeof name !== 'string' || typeof value !== 'string' || !isSafeAttribute(name, value)) {
      return undefined;
    }
    attributes.push([name, value]);
  }
  return { kind: 'element', tag, attributes, text };
}
