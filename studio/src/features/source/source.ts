import { parsePage } from '../../../vendor/stacki/electron/parse/astroParser';
import type { ParserNode } from '../../../vendor/stacki/electron/parse/astroParserTypes';
import { MAX_SOURCE, record, string } from '../../shared/validation';
import { parseClipboard, type NodeClipboard } from './clipboardPayload';
import { parseInsertContent, type InsertContent } from './insertContentContract';

export { parsePage };
export type { ParserNode };
export interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}
export type TreeAction =
  | {
      readonly kind: 'paste';
      readonly target: string;
      readonly placement: 'inside' | 'after';
      readonly clipboard: NodeClipboard;
    }
  | {
      readonly kind: 'insert-content';
      readonly target: string;
      readonly placement: 'before' | 'after' | 'inside';
      readonly content: InsertContent;
    }
  | { readonly kind: 'delete'; readonly node: string }
  | { readonly kind: 'duplicate'; readonly node: string }
  | { readonly kind: 'wrap-text'; readonly node: string; readonly name: 'div' | 'span' }
  | {
      readonly kind: 'move';
      readonly node: string;
      readonly target: string;
      readonly placement: 'before' | 'after' | 'inside';
    }
  | {
      readonly kind: 'insert';
      readonly target: string;
      readonly name: string;
      readonly importPath: string;
      readonly paired: boolean;
      readonly placement?: 'before' | 'after' | 'inside';
    };

export function nodesOf(source: string): ParserNode[] {
  const parsed = parsePage(source, { locs: true });
  if (!parsed.editable) {
    throw new Error(parsed.reason);
  }
  return parsed.model.nodes;
}
export function flatten(nodes: readonly ParserNode[]): ParserNode[] {
  const out: ParserNode[] = [];
  const queue = [...nodes].reverse();
  while (queue.length && out.length < 10_000) {
    const node = queue.pop();
    if (!node) {
      break;
    }
    out.push(node);
    if (node.children) {
      queue.push(...[...node.children].reverse());
    }
  }
  return out;
}
export function nodeAt(source: string, id: string): ParserNode {
  const node = flatten(nodesOf(source)).find((node) => node.id === id);
  if (!node || node.start === undefined || node.end === undefined) {
    throw new Error('Selection changed. Select the element again.');
  }
  return node;
}
export function bounds(node: ParserNode) {
  if (node.start === undefined || node.end === undefined) {
    throw new Error('This node has no editable source range');
  }
  return { start: node.start, end: node.end };
}
export function applyEdits(source: string, edits: readonly Edit[]): string {
  let previous = source.length + 1;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    if (edit.start < 0 || edit.end < edit.start || edit.end > source.length || edit.end > previous) {
      throw new Error('Overlapping edit');
    }
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
    previous = edit.start;
  }
  if (source.length > MAX_SOURCE) {
    throw new Error('File exceeds 1 MB limit');
  }
  return source;
}
export function attributeEdit(source: string, id: string, name: string, value: string | undefined, expression = false): Edit {
  if (!/^[A-Za-z_:][\w:.-]*$/.test(name)) {
    throw new Error('Invalid property name');
  }
  const node = nodeAt(source, id);
  if (node.kind !== 'component' && node.kind !== 'element') {
    throw new Error('Select a component or element');
  }
  const spans = node.attrSpans?.filter((span) => span.name === name) ?? [];
  if (spans.length > 1) {
    throw new Error('Duplicate attributes require source editing');
  }
  const text = value === undefined ? '' : expression ? `${name}={${value}}` : `${name}="${escapeAttribute(value)}"`;
  const span = spans[0];
  if (span) {
    return { start: span.span.start, end: span.span.end, text };
  }
  const start = bounds(node).start + 1 + node.name.length;
  return { start, end: start, text: text ? ` ${text}` : '' };
}
export function contentEdit(source: string, id: string, value: string): Edit {
  const node = nodeAt(source, id);
  if (node.kind === 'text') {
    return { ...bounds(node), text: escapeText(value) };
  }
  if (!node.children || node.children.some((child) => child.kind !== 'text')) {
    throw new Error('Edit nested content through the navigator');
  }
  const first = node.children[0];
  const last = node.children.at(-1);
  if (first && last) {
    return { start: bounds(first).start, end: bounds(last).end, text: escapeText(value) };
  }
  const end = closingOffset(source, node);
  return { start: end, end, text: escapeText(value) };
}
function closingOffset(source: string, node: ParserNode): number {
  if (!node.children) {
    throw new Error('This component does not have a child slot');
  }
  const { start, end } = bounds(node);
  const offset = source.lastIndexOf('</', end - 1);
  if (offset < start) {
    throw new Error('Cannot find a safe insertion point');
  }
  return offset;
}
export function parseAction(input: unknown): TreeAction {
  const action = record(input);
  const kind = string(action['kind'], 20);
  if (kind === 'insert-content') {
    const placement = action['placement'];
    if (placement !== 'before' && placement !== 'after' && placement !== 'inside') {
      throw new Error('Invalid placement');
    }
    return {
      kind,
      target: string(action['target'], 200),
      placement,
      content: parseInsertContent(action['content']),
    };
  }
  if (kind === 'paste') {
    if (action['placement'] !== 'inside' && action['placement'] !== 'after') {
      throw new Error('Invalid placement');
    }
    return {
      kind,
      target: string(action['target'], 200),
      placement: action['placement'],
      clipboard: parseClipboard(action['clipboard']),
    };
  }
  if (kind === 'delete' || kind === 'duplicate') {
    return { kind, node: string(action['node'], 200) };
  }
  if (kind === 'wrap-text') {
    const name = action['name'];
    if (name !== 'div' && name !== 'span') {
      throw new Error('Invalid text tag');
    }
    return { kind, node: string(action['node'], 200), name };
  }
  if (kind === 'move') {
    const placement = action['placement'];
    if (placement !== 'before' && placement !== 'after' && placement !== 'inside') {
      throw new Error('Invalid placement');
    }
    return {
      kind,
      node: string(action['node'], 200),
      target: string(action['target'], 200),
      placement,
    };
  }
  if (kind === 'insert') {
    return {
      kind,
      target: string(action['target'], 200),
      name: string(action['name'], 100),
      importPath: string(action['importPath'], 500),
      paired: action['paired'] === true,
      ...(action['placement'] === 'before' || action['placement'] === 'after' || action['placement'] === 'inside' ? { placement: action['placement'] } : {}),
    };
  }
  throw new Error('Unknown operation');
}
function escapeAttribute(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}
function escapeText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('{', '&#123;');
}

export function nodeId(node: ParserNode): string {
  if (!node.id) {
    throw new Error('Node is missing its identity');
  }
  return node.id;
}
