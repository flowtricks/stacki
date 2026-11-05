// New nodes and the page facts gestures ask about: fresh ids, default text,
// slot hosts and definitions, finding an element by tag, the opening
// selection, the names a page already uses, and a node's code text (App.tsx).

import type { SetStateAction } from 'react';
import type { Attr, PageModel, PageNode, PairedNode } from '../../../shared/page/pageNode';
import type { ScanComponent } from '../../../shared/properties/projectScan';
import { LIMITS } from '../../../shared/core/limits';
import { assert } from '../../../shared/core/assert';
import { VOID_TAGS } from '../../editor/elementSchemas';
import { previewGestures } from '../../editor/pageSender';
import { carryHandles, seedOf } from '../../editor/nodeHandles';
import { type PageOrigin, type EditGesture, type EditsRecord, type QueueEntry } from '../../editor/pageEdits';
import { frontmatterGesture, propsGesture, sequence, tagRenameGesture } from '../../editor/editGestures';
import type { PageEdited } from '../../../shared/ipc/pageSave';
import { ancestorChain, nodeAtPath } from '../../editor/editorTree';
import { renamedLoopVar, parseLoopHead, disconnectedLoops } from '../../editor/loopBindings';
import type { InlineNode } from '../../features/props/RichContent';
import type { Rename } from '../../features/props/propNodeEditors';
import { findEditorNodeById as findNodeById, type EditablePageState, type EditorPageState, type OpenFile, type TrailingSlash } from '../../editor/pageState';
import { nodeId, type EditorModel, type EditorNode } from '../../editor/pageView';
import { previewProjectPageEdit } from '../../ipc/appBridge';

// A node a gesture creates has no parse yet to name it: its handle is random,
// unique without a counter, and carried onto the reply that first contains it
// (src/editor/nodeHandles.ts). It never reaches main.
export const newId = () => nodeId(`g${crypto.randomUUID().replace(/-/g, '')}`);

// A copy of `node` in which it and every node below it take fresh ids: a
// pasted or duplicated node is a new node, and must never answer to the
// handle of the one it was copied from.
export function withNewIds(node: EditorNode, depth = 0): EditorNode {
  // A copied node came from a parse, which caps nesting.
  assert(depth <= LIMITS.treeDepthMax, `withNewIds: depth ${depth} exceeds the tree cap`);
  const id = newId();
  assert(id !== node.id, 'A copy never keeps the handle it was copied from');
  const children = node.children;
  if (children === undefined) {
    return { ...node, id };
  }
  // Object.assign keeps the node's own variant, where a spread would widen it.
  const copies = children.map((child) => withNewIds(child, depth + 1));
  return Object.assign({}, node, { id, children: copies });
}

// Inline nodes from the rich Content field, which arrive without ids: each takes
// a fresh one, and an element keeps only the attributes that have a value.
export function inlineWithIds(list: readonly InlineNode[], depth: number): EditorNode[] {
  // Inline content is nested markup of a parsed page, bounded like any tree.
  assert(depth <= LIMITS.treeDepthMax, 'inlineWithIds: depth exceeds the tree cap');
  return list.map((node): EditorNode => {
    if (node.kind === 'text' || node.kind === 'expr') {
      return { ...node, id: newId() };
    }
    const props = Object.fromEntries(Object.entries(node.props ?? {}).filter((entry): entry is [string, Attr] => entry[1] !== undefined));
    return {
      id: newId(),
      kind: 'element',
      name: node.name,
      props,
      children: node.children === undefined ? undefined : inlineWithIds(node.children, depth + 1),
    };
  });
}

// Placeholder copy for newly inserted text elements, so they're visible on the
// canvas straight away instead of collapsing to a zero-height box.
export const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Suspendisse varius ' +
  'enim in eros elementum tristique. Duis cursus, mi quis viverra ornare, eros ' +
  'dolor interdum nulla, ut commodo diam libero vitae erat. Aenean faucibus nibh ' +
  'et justo cursus id rutrum lorem imperdiet. Nunc ut sem vitae risus tristique ' +
  'posuere.';
export const DEFAULT_TEXT = {
  h1: 'Heading',
  h2: 'Heading',
  h3: 'Heading',
  h4: 'Heading',
  h5: 'Heading',
  h6: 'Heading',
  p: LOREM,
};

export function defaultText(tag: string): string | undefined {
  switch (tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
    case 'p':
      return DEFAULT_TEXT[tag];
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Tree helpers (model.nodes is a tree of {id, kind, name?, props?, children?})
// ---------------------------------------------------------------------------

// Whether a subtree reads anything from the file it currently sits in — an
// expression, a conditional, a loop, or a prop written as code. Moved into a
// component, those names aren't in scope any more: `{title}` in a page reads
// the page's `title`, and in Card.astro it reads nothing at all. Not something
// to refuse over (the fix is a prop, and only the author knows its name) but
// very much something to say out loud.
export function usesPageScope(node: PageNode | undefined): boolean {
  if (!node) {
    return false;
  }
  if (['expr', 'cond', 'map', 'branch'].includes(node.kind)) {
    return true;
  }
  const props = 'props' in node ? node.props : undefined;
  for (const value of Object.values(props || {})) {
    if (value && value.type === 'expr') {
      return true;
    }
  }
  const children = 'children' in node ? node.children : undefined;
  return (children || []).some(usesPageScope);
}

// Loops and conditionals render their children straight through, so a `slot`
// under one is still read by whatever component sits above it.
export const SLOT_TRANSPARENT = new Set(['map', 'cond', 'branch', 'chunk-group']);

// The component (or layout) whose slots a node's `slot` attribute names,
// looking past those pass-through wrappers. Null when the node lands in a
// plain element or at the page root — nothing there reads a slot name.
export function slotHostOf(model: Pick<PageModel, 'nodes'>, id: string): PairedNode | undefined {
  const parents = (ancestorChain(model.nodes, id) || []).slice(0, -1);
  const node = parents.reverse().find((parent) => !SLOT_TRANSPARENT.has(parent.kind));
  return node?.kind === 'component' ? node : undefined;
}

// What we know about a placed component, which may be imported under a local
// name of its own (`import Layout from '../layouts/BaseLayout.astro'`) — so
// fall back to the file the import points at. Null means "no definition
// scanned", which is never the same answer as "has no slots".
export function definitionOf(
  model: Pick<PageModel, 'imports'>,
  node: Pick<PairedNode, 'name'>,
  insertables: readonly ScanComponent[],
): ScanComponent | undefined {
  const specifier = model.imports.find((item) => item.name === node.name)?.path;
  const installed = insertables.find((item) => item.origin?.kind === 'package' && item.origin.importPath === specifier);
  if (installed) {
    return installed;
  }
  const byName = insertables.find((component) => component.name === node.name);
  if (byName) {
    return byName;
  }
  const imp = (model.imports || []).find((i) => i.name === node.name);
  const base = imp?.path
    .split('/')
    .pop()
    ?.replace(/\.astro$/i, '');
  return (base && insertables.find((component) => component.name === base)) || undefined;
}

// First element with this tag, depth-first. Used to land the selection on a
// layout's <body> when it is opened: the html/head wrapper above it is not
// what anyone came to edit, and <body> is the page's real root.
export function findElementByTag(nodes: readonly PageNode[] | undefined, tag: string, depth = 0): PairedNode | undefined {
  // A parsed tree is bounded by the page-tree depth cap.
  assert(depth <= LIMITS.treeDepthMax, 'findElementByTag: depth exceeds the tree cap');
  for (const node of nodes || []) {
    if (node.kind === 'element' && String(node.name).toLowerCase() === tag) {
      return node;
    }
    if ('children' in node && Array.isArray(node.children)) {
      const found = findElementByTag(node.children, tag, depth + 1);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

// Start a component on its rendered markup, looking through control flow and
// fragments because those wrappers have no element to style. Layouts keep
// their <body> selection; files without rendered markup still get a fallback.
export function openingSelection(nodes: readonly PageNode[] | undefined): PageNode | undefined {
  const list = Array.isArray(nodes) ? nodes : [];
  const firstRendered = (children: readonly PageNode[] | undefined, depth: number): PageNode | undefined => {
    assert(depth <= LIMITS.treeDepthMax, 'openingSelection: depth exceeds the tree cap');
    for (const node of children || []) {
      const markup = node.kind === 'element' || node.kind === 'component';
      if (SLOT_TRANSPARENT.has(node.kind) || (markup && ['Fragment', 'slot'].includes(node.name))) {
        const child = firstRendered('children' in node ? node.children : undefined, depth + 1);
        if (child) {
          return child;
        }
      } else if (markup && !['head', 'script', 'style', 'link', 'meta', 'title', 'base', 'template'].includes(node.name)) {
        return node;
      }
    }
    return undefined;
  };
  return findElementByTag(list, 'body') || firstRendered(list, 0) || outermostNode(list);
}

// The outermost thing a page renders: its layout wrapper when it has one,
// otherwise the first real node. A doctype line, a leading comment or stray
// whitespace isn't what the page is about, so those are skipped — but any
// node beats selecting nothing.
export function outermostNode(nodes: readonly PageNode[] | undefined): PageNode | undefined {
  const list: readonly PageNode[] = nodes ?? [];
  return list.find((node) => node.kind === 'element' || node.kind === 'component') || list[0] || undefined;
}

export interface OpenFileOptions {
  readonly nextStack: SetStateAction<readonly OpenFile[]>;
  readonly selectionPath: string | undefined;
}

// Returning from a component should land on the instance that opened it. The
// path is stored with the child stack entry because node ids can change when
// the parent file is parsed again during the return trip.
export function openFileSelection(entry: OpenFile, result: EditorPageState, selectionPath: string | undefined): PageNode | undefined {
  if (!result.editable) {
    return undefined;
  }
  if (selectionPath) {
    const localPath = selectionPath.split('|').at(-1);
    assert(localPath !== undefined, 'A stored component path must have a local path');
    const selected = nodeAtPath(result.model.nodes, localPath.split('.').map(Number));
    if (selected) {
      return selected;
    }
  }
  return entry.kind === 'component' ? openingSelection(result.model.nodes) : outermostNode(result.model.nodes);
}

export function collectUsedNames(model: PageModel): Set<string> {
  const used = new Set<string>();
  const walk = (list: readonly PageNode[], depth: number): void => {
    assert(depth <= LIMITS.treeDepthMax, 'collectUsedNames: depth exceeds the tree cap');
    for (const node of list) {
      if ('name' in node && node.name) {
        used.add(node.name);
      }
      if ('children' in node && Array.isArray(node.children)) {
        walk(node.children, depth + 1);
      }
    }
  };
  walk(model.nodes, 0);
  return used;
}

// Comments in the frontmatter are prose about the page, and prose names the
// things the page is built from — `// Hero copy` is talk about <Hero>, not a
// use of it. Only whole-line `//` comments go: a trailing one can't be told
// from the `//` inside a URL without really parsing, and cutting a string in
// half there would hide a reference that is real.
export function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

// Everything in the file that is code rather than markup: the frontmatter, a
// loop's head, a condition's test, an expression node, and any prop whose
// value is an expression. An imported name can be used in any of them without
// ever appearing as a tag.
//
// <style> and <script> bodies are pointedly not code for this purpose. Both
// are their own scope in Astro — CSS never sees a frontmatter binding, and a
// <script> is a separate module — so a name inside one is a coincidence, not
// a use. Reading them meant a `.Hero` class or a `/* Hero */` note pinned
// <Hero>'s import in place for good. What those blocks genuinely share comes
// in through `define:vars`, which is a prop expression and is still read.
export function codeText(model: PageModel): string {
  const parts = [stripComments(model.extraFrontmatter || '')];
  const walk = (list: readonly PageNode[], depth: number): void => {
    assert(depth <= LIMITS.treeDepthMax, 'codeText: depth exceeds the tree cap');
    for (const node of list) {
      if (node.kind === 'expr' || node.kind === 'raw-line') {
        parts.push(node.value || '');
      }
      if (node.kind === 'map') {
        parts.push(node.head || '');
      }
      if (node.kind === 'cond') {
        parts.push(node.test || '');
      }
      const props = 'props' in node ? node.props : undefined;
      for (const value of Object.values(props || {})) {
        if (value && (value.type === 'expr' || value.type === 'spread')) {
          parts.push(String(value.value ?? ''));
        }
      }
      if ('children' in node && Array.isArray(node.children)) {
        walk(node.children, depth + 1);
      }
    }
  };
  walk(model.nodes, 0);
  return parts.join('\n');
}

export type BranchNode = Extract<EditorNode, { readonly kind: 'branch' }>;

/** A tag's new name and kind, and the attributes the new name does not keep. */
export interface TagChange {
  readonly kind: 'element' | 'component';
  readonly name: string;
  readonly asset: boolean;
  readonly dropped: readonly string[];
}

// A tag renamed (step 9): the attributes the new name does not keep removed
// first — removals anchor on the node as authored, and a rename may change
// its kind, which the next request's anchor would no longer match — then the
// name, then the imports the new name needs and the old one leaves unused, all
// one undo step. Void tags keep no children: `<img>` holds none.
export function tagChangeGesture(model: EditorModel, node: EditorNode, change: TagChange, imports: (model: EditorModel) => EditorModel): EditGesture {
  const options = { coalesceKey: undefined, urgency: true };
  const patch = Object.fromEntries(change.dropped.map((attr) => [attr, undefined]));
  const removal = propsGesture(node.id, patch, options);
  const kept = change.dropped.length > 0 ? removal.apply(model) : model;
  const before = findNodeById(kept.nodes, node.id);
  assert(before !== undefined, 'The renamed node survives its attribute removals');
  const children = VOID_TAGS.has(change.name) ? undefined : before.children;
  // A fresh copy, so taking the old tag's flags off it edits nothing shown.
  const next: EditorNode = Object.assign({}, before, {
    kind: change.kind,
    name: change.name,
    children,
  });
  Reflect.deleteProperty(next, 'dynamicTag');
  Reflect.deleteProperty(next, 'astroAsset');
  if (change.asset) {
    Object.assign(next, { astroAsset: true });
  }
  const rename = tagRenameGesture(node, next, options);
  const renamed = rename.apply(kept);
  const named = change.dropped.length > 0 ? sequence(removal, rename) : rename;
  if (frontmatterOf(imports(renamed)) === frontmatterOf(renamed)) {
    return named;
  }
  return sequence(named, frontmatterGesture(renamed, options, imports));
}

// The unsaved version of a conflicted page as text, for review (plan §7). The
// page's queued gestures are planned as the splices they would write, against
// the bytes they were stated on (page:previewEdit) — never printed whole, on
// any page since step 10.
export type Reviewed = { readonly tag: 'shown'; readonly source: string } | { readonly tag: 'failed'; readonly message: string };

export async function reviewedSource(path: string, state: EditablePageState, queued: readonly QueueEntry[]): Promise<Reviewed> {
  // Only typed code leaves a page without an origin, and typed code is
  // reviewed as it was typed (the caller's branch).
  assert(state.origin !== undefined, 'A page with only gestures queued has an origin');
  const gestures = queued.flatMap((entry) => (entry.tag === 'gesture' ? [entry.gesture] : []));
  assert(gestures.length === queued.length, 'Typed code is reviewed as it was typed');
  const shown = await previewGestures({
    path,
    origin: state.origin,
    gestures,
    preview: previewProjectPageEdit,
  });
  switch (shown.tag) {
    case 'previewed':
      return { tag: 'shown', source: shown.origin.source };
    case 'failed':
      return shown;
    default: {
      const exhaustive: never = shown;
      return exhaustive;
    }
  }
}

// The node as a text field states it (step 9): a loop's head — the renames
// followed below it, and loops reading an item whose data changed disconnected
// — a condition's test, a style or script body, or the value of a text, an
// expression or a note. A new node; the shown one is left as it was, and the
// loop helpers edit a private copy of the loop only.
export function restatedText(node: EditorNode, value: string, renames: readonly Rename[] | undefined): EditorNode | undefined {
  switch (node.kind) {
    case 'map': {
      const renamed = (renames || []).reduce(
        (children, { from, to }) => (from && to && from !== to ? renamedLoopVar(children, from, to) : children),
        node.children,
      );
      // Renames above already re-pointed the children, so compare the data
      // sources and orphan-proof what reads from this item.
      const before = parseLoopHead(node.head);
      const after = parseLoopHead(value);
      const vars = after ? [after.item, after.index].filter(Boolean) : [];
      const moved = before && after && before.data !== after.data && vars.length > 0;
      const children = moved ? disconnectedLoops(renamed, vars) : renamed;
      return { ...node, head: value, children };
    }
    case 'cond':
      return { ...node, test: value };
    case 'raw':
      return { ...node, inner: value };
    case 'text':
    case 'expr':
    case 'comment':
      return { ...node, value };
    case 'element':
    case 'component':
    case 'branch':
    case 'raw-line':
    case 'chunk-group':
      return undefined; // No text field states these.
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}

// The text a node's field states, as restatedText writes it back: undefined
// for a node no text field states.
export function statedText(node: EditorNode): string | undefined {
  switch (node.kind) {
    case 'map':
      return node.head;
    case 'cond':
      return node.test;
    case 'raw':
      return node.inner;
    case 'text':
    case 'expr':
    case 'comment':
      return node.value;
    case 'element':
    case 'component':
    case 'branch':
    case 'raw-line':
    case 'chunk-group':
      return undefined;
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}

// An undo step with nothing of its own to undo.
export function voided(outcome: EditsRecord['outcome']): boolean {
  switch (outcome.tag) {
    case 'folded':
    case 'dropped':
      return true;
    case 'applied':
      return outcome.applied.every((write) => write.inverse.length === 0);
    case 'pending':
      return false;
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

// The origin after an Undo's revert: its reply, carried from the origin
// through the revert's own splices (an .astro page; undefined otherwise).
export function revertedOrigin(origin: PageOrigin | undefined, reply: PageEdited): PageOrigin | undefined {
  if (origin === undefined || !reply.editable) {
    return undefined;
  }
  const after = { source: reply.source, seed: seedOf(reply.checksum), model: reply.model };
  const model = carryHandles({ before: origin, after, own: reply.inverse, predicted: undefined });
  return { checksum: reply.checksum, source: reply.source, model };
}

// How long a pending save waits, by urgency. See scheduleSave.
export function saveDelay({ urgency }: { readonly urgency: boolean | 'live' }): number {
  if (urgency === true) {
    return 0;
  }
  if (urgency === 'live') {
    return 120;
  }
  return 300;
}

/** A save waiting on its timer: the handle that cancels it and the time it is due. */
export interface PendingSave {
  readonly handle: ReturnType<typeof setTimeout>;
  readonly dueMs: number;
}

// What a new save request does to the save already pending: keep it, or
// replace it with one that waits `delayMs`.
//
// Typing is a debounce on purpose: each keystroke pushes the save back, so a
// word saves once. A live request (a style-panel drag or scrub) must not do
// that. It arrives once per animation frame, far closer together than its own
// delay, so a debounce never fired while the hand kept moving and the canvas
// stood still until the pointer rested. A live request therefore keeps any
// save already due no later than it would be, which turns the stream into one
// save per delay; the save that runs reads the model as it is then, so it
// carries the latest frame. An immediate request is due at once and always
// replaces.
export function nextSave({
  urgency,
  pending,
  nowMs,
}: {
  readonly urgency: boolean | 'live';
  readonly pending: PendingSave | undefined;
  readonly nowMs: number;
}): { readonly tag: 'keep' } | { readonly tag: 'replace'; readonly delayMs: number } {
  assert(Number.isFinite(nowMs), 'nextSave: the clock reads a finite time');
  const delayMs = saveDelay({ urgency });
  assert(delayMs >= 0, 'nextSave: a save never waits a negative time');
  if (urgency === 'live') {
    if (pending !== undefined) {
      if (pending.dueMs <= nowMs + delayMs) {
        return { tag: 'keep' };
      }
    }
  }
  return { tag: 'replace', delayMs };
}

// A route is stored the way it identifies a page — slashless, so /de/hotel
// and /de/hotel/ are the same entry however a link was typed. A URL is a
// different thing: Astro's dev server serves exactly one of those spellings,
// and answers the other with a 404 help page. So the project's trailingSlash
// is applied on the way from one to the other, never before.
export function routeToPath(route: string, trailingSlash: TrailingSlash): string {
  if (route.startsWith('/__avb/preview?defaults=')) {
    return route;
  }
  if (!route || route === '/') {
    return route || '/';
  }
  // An extension means a file, not a directory-style route: /rss.xml keeps
  // its shape under every setting, which is also how Astro checks it.
  if (trailingSlash === 'always') {
    return /\.[^/]+$/.test(route) ? route : route + '/';
  }
  if (trailingSlash === 'never') {
    return route.replace(/\/$/, '');
  }
  return route; // 'ignore' — the default, and it serves either
}

export function parseTrailingSlash(value: string): TrailingSlash {
  if (value === 'always' || value === 'never' || value === 'ignore') {
    return value;
  }
  throw new Error(`Unknown trailing-slash mode: ${value}`);
}

// The frontmatter a model describes, compared as data.
export function frontmatterOf(model: PageModel): string {
  return JSON.stringify([model.imports, model.extraFrontmatter]);
}
