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
//
// The paths the page is tagged with move up with the delete (renumberedDeletePath,
// shared/page/canvasMove.ts), as a shown move and insert renumber theirs. Why: the next edit is
// planned over the new source, where the node's later siblings sit one place earlier. Measured in
// Studio with a 700 ms render: deleting a paragraph and then the one that took its place showed
// nothing for the second delete until its own render, about 1.6 s later, because the second
// delete named a path no element carried any more. The node's own marker comments leave with it
// for the same reason: left behind, they would share a path with the sibling renumbered onto it.

import { renumberedDeletePath } from '../../shared/page/canvasMove';
import { PREVIEW_STAMP_PREFIX } from '../../shared/page/previewToken';
import { isComment, isElement } from './frameBasics';
import { pendingKeptFrom, putBackPaths, renumberPaths, sourceStamps, type Undo } from './frameMove';
import { allElementsWithPath, runsOf } from './frameRegions';

// How long a removed node waits for the patch that confirms it.
const PENDING_CLEAR_MS = 5000;
// Nodes held out at once; a delete of a node in a loop is one element per item.
const GHOSTS_MAX = 4096;
// Comments read to find a node's marker pairs; the same bound a shown move reads stamps under.
const COMMENTS_MAX = 20_000;
const STAMP_PREFIX = PREVIEW_STAMP_PREFIX;
// Node.DOCUMENT_POSITION_FOLLOWING, spelled out: the frame modules also run where `Node` is not a global.
const DOCUMENT_POSITION_FOLLOWING = 4;

interface Ghost {
  readonly element: ChildNode;
  readonly parent: ParentNode;
  /** The sibling it stood before; undefined when it ended its parent. */
  readonly next: ChildNode | undefined;
}

interface Deleted {
  readonly path: string;
  readonly ghosts: readonly Ghost[];
  /** The page's paths before this delete renumbered them, to put back first. */
  readonly paths: Pick<Undo, 'attributes' | 'comments'>;
  /** The stamp of the source the delete was planned over, when the editor said (pendingKeptFrom). */
  readonly base: string | undefined;
}

let deleted: Deleted[] = [];
let clearTimer: ReturnType<typeof setTimeout> | undefined;
// The source the page was rendered from when the first pending delete was taken out.
let removedFrom: string | undefined;

export function hidePendingDelete(path: string, base?: string): void {
  // Read before the node leaves: a component's own stamp can sit inside its run.
  const stamps = deleted.length === 0 ? sourceStamps(document) : removedFrom;
  const entry = detach(path, base);
  if (entry === undefined) {
    return;
  }
  removedFrom = stamps;
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
  let replay: readonly Pick<Deleted, 'path' | 'base'>[] = [];
  document.addEventListener('avb:before-morph', (event) => {
    if (deleted.length === 0) {
      replay = [];
      return;
    }
    const incoming = event instanceof CustomEvent && event.detail instanceof Document ? sourceStamps(event.detail) : undefined;
    // A render from before a delete takes that node out again after the patch; the deletes it includes settle.
    const from = pendingKeptFrom(
      deleted.map((entry) => entry.base),
      incoming,
      removedFrom,
    );
    replay = deleted.slice(from);
    putBack();
    if (replay.length === 0) {
      forget();
    } else if (from > 0) {
      removedFrom = incoming; // The page now shows this rendering; the kept deletes were made over it.
    }
  });
  document.addEventListener('avb:after-patch', () => {
    const paths = replay;
    replay = [];
    if (paths.length === 0) {
      return;
    }
    const kept: Deleted[] = [];
    for (const { path, base } of paths) {
      const entry = detach(path, base);
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
    putBackPaths(entry.paths);
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

function detach(path: string, base: string | undefined): Deleted | undefined {
  const nodes = pendingNodes(path);
  if (nodes === undefined || nodes.length === 0 || nodes.length > GHOSTS_MAX) {
    return undefined;
  }
  const ghosts: Ghost[] = [];
  for (const node of nodes) {
    const parent = node.parentNode;
    if (parent !== null) {
      ghosts.push({ element: node, parent, next: node.nextSibling ?? undefined });
    }
  }
  for (const ghost of ghosts) {
    ghost.element.remove();
  }
  if (ghosts.length === 0) {
    return undefined;
  }
  const paths = renumberPaths((token) => renumberedDeletePath(token, path));
  return { path, ghosts, paths, base };
}

// Everything that measures the page listens for a patch: outlines, hover, the regions, the guide.
function announce(): void {
  document.dispatchEvent(new CustomEvent('avb:morphed', { detail: undefined }));
}

// The node's own nodes, in document order: its marker pairs with everything between them, and
// its tagged elements outside those. Undefined past the bound: the render shows such a delete.
function pendingNodes(path: string): ChildNode[] | undefined {
  const runs = markerRuns(path);
  if (runs === undefined) {
    return undefined;
  }
  const tagged = allElementsWithPath(path);
  const marked = (runsOf(path) ?? []).flatMap((run) => run.filter(isElement));
  const chosen: ChildNode[] = [...runs];
  for (const element of new Set([...tagged, ...marked])) {
    if (!chosen.some((node) => node === element || node.contains(element))) {
      chosen.push(element);
    }
  }
  // Outermost only: an element inside another chosen node leaves with it.
  const outermost = chosen.filter((node) => !chosen.some((other) => other !== node && other.contains(node)));
  return outermost.sort((left, right) => (left.compareDocumentPosition(right) & DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
}

// Every closed `avb-s:<path>` … `avb-e:<path>` pair, markers included. An unclosed pair (a
// layout's markers split across head and body) is left alone.
function markerRuns(path: string): ChildNode[] | undefined {
  const start = `avb-s:${path}`;
  const end = `avb-e:${path}`;
  const found: ChildNode[] = [];
  const walker = document.createTreeWalker(document, 128); // NodeFilter.SHOW_COMMENT
  for (let visited = 0; visited < COMMENTS_MAX; visited++) {
    const node = walker.nextNode();
    if (node === null) {
      return found;
    }
    if (!isComment(node) || node.data !== start) {
      continue;
    }
    const run: ChildNode[] = [node];
    for (let next = node.nextSibling; next !== null && run.length <= GHOSTS_MAX; next = next.nextSibling) {
      if (isComment(next) && next.data === end) {
        found.push(...run, next);
        break;
      }
      // A file's source stamp stays: it tells which source the page was rendered from.
      if (!isComment(next) || !next.data.startsWith(STAMP_PREFIX)) {
        run.push(next);
      }
    }
    if (found.length > GHOSTS_MAX) {
      return undefined;
    }
  }
  return undefined;
}
