// Which pass of a loop a rendered node is in.
//
// The marked page writes a comment at the start of every pass of a loop
// (shared/page/previewIteration.ts). The collector reads them with the node
// markers and takes them out of the document, as it does those, so each is
// kept here as the place it stood: the first node after it. A node is in the
// pass whose mark is the last one to stand before it, among the marks of one
// loop. That holds whatever the pass rendered, which is the point: a node a
// condition leaves out of every pass but the third is still found after the
// third pass's mark, and counting copies of the node would have called it the
// first.

import { assert } from '../../shared/core/assert';
import { ITERATION_LIMITS, parseIterationMarker, type PreviewIteration } from '../../shared/page/previewIteration';
import { isComment, isElement, isText } from './frameBasics';
import { parentPath } from './framePaths';

interface Mark extends PreviewIteration {
  /** The first rendered node after the comment: where the pass begins. */
  readonly anchor: Node;
}

let marks: Mark[] = [];

/** Whether a comment is an iteration marker. */
/** Whether a comment's text is an iteration marker's. */
export const isIterationData = (data: string): boolean => parseIterationMarker(data) !== undefined;

// Where a pass begins: the next sibling that is not another marker or blank space. A pass that
// renders nothing there has no place, and so no node to be found in it.
function anchorAfter(comment: Comment): Node | undefined {
  for (let node = comment.nextSibling; node; node = node.nextSibling) {
    if (isComment(node) && node.data.startsWith('avb-')) {
      continue;
    }
    if (isElement(node) && node.tagName === 'TEMPLATE' && node.getAttribute('data-avb-s') !== null) {
      continue;
    }
    if (isElement(node) && node.tagName === 'TEMPLATE' && node.getAttribute('data-avb-e') !== null) {
      continue;
    }
    if (isText(node) && node.textContent.trim() === '') {
      continue;
    }
    return node;
  }
  return undefined;
}

/** Keeps the places of the comments found this pass, in document order, after those of earlier passes still on the page. */
export function recordIterationMarks(comments: readonly Comment[]): void {
  assert(comments.length <= ITERATION_LIMITS.marksMax * 2, 'recordIterationMarks: a page holds a bounded number of passes');
  marks = marks.filter((mark) => mark.anchor.isConnected);
  for (const comment of comments) {
    const read = parseIterationMarker(comment.data);
    const anchor = anchorAfter(comment);
    if (read !== undefined && anchor !== undefined) {
      marks.push({ ...read, anchor });
    }
  }
  if (marks.length > ITERATION_LIMITS.marksMax) {
    marks = marks.slice(marks.length - ITERATION_LIMITS.marksMax);
  }
  assert(marks.length <= ITERATION_LIMITS.marksMax, 'recordIterationMarks: the kept marks are bounded');
}

// Whether the pass that began at `anchor` can hold `node`: the node is the anchor, inside it, or after it.
function holds(anchor: Node, node: Node): boolean {
  if (anchor === node || anchor.contains(node)) {
    return true;
  }
  return (anchor.compareDocumentPosition(node) & 4) !== 0; // DOCUMENT_POSITION_FOLLOWING
}

/**
 * The passes `node` is in, one per loop in `loopPaths` that has a mark standing before it, in the
 * order the paths are given. A loop with no mark before the node (older cached pages, a loop the
 * page does not read a list for) is left out: the editor reads that as unknown.
 */
export function iterationsOf(node: Node, loopPaths: readonly string[]): PreviewIteration[] {
  assert(loopPaths.length <= ITERATION_LIMITS.loopsMax * 4, 'iterationsOf: a node sits in a bounded number of ancestors');
  const found: PreviewIteration[] = [];
  for (const path of loopPaths) {
    let latest: Mark | undefined = undefined;
    for (const mark of marks) {
      if (mark.path !== path || !mark.anchor.isConnected || !holds(mark.anchor, node)) {
        continue;
      }
      if (latest === undefined || (latest.anchor !== mark.anchor && latest.anchor.compareDocumentPosition(mark.anchor) & 4)) {
        latest = mark;
      }
    }
    if (latest !== undefined) {
      found.push({ path, index: latest.index });
    }
  }
  assert(found.length <= loopPaths.length, 'iterationsOf: at most one pass per loop');
  return found.slice(0, ITERATION_LIMITS.loopsMax);
}

/** Forgets every mark: the page was replaced. */
export function forgetIterationMarks(): void {
  marks = [];
}

/**
 * The passes a click names for the copy `run` of the node at `nodePath`: one per loop around it that
 * marked its passes, the loop named by its own path. Empty when no loop around the node did.
 */
export function iterationsForRun(nodePath: string, run: readonly Node[] | undefined): PreviewIteration[] {
  const node = run?.find(isElement) ?? run?.[0];
  if (node === undefined) {
    return [];
  }
  const loopPaths: string[] = [];
  for (let path = parentPath(nodePath); path !== undefined && loopPaths.length < ITERATION_LIMITS.loopsMax * 4; path = parentPath(path)) {
    loopPaths.push(path);
  }
  return iterationsOf(node, loopPaths);
}
