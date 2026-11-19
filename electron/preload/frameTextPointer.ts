// Pointer input over words that are being edited while something else is on top of them: a card's stretched link (`::after` over
// the whole card) takes the browser's hit test, so the press never reaches the editor and the browser would place no caret, select
// no word and drag no selection, and the click would end the edit. The press is then the editor's: inside the box of the edited
// words it places the caret at the character under it (found from where the characters are drawn), a double click selects the
// word, a triple click the whole text, and a drag extends the selection. A press that lands on the editor itself is left entirely
// to the browser, and a press outside the words keeps its old meaning.
import { caretByGeometry, selectTextOffsets } from './frameTextSelection';

/** Whether a point lies on a line of the words, by the boxes the browser draws their characters in. */
export function pointOnWords(nodes: readonly Text[], x: number, y: number): boolean {
  for (const node of nodes) {
    if (node.length === 0) {
      continue;
    }
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, node.length);
    if (typeof range.getClientRects !== 'function') {
      return false;
    }
    for (const box of Array.from(range.getClientRects())) {
      if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) {
        return true;
      }
    }
  }
  return false;
}

/** The word around an offset of the words' text, or the whole run of non-word characters it sits in. */
function wordAt(text: string, offset: number): { readonly start: number; readonly end: number } {
  const isWord = (character: string | undefined) => character !== undefined && /[\p{L}\p{N}_]/u.test(character);
  const inside = isWord(text[offset]) || !isWord(text[offset - 1]) ? offset : offset - 1;
  let start = inside;
  let end = inside;
  const kind = isWord(text[inside]);
  for (let step = 0; start > 0 && isWord(text[start - 1]) === kind && step < text.length; step++) {
    start--;
  }
  for (let step = 0; end < text.length && isWord(text[end]) === kind && step < text.length; step++) {
    end++;
  }
  return { start, end };
}

/** Installs the handling for one editing session; the result removes it. */
export function installInterceptedPointer(root: HTMLElement, nodes: readonly Text[]): () => void {
  let anchor: number | undefined;
  const text = () => nodes.map((node) => node.data).join('');
  const offsetAt = (event: MouseEvent) => caretByGeometry(nodes, event.clientX, event.clientY)?.start;
  // The editor takes its own presses: only those that something else would take are handled here.
  const intercepted = (event: MouseEvent) =>
    !(event.target instanceof Node && root.contains(event.target)) && pointOnWords(nodes, event.clientX, event.clientY);
  const down = (event: MouseEvent) => {
    if (event.button !== 0 || !intercepted(event)) {
      return;
    }
    const offset = offsetAt(event);
    if (offset === undefined) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    root.focus({ preventScroll: true });
    if (event.detail >= 3) {
      selectTextOffsets(nodes, { start: 0, end: text().length });
      anchor = undefined;
    } else if (event.detail === 2) {
      selectTextOffsets(nodes, wordAt(text(), offset));
      anchor = undefined;
    } else {
      selectTextOffsets(nodes, { start: offset, end: offset });
      anchor = offset;
    }
  };
  const move = (event: MouseEvent) => {
    // The press began here and its release (`up`) has not come: the pointer is dragging. (A release outside the window is never heard, so a later press starts afresh.)
    if (anchor === undefined) {
      return;
    }
    const offset = offsetAt(event);
    if (offset !== undefined) {
      selectTextOffsets(nodes, { start: Math.min(anchor, offset), end: Math.max(anchor, offset) });
    }
  };
  const up = () => {
    anchor = undefined;
  };
  window.addEventListener('mousedown', down, true);
  window.addEventListener('mousemove', move, true);
  window.addEventListener('mouseup', up, true);
  return () => {
    window.removeEventListener('mousedown', down, true);
    window.removeEventListener('mousemove', move, true);
    window.removeEventListener('mouseup', up, true);
  };
}
