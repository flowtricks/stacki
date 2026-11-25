// Formatting words selected on the canvas, with the Settings Content field's
// own formatting (richFormat.ts) — not a second implementation of it.
//
// The Content field edits an element's inline content in an editable element
// and reads the result back as nodes. The canvas does the same with a hidden
// copy of that content: it selects the words the canvas selected, presses the
// same button, and hands the nodes to the same setNodeInline. So a word made
// bold on the canvas gets exactly the markup the panel would give it, and
// pressing a lit button turns the format off, as it does there.

import { assert } from '../../../shared/core/assert';
import type { Attr } from '../../../shared/page/pageNode';
import type { CanvasTextBreaks } from '../../../shared/properties/canvasText';
import type { EditingSettings } from '../../../shared/properties/componentDefaults';
import { richTextNodes, richTextView, sameRichContent } from '../../features/props/richTextContent';
import { LIMITS } from '../../../shared/core/limits';
import { INLINE_TAGS, isChippable, isInlineOnly, nodesToHtml, type InlineCandidate, type InlineNode } from '../../features/props/richContentModel';
import { richApplyLink, richContentNodes, richExec, richWrapTag, type FormatState } from '../../features/props/richFormat';
import type { CanvasFormatAction } from '../../features/preview/canvasTextSelection';
import type { CanvasTextFormatter } from '../../features/preview/useCanvasText';

/**
 * The canvas bar's presses for a page's nodes, saved the way the Content field
 * saves: the whole inline content of the element, through `setInline`. Desktop
 * and Studio share it, so a press writes the same markup in both; only the
 * write differs (Desktop's page model, Studio's shared source).
 */
export function canvasTextFormatter<Node extends CanvasFormatTree<Node> & InlineCandidate>(
  nodes: readonly Node[],
  setInline: (rootId: string, children: readonly InlineNode[]) => void,
): CanvasTextFormatter {
  const contentOf = (textId: string) => {
    const found = inlineRootOf(nodes, textId);
    if (!found?.root.id) {
      return undefined;
    }
    const children = found.root.children;
    if (!isInlineOnly(children)) {
      return undefined;
    }
    return { rootId: found.root.id, children, trail: found.trail };
  };
  return {
    states: (textId) => {
      const content = contentOf(textId);
      return content ? inlineStatesAt(content.children, content.trail) : undefined;
    },
    apply: (textId, selection, action) => {
      const content = contentOf(textId);
      if (!content) {
        return false;
      }
      assert(content.trail.length > 0, 'Formatted text sits inside its element');
      const typed = inlineWithValue(content.children, content.trail, selection.value);
      const next = formatInlineSelection(typed, { ...selection, trail: content.trail }, action);
      if (!next) {
        return false;
      }
      assert(next.length > 0, 'A press leaves the element its content');
      setInline(content.rootId, next);
      return true;
    },
    breaks: (textId, breaks, value) => {
      const content = contentOf(textId);
      if (!content) {
        return false;
      }
      const typed = inlineWithValue(content.children, content.trail, value);
      if (breaks === 'line') {
        setInline(content.rootId, withLineBreaks(typed, content.trail));
        return true;
      }
      return splitIntoParagraphs(nodes, { rootId: content.rootId, children: typed, trail: content.trail }, setInline);
    },
    richText: (textId, html) => {
      const chain = ancestorsOf(nodes, textId);
      const instance = [...(chain?.ancestors ?? [])].reverse().find((node) => node.kind === 'component');
      if (instance?.id === undefined || richTextView(html, document).view !== 'rich') {
        return false;
      }
      assert(chain !== undefined, 'An instance was found among the text’s ancestors');
      const before = sourceOf(instance);
      if (before !== undefined && sameRichContent(before, html, document)) {
        return true; // Nothing a reader would see changed: the file keeps its bytes.
      }
      setInline(instance.id, richTextNodes(html, document));
      return true;
    },
  };
}

const BREAK: InlineNode = { kind: 'element', name: 'br', props: {}, children: undefined };

/** The content with the text at `trail` cut at each typed newline, a `<br>` where each was. */
export function withLineBreaks(children: readonly InlineNode[], trail: readonly number[], depth = 0): InlineNode[] {
  assert(depth <= LIMITS.treeDepthMax, 'Inline content depth limit exceeded');
  const [index, ...rest] = trail;
  assert(index !== undefined, 'A trail reaches a text node');
  return children.flatMap((node, at): InlineNode[] => {
    if (at !== index) {
      return [node];
    }
    if (rest.length > 0) {
      return node.kind === 'element' ? [{ ...node, children: withLineBreaks(node.children ?? [], rest, depth + 1) }] : [node];
    }
    if (node.kind !== 'text') {
      return [node];
    }
    const lines = node.value.split('\n');
    assert(lines.length <= LIMITS.nodeValueCharsMax, 'Each break is one typed character');
    return lines.flatMap((line, position) => [...(position === 0 ? [] : [BREAK]), ...(line === '' ? [] : [{ kind: 'text' as const, value: line }])]);
  });
}

/**
 * Inline content cut in two at `offset` of the text at `trail`: each element on the way down is in both halves, so
 * a cut inside `<strong>` leaves a `<strong>` on either side. A half with nothing in it drops the element.
 */
export function splitInlineAt(children: readonly InlineNode[], trail: readonly number[], offset: number, depth = 0): readonly [InlineNode[], InlineNode[]] {
  assert(depth <= LIMITS.treeDepthMax, 'Inline content depth limit exceeded');
  const [index, ...rest] = trail;
  assert(index !== undefined, 'A trail reaches a text node');
  const node = children[index];
  assert(node !== undefined, 'The trail names a child');
  const before = children.slice(0, index);
  const after = children.slice(index + 1);
  if (rest.length === 0) {
    assert(node.kind === 'text', 'A trail ends at a text');
    const left = node.value.slice(0, offset);
    const right = node.value.slice(offset);
    return [
      [...before, ...(left === '' ? [] : [{ ...node, value: left }])],
      [...(right === '' ? [] : [{ ...node, value: right }]), ...after],
    ];
  }
  assert(node.kind === 'element', 'A trail passes through elements');
  const [left, right] = splitInlineAt(node.children ?? [], rest, offset, depth + 1);
  return [
    [...before, ...(left.length === 0 ? [] : [{ ...node, children: left }])],
    [...(right.length === 0 ? [] : [{ ...node, children: right }]), ...after],
  ];
}

/** Rich text blocks Enter splits; a heading or a quote goes on as a paragraph, a list item as another item. */
const SPLIT_BLOCKS: ReadonlySet<string> = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'li', 'pre']);

// The block holding the typed text, as one block per typed newline, written over the parent's content: the parent is
// a rich text component's slot or a list, whose content is plain rich text (the catalog offers `rich` only then).
function splitIntoParagraphs<Node extends CanvasFormatTree<Node> & InlineCandidate>(
  nodes: readonly Node[],
  block: { readonly rootId: string; readonly children: readonly InlineNode[]; readonly trail: readonly number[] },
  setInline: (rootId: string, children: readonly InlineNode[]) => void,
): boolean {
  const parent = parentOf(nodes, block.rootId);
  const own = parent?.children?.find((child) => child.id === block.rootId);
  if (parent?.id === undefined || own === undefined || !SPLIT_BLOCKS.has(own.name ?? '') || !isInlineOnly(own.children ?? [])) {
    return false;
  }
  const siblings = parent.children ?? [];
  if (!siblings.every((child) => child.id === block.rootId || plainMarkup(child, 0))) {
    return false;
  }
  const blocks = paragraphsOf(block.children, block.trail);
  assert(blocks.length >= 2, 'A save with a typed newline splits its block');
  const tag = own.name ?? 'p';
  const props = attributesOf(own.props);
  const replaced = blocks.map((children, index): InlineNode => ({
    kind: 'element',
    name: index === 0 || tag === 'li' || tag === 'p' ? tag : 'p',
    props: index === 0 ? props : {},
    children,
  }));
  setInline(
    parent.id,
    siblings.flatMap((child) => (child.id === block.rootId ? replaced : [toInline(child, 0)])),
  );
  return true;
}

/** The block's content cut at every newline of the text at `trail`. */
export function paragraphsOf(children: readonly InlineNode[], trail: readonly number[]): readonly InlineNode[][] {
  const blocks: InlineNode[][] = [];
  let current: readonly InlineNode[] = children;
  let at = trail;
  for (let cuts = 0; cuts <= LIMITS.nodeValueCharsMax; cuts++) {
    const text = textAt(current, at);
    const offset = text?.indexOf('\n') ?? -1;
    if (text === undefined || offset < 0) {
      blocks.push([...current]);
      return blocks;
    }
    const [left, right] = splitInlineAt(current, at, offset);
    blocks.push(left);
    // The right half starts with the text that held the newline, at the first child of every level it passes.
    at = at.map(() => 0);
    // Cut the newline itself off: whatever it leaves empty (the text, an element around it) goes with it.
    current = textAt(right, at) === undefined ? right : splitInlineAt(right, at, 1)[1];
  }
  assert(false, 'A text holds fewer newlines than characters');
  return blocks;
}

function textAt(children: readonly InlineNode[], trail: readonly number[]): string | undefined {
  let level: readonly InlineNode[] = children;
  let node: InlineNode | undefined;
  for (const index of trail) {
    node = level[index];
    level = node?.kind === 'element' ? (node.children ?? []) : [];
  }
  return node?.kind === 'text' ? node.value : undefined;
}

// Text and elements with plain attributes all the way down: what the parent's content is rewritten from without loss.
function plainMarkup(node: InlineCandidate, depth: number): boolean {
  if (depth > LIMITS.treeDepthMax) {
    return false;
  }
  if (node.kind === 'text') {
    return true;
  }
  if (node.kind !== 'element') {
    return false;
  }
  const attributes = Object.values(node.props ?? {}).every((value) => value === undefined || value.type === 'bare' || value.type === 'string');
  return attributes && (node.children ?? []).every((child) => plainMarkup(child, depth + 1));
}

function toInline(node: InlineCandidate, depth: number): InlineNode {
  assert(depth <= LIMITS.treeDepthMax, 'Inline content depth limit exceeded');
  if (node.kind === 'text') {
    return { kind: 'text', value: node.value ?? '' };
  }
  if (node.kind === 'expr') {
    return { kind: 'expr', value: node.value ?? '' };
  }
  return {
    kind: 'element',
    name: node.name ?? '',
    props: attributesOf(node.props),
    children: node.children === undefined ? undefined : node.children.map((child) => toInline(child, depth + 1)),
  };
}

// Plain attributes only: isInlineOnly admits no other kind, so nothing is dropped here.
function attributesOf(props: InlineCandidate['props']): Record<string, Attr> {
  const out: Record<string, Attr> = {};
  for (const [name, value] of Object.entries(props ?? {})) {
    if (value?.type === 'bare') {
      out[name] = { type: 'bare' };
    } else if (value?.type === 'string' && value.value !== undefined) {
      out[name] = { type: 'string', value: value.value };
    }
  }
  return out;
}

function parentOf<Node extends CanvasFormatTree<Node>>(nodes: readonly Node[], id: string): Node | undefined {
  const stack: Node[] = [...nodes];
  for (let visited = 0; visited < LIMITS.treeNodesMax; visited += 1) {
    const node = stack.pop();
    if (node === undefined) {
      return undefined;
    }
    const children: readonly Node[] = node.children ?? [];
    if (children.some((child) => child.id === id)) {
      return node;
    }
    stack.push(...children);
  }
  return undefined;
}

/** A model node whose children are its own kind, as the page model's are. */
export interface CanvasFormatTree<Node> {
  readonly id?: string;
  readonly kind: string;
  readonly name?: string;
  readonly value?: string;
  readonly children?: readonly Node[] | undefined;
}

/** The element whose inline content holds a text node, and the way down to it. */
export interface InlineRoot<Node extends CanvasFormatTree<Node>> {
  readonly root: Node;
  readonly trail: readonly number[];
}

/**
 * The element the Content field would edit for this text node: its parent,
 * or, when the text sits inside inline markup (`<strong>`, `<a>` …), the
 * element around that markup — so a press can take a format off as well as
 * put one on. Undefined when the content is not plain inline content.
 */
export function inlineRootOf<Node extends CanvasFormatTree<Node>>(nodes: readonly Node[], textId: string): InlineRoot<Node> | undefined {
  const chain = ancestorsOf(nodes, textId);
  if (!chain) {
    return undefined;
  }
  let at = chain.ancestors.length - 1;
  while (at > 0) {
    const node = chain.ancestors[at];
    const parent = chain.ancestors[at - 1];
    assert(node !== undefined, 'An ancestor exists at each level');
    assert(parent !== undefined, 'An ancestor exists above each level');
    if (node.kind !== 'element' || !INLINE_TAGS.has(node.name ?? '')) {
      break;
    }
    if (!isInlineOnly(parent.children)) {
      break;
    }
    at -= 1;
  }
  const root = chain.ancestors[at];
  if (root === undefined || !isInlineOnly(root.children)) {
    return undefined;
  }
  return { root, trail: chain.indices.slice(at + 1) };
}

// Every ancestor of a node, outermost first, with the child index taken at
// each one. Iterative and bounded by the tree's node limit.
function ancestorsOf<Node extends CanvasFormatTree<Node>>(
  nodes: readonly Node[],
  id: string,
): { readonly ancestors: readonly Node[]; readonly indices: readonly number[] } | undefined {
  type Entry = { readonly node: Node; readonly ancestors: Node[]; readonly indices: number[] };
  const stack: Entry[] = nodes.map((node, index) => ({ node, ancestors: [], indices: [index] }));
  for (let visited = 0; visited < LIMITS.treeNodesMax; visited += 1) {
    const entry = stack.pop();
    if (!entry) {
      return undefined;
    }
    if (entry.node.id === id) {
      assert(entry.indices.length === entry.ancestors.length + 1, 'One index per level');
      return entry.ancestors.length ? { ancestors: entry.ancestors, indices: entry.indices } : undefined;
    }
    const children: readonly Node[] = entry.node.children ?? [];
    children.forEach((child, index) =>
      stack.push({
        node: child,
        ancestors: [...entry.ancestors, entry.node],
        indices: [...entry.indices, index],
      }),
    );
  }
  return undefined;
}

/** Which buttons are lit: the inline markup the selected text already sits in. */
export function inlineStatesAt(children: readonly InlineNode[], trail: readonly number[]): FormatState {
  assert(trail.length > 0, 'A trail reaches a text node');
  const names = new Set<string>();
  let level: readonly InlineNode[] = children;
  for (const index of trail.slice(0, -1)) {
    const node = level[index];
    if (node?.kind !== 'element') {
      return {};
    }
    names.add(node.name);
    level = node.children ?? [];
  }
  const has = (...tags: readonly string[]) => tags.some((tag) => names.has(tag));
  return {
    bold: has('strong', 'b'),
    italic: has('em', 'i'),
    superscript: has('sup'),
    subscript: has('sub'),
    code: has('code'),
    span: has('span'),
    link: has('a'),
  };
}

/** The content with the text at `trail` holding `value` — what is typed but not saved yet. */
export function inlineWithValue(children: readonly InlineNode[], trail: readonly number[], value: string, depth = 0): readonly InlineNode[] {
  assert(depth <= LIMITS.treeDepthMax, 'Inline content depth limit exceeded');
  const [index, ...rest] = trail;
  assert(index !== undefined, 'A trail reaches a text node');
  return children.map((node, at) => {
    if (at !== index) {
      return node;
    }
    if (rest.length === 0) {
      return node.kind === 'text' ? { ...node, value } : node;
    }
    if (node.kind !== 'element') {
      return node;
    }
    return { ...node, children: inlineWithValue(node.children ?? [], rest, value, depth + 1) };
  });
}

/**
 * The content after one press over the words [start, end) of the text at
 * `trail`, which must read `value`. Undefined when the content cannot be laid
 * out as the panel would lay it out, or the press changes nothing.
 */
export function formatInlineSelection(
  children: readonly InlineNode[],
  selection: {
    readonly trail: readonly number[];
    readonly start: number;
    readonly end: number;
    readonly value: string;
  },
  action: CanvasFormatAction,
): InlineNode[] | undefined {
  assert(selection.start < selection.end, 'A format acts on selected words');
  assert(selection.end <= selection.value.length, 'The selection lies inside its text');
  const host = document.createElement('div');
  host.contentEditable = 'true';
  host.setAttribute('aria-hidden', 'true');
  // Off screen, not display:none: the browser only edits what it lays out.
  host.style.cssText = 'position:fixed;left:-10000px;top:0;opacity:0;white-space:pre';
  document.body.append(host);
  try {
    host.innerHTML = nodesToHtml(children, isChippable);
    const text = nodeAtTrail(host, selection.trail);
    if (!text || text.nodeType !== Node.TEXT_NODE || text.textContent !== selection.value) {
      return undefined;
    }
    const range = document.createRange();
    range.setStart(text, selection.start);
    range.setEnd(text, selection.end);
    const target = { host, savedRange: { current: range } };
    return pressFormat(target, action) ? richContentNodes(host) : undefined;
  } finally {
    host.remove();
  }
}

function pressFormat(target: Parameters<typeof richExec>[0], action: CanvasFormatAction): boolean {
  switch (action.kind) {
    case 'exec':
      richExec(target, action.command);
      return true;
    case 'wrap':
      return richWrapTag(target, action.tag);
    case 'link':
      return richApplyLink(target, action.url);
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

function nodeAtTrail(host: HTMLElement, trail: readonly number[]): ChildNode | undefined {
  let node: ChildNode | undefined = undefined;
  let level: NodeListOf<ChildNode> = host.childNodes;
  for (const index of trail) {
    node = level[index];
    if (!node) {
      return undefined;
    }
    level = node.childNodes;
  }
  return node;
}

/** What Enter types in one text, and for rich text the instance whose blocks the canvas edits. */
export interface CanvasTextBreaking {
  readonly breaks: CanvasTextBreaks;
  readonly richRoot?: string;
}

/**
 * What Enter types in each text of a page, keyed by the text's page path, from the editing settings of the component
 * instance it sits in. Rich text applies to the words of a block (a paragraph, a heading, a list item …) directly in
 * the instance's content, and only while that content is plain rich text (richTextView); line breaks apply to the
 * instance's own inline words. Desktop and Studio share it, so both canvases type the same thing.
 */
export function canvasTextBreaksOf<Node extends CanvasFormatTree<Node> & InlineCandidate>(
  nodes: readonly Node[],
  pathFor: (id: string) => string | undefined,
  settingsOf: (component: Node) => EditingSettings,
): ReadonlyMap<string, CanvasTextBreaking> {
  const breaks = new Map<string, CanvasTextBreaking>();
  const mark = (node: Node, kind: CanvasTextBreaking, depth: number) => {
    assert(depth <= LIMITS.treeDepthMax, 'Marked text sits at a bounded depth');
    if (node.kind === 'text') {
      const path = node.id === undefined ? undefined : pathFor(node.id);
      if (path !== undefined) {
        breaks.set(path, kind);
      }
      return;
    }
    if (node.kind === 'element' && INLINE_TAGS.has(node.name ?? '')) {
      (node.children ?? []).forEach((child) => mark(child, kind, depth + 1));
    }
  };
  const stack: Node[] = [...nodes];
  for (let visited = 0; visited < LIMITS.treeNodesMax && stack.length > 0; visited += 1) {
    const node = stack.pop();
    assert(node !== undefined, 'The stack held a node');
    stack.push(...(node.children ?? []));
    if (node.kind !== 'component') {
      continue;
    }
    const settings = settingsOf(node);
    const rich = settings.richText === true && richTextView(sourceOf(node), document).view === 'rich';
    const richRoot = rich && node.id !== undefined ? pathFor(node.id) : undefined;
    for (const child of node.children ?? []) {
      if (richRoot !== undefined) {
        markBlock(child, (text) => mark(text, { breaks: 'rich', richRoot }, 0));
      } else if (settings.lineBreaks === true) {
        mark(child, { breaks: 'line' }, 0);
      }
    }
  }
  return breaks;
}

// A block's words, and a list's items' words.
function markBlock<Node extends CanvasFormatTree<Node>>(block: Node, mark: (child: Node) => void): void {
  if (block.kind !== 'element') {
    return;
  }
  if (block.name === 'ul' || block.name === 'ol') {
    (block.children ?? []).filter((item) => item.name === 'li').forEach((item) => (item.children ?? []).forEach(mark));
    return;
  }
  if (SPLIT_BLOCKS.has(block.name ?? '')) {
    (block.children ?? []).forEach(mark);
  }
}

function sourceOf(node: object): string | undefined {
  return 'source' in node && typeof node.source === 'string' ? node.source : undefined;
}
