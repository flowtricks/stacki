// Patching the live page by the difference between the server's previous
// rendering and its new one: child lists lined up by longest common
// subsequence, live nodes found past whatever the client added, and only
// what the two renderings disagree about written.

import { isAnchor, asElement, asText, asComment } from './morphNodes';
import { spendMorphWork } from './morphBudget';

// Never looked inside. A dev stylesheet belongs to Vite, which swaps it in by
// data-vite-dev-id; an external script re-runs if it is re-inserted, which is
// the reload this exists to avoid.
//
// <template> is opaque for a different reason: its markup lives in a separate
// fragment rather than in childNodes.
//
// <noscript> is not here. A fetched rendering is parsed with scripting off, so
// its <noscript> markup came back as elements while the live page holds text;
// pinning it hid that mismatch from the walk, but an insertion still carried
// the elements in, live. morphClient now flattens every parsed <noscript> to
// its text first (inertNoscripts), so all three trees agree and its text is
// patched like any other.
const pinned = (node: Node): boolean => {
  if (!asElement(node)) {
    return false;
  }
  return (
    node.tagName === 'TEMPLATE' ||
    (node.tagName === 'SCRIPT' && !!node.getAttribute('src')) ||
    (node.tagName === 'STYLE' && node.hasAttribute('data-vite-dev-id'))
  );
};

// An id, and deliberately nothing else. `data-avb-p` looks like a better key —
// it is the editor's own node path — but the canvas stamps it onto live
// elements as it records them, while the server's HTML mostly has no such
// attribute. Reading it here compared a stamped path against an id, decided
// every element was a different element, and fell back to reloading the page
// on every keystroke: the exact thing this was written to stop.
const keyOf = (node: Node | undefined): string | undefined => {
  if (node !== undefined && asElement(node)) {
    return node.getAttribute('id') || undefined;
  }
  return undefined;
};

// What makes two nodes the same kind of thing for the purpose of lining up two
// lists: a tag, and an id if it has one. Every text node is interchangeable
// with every other, and so is every comment — their content is what changes,
// and the diff below decides which is which.
//
// Class is pointedly NOT part of this. It reads like free identity, but a
// class is the thing these props exist to change: pick another variant or
// theme and a wrapper goes from `theme-brand` to `theme-invert`. Counting that
// as a different element meant the old one was removed and a new one built in
// its place — and a wrapper takes the whole page down with it, which is why
// changing a variant threw the canvas back to the top. It is an attribute, and
// it is patched like one.
function keyFor(node: Node): string {
  if (asElement(node)) {
    return 'e:' + node.tagName + '#' + (keyOf(node) || '');
  }
  return asComment(node) ? 'c' : 't';
}

// Longest common subsequence over the two child lists.
//
// This replaces the obvious thing — walk both lists and guess, when they stop
// agreeing, whether something was inserted or removed. That guess is wrong far
// too often: whitespace text nodes are everywhere and all alike, so a look
// ahead always finds one, decides a node was inserted, and from there every
// remaining sibling is rebuilt. An element that was only meant to keep still
// loses its animation, its scroll position and anything the client hung on it.
// Consume a shared prefix before building the matrix. Most edits change text
// or attributes, leaving every child key in place; those lists, along with
// appends and removals at the end, take linear time and memory. The remaining
// matrix keeps the existing tie-breaking for repeated text and element keys.
type DiffOp = readonly [kind: number, i: number, j: number];

export function diffChildren(before: readonly string[], after: readonly string[]): DiffOp[] {
  const beforeCount = before.length;
  const afterCount = after.length;
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < beforeCount && j < afterCount && before[i] === after[j]) {
    ops.push([0, i++, j++]);
  }

  const start = i;
  const dp: Int32Array[] = [];
  if (i < beforeCount && j < afterCount) {
    spendMorphWork((beforeCount - start + 1) * (afterCount - start + 1));
    for (let row = 0; row <= beforeCount - start; row++) {
      dp.push(new Int32Array(afterCount - start + 1));
    }
    for (let row = beforeCount - start - 1; row >= 0; row--) {
      const currentRow = dp[row];
      const next = dp[row + 1];
      if (!currentRow || !next) {
        continue;
      }
      for (let col = afterCount - start - 1; col >= 0; col--) {
        currentRow[col] = before[row + start] === after[col + start] ? (next[col + 1] ?? 0) + 1 : Math.max(next[col] ?? 0, currentRow[col + 1] ?? 0);
      }
    }
  }
  while (i < beforeCount && j < afterCount) {
    if (before[i] === after[j]) {
      ops.push([0, i++, j++]);
      continue; // keep
    }
    if ((dp[i - start + 1]?.[j - start] ?? 0) >= (dp[i - start]?.[j - start + 1] ?? 0)) {
      ops.push([-1, i++, -1]); // removed
    } else {
      ops.push([1, -1, j++]); // inserted
    }
  }
  while (i < beforeCount) {
    ops.push([-1, i++, -1]);
  }
  while (j < afterCount) {
    ops.push([1, -1, j++]);
  }
  return ops;
}

// Raised when the live document cannot be lined up with the server's, which
// happens when client code has rearranged something this cannot reason about.
// The caller turns it into the reload it replaced: losing the running state is
// a disappointment, patching the wrong element is a bug.
function Ambiguous(what: string): Error {
  return new Error('cannot line up ' + what + ' with the live page');
}

// The live node standing for a server node. The scan steps over anything the
// client added — that is the whole point — and over the editor's own markers,
// which are put back separately.
//
// A key is taken at its word. Without one, class is evidence — but the test is
// whether the live node still carries the classes the SERVER gave it, not
// whether the two lists are identical. Client code adds classes constantly, and
// that is the one thing this must not read as a different element: a tablist
// marks its open tab `is-active`, so `tabs_link is-active` stopped matching the
// server's `tabs_link`, the scan ran on to the next tab — which still had the
// pristine class — and matched THAT. Two tabs were patched as each other and
// the third had nothing left to match, so the page reloaded, which is the
// flicker this whole file exists to avoid.
//
// Order is the stronger signal, because the diff has already decided which
// nodes persist and in what order. So the first candidate that isn't
// contradicted wins, and scanning past one for a "better" match is exactly the
// mistake. A same-tag node is still remembered as a last resort, for the case
// where client code took one of the server's own classes away.
const classesOf = (node: Element): string[] => (node.getAttribute('class') || '').split(/\s+/).filter(Boolean);

// Every class the server put on the node is still on the live one. A node the
// server gave no class to has to have none either — otherwise the test is
// vacuous and would match anything, including a node the client inserted.
function keepsClassesOf(live: Element, serverNode: Element): boolean {
  const want = classesOf(serverNode);
  if (!want.length) {
    return live.classList.length === 0;
  }
  for (const className of want) {
    if (!live.classList.contains(className)) {
      return false;
    }
  }
  return true;
}

export function findLive(from: Node | undefined, serverNode: Node): Node | undefined {
  let loose: Element | undefined = undefined;
  if (!asElement(serverNode)) {
    for (let node = from; node; node = node.nextSibling ?? undefined) {
      if (isAnchor(node)) {
        continue;
      }
      if (node.nodeType === serverNode.nodeType) {
        return node;
      }
    }
    return undefined;
  }
  const key = keyOf(serverNode);
  for (let node = from; node; node = node.nextSibling ?? undefined) {
    if (isAnchor(node)) {
      continue;
    }
    if (!asElement(node)) {
      continue;
    }
    if (node.tagName !== serverNode.tagName) {
      continue;
    }
    // An explicit id cannot fall back to a different same-tag element. If
    // client code removed it, reloading is safer than editing its neighbour.
    if (key !== undefined) {
      if (keyOf(node) === key) {
        return node;
      }
      continue;
    }
    if (keepsClassesOf(node, serverNode)) {
      return node;
    }
    // Same tag, weaker evidence. Kept in case nothing better turns up: the
    // diff has already decided this node persists, so the only question left
    // is which one it is, and a same-tag sibling beats giving up and reloading.
    if (!loose) {
      loose = node;
    }
  }
  return loose;
}

// Class is merged rather than assigned: a class the server added or dropped is
// applied, and one the client added — `is-open`, `in-view` — is left in place.
function patchClass(live: Element, previous: Element, next: Element): void {
  const before = (previous.getAttribute('class') || '').split(/\s+/).filter(Boolean);
  const after = (next.getAttribute('class') || '').split(/\s+/).filter(Boolean);
  for (const className of before) {
    if (after.indexOf(className) === -1) {
      live.classList.remove(className);
    }
  }
  for (const className of after) {
    if (before.indexOf(className) === -1) {
      live.classList.add(className);
    }
  }
}

// Only where the two renderings disagree. An attribute the client set that the
// server never mentions is never seen here, so it stays.
export function patchAttrs(live: Element, previous: Element, next: Element): void {
  const want = next.attributes;
  for (let i = 0; i < want.length; i++) {
    const attribute = want[i];
    if (!attribute) {
      continue;
    }
    if (previous.getAttribute(attribute.name) === attribute.value) {
      continue;
    }
    if (attribute.name === 'class') {
      patchClass(live, previous, next);
    } else {
      live.setAttribute(attribute.name, attribute.value);
    }
  }
  const had = previous.attributes;
  for (let i = had.length - 1; i >= 0; i--) {
    const attribute = had[i];
    if (!attribute) {
      continue;
    }
    if (next.hasAttribute(attribute.name)) {
      continue;
    }
    if (attribute.name === 'class') {
      patchClass(live, previous, next);
    } else {
      live.removeAttribute(attribute.name);
    }
  }
}

function patchNode(live: Node, previous: Node, next: Node): void {
  // An unchanged server subtree has no patch to contribute. Client code is
  // free to reorder, remove, or clone anything inside it, so descending into
  // that live subtree is both wasted work and actively unsafe: a slider or nav
  // can no longer resemble its server rendering even though the edit happened
  // somewhere else on the page.
  if (previous.isEqualNode(next)) {
    return;
  }
  if (live.nodeType === 3 || live.nodeType === 8) {
    // Only when the server changed it, and only if the live copy still says
    // what the server last said — client code that rewrote this text keeps it.
    const liveText = asText(live) ? live : asComment(live) ? live : undefined;
    const previousData = (asText(previous) ? previous : asComment(previous) ? previous : undefined)?.data;
    const nextData = (asText(next) ? next : asComment(next) ? next : undefined)?.data;
    if (liveText && previousData !== undefined && nextData !== undefined && previousData !== nextData && liveText.data === previousData) {
      liveText.data = nextData;
    }
    return;
  }
  if (!asElement(live) || pinned(live)) {
    return;
  }
  if (!asElement(previous) || !asElement(next)) {
    // The diff only pairs nodes of equal kind, so reach is impossible; the
    // guard keeps the types truthful rather than encoding a lie about it.
    return;
  }
  patchAttrs(live, previous, next);
  // A change to the element's own attributes (a class, a style, a prop's value) is not
  // a change to what it holds. Its children are left to the page when the server's are
  // the same: a script may have rebuilt them (split text into lines, wrapped words for
  // an entrance), and lining that up with the server's children would fail and reload
  // the page, restarting every animation on it, for an edit that changed one attribute.
  if (sameChildren(previous, next)) {
    return;
  }
  patchChildren(live, previous, next);
}

function sameChildren(previous: Element, next: Element): boolean {
  if (previous.childNodes.length !== next.childNodes.length) {
    return false;
  }
  for (let index = 0; index < previous.childNodes.length; index++) {
    const before = previous.childNodes[index];
    const after = next.childNodes[index];
    if (before === undefined || after === undefined || !before.isEqualNode(after)) {
      return false;
    }
  }
  return true;
}

export function patchChildren(liveParent: Element, previousParent: Element, nextParent: Element): void {
  const before: Node[] = [];
  for (let node = previousParent.firstChild; node; node = node.nextSibling) {
    before.push(node);
  }
  const after: Node[] = [];
  for (let node = nextParent.firstChild; node; node = node.nextSibling) {
    after.push(node);
  }

  let live = liveParent.firstChild;
  const locate = (serverNode: Node): Node => {
    const target = findLive(live ?? undefined, serverNode);
    if (!target) {
      throw Ambiguous(describe(serverNode));
    }
    return target;
  };

  for (const [kind, i, j] of diffChildren(before.map(keyFor), after.map(keyFor))) {
    if (kind === 0) {
      const previousNode = before[i];
      const nextNode = after[j];
      // The diff only emits keep ops for valid indexes; a gap is a bug, and
      // the reload the catch performs is the right failure then too.
      if (previousNode === undefined || nextNode === undefined) {
        throw Ambiguous('index gap in diff');
      }
      const target = locate(previousNode);
      patchNode(target, previousNode, nextNode);
      live = target.nextSibling;
    } else if (kind === -1) {
      const previousNode = before[i];
      if (previousNode === undefined) {
        throw Ambiguous('index gap in diff');
      }
      const target = locate(previousNode);
      if (live === target) {
        live = target.nextSibling;
      }
      // remove() lives on the leaf kinds, not on Node itself.
      const removal = asElement(target) ? target : asText(target) ? target : asComment(target) ? target : undefined;
      removal?.remove();
    } else {
      const nextNode = after[j];
      if (nextNode !== undefined) {
        liveParent.insertBefore(document.importNode(nextNode, true), live);
      }
    }
  }
}

const describe = (node: Node): string => {
  if (asElement(node)) {
    return '<' + node.tagName.toLowerCase() + '>';
  }
  if (asComment(node)) {
    return 'marker ' + node.data;
  }
  return 'text';
};
