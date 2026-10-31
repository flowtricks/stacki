import type { TextMatch } from './frameTextMatch';

export interface TextOffsets {
  readonly start: number;
  readonly end: number;
}

export function textSelection(
  nodes: readonly Text[],
  range?: AbstractRange,
): TextOffsets | undefined {
  const selection = window.getSelection();
  const current = range ?? (selection?.rangeCount ? selection.getRangeAt(0) : undefined);
  if (!current) {
    return undefined;
  }
  const start = textOffset(nodes, current.startContainer, current.startOffset);
  const end = textOffset(nodes, current.endContainer, current.endOffset);
  if (start === undefined || end === undefined || start > end) {
    return undefined;
  }
  return { start, end };
}

export function selectTextOffsets(nodes: readonly Text[], offsets: TextOffsets): void {
  const first = positionAt(nodes, offsets.start);
  const last = positionAt(nodes, offsets.end);
  if (!first || !last) {
    return;
  }
  const range = document.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export function placeTextCaret(nodes: readonly Text[], event: MouseEvent): void {
  const offsets =
    caretOffsetsAt(nodes, event.clientX, event.clientY) ?? caretBesideText(nodes, event);
  if (offsets) {
    selectTextOffsets(nodes, offsets);
  }
}

function caretOffsetsAt(nodes: readonly Text[], x: number, y: number) {
  const range = document.caretRangeFromPoint(x, y);
  return range ? textSelection(nodes, range) : undefined;
}

// A double-click beside the words (frameText.ts) puts the caret at the point
// in them nearest the click: the click moved inside their box.
function caretBesideText(nodes: readonly Text[], event: MouseEvent) {
  const first = nodes[0];
  const last = nodes.at(-1);
  if (!first || !last) {
    return undefined;
  }
  const range = document.createRange();
  range.setStart(first, 0);
  range.setEnd(last, last.length);
  const box = range.getBoundingClientRect();
  const x = Math.min(Math.max(event.clientX, box.left + 1), box.right - 1);
  const y = Math.min(Math.max(event.clientY, box.top + 1), box.bottom - 1);
  return caretOffsetsAt(nodes, x, y);
}

export function textEditorRoot(match: TextMatch): HTMLElement | undefined {
  let root = match.nodes[0]?.parentElement;
  // Match traversal is capped at 1,000 nodes; ancestry also has a fixed depth bound.
  for (let depth = 0; root && depth < 32; depth++) {
    if (match.nodes.every((node) => root?.contains(node))) {
      return root instanceof HTMLElement ? root : undefined;
    }
    root = root.parentElement;
  }
  return undefined;
}

function textOffset(nodes: readonly Text[], container: Node, offset: number): number | undefined {
  let total = 0;
  for (const node of nodes) {
    if (container === node) {
      return offset <= node.length ? total + offset : undefined;
    }
    // Browsers can represent a selection at the parent's child boundary.
    const children = node.parentNode?.childNodes;
    if (container === node.parentNode && children) {
      const index = Array.from(children).indexOf(node);
      if (offset === index) {
        return total;
      }
      if (offset === index + 1) {
        return total + node.length;
      }
    }
    total += node.length;
  }
  return undefined;
}

function positionAt(nodes: readonly Text[], offset: number) {
  let remaining = offset;
  for (const node of nodes) {
    if (remaining <= node.length) {
      return { node, offset: remaining };
    }
    remaining -= node.length;
  }
  const node = nodes.at(-1);
  return node ? { node, offset: node.length } : undefined;
}
