// A deleted node leaves the canvas the moment it is deleted.
//
// A delete reaches the page only after the source is saved and the dev server
// has rendered the whole page again — a few hundred milliseconds on a large
// page, during which the node sat there as if the key had not been pressed. The
// app says which node went (avb:hide-pending), and its elements are hidden at
// once. The rebuilt page is still the authority: the next patch either removes
// those elements or, when the delete did not happen, shows them again, because
// the first patch rendered from the saved source clears the mark. That is told
// by the page's source stamps (one checksum per file, data-avb-d), not by any
// patch at all: the first refresh after a save can still be a render of the old
// file, and clearing on it would flash the node back for a moment. A patch that
// never comes clears the mark too, after a bound, so a refused delete cannot
// leave a node invisible. Paths are not used to un-hide: after a delete the next
// sibling takes the deleted node's path, so a path no longer names the node.

import { isElement } from './frameBasics';
import { STAMP_ATTRIBUTE, allElementsWithPath, runsOf } from './frameRegions';

export const PENDING_DELETE_ATTR = 'data-avb-pending-delete';

// Elements one delete may hide: a node in a loop is one element per item.
const PENDING_ELEMENTS_MAX = 1024;
// How long a hidden node waits for the patch that confirms it.
const PENDING_CLEAR_MS = 5000;

// Marks every pending delete may hold at once, across deletes in a row.
const PENDING_MARKS_MAX = 4096;

let stylesheet: CSSStyleSheet | undefined;
let clearTimer: ReturnType<typeof setTimeout> | undefined;
// The source the page was rendered from when the first pending delete was hidden.
let hiddenFrom: string | undefined;

export function hidePendingDelete(path: string): void {
  const elements = pendingElements(path);
  if (elements.length === 0) {
    return;
  }
  installPendingStyle();
  hiddenFrom ??= sourceStamps();
  for (const element of elements) {
    element.setAttribute(PENDING_DELETE_ATTR, '');
  }
  clearTimeout(clearTimer);
  clearTimer = setTimeout(clearPendingDeletes, PENDING_CLEAR_MS);
}

/** After a patch: un-hide once the page is rendered from source newer than the delete. */
export function settlePendingDeletes(): void {
  if (hiddenFrom === undefined) {
    return;
  }
  if (sourceStamps() !== hiddenFrom) {
    clearPendingDeletes();
  }
}

export function clearPendingDeletes(): void {
  clearTimeout(clearTimer);
  clearTimer = undefined;
  hiddenFrom = undefined;
  const marked = document.querySelectorAll(`[${PENDING_DELETE_ATTR}]`);
  const count = Math.min(marked.length, PENDING_MARKS_MAX);
  for (let index = 0; index < count; index += 1) {
    marked.item(index)?.removeAttribute(PENDING_DELETE_ATTR);
  }
}

// Which source the page is rendered from: every file's stamp, in page order.
function sourceStamps(): string {
  const stamped = document.querySelectorAll(`[${STAMP_ATTRIBUTE}]`);
  const count = Math.min(stamped.length, PENDING_MARKS_MAX);
  const stamps: string[] = [];
  for (let index = 0; index < count; index += 1) {
    stamps.push(stamped.item(index)?.getAttribute(STAMP_ATTRIBUTE) ?? '');
  }
  return stamps.join(' ');
}

// The node's own elements: tagged with its path, or inside its marker runs.
function pendingElements(path: string): Element[] {
  const tagged = allElementsWithPath(path, PENDING_ELEMENTS_MAX) ?? [];
  const marked = (runsOf(path) ?? []).flatMap((run) => run.filter(isElement));
  return [...new Set([...tagged, ...marked])].slice(0, PENDING_ELEMENTS_MAX);
}

function installPendingStyle(): void {
  if (stylesheet) {
    return;
  }
  stylesheet = new CSSStyleSheet();
  stylesheet.replaceSync(`[${PENDING_DELETE_ATTR}] { display: none !important; }`);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, stylesheet];
}
