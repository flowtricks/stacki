// Patching the live page by the difference between the server's previous
// rendering and its new one: child lists lined up by longest common
// subsequence, live nodes found past whatever the client added, and only
// what the two renderings disagree about written.

import { isAnchor, MORPH_LIMITS, asElement, asText, asComment } from './morphNodes';

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
//
// The one exception is a dev stylesheet, which the server and the live page
// both name by its data-vite-dev-id (Vite reuses the server's element): the
// component and the <style> block it came from. Unkeyed, every <style> of the
// head was interchangeable, so when a component's block was deleted the diff
// paired the rest by position and removed the LAST stylesheet instead of the
// deleted one: the deleted block's rules stayed on the page (an is:global
// block went on styling it) while another component lost its own.
const keyOf = (node: Node | undefined): string | undefined => {
  if (node !== undefined && asElement(node)) {
    const id = node.getAttribute('id');
    if (id) {
      return id;
    }
    if (node.tagName === 'STYLE') {
      return node.getAttribute('data-vite-dev-id') || undefined;
    }
    return undefined;
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
//
// There is no size at which a patch gives up and reloads the page. What changes
// with size is the algorithm, never the answer's correctness:
//   1. A shared prefix is consumed first. Most edits change text or attributes,
//      leaving every child key in place; those lists, along with appends and
//      removals at the end, take linear time and memory.
//   2. A small remainder is lined up by an exact matrix, which keeps the
//      tie-breaking for repeated text and element keys that the rest of the
//      patcher was tuned against.
//   3. A large remainder trims its shared suffix, then runs Myers' O(ND) diff,
//      which is linear in the list plus the square of the edits: a huge list
//      with a handful of edits (the usual case) costs a few passes over it.
//   4. If the edits are so many that even that would run long, the lists are
//      lined up greedily in one linear pass. The result is still a correct edit
//      script; only the choice of which equal-keyed nodes persist is cruder.
type DiffOp = readonly [kind: number, i: number, j: number];

// Matrix cells the exact diff may allocate (4 bytes each). This selects the
// algorithm; it does not reject a larger list, which takes the path below.
const EXACT_DIFF_CELLS_MAX = 1_000_000;
// The edit distance Myers' trace is kept for (its memory is the square of it),
// and the work (diagonals visited plus snake steps) it may spend before the
// greedy pass takes over. Both only choose between algorithms.
const MYERS_EDITS_MAX = 1024;
const MYERS_WORK_MAX = 4_000_000;

// `identical`, when given, says whether two same-kind nodes are the same node unchanged. Among
// the ways to line them up, the ones keeping those win: a paragraph inserted before another is
// a new node, not the old one rewritten into it with the old one rebuilt after it. Why it
// matters: what a page script did to a node's insides (a heading split into lines) stays on
// the live node, and the patch cannot reach through it, so
// pairing a node with the wrong partner showed one node's words under another's class and
// left the new words off the page until a refresh. Only the exact diff weighs it; lists past
// its size are lined up by kind alone.
export function diffChildren(before: readonly string[], after: readonly string[], identical?: (i: number, j: number) => boolean): DiffOp[] {
  const beforeCount = before.length;
  const afterCount = after.length;
  const ops: DiffOp[] = [];
  const weigh = identical !== undefined && (beforeCount + 1) * (afterCount + 1) <= EXACT_DIFF_CELLS_MAX ? identical : undefined;
  let i = 0;
  let j = 0;
  while (i < beforeCount && j < afterCount && before[i] === after[j] && (weigh === undefined || !isElementKey(before[i]) || weigh(i, j))) {
    ops.push([0, i++, j++]);
  }
  if (i < beforeCount && j < afterCount) {
    if ((beforeCount - i + 1) * (afterCount - j + 1) <= EXACT_DIFF_CELLS_MAX) {
      appendExactDiff(ops, before, after, i, weigh);
      return ops;
    }
    appendScalableDiff(ops, before, after, i);
    return ops;
  }
  while (i < beforeCount) {
    ops.push([-1, i++, -1]);
  }
  while (j < afterCount) {
    ops.push([1, -1, j++]);
  }
  return ops;
}

const isElementKey = (key: string | undefined): boolean => key?.startsWith('e:') === true;

// What a kept pair is worth to the exact diff. An unchanged node outweighs two pairs of
// different ones, so that of two swapped siblings one stays as it is and the other is built
// anew, rather than each being rewritten into the other: what a page script had set on one (an
// entrance holding it invisible) went to the other's content, and hid it until a refresh.
const PAIR_WEIGHT = 2;
const IDENTICAL_PAIR_WEIGHT = 5;

// The exact matrix, from `start` (the lists agree before it), appended to `ops`.
function appendExactDiff(
  ops: DiffOp[],
  before: readonly string[],
  after: readonly string[],
  start: number,
  identical: ((i: number, j: number) => boolean) | undefined,
): void {
  const weightOf = (i: number, j: number): number => (identical?.(i, j) ? IDENTICAL_PAIR_WEIGHT : PAIR_WEIGHT);
  const beforeCount = before.length;
  const afterCount = after.length;
  let i = start;
  let j = start;
  const dp: Int32Array[] = [];
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
      const skipped = Math.max(next[col] ?? 0, currentRow[col + 1] ?? 0);
      const paired = before[row + start] === after[col + start] ? (next[col + 1] ?? 0) + weightOf(row + start, col + start) : 0;
      currentRow[col] = Math.max(paired, skipped);
    }
  }
  while (i < beforeCount && j < afterCount) {
    if (before[i] === after[j] && (dp[i - start]?.[j - start] ?? 0) === (dp[i - start + 1]?.[j - start + 1] ?? 0) + weightOf(i, j)) {
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
}

// Large lists: trim the shared suffix, diff what is left between, then keep the suffix.
function appendScalableDiff(ops: DiffOp[], before: readonly string[], after: readonly string[], start: number): void {
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (start < beforeEnd && start < afterEnd && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd--;
    afterEnd--;
  }
  const middle = myersDiff(before, after, start, beforeEnd, afterEnd) ?? greedyDiff(before, after, start, beforeEnd, afterEnd);
  for (const op of middle) {
    ops.push(op);
  }
  for (let offset = 0; beforeEnd + offset < before.length; offset++) {
    ops.push([0, beforeEnd + offset, afterEnd + offset]);
  }
}

// Myers' greedy O(ND) diff of before[start..beforeEnd) against after[start..afterEnd),
// or undefined when the edits or the work pass what it keeps a trace for. Ops carry
// absolute indexes, in list order.
function myersDiff(before: readonly string[], after: readonly string[], start: number, beforeEnd: number, afterEnd: number): DiffOp[] | undefined {
  const beforeCount = beforeEnd - start;
  const afterCount = afterEnd - start;
  if (beforeCount === 0 || afterCount === 0) {
    return trivialDiff(start, beforeEnd, afterEnd);
  }
  const editsLimit = Math.min(beforeCount + afterCount, MYERS_EDITS_MAX);
  const furthest = new Int32Array(2 * editsLimit + 3);
  const middle = editsLimit + 1;
  // trace[d] holds the frontier as step d found it (diagonals -d..d), which is what backtracking reads.
  const trace: Int32Array[] = [];
  let work = 0;
  for (let edits = 0; edits <= editsLimit; edits++) {
    trace.push(furthest.slice(middle - edits, middle + edits + 1));
    for (let diagonal = -edits; diagonal <= edits; diagonal += 2) {
      let x: number;
      if (diagonal === -edits || (diagonal !== edits && (furthest[middle + diagonal - 1] ?? 0) < (furthest[middle + diagonal + 1] ?? 0))) {
        x = furthest[middle + diagonal + 1] ?? 0;
      } else {
        x = (furthest[middle + diagonal - 1] ?? 0) + 1;
      }
      let y = x - diagonal;
      while (x < beforeCount && y < afterCount && before[start + x] === after[start + y]) {
        x++;
        y++;
        work++;
      }
      furthest[middle + diagonal] = x;
      work++;
      if (x >= beforeCount && y >= afterCount) {
        return myersBacktrack(trace, start, beforeCount, afterCount, edits);
      }
    }
    if (MYERS_WORK_MAX < work) {
      return undefined;
    }
  }
  return undefined;
}

function myersBacktrack(trace: readonly Int32Array[], start: number, beforeCount: number, afterCount: number, edits: number): DiffOp[] {
  const reversed: DiffOp[] = [];
  let x = beforeCount;
  let y = afterCount;
  for (let step = edits; step > 0; step--) {
    const frontier = trace[step];
    if (frontier === undefined) {
      throw Ambiguous('trace gap in diff');
    }
    const at = (diagonal: number): number => frontier[diagonal + step] ?? 0;
    const diagonal = x - y;
    const previousDiagonal = diagonal === -step || (diagonal !== step && at(diagonal - 1) < at(diagonal + 1)) ? diagonal + 1 : diagonal - 1;
    const previousX = at(previousDiagonal);
    const previousY = previousX - previousDiagonal;
    while (x > previousX && y > previousY) {
      x--;
      y--;
      reversed.push([0, start + x, start + y]);
    }
    if (x === previousX) {
      reversed.push([1, -1, start + previousY]); // down: an insertion
    } else {
      reversed.push([-1, start + previousX, -1]); // right: a removal
    }
    x = previousX;
    y = previousY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    reversed.push([0, start + x, start + y]);
  }
  if (x !== 0 || y !== 0) {
    throw Ambiguous('trace end in diff');
  }
  return reversed.reverse();
}

// One linear pass that always yields a correct edit script: each before key takes
// the next unused position of the same key in after, when there is one, and is
// removed when there is not. What it gives up against an exact diff is only which
// equal-keyed nodes persist; none is ever matched to a node of another key.
function greedyDiff(before: readonly string[], after: readonly string[], start: number, beforeEnd: number, afterEnd: number): DiffOp[] {
  const positions = new Map<string, number[]>();
  for (let j = start; j < afterEnd; j++) {
    const key = after[j];
    if (key === undefined) {
      continue;
    }
    const list = positions.get(key);
    if (list === undefined) {
      positions.set(key, [j]);
    } else {
      list.push(j);
    }
  }
  const cursors = new Map<string, number>();
  const ops: DiffOp[] = [];
  let j = start;
  for (let i = start; i < beforeEnd; i++) {
    const key = before[i];
    const list = key === undefined ? undefined : positions.get(key);
    let cursor = key === undefined ? 0 : (cursors.get(key) ?? 0);
    while (list !== undefined && cursor < list.length && (list[cursor] ?? 0) < j) {
      cursor++;
    }
    const matched = list === undefined ? undefined : list[cursor];
    if (key !== undefined) {
      cursors.set(key, cursor + 1);
    }
    if (matched === undefined) {
      ops.push([-1, i, -1]);
      continue;
    }
    while (j < matched) {
      ops.push([1, -1, j++]);
    }
    ops.push([0, i, j++]);
  }
  while (j < afterEnd) {
    ops.push([1, -1, j++]);
  }
  return ops;
}

function trivialDiff(start: number, beforeEnd: number, afterEnd: number): DiffOp[] {
  const ops: DiffOp[] = [];
  for (let i = start; i < beforeEnd; i++) {
    ops.push([-1, i, -1]);
  }
  for (let j = start; j < afterEnd; j++) {
    ops.push([1, -1, j]);
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

interface Declaration {
  readonly value: string;
  readonly priority: string;
}

// One declaration of a style attribute: a `;` inside quotes or brackets (a data URL, a quoted
// font name) does not end it.
const DECLARATION_TEXT = /(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:"[^"]*"|'[^']*'|\([^()]*\)|[^()"'])*\)|[^;"'(])+/g;

// A style attribute's declarations in order, or undefined past the bound.
function declarationsOf(element: Element): Map<string, Declaration> | undefined {
  const parts = (element.getAttribute('style') || '').match(DECLARATION_TEXT) ?? [];
  if (parts.length > STYLE_DECLARATIONS_MAX) {
    return undefined;
  }
  const declarations = new Map<string, Declaration>();
  for (const part of parts) {
    const colon = part.indexOf(':');
    if (colon <= 0) {
      continue;
    }
    const written = part.slice(0, colon).trim();
    const name = written.startsWith('--') ? written : written.toLowerCase();
    const text = part.slice(colon + 1).trim();
    const value = text.replace(/\s*!\s*important$/i, '');
    declarations.set(name, { value, priority: value === text ? '' : 'important' });
  }
  return declarations;
}

const isStyleDeclaration = (value: unknown): value is CSSStyleDeclaration =>
  typeof value === 'object' && value !== null && 'setProperty' in value && 'removeProperty' in value;

// A style the page has written to as well as the server: only the declarations the two renderings
// disagree about are written, as classes are merged. Writing the whole attribute took away what a
// script had put there (a text entrance's `visibility: visible`), which no fresh load is without.
// False when the page has added nothing, and the attribute is then written as the server wrote
// it. So is a variant's (the class changed too): what the page set was set for the element it
// was before.
function mergeStyle(live: Element, previous: Element, next: Element): boolean {
  if (live.getAttribute('style') === previous.getAttribute('style')) {
    return false;
  }
  if ((previous.getAttribute('class') || '') !== (next.getAttribute('class') || '')) {
    return false;
  }
  const style: unknown = 'style' in live ? live.style : undefined;
  const before = declarationsOf(previous);
  const after = declarationsOf(next);
  if (!isStyleDeclaration(style) || before === undefined || after === undefined) {
    return false;
  }
  const removed = [...before.keys()].filter((name) => !after.has(name));
  for (const name of removed) {
    style.removeProperty(name);
  }
  for (const [name, { value, priority }] of after) {
    const had = before.get(name);
    // Removing a shorthand takes its longhands with it (`margin`, `margin-top`): those the
    // server still writes are written again.
    const swept = removed.some((gone) => name.startsWith(gone + '-'));
    if (swept || had?.value !== value || had.priority !== priority) {
      style.setProperty(name, value, priority);
    }
  }
  if (live.getAttribute('style') === '' && !next.hasAttribute('style')) {
    live.removeAttribute('style');
  }
  return true;
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
    } else if (attribute.name !== 'style' || !mergeStyle(live, previous, next)) {
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
    } else if (attribute.name !== 'style' || !mergeStyle(live, previous, next)) {
      live.removeAttribute(attribute.name);
    }
  }
}

// Returns the node now standing where `live` stood: `live` itself, but for words a script re-wrapped.
function patchNode(live: Node, previous: Node, next: Node): Node {
  // An unchanged server subtree has no patch to contribute. Client code is
  // free to reorder, remove, or clone anything inside it, so descending into
  // that live subtree is both wasted work and actively unsafe: a slider or nav
  // can no longer resemble its server rendering even though the edit happened
  // somewhere else on the page.
  if (previous.isEqualNode(next)) {
    return live;
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
    return live;
  }
  if (!asElement(live) || pinned(live)) {
    return live;
  }
  if (!asElement(previous) || !asElement(next)) {
    // The diff only pairs nodes of equal kind, so reach is impossible; the
    // guard keeps the types truthful rather than encoding a lie about it.
    return live;
  }
  refuseStaleMeasurement(live, previous, next);
  if (rewrappedWords(live, previous, next)) {
    return replaceRewrapped(live, previous, next);
  }
  patchAttrs(live, previous, next);
  // A change to the element's own attributes (a class, a style, a prop's value) is not
  // a change to what it holds. Its children are left to the page when the server's are
  // the same: a script may have rebuilt them (split text into lines, wrapped words for
  // an entrance), and lining that up with the server's children would fail and reload
  // the page, restarting every animation on it, for an edit that changed one attribute.
  if (sameChildren(previous, next)) {
    return live;
  }
  patchChildren(live, previous, next);
  reloadChangedMedia(live, previous, next);
  return live;
}

// A <video> or <audio> reads its <source> children once, when it starts loading: a source the
// patch swaps under it changes the markup and nothing else, and the old film plays on where a
// fresh load shows the new one. A `src` on the element itself loads by itself.
function reloadChangedMedia(live: Element, previous: Element, next: Element): void {
  if (live.tagName !== 'VIDEO' && live.tagName !== 'AUDIO') {
    return;
  }
  if (mediaSources(previous) !== mediaSources(next)) {
    if (canLoad(live)) {
      live.load();
    }
  }
}

const canLoad = (element: Element): element is Element & { load: () => void } => 'load' in element && typeof element.load === 'function';

function mediaSources(element: Element): string {
  const sources = Array.from(element.children).filter((child) => child.tagName === 'SOURCE');
  return JSON.stringify(sources.map((source) => [source.getAttribute('src'), source.getAttribute('type'), source.getAttribute('media')]));
}

// Words a script wrapped again: split into lines or letters for an entrance, which leaves none of
// the server's text where the patch looks for it. A change to those words had nowhere to land,
// so the canvas kept the old ones until a refresh, and the script, putting back the markup it
// had saved, kept them for good. Only plain words are judged: an element the server filled with
// text and inline markup, whose live copy still says exactly those words, in other nodes.
const PHRASING_TAGS: ReadonlySet<string> = new Set(
  'A ABBR B BDI BDO BR CITE CODE DATA DEL DFN EM I INS KBD MARK Q S SAMP SMALL SPAN STRONG SUB SUP TIME U VAR WBR'.split(' '),
);
// Elements read to judge one element's words; longer content is left to the ordinary patch.
const PHRASING_ELEMENTS_MAX = 512;

function plainWords(element: Element): boolean {
  const inside = element.getElementsByTagName('*');
  if (inside.length > PHRASING_ELEMENTS_MAX) {
    return false;
  }
  return Array.from(inside).every((child) => PHRASING_TAGS.has(child.tagName));
}

const lettersOf = (text: string): string => text.replace(/\s+/g, '');
const lettersIn = (node: Element): string => lettersOf(node.textContent ?? '');

function rewrappedWords(live: Element, previous: Element, next: Element): boolean {
  const said = lettersIn(previous);
  if (said === '' || said === lettersIn(next)) {
    return false; // Nothing new to say: the script's own wrapping stays.
  }
  if (!plainWords(previous) || !plainWords(next)) {
    return false;
  }
  if (lettersIn(live) !== said) {
    return false; // The script changed the words themselves (a counter, a typed line): its own.
  }
  const liveTexts = new Set(Array.from(live.childNodes).flatMap((node) => (asText(node) ? [node.data] : [])));
  return Array.from(previous.childNodes).some((node) => asText(node) && node.data.trim() !== '' && !liveTexts.has(node.data));
}

// A new element, not new children: a split keeps hold of the element it split and writes its saved
// markup back into it when its animation ends, which must reach the old element, no longer on the
// page. What the page added to the element itself (classes, inline style) comes along.
function replaceRewrapped(live: Element, previous: Element, next: Element): Element {
  const made = live.cloneNode(false);
  if (!isElementNode(made)) {
    throw Ambiguous(describe(previous) + ', whose words a script wrapped');
  }
  patchAttrs(made, previous, next);
  // A label the split added to say the words it took apart: the old words, over the new ones.
  const label = made.getAttribute('aria-label');
  if (label !== null && !previous.hasAttribute('aria-label') && lettersOf(label) === lettersIn(previous)) {
    made.removeAttribute('aria-label');
  }
  for (const child of Array.from(next.childNodes)) {
    made.appendChild(document.importNode(child, true));
  }
  live.replaceWith(made);
  return made;
}

const isElementNode = (node: Node): node is Element => asElement(node);

// A page script that sized an element from what it held, once, as it mounted: the
// patch keeps the size (it is the client's inline style, which the patch never
// touches) while the variant it measured is replaced, and the canvas shows the new
// variant at the old variant's size. Reported on swash-labs: its hero script adopts
// the CTA Button and writes `--pill-w` and `font-size` from the label it finds; a
// Button written as `main` has no pill label, so it measured 105px, and switching
// to `pill` put a 183px label in that 105px pill ("LET'S", clipped). A refresh
// measures the pill and is right. Nothing in the page can be asked to measure
// again, so the patch cannot reach what a fresh load shows: the reload is the
// honest answer, and morphClient logs why.
//
// Only when all of it holds: the server changed the element's class (a variant,
// not a text edit) AND what it holds, AND the live element carries an inline
// sizing declaration the server did not write. A transform or opacity an
// animation set does not depend on the content, so it is no reason. Neither is a
// custom property: Button's own pointer handler writes `--_mx` on every hover,
// and reading that as a measurement reloaded every hovered pill. The hero's
// measurement also writes `font-size`, which is what this catches.
const MEASURED_PROPERTIES: ReadonlySet<string> = new Set([
  'block-size',
  'font-size',
  'height',
  'inline-size',
  'max-block-size',
  'max-height',
  'max-inline-size',
  'max-width',
  'min-block-size',
  'min-height',
  'min-inline-size',
  'min-width',
  'width',
]);
// Declarations read from one style attribute; past it, the rest is not read (an
// inline style that long was not written by a measuring script).
const STYLE_DECLARATIONS_MAX = 256;

function refuseStaleMeasurement(live: Element, previous: Element, next: Element): void {
  if ((previous.getAttribute('class') || '') === (next.getAttribute('class') || '')) {
    return; // Not a variant: the element is still the thing that was measured.
  }
  if (sameChildren(previous, next)) {
    return; // Only its own attributes changed; the measured content did not.
  }
  const measured = pageMeasured(live, previous);
  if (measured === undefined) {
    return;
  }
  throw new Error('the page sized ' + describe(live) + ' (' + measured + ') from markup this edit replaces');
}

/** The first sizing declaration the live element carries that the server's rendering did not write, if any. */
export function pageMeasured(live: Element, previous: Element): string | undefined {
  const served = inlineSizing(previous);
  for (const [name, value] of inlineSizing(live)) {
    if (served.get(name) !== value) {
      return name;
    }
  }
  return undefined;
}

function inlineSizing(element: Element): Map<string, string> {
  const sizing = new Map<string, string>();
  const declarations = (element.getAttribute('style') || '').split(';').slice(0, STYLE_DECLARATIONS_MAX);
  for (const declaration of declarations) {
    const colon = declaration.indexOf(':');
    if (colon > 0) {
      const name = declaration.slice(0, colon).trim().toLowerCase();
      if (MEASURED_PROPERTIES.has(name)) {
        sizing.set(name, declaration.slice(colon + 1).trim());
      }
    }
  }
  return sizing;
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

// The editor's own attributes name a node by its place, so they differ for a node that only
// moved along; they are no part of what makes it the same node.
const MARKER_ATTRIBUTE_TEXT = / data-avb-[a-z-]+="[^"]*"/g;

// Whether two renderings hold the same element, unchanged. Text and comments never count: blank
// text is all alike, and weighing it would steer which elements are paired. Each element is
// written out at most once per list.
function identicalNodes(before: readonly Node[], after: readonly Node[]): (i: number, j: number) => boolean {
  const written = new Map<Node, string>();
  const writtenAs = (element: Element): string => {
    let markup = written.get(element);
    if (markup === undefined) {
      markup = element.outerHTML.replace(MARKER_ATTRIBUTE_TEXT, '');
      written.set(element, markup);
    }
    return markup;
  };
  return (i, j) => {
    const left = before[i];
    const right = after[j];
    if (left === undefined || right === undefined || !asElement(left) || !asElement(right)) {
      return false;
    }
    return left.tagName === right.tagName && writtenAs(left) === writtenAs(right);
  };
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
  // A text or comment the server rendered may be gone from the live page: a script that splits a
  // label into lines or words, or trims the whitespace between its pieces, leaves none of the
  // server's text nodes. Nothing is left to patch there, which is what "client code that rewrote
  // this text keeps it" already says (patchNode), so that is a skip. Reloading for it replayed the
  // page's intro on a prop edit (a Button's arrow inside a script-adopted hero). An element that is
  // not among the live siblings may have been moved by a script (an adopted hero hands its server
  // nodes to its own layout): its editor marker finds it wherever it went (relocated). Only an
  // element found by neither is a reason to give up: patching its neighbour would be a bug.
  const locate = (serverNode: Node): Node | undefined => {
    const target = findLive(live ?? undefined, serverNode);
    if (!target && asElement(serverNode) && relocated(serverNode) === undefined && !hasMarker(serverNode)) {
      throw Ambiguous(describe(serverNode) + ' (in ' + describe(liveParent) + ')');
    }
    return target;
  };

  for (const [kind, i, j] of diffChildren(before.map(keyFor), after.map(keyFor), identicalNodes(before, after))) {
    if (kind === 0) {
      const previousNode = before[i];
      const nextNode = after[j];
      // The diff only emits keep ops for valid indexes; a gap is a bug, and
      // the reload the catch performs is the right failure then too.
      if (previousNode === undefined || nextNode === undefined) {
        throw Ambiguous('index gap in diff');
      }
      const target = locate(previousNode);
      if (target === undefined) {
        patchAway(previousNode, nextNode, 0);
        continue;
      }
      live = patchNode(target, previousNode, nextNode).nextSibling;
    } else if (kind === -1) {
      const previousNode = before[i];
      if (previousNode === undefined) {
        throw Ambiguous('index gap in diff');
      }
      const target = locate(previousNode);
      if (target === undefined) {
        if (asElement(previousNode)) {
          const moved = relocated(previousNode);
          if (moved === undefined) {
            throw Ambiguous(describe(previousNode) + ' (in ' + describe(liveParent) + ')');
          }
          moved.remove();
        }
        continue;
      }
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

// The live element a server element stands for when a script moved it out of its parent: the one
// element of the page carrying the same editor path (data-avb-p names the file and the node, and the
// live copy keeps what the server rendered). None or more than one is no answer.
const MARKER_CHARS_MAX = 2048;
const elementOf = (node: Node): Element | undefined => (asElement(node) ? node : undefined);
function markerOf(node: Node): string | undefined {
  const marker = elementOf(node)?.getAttribute('data-avb-p');
  return marker !== null && marker !== undefined && marker.length > 0 && marker.length <= MARKER_CHARS_MAX ? marker : undefined;
}
function hasMarker(node: Node): boolean {
  return markerOf(node) !== undefined;
}
function relocated(serverNode: Node): Element | undefined {
  const marker = markerOf(serverNode);
  if (marker === undefined) {
    return undefined;
  }
  const found = document.querySelectorAll('[data-avb-p="' + marker.replace(/["\\]/g, '\\$&') + '"]');
  const only = found.length === 1 ? found[0] : undefined;
  return only !== undefined && only.tagName === elementOf(serverNode)?.tagName ? only : undefined;
}

// A server element that is not where the server put it. Found by its marker, it is patched where it
// is. Absent altogether (a script dismantled its parent), what changed lies in its descendants, so
// they are looked for the same way; a change to the absent element's own attributes or to its list
// of children has nowhere to land, and that is the reload.
function patchAway(previous: Node, next: Node, depth: number): void {
  if (depth > MORPH_LIMITS.domDepthMax) {
    throw Ambiguous('a subtree nested deeper than the patch walks');
  }
  const previousElement = elementOf(previous);
  const nextElement = elementOf(next);
  if (previousElement === undefined || nextElement === undefined) {
    return; // Text or a comment that is gone has nothing to patch.
  }
  const moved = relocated(previousElement);
  if (moved !== undefined) {
    patchNode(moved, previousElement, nextElement);
    return;
  }
  if (previousElement.isEqualNode(nextElement)) {
    return;
  }
  const before = Array.from(previousElement.childNodes);
  const after = Array.from(nextElement.childNodes);
  for (const [kind, i, j] of diffChildren(before.map(keyFor), after.map(keyFor))) {
    const previousChild = i >= 0 ? before[i] : undefined;
    const nextChild = j >= 0 ? after[j] : undefined;
    if (kind === 0 && previousChild !== undefined && nextChild !== undefined) {
      patchAway(previousChild, nextChild, depth + 1);
    } else if ((previousChild !== undefined && asElement(previousChild)) || (nextChild !== undefined && asElement(nextChild))) {
      throw Ambiguous(describe(previousElement) + ' children (' + describe(previousElement) + ' is not on the live page)');
    }
  }
}

const describe = (node: Node): string => {
  if (asElement(node)) {
    const className = node.getAttribute('class');
    return '<' + node.tagName.toLowerCase() + (className ? '.' + className.trim().split(/\s+/).slice(0, 3).join('.') : '') + '>';
  }
  if (asComment(node)) {
    return 'marker ' + node.data;
  }
  return 'text';
};
