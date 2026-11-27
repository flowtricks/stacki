// What a change to the page model does to the canvas, worked out from the model alone, so the canvas
// shows it in the frame the change is made in (docs/instant-edits.md).
//
// The editor already holds the page before and after a gesture. Where a node keeps its place and
// only its attributes, its words or its tag change, the result is as predictable as the template the
// writer emits: set these attributes, remove those, put these words in, rename the tag. Where the
// result needs the server (a component's props reach code, an attribute is an expression), the
// closest honest thing is to keep the old DOM and say the element is updating, never to blank it.
// A node that was added or removed (insert, delete, undo of either) is `singleStructuralChange`.
//
// Pure: no I/O, no globals. The frame applies and reconciles these (electron/preload/framePendingEdit.ts).

import { assert } from '../core/assert';
import { LIMITS } from '../core/limits';
import { HTML_VOID_TAGS } from './htmlTags';
import { CANVAS_INSERT_LIMITS, isSafeAttribute } from './canvasInsert';

/** One change to nodes the canvas already shows. `path` is the node's canvas path, scope included. */
export type CanvasEdit =
  | { readonly kind: 'attributes'; readonly path: string; readonly set: readonly (readonly [string, string])[]; readonly remove: readonly string[] }
  | { readonly kind: 'text'; readonly path: string; readonly text: string }
  | { readonly kind: 'tag'; readonly path: string; readonly tag: string }
  // Single classes put on or taken off, keeping the rest: a component instance's class, which the
  // canvas shows on the component's own root, beside the classes the component writes there.
  | { readonly kind: 'classes'; readonly path: string; readonly add: readonly string[]; readonly remove: readonly string[] }
  | { readonly kind: 'updating'; readonly path: string };

/** The model's node, as far as a diff reads it. */
export interface EditTreeNode {
  readonly id: string;
  readonly kind: string;
  readonly name?: string | undefined;
  readonly value?: string | undefined;
  readonly props?: Readonly<Record<string, { readonly type: string; readonly value?: string | undefined }>> | undefined;
  readonly children?: readonly EditTreeNode[] | undefined;
}

export const CANVAS_EDIT_LIMITS = {
  /** Edits one gesture shows. */
  editsMax: 64,
  /** Nodes one diff visits. */
  nodesMax: LIMITS.treeNodesMax,
  textCharsMax: CANVAS_INSERT_LIMITS.textCharsMax,
  /** Class names one edit adds and removes together. */
  classNamesMax: 64,
  classNameCharsMax: 256,
} as const satisfies Record<string, number>;

const TAG_NAME = /^[a-z][a-z0-9-]*$/;
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

/**
 * The edits that take the canvas from `before` to `after`, for nodes in the same place in both.
 * `structural` is true when a node was added, removed or moved anywhere: those are shown by their
 * own paths (insert, delete, reorder), and this reports only what it can say about the rest.
 */
export function planModelEdits(
  before: readonly EditTreeNode[],
  after: readonly EditTreeNode[],
  pathOf: (id: string) => string | undefined,
): { readonly edits: readonly CanvasEdit[]; readonly structural: boolean } {
  const edits: CanvasEdit[] = [];
  let structural = false;
  const pending: (readonly [readonly EditTreeNode[], readonly EditTreeNode[]])[] = [[before, after]];
  let visited = 0;
  for (let at = 0; at < pending.length; at += 1) {
    const pair = pending[at];
    assert(pair !== undefined, 'planModelEdits: the visit index lies inside the queue');
    const [left, right] = pair;
    if (!sameIds(left, right)) {
      structural = true;
    }
    const byId = new Map(left.map((node) => [node.id, node]));
    for (const next of right) {
      visited += 1;
      assert(visited <= CANVAS_EDIT_LIMITS.nodesMax, 'planModelEdits: a diff stays inside the node bound');
      const previous = byId.get(next.id);
      if (previous === undefined) {
        continue;
      }
      const found = editsFor(previous, next, pathOf);
      edits.push(...found);
      if (previous.children !== undefined && next.children !== undefined) {
        pending.push([previous.children, next.children]);
      }
    }
  }
  return { edits: edits.slice(0, CANVAS_EDIT_LIMITS.editsMax), structural };
}

/** The one node an edit added or removed, when exactly that happened: undo of an insert or of a delete. */
export function singleStructuralChange(
  before: readonly EditTreeNode[],
  after: readonly EditTreeNode[],
):
  | { readonly kind: 'removed'; readonly id: string }
  | { readonly kind: 'added'; readonly id: string; readonly parentId: string | undefined; readonly index: number; readonly node: EditTreeNode }
  | undefined {
  const lists: { readonly parentId: string | undefined; readonly left: readonly EditTreeNode[]; readonly right: readonly EditTreeNode[] }[] = [
    { parentId: undefined, left: before, right: after },
  ];
  let found: ReturnType<typeof singleStructuralChange> = undefined;
  for (let at = 0; at < lists.length; at += 1) {
    assert(at < CANVAS_EDIT_LIMITS.nodesMax, 'singleStructuralChange: a diff stays inside the node bound');
    const list = lists[at];
    assert(list !== undefined, 'singleStructuralChange: the visit index lies inside the queue');
    const leftIds = list.left.map((node) => node.id);
    const rightIds = list.right.map((node) => node.id);
    if (leftIds.join('\n') !== rightIds.join('\n')) {
      if (found !== undefined) {
        return undefined; // More than one list changed.
      }
      if (rightIds.length === leftIds.length + 1) {
        const index = rightIds.findIndex((id, position) => id !== leftIds[position]);
        const node = list.right[index];
        if (node === undefined || rightIds.filter((id, position) => position !== index).join('\n') !== leftIds.join('\n')) {
          return undefined;
        }
        found = { kind: 'added', id: node.id, parentId: list.parentId, index, node };
      } else if (leftIds.length === rightIds.length + 1) {
        const index = leftIds.findIndex((id, position) => id !== rightIds[position]);
        const node = list.left[index];
        if (node === undefined || leftIds.filter((id, position) => position !== index).join('\n') !== rightIds.join('\n')) {
          return undefined;
        }
        found = { kind: 'removed', id: node.id };
      } else {
        return undefined;
      }
    }
    const byId = new Map(list.left.map((node) => [node.id, node]));
    for (const next of list.right) {
      const previous = byId.get(next.id);
      if (previous?.children !== undefined && next.children !== undefined) {
        lists.push({ parentId: next.id, left: previous.children, right: next.children });
      }
    }
  }
  return found;
}

/** The boundary parser for the edits crossing into the frame; one bad edit drops the whole message. */
export function parseCanvasEdits(input: unknown): readonly CanvasEdit[] | undefined {
  if (!Array.isArray(input) || input.length > CANVAS_EDIT_LIMITS.editsMax) {
    return undefined;
  }
  const edits: CanvasEdit[] = [];
  for (const entry of input) {
    const edit = parseOne(entry);
    if (edit === undefined) {
      return undefined;
    }
    edits.push(edit);
  }
  return edits;
}

// --- Internals ---------------------------------------------------------------------

function sameIds(left: readonly EditTreeNode[], right: readonly EditTreeNode[]): boolean {
  return left.length === right.length && left.every((node, index) => node.id === right[index]?.id);
}

function editsFor(previous: EditTreeNode, next: EditTreeNode, pathOf: (id: string) => string | undefined): readonly CanvasEdit[] {
  const path = pathOf(next.id);
  if (path === undefined) {
    return [];
  }
  const out: CanvasEdit[] = [];
  const sameShape = previous.kind === next.kind;
  if (!sameShape) {
    return [{ kind: 'updating', path }];
  }
  if (next.kind === 'element') {
    const named = previous.name === next.name;
    if (!named) {
      if (
        next.name !== undefined &&
        TAG_NAME.test(next.name) &&
        !UNSAFE_TAGS.has(next.name) &&
        previous.name !== undefined &&
        !UNSAFE_TAGS.has(previous.name)
      ) {
        out.push({ kind: 'tag', path, tag: next.name });
      } else {
        out.push({ kind: 'updating', path });
      }
    }
    const attributes = attributeEdit(previous, next, path);
    if (attributes === 'updating') {
      out.push({ kind: 'updating', path });
    } else if (attributes !== undefined) {
      out.push(attributes);
    }
    const words = textEdit(previous, next, path);
    if (words !== undefined) {
      out.push(words);
    }
    return out;
  }
  if (next.kind === 'component') {
    const propsChanged = JSON.stringify(previous.props ?? {}) !== JSON.stringify(next.props ?? {});
    const nameChanged = previous.name !== next.name;
    const wordsChanged = textEdit(previous, next, path) !== undefined;
    if (propsChanged || nameChanged || wordsChanged) {
      return [{ kind: 'updating', path }];
    }
  }
  return out;
}

function attributeEdit(previous: EditTreeNode, next: EditTreeNode, path: string): CanvasEdit | 'updating' | undefined {
  const names = new Set([...Object.keys(previous.props ?? {}), ...Object.keys(next.props ?? {})]);
  const set: (readonly [string, string])[] = [];
  const remove: string[] = [];
  for (const name of names) {
    const was = previous.props?.[name];
    const now = next.props?.[name];
    if (JSON.stringify(was) === JSON.stringify(now)) {
      continue;
    }
    if ((was !== undefined && was.type !== 'string' && was.type !== 'bare') || (now !== undefined && now.type !== 'string' && now.type !== 'bare')) {
      return 'updating'; // An expression or a spread: its value is the server's.
    }
    if (now === undefined) {
      if (!isSafeAttribute(name, '')) {
        return 'updating';
      }
      remove.push(name);
      continue;
    }
    const value = now.type === 'bare' ? '' : (now.value ?? '');
    if (!isSafeAttribute(name, value)) {
      return 'updating';
    }
    set.push([name, value]);
  }
  if (set.length === 0 && remove.length === 0) {
    return undefined;
  }
  return { kind: 'attributes', path, set, remove };
}

// An element whose children are text before and after, with different words.
function textEdit(previous: EditTreeNode, next: EditTreeNode, path: string): CanvasEdit | undefined {
  const was = wordsOf(previous.children);
  const now = wordsOf(next.children);
  if (was === undefined || now === undefined || was === now || now.length > CANVAS_EDIT_LIMITS.textCharsMax) {
    return undefined;
  }
  if (next.name !== undefined && HTML_VOID_TAGS.has(next.name)) {
    return undefined;
  }
  return { kind: 'text', path, text: now };
}

function wordsOf(children: readonly EditTreeNode[] | undefined): string | undefined {
  if (children === undefined) {
    return '';
  }
  let words = '';
  for (const child of children) {
    if (child.kind !== 'text' || child.value === undefined) {
      return undefined;
    }
    words += child.value;
  }
  return words;
}

function recordOf(input: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(input));
}

function parseOne(input: unknown): CanvasEdit | undefined {
  const record = recordOf(input);
  const path = record?.['path'];
  if (record === undefined || typeof path !== 'string' || path.length === 0 || path.length > CANVAS_INSERT_LIMITS.scopeCharsMax) {
    return undefined;
  }
  switch (record['kind']) {
    case 'updating':
      return { kind: 'updating', path };
    case 'text': {
      const text = record['text'];
      return typeof text === 'string' && text.length <= CANVAS_EDIT_LIMITS.textCharsMax ? { kind: 'text', path, text } : undefined;
    }
    case 'tag': {
      const tag = record['tag'];
      return typeof tag === 'string' && TAG_NAME.test(tag) && !UNSAFE_TAGS.has(tag) && tag.length <= CANVAS_INSERT_LIMITS.tagCharsMax
        ? { kind: 'tag', path, tag }
        : undefined;
    }
    case 'attributes':
      return parseAttributes(record, path);
    case 'classes':
      return parseClasses(record, path);
    default:
      return undefined;
  }
}

function parseClasses(record: Readonly<Record<string, unknown>>, path: string): CanvasEdit | undefined {
  const add = parseClassNames(record['add']);
  const remove = parseClassNames(record['remove']);
  if (add === undefined || remove === undefined || add.length + remove.length > CANVAS_EDIT_LIMITS.classNamesMax) {
    return undefined;
  }
  return { kind: 'classes', path, add, remove };
}

function parseClassNames(input: unknown): readonly string[] | undefined {
  if (!Array.isArray(input) || input.length > CANVAS_EDIT_LIMITS.classNamesMax) {
    return undefined;
  }
  const names: string[] = [];
  for (const name of input) {
    if (typeof name !== 'string' || name.length === 0 || name.length > CANVAS_EDIT_LIMITS.classNameCharsMax || /\s/.test(name)) {
      return undefined;
    }
    names.push(name);
  }
  return names;
}

function parseAttributes(record: Readonly<Record<string, unknown>>, path: string): CanvasEdit | undefined {
  const setInput = record['set'];
  const removeInput = record['remove'];
  if (!Array.isArray(setInput) || !Array.isArray(removeInput) || setInput.length + removeInput.length > CANVAS_INSERT_LIMITS.attributesMax) {
    return undefined;
  }
  const set: (readonly [string, string])[] = [];
  for (const entry of setInput) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      return undefined;
    }
    const name: unknown = entry[0];
    const value: unknown = entry[1];
    if (typeof name !== 'string' || typeof value !== 'string' || !isSafeAttribute(name, value)) {
      return undefined;
    }
    set.push([name, value]);
  }
  const remove: string[] = [];
  for (const name of removeInput) {
    if (typeof name !== 'string' || !isSafeAttribute(name, '')) {
      return undefined;
    }
    remove.push(name);
  }
  return { kind: 'attributes', path, set, remove };
}
