// A deleted node leaves the canvas the moment it is deleted, really: its elements are taken out
// of the document, not hidden.
//
// A delete reaches the page only after the source is saved and the dev server has rendered the
// whole page again, during which the node sat there as if the key had not been pressed. The app
// says which node went (avb:hide-pending) and its elements are removed at once. Removed, not
// `display: none`: a hidden element still counts as a sibling, so `:last-child`, `:first-child`,
// `:only-child`, `:nth-*`, `+` and `~`, `:empty` and a margin-trim rule on the neighbours would
// keep matching the page as it was, and the heading before a deleted paragraph kept its trimmed
// margin until the render. With the node out of the DOM the browser re-evaluates every
// structural selector in the same frame. The elements are kept detached, in a list here, never
// in the document, so a refusal can put each back exactly where it stood.
//
// The rebuilt page is still the authority, as for a reorder (frameMove.ts). A patch assumes the
// live page is the previous rendering plus whatever the page's own scripts did, so just before a
// patch the elements are put back and the patch removes them itself, in the same task: nothing
// paints in between. Which rendering arrived is told by the source stamps (data-avb-d): one
// rendered from the source before the delete is a render of the old file, so the node is taken
// out again right after it. A patch that never comes puts the node back after a bound, so a
// refused delete cannot leave a node missing. Nothing here writes a file.

import { isElement } from './frameBasics';
import { sourceStamps } from './frameMove';
import { allElementsWithPath, runsOf } from './frameRegions';

// How long a removed node waits for the patch that confirms it.
const PENDING_CLEAR_MS = 5000;
// Nodes held out at once; a delete of a node in a loop is one element per item.
const GHOSTS_MAX = 4096;

interface Ghost {
  readonly element: Element;
  readonly parent: ParentNode;
  /** The sibling it stood before; undefined when it ended its parent. */
  readonly next: ChildNode | undefined;
}

interface Deleted {
  readonly path: string;
  readonly ghosts: readonly Ghost[];
}

let deleted: Deleted[] = [];
let clearTimer: ReturnType<typeof setTimeout> | undefined;
// The source the page was rendered from when the first pending delete was taken out.
let removedFrom: string | undefined;

export function hidePendingDelete(path: string): void {
  const entry = detach(path);
  if (entry === undefined) {
    return;
  }
  removedFrom ??= sourceStamps(document);
  deleted = [...deleted, entry];
  clearTimeout(clearTimer);
  clearTimer = setTimeout(clearPendingDeletes, PENDING_CLEAR_MS);
  announce();
}

/** Puts every removed node back where it stood: the write was refused, or never rendered. */
export function clearPendingDeletes(): void {
  const had = deleted.length > 0;
  putBack();
  forget();
  if (had) {
    announce();
  }
}

/** Whether deletes are shown and waiting for the page to confirm them. */
export function pendingDeletesCount(): number {
  return deleted.length;
}

/** The patcher's two moments (morphClient.ts): before it patches, and after. */
export function listenForPendingDeletes(): void {
  let replay: readonly string[] = [];
  document.addEventListener('avb:before-morph', (event) => {
    if (deleted.length === 0) {
      replay = [];
      return;
    }
    const incoming = event instanceof CustomEvent && event.detail instanceof Document ? sourceStamps(event.detail) : undefined;
    // A render of the old file takes the nodes out again after the patch; a newer one settles it.
    const stale = removedFrom !== undefined && removedFrom !== '' && incoming === removedFrom;
    replay = stale ? deleted.map((entry) => entry.path) : [];
    putBack();
    if (!stale) {
      forget();
    }
  });
  document.addEventListener('avb:after-patch', () => {
    const paths = replay;
    replay = [];
    if (paths.length === 0) {
      return;
    }
    const kept: Deleted[] = [];
    for (const path of paths) {
      const entry = detach(path);
      if (entry !== undefined) {
        kept.push(entry);
      }
    }
    deleted = kept;
    if (kept.length === 0) {
      forget();
    }
  });
}

// --- Internals ---------------------------------------------------------------------

function forget(): void {
  clearTimeout(clearTimer);
  clearTimer = undefined;
  deleted = [];
  removedFrom = undefined;
}

// Newest first, so each node meets its siblings as it left them.
function putBack(): void {
  for (let index = deleted.length - 1; index >= 0; index -= 1) {
    const entry = deleted[index];
    if (entry === undefined) {
      continue;
    }
    for (let at = entry.ghosts.length - 1; at >= 0; at -= 1) {
      const ghost = entry.ghosts[at];
      if (ghost === undefined) {
        continue;
      }
      if (ghost.next !== undefined && ghost.next.parentNode === ghost.parent) {
        ghost.next.before(ghost.element);
      } else {
        ghost.parent.append(ghost.element);
      }
    }
  }
  deleted = [];
}

function detach(path: string): Deleted | undefined {
  const elements = pendingElements(path);
  if (elements.length === 0 || elements.length > GHOSTS_MAX) {
    return undefined;
  }
  const ghosts: Ghost[] = [];
  for (const element of elements) {
    const parent = element.parentNode;
    if (parent !== null) {
      ghosts.push({ element, parent, next: element.nextSibling ?? undefined });
    }
  }
  for (const ghost of ghosts) {
    ghost.element.remove();
  }
  return ghosts.length === 0 ? undefined : { path, ghosts };
}

// Everything that measures the page listens for a patch: outlines, hover, the regions, the guide.
function announce(): void {
  document.dispatchEvent(new CustomEvent('avb:morphed', { detail: undefined }));
}

// The node's own elements: tagged with its path, or inside its marker runs.
function pendingElements(path: string): Element[] {
  const tagged = allElementsWithPath(path);
  const marked = (runsOf(path) ?? []).flatMap((run) => run.filter(isElement));
  return [...new Set([...tagged, ...marked])];
}
