import { LIMITS } from '../../../shared/core/limits';
import type { EditorModel, EditorNode } from '../../editor/pageView';
import { rendersOwnElement } from '../../editor/liveClasses';

export interface SourceRange {
  readonly from: number;
  readonly to: number;
}

/** Code a refusal pointed at, for the Code panel to show: which element, where, and the text it expects there. */
export interface CodeReveal extends SourceRange {
  readonly nodeId: string;
  readonly code: string;
}

export interface ComponentSourceRange extends SourceRange {
  readonly id: string;
  readonly name: string;
}

export function sourceRangeForSelection(model: EditorModel | undefined, selectedId: string | undefined, sourceLength: number): SourceRange | undefined {
  if (!model || !selectedId) {
    return undefined;
  }
  if (selectedId === 'frontmatter') {
    const end = model.bodyStart;
    if (typeof end === 'number' && end > 0 && end <= sourceLength) {
      return { from: 0, to: end };
    }
    return undefined;
  }
  const node = sourceNodeById(model.nodes, selectedId);
  return node ? sourceRangeForNode(node, sourceLength) : undefined;
}

export function sourceNodeAtOffset(nodes: readonly EditorNode[], offset: number): EditorNode | undefined {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return undefined;
  }
  const pending: { readonly node: EditorNode; readonly parent: EditorNode | undefined }[] = nodes.map((node) => ({ node, parent: undefined }));
  let best: EditorNode | undefined = undefined;
  let bestWidth = Number.POSITIVE_INFINITY;
  for (let index = 0; index < pending.length; index += 1) {
    if (index >= LIMITS.treeNodesMax) {
      throw new Error('Code source lookup exceeds the node limit');
    }
    const entry = pending[index];
    if (!entry) {
      continue;
    }
    const { node, parent } = entry;
    const candidate = sourceSelectableNode(node, parent);
    const start = candidate.start;
    const end = candidate.end;
    if (typeof start === 'number' && typeof end === 'number') {
      const contains = start <= offset && offset <= end;
      const width = end - start;
      if (contains) {
        if (width <= bestWidth) {
          best = candidate;
          bestWidth = width;
        }
      }
    }
    if (node.children !== undefined) {
      pending.push(...node.children.map((child) => ({ node: child, parent: node })));
    }
  }
  return best;
}

function sourceSelectableNode(node: EditorNode, parent: EditorNode | undefined): EditorNode {
  if (node.kind !== 'text') {
    return node;
  }
  if (parent === undefined) {
    return node;
  }
  // Text has no box of its own in the preview. Its containing tag does.
  if (parent.kind === 'element') {
    return rendersOwnElement(parent) ? parent : node;
  }
  if (parent.kind === 'component') {
    return rendersOwnElement(parent) ? parent : node;
  }
  return node;
}

export function componentSourceRanges(nodes: readonly EditorNode[], source: string): readonly ComponentSourceRange[] {
  const ranges: ComponentSourceRange[] = [];
  const pending = [...nodes];
  for (let index = 0; index < pending.length; index += 1) {
    if (index >= LIMITS.treeNodesMax) {
      throw new Error('Code component lookup exceeds the node limit');
    }
    const node = pending[index];
    if (!node) {
      continue;
    }
    if (node.kind === 'component' && !node.dynamicTag && !node.astroAsset && node.name !== 'Fragment' && typeof node.start === 'number') {
      const from = node.start + 1;
      const to = from + node.name.length;
      if (source.slice(from, to) === node.name) {
        ranges.push({ id: node.id, name: node.name, from, to });
      }
    }
    if (node.children !== undefined) {
      pending.push(...node.children);
    }
  }
  return ranges;
}

/** A selection as "Add to chat" takes it: the code as it reads now, its lines, and the element it is, if it is one. */
export interface SourceSelection {
  readonly code: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly element: string | undefined;
}

/** The text a person selected in the editor, exactly. */
export function textSelectionOf(source: string, range: SourceRange): SourceSelection | undefined {
  if (range.from < 0 || range.to <= range.from || range.to > source.length) {
    return undefined;
  }
  const code = source.slice(range.from, range.to);
  return { code, startLine: sourceLineAt(source, range.from), endLine: sourceLineAt(source, range.to - 1), element: undefined };
}

/** What the Code panel asks to add: the text selected in the editor, or the selected element. */
export type CodeAddRequest = { readonly kind: 'text'; readonly selection: SourceSelection } | { readonly kind: 'node'; readonly id: string };

/** Whether node `id` has code of its own in the open file, and what to call it: a component's name, an element's `<tag>`. */
export function offeredNodeOf(model: EditorModel | undefined, id: string): { readonly name: string | undefined } | undefined {
  if (model === undefined) {
    return undefined;
  }
  if (id === 'frontmatter') {
    return { name: undefined };
  }
  const node = sourceNodeById(model.nodes, id);
  // A chunk group's code is in another file.
  if (node === undefined || node.kind === 'chunk-group') {
    return undefined;
  }
  return { name: node.kind === 'component' ? node.name : node.kind === 'element' ? `<${node.name}>` : undefined };
}

/**
 * Node `id`'s own code: from the start of its first line when only the indent precedes it, so the code reads as
 * it is laid out. Undefined for a node with no code of its own, or one whose place no longer matches the source (an
 * edit the tree has not read yet): a wrong slice would be worse than none.
 */
export function nodeSelectionOf(source: string, model: EditorModel | undefined, id: string | undefined, path: string): SourceSelection | undefined {
  const range = sourceRangeForSelection(model, id, source.length);
  if (model === undefined || id === undefined || range === undefined || range.to <= range.from) {
    return undefined;
  }
  const node = id === 'frontmatter' ? undefined : sourceNodeById(model.nodes, id);
  const tagged = node?.kind === 'element' || node?.kind === 'component';
  // Markdown writes its elements in its own syntax; anywhere else a tag's code opens with the tag.
  if (tagged && !/\.mdx?$/iu.test(path) && !source.startsWith(`<${node.name}`, range.from)) {
    return undefined;
  }
  // A text node runs from tag to tag, with the line breaks around its words: those are not part of the selection.
  const own = node?.kind === 'text' ? trimmedRange(source, range) : range;
  const lineStart = source.lastIndexOf('\n', own.from - 1) + 1;
  const from = own.from > 0 && /^[ \t]*$/u.test(source.slice(lineStart, own.from)) ? lineStart : own.from;
  const selection = textSelectionOf(source, { from, to: own.to });
  return selection === undefined ? undefined : { ...selection, element: tagged ? node.name : undefined };
}

function trimmedRange(source: string, range: SourceRange): SourceRange {
  const code = source.slice(range.from, range.to);
  const from = range.from + (code.length - code.trimStart().length);
  const to = range.to - (code.length - code.trimEnd().length);
  return { from, to: Math.max(from, to) };
}

export function sourceLineLabel(source: string, range: SourceRange | undefined): string | undefined {
  if (!range) {
    return undefined;
  }
  const startLine = sourceLineAt(source, range.from);
  const endLine = sourceLineAt(source, Math.max(range.from, range.to - 1));
  return startLine === endLine ? `L${startLine}` : `L${startLine}–${endLine}`;
}

function sourceNodeById(nodes: readonly EditorNode[], id: string): EditorNode | undefined {
  const pending = [...nodes];
  for (let index = 0; index < pending.length; index += 1) {
    if (index >= LIMITS.treeNodesMax) {
      throw new Error('Code selection lookup exceeds the node limit');
    }
    const node = pending[index];
    if (!node) {
      continue;
    }
    if (node.id === id) {
      return node;
    }
    if (node.children !== undefined) {
      pending.push(...node.children);
    }
  }
  return undefined;
}

function sourceRangeForNode(node: EditorNode, sourceLength: number): SourceRange | undefined {
  const start = node.start;
  const end = node.end;
  if (typeof start !== 'number' || typeof end !== 'number') {
    return undefined;
  }
  if (start < 0 || end < start || end > sourceLength) {
    return undefined;
  }
  return { from: start, to: end };
}

function sourceLineAt(source: string, offset: number): number {
  const end = Math.min(Math.max(offset, 0), source.length);
  let line = 1;
  for (let index = 0; index < end; index += 1) {
    if (source.charAt(index) === '\n') {
      line += 1;
    }
  }
  return line;
}

// Past this the opening tag is not searched further: a tag's attributes are bounded where they are parsed.
const OPENING_TAG_CHARS_MAX = 64 * 1024;

/**
 * Where a piece of an attribute's expression sits in the file: `snippet` gives
 * offsets into the `{…}` of `attribute` on `node`'s own opening tag. Undefined
 * when the source no longer holds that code there (it was edited since), so a
 * caller falls back to the element.
 */
export function attributeCodeRange(
  source: string,
  node: Pick<EditorNode, 'start' | 'end'>,
  attribute: string,
  snippet: { readonly code: string; readonly from: number; readonly to: number },
): SourceRange | undefined {
  if (typeof node.start !== 'number' || node.start < 0 || node.start >= source.length) {
    return undefined;
  }
  if (snippet.from < 0 || snippet.to < snippet.from) {
    return undefined;
  }
  const end = Math.min(source.length, typeof node.end === 'number' ? node.end : source.length, node.start + OPENING_TAG_CHARS_MAX);
  const tag = source.slice(node.start, end);
  // The element's own attribute comes before any child, so the first match is it.
  // `class` must not match `class:list`, nor `data-class`.
  const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?<![\\w:-])${escaped}\\s*=\\s*\\{`).exec(tag);
  if (match === null) {
    return undefined;
  }
  const expressionStart = node.start + match.index + match[0].length;
  const from = expressionStart + snippet.from;
  const to = expressionStart + snippet.to;
  if (source.slice(from, to) !== snippet.code) {
    return undefined;
  }
  return { from, to };
}
