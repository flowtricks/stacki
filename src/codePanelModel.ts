import { LIMITS } from '../shared/limits';
import type { EditorModel, EditorNode } from './appTypes';

export interface SourceRange {
  readonly from: number;
  readonly to: number;
}

export interface ComponentSourceRange extends SourceRange {
  readonly id: string;
  readonly name: string;
}

export function sourceRangeForSelection(
  model: EditorModel | null,
  selectedId: string | null,
  sourceLength: number
): SourceRange | null {
  if (!model || !selectedId) {
    return null;
  }
  if (selectedId === 'frontmatter') {
    const end = model.bodyStart;
    return typeof end === 'number' && end > 0 && end <= sourceLength ? { from: 0, to: end } : null;
  }
  const node = sourceNodeById(model.nodes, selectedId);
  return node ? sourceRangeForNode(node, sourceLength) : null;
}

export function sourceNodeAtOffset(
  nodes: readonly EditorNode[],
  offset: number
): EditorNode | null {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return null;
  }
  const pending = [...nodes];
  let best: EditorNode | null = null;
  let bestWidth = Number.POSITIVE_INFINITY;
  for (let index = 0; index < pending.length; index += 1) {
    if (index >= LIMITS.treeNodesMax) {
      throw new Error('Code source lookup exceeds the node limit');
    }
    const node = pending[index];
    if (!node) {
      continue;
    }
    const start = node.start;
    const end = node.end;
    if (typeof start === 'number' && typeof end === 'number') {
      const contains = start <= offset && offset <= end;
      const width = end - start;
      if (contains && width <= bestWidth) {
        best = node;
        bestWidth = width;
      }
    }
    if (Array.isArray(node.children)) {
      pending.push(...node.children);
    }
  }
  return best;
}

export function componentSourceRanges(
  nodes: readonly EditorNode[],
  source: string
): readonly ComponentSourceRange[] {
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
    if (
      node.kind === 'component' &&
      !node.dynamicTag &&
      !node.astroAsset &&
      node.name !== 'Fragment' &&
      typeof node.start === 'number'
    ) {
      const from = node.start + 1;
      const to = from + node.name.length;
      if (source.slice(from, to) === node.name) {
        ranges.push({ id: node.id, name: node.name, from, to });
      }
    }
    if (Array.isArray(node.children)) {
      pending.push(...node.children);
    }
  }
  return ranges;
}

export function sourceLineLabel(source: string, range: SourceRange | null): string | null {
  if (!range) {
    return null;
  }
  const startLine = sourceLineAt(source, range.from);
  const endLine = sourceLineAt(source, Math.max(range.from, range.to - 1));
  return startLine === endLine ? `L${startLine}` : `L${startLine}–${endLine}`;
}

function sourceNodeById(nodes: readonly EditorNode[], id: string): EditorNode | null {
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
    if (Array.isArray(node.children)) {
      pending.push(...node.children);
    }
  }
  return null;
}

function sourceRangeForNode(node: EditorNode, sourceLength: number): SourceRange | null {
  const start = node.start;
  const end = node.end;
  if (typeof start !== 'number' || typeof end !== 'number') {
    return null;
  }
  if (start < 0 || end < start || end > sourceLength) {
    return null;
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
