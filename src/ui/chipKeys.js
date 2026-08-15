// Backspace or Delete beside a chip should take the chip — one press, the
// whole thing, and nothing either side of it.
//
// Left to the browser this is unreliable: a `contenteditable=false` element
// with no text node next to it leaves the caret at an element-level position,
// and from there Chromium's own delete heuristics can take the whole field
// with them. So the one case that matters is handled here, and everything else
// (deleting characters, deleting a real selection) is left alone.

const isChip = (node) => !!node && node.nodeType === 1 && node.classList.contains('expr-chip');

// The chip the caret is sitting against, on the side it is about to delete
// towards: -1 for Backspace, 1 for Delete. Null when the caret is inside text,
// where an ordinary character delete is what was meant.
function chipBesideCaret(host, dir) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!range.collapsed || !host.contains(range.startContainer)) return null;
  const node = range.startContainer;
  const offset = range.startOffset;
  if (node.nodeType === 3) {
    // Only from the very edge of the text: anywhere else there is a character
    // to remove, which is what the key is for.
    if (dir < 0 ? offset > 0 : offset < node.nodeValue.length) return null;
    const sib = dir < 0 ? node.previousSibling : node.nextSibling;
    return isChip(sib) ? sib : null;
  }
  const child = dir < 0 ? node.childNodes[offset - 1] : node.childNodes[offset];
  return isChip(child) ? child : null;
}

/**
 * Handles Backspace/Delete against a chip inside `host`. Returns true when it
 * took one — the caller should then prevent the event and emit, since the DOM
 * has changed without the browser's own editing having run.
 */
export function deleteChipAtCaret(host, event) {
  if (!host) return false;
  if (event.key !== 'Backspace' && event.key !== 'Delete') return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  const chip = chipBesideCaret(host, event.key === 'Backspace' ? -1 : 1);
  if (!chip) return false;
  // Put the caret where the chip was, so typing carries on from that spot
  // rather than jumping to an end of the field.
  const parent = chip.parentNode;
  const at = Array.prototype.indexOf.call(parent.childNodes, chip);
  chip.remove();
  const range = document.createRange();
  range.setStart(parent, Math.min(at, parent.childNodes.length));
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}
