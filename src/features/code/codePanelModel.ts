import { LIMITS } from '../../../shared/core/limits';
import type { EditorModel, EditorNode } from '../../editor/pageView';
import { rendersOwnElement } from '../../editor/liveClasses';

export interface SourceRange {
  readonly from: number;
  readonly to: number;
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
