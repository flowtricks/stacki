import type { TextMatch } from './frameTextMatch';

export interface TextOffsets {
  readonly start: number;
  readonly end: number;
}

/**
 * The text one editor may change: separate source texts in document order, and
 * the one that was opened. Offsets into runs count one extra position at each
 * seam between two runs, so the end of one run and the start of the next stay
 * different places: a caret after a <br> must not type before it.
 */
export interface TextSpace {
  readonly runs: readonly (readonly Text[])[];
  readonly primary: number;
}

export function textSelection(nodes: readonly Text[], range?: AbstractRange): TextOffsets | undefined {
  return runsSelection([nodes], range);
}

export function runsSelection(runs: TextSpace['runs'], range?: AbstractRange): TextOffsets | undefined {
  const selection = window.getSelection();
  const current = range ?? (selection?.rangeCount ? selection.getRangeAt(0) : undefined);
  if (!current) {
    return undefined;
  }
  const start = textOffset(runs, current.startContainer, current.startOffset);
  const end = textOffset(runs, current.endContainer, current.endOffset);
  if (start === undefined || end === undefined || start > end) {
    return undefined;
  }
  return { start, end };
}

export function selectTextOffsets(nodes: readonly Text[], offsets: TextOffsets): void {
  selectRunsOffsets([nodes], offsets);
}

export function selectRunsOffsets(runs: TextSpace['runs'], offsets: TextOffsets): void {
  const first = positionAt(runs, offsets.start);
  const last = positionAt(runs, offsets.end);
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
  const offsets = caretOffsetsAt(nodes, event.clientX, event.clientY) ?? caretBesideText(nodes, event) ?? caretByGeometry(nodes, event.clientX, event.clientY);
  if (offsets) {
    selectTextOffsets(nodes, offsets);
  }
}

function caretOffsetsAt(nodes: readonly Text[], x: number, y: number) {
  const range = document.caretRangeFromPoint(x, y);
  return range ? textSelection(nodes, range) : undefined;
}

// The caret position by where the characters are drawn, for a point the browser's hit test answers with something else: an element
// laid over the words (a card's stretched link) takes the point, so `caretRangeFromPoint` names that element's text and not these.
// The line nearest the point's height is found from each character's own box, then the character whose box holds the point's x;
// past either end of the line the caret goes to that end. Characters read are bounded.
const CARET_CHARS_MAX = 20_000;
function caretByGeometry(nodes: readonly Text[], x: number, y: number) {
  const lines: {
    readonly top: number;
    readonly bottom: number;
    readonly first: number;
    last: number;
    readonly rects: { readonly left: number; readonly right: number; readonly at: number }[];
  }[] = [];
  let total = 0;
  for (const node of nodes) {
    for (let index = 0; index < node.length && total < CARET_CHARS_MAX; index++, total++) {
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + 1);
      const box = typeof range.getClientRects === 'function' ? range.getClientRects()[0] : undefined;
      if (!box || box.width === 0) {
        continue;
      }
      const line = lines.find((entry) => Math.abs(entry.top - box.top) < box.height / 2);
      if (line) {
        line.rects.push({ left: box.left, right: box.right, at: total });
        line.last = total;
      } else {
        lines.push({ top: box.top, bottom: box.bottom, first: total, last: total, rects: [{ left: box.left, right: box.right, at: total }] });
      }
    }
  }
  if (lines.length === 0) {
    return undefined;
  }
  let nearest = lines[0];
  for (const line of lines) {
    const distance = y < line.top ? line.top - y : y > line.bottom ? y - line.bottom : 0;
    const best = nearest === undefined ? Infinity : y < nearest.top ? nearest.top - y : y > nearest.bottom ? y - nearest.bottom : 0;
    if (nearest === undefined || distance < best) {
      nearest = line;
    }
  }
  if (nearest === undefined) {
    return undefined;
  }
  let offset = nearest.last + 1;
  for (const rect of nearest.rects) {
    if (x < rect.left + (rect.right - rect.left) / 2) {
      offset = rect.at;
      break;
    }
  }
  return { start: offset, end: offset };
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

function textOffset(runs: TextSpace['runs'], container: Node, offset: number): number | undefined {
  let total = 0;
  for (const run of runs) {
    for (const node of run) {
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
    total += 1; // The seam before the next run.
  }
  return undefined;
}

function positionAt(runs: TextSpace['runs'], offset: number) {
  let remaining = offset;
  for (const run of runs) {
    for (const node of run) {
      if (remaining <= node.length) {
        return { node, offset: remaining };
      }
      remaining -= node.length;
    }
    remaining -= 1; // The seam before the next run.
  }
  const node = runs.at(-1)?.at(-1);
  return node ? { node, offset: node.length } : undefined;
}
