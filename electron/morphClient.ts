// Astro renders components on the server, so Vite cannot hot-swap one: any
// edit ends in "reload the document". A reload restarts every CSS animation,
// rewinds every video, drops scroll position and closes whatever was open —
// in an editor, that is the state you were looking at when you made the edit.
// The dev plugin catches that reload and sends a message here instead.
//
// What arrives is a NEW server rendering of the page. The obvious thing is to
// diff it against the live DOM, and that is wrong: the live DOM is not the
// server's to command. A slider has cloned its slides, a menu has set
// aria-expanded, an analytics tag has appended an iframe. Diffing against the
// live DOM treats all of that as content the server deleted, and removes it.
//
// So the diff is between the server's PREVIOUS rendering and its new one, and
// only that difference is applied to the live page. Anything the client did
// appears in neither rendering, so nothing here has an opinion about it, and
// it survives untouched. Three trees, and the live one is only ever written
// where the other two disagree.

// This module is served to the browser as source text (main.js reads it and
// hands it to the dev plugin), so it is emitted as plain ESM by its own
// tsconfig, never as CommonJS. The exports at the bottom are the module
// marker the compiler needs (import.meta is only legal in a module) and a
// no-op to the page.

declare global {
  // Vite's import.meta.hot; only .on is used here, so only .on is declared.
  interface ImportMeta {
    readonly hot?: {
      readonly on: (event: string, handler: () => void) => void;
    };
  }
}

// A <template> marker is an element, and the page removes those from itself on
// load, so they are taken out of the fetched copies too — otherwise they are
// nodes on one side with nothing to match on the other.
//
// The comment markers are left in place, and they are what makes this safe.
// They wrap every node the editor knows about, they carry its path, and they
// sit in the live document as well as in both fetched ones. Matching walks
// from one to the next, so it can never drift onto the wrong element the way
// guessing from tag names does.
function stripTemplateMarkers(root: ParentNode): void {
  const gone = root.querySelectorAll('template[data-avb-s],template[data-avb-e]');
  for (let i = 0; i < gone.length; i++) {
    const node = gone[i];
    if (node) {
      node.remove();
    }
  }
}

const isAnchor = (n: Node | null | undefined): boolean => {
  const comment = n !== undefined && n !== null && asComment(n) ? n : null;
  return comment !== null && /^avb-[se]:/.test(comment.data);
};

const asElement = (n: Node): n is Element => n.nodeType === 1;
const asText = (n: Node): n is Text => n.nodeType === 3;
const asComment = (n: Node): n is Comment => n.nodeType === 8;
const asDocument = (n: Node): n is Document => n.nodeType === 9;

// test/morph.js lifts the patching half out of this file by slicing from the
// `const isAnchor =` line, so the type guards live below that marker, before
// their first use. That keeps the lifted source self-contained.

// Markers take no part in the comparison. Their path is an index, so removing
// one node renumbers every marker after it, and a diff that reads them as
// content sees the whole rest of the page change. They are stripped from both
// fetched copies, skipped over in the live page, and put back afterwards.
function stripAnchors(root: ParentNode): void {
  const gone: Comment[] = [];
  const walk = (p: ParentNode): void => {
    for (let n = p.firstChild; n; n = n.nextSibling) {
      if (asComment(n) && isAnchor(n)) {
        gone.push(n);
      } else if (asElement(n)) {
        walk(n);
      }
    }
  };
  walk(root);
  for (const n of gone) {
    n.remove();
  }
}

// Markers are comments: invisible to layout, to selectors and to animation, so
// they can be taken out and put back without the page noticing. Done in one
// pass after the content is settled, from a copy of the new rendering that
// still has them, so the editor's paths point at what is on the page now.
function syncAnchors(liveRoot: ParentNode, serverRoot: ParentNode): void {
  stripAnchors(liveRoot);

  // Whitespace is not content, and is never matched.
  //
  // It used to be: any text node stood for any other. Two renderings of the
  // same page hardly ever have the same number of blank text nodes — the diff
  // above keeps whichever ones it can — so one server blank could be matched
  // against a live blank on the far side of an element, and the cursor came out
  // PAST that element. Every anchor after it then landed a node too late, and
  // when the cursor ran off the end they were appended to the parent instead:
  // a closing marker after the very element it was supposed to close, and a
  // region that swallowed its next sibling whole. On the docs footer that made
  // a clicked line report the comment above it.
  const blank = (n: Node): boolean => (asText(n) ? n.data.trim() === '' : false);
  const sameKind = (a: Node, b: Node): boolean => {
    if (a.nodeType !== b.nodeType) {
      return false;
    }
    if (b.nodeType !== 1) {
      return true;
    }
    return asElement(a) && asElement(b) && a.tagName === b.tagName;
  };

  const walk = (live: ParentNode, server: ParentNode): void => {
    let l = live.firstChild;
    for (let sv = server.firstChild; sv; sv = sv.nextSibling) {
      const marker = asComment(sv) && isAnchor(sv) ? sv : null;
      if (marker) {
        live.insertBefore(document.createComment(marker.data), l);
        continue;
      }
      if (blank(sv)) {
        continue;
      }
      let t = l;
      while (t && (blank(t) || !sameKind(t, sv))) {
        t = t.nextSibling;
      }
      if (!t) {
        continue;
      }
      if (asElement(t) && asElement(sv)) {
        walk(t, sv);
      }
      l = t.nextSibling;
    }
  };
  walk(liveRoot, serverRoot);
}

// Never looked inside. A dev stylesheet belongs to Vite, which swaps it in by
// data-vite-dev-id; an external script re-runs if it is re-inserted, which is
// the reload this exists to avoid.
//
// <noscript> is here for a different and less obvious reason. Whether its
// markup is parsed at all depends on whether scripting is enabled in the
// document doing the parsing. In the live page it is, so the contents are
// inert text and the element has no children. In a DOMParser document it is
// not, so the same markup comes back as real elements. The two can never be
// compared, and walking in found children on one side and none on the other,
// gave up, and reloaded — on every patch, for any page carrying a <noscript>.
// Nothing in it can change without the file around it changing anyway.
//
// <template> is opaque for the same kind of reason: its markup lives in a
// separate fragment rather than in childNodes.
const pinned = (n: Node): boolean => {
  if (!asElement(n)) {
    return false;
  }
  return (
    n.tagName === 'NOSCRIPT' ||
    n.tagName === 'TEMPLATE' ||
    (n.tagName === 'SCRIPT' && !!n.getAttribute('src')) ||
    (n.tagName === 'STYLE' && n.hasAttribute('data-vite-dev-id'))
  );
};

// An id, and deliberately nothing else. `data-avb-p` looks like a better key —
// it is the editor's own node path — but the canvas stamps it onto live
// elements as it records them, while the server's HTML mostly has no such
// attribute. Reading it here compared a stamped path against an id, decided
// every element was a different element, and fell back to reloading the page
// on every keystroke: the exact thing this was written to stop.
const keyOf = (n: Node | null | undefined): string | null => {
  if (n !== undefined && n !== null && asElement(n)) {
    return n.getAttribute('id') || null;
  }
  return null;
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
function keyFor(n: Node): string {
  if (asElement(n)) {
    return 'e:' + n.tagName + '#' + (keyOf(n) || '');
  }
  return asComment(n) ? 'c' : 't';
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

function diffChildren(a: readonly string[], b: readonly string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m && a[i] === b[j]) {
    ops.push([0, i++, j++]);
  }

  const start = i;
  const dp: Int32Array[] = [];
  if (i < n && j < m) {
    for (let row = 0; row <= n - start; row++) {
      dp.push(new Int32Array(m - start + 1));
    }
    for (let row = n - start - 1; row >= 0; row--) {
      const cur = dp[row];
      const next = dp[row + 1];
      if (!cur || !next) {
        continue;
      }
      for (let col = m - start - 1; col >= 0; col--) {
        cur[col] = a[row + start] === b[col + start] ? (next[col + 1] ?? 0) + 1 : Math.max(next[col] ?? 0, cur[col + 1] ?? 0);
      }
    }
  }
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push([0, i++, j++]);
      continue; // keep
    }
    if ((dp[i - start + 1]?.[j - start] ?? 0) >= (dp[i - start]?.[j - start + 1] ?? 0)) {
      ops.push([-1, i++, -1]); // removed
    } else {
      ops.push([1, -1, j++]); // inserted
    }
  }
  while (i < n) {
    ops.push([-1, i++, -1]);
  }
  while (j < m) {
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
const classesOf = (n: Element): string[] => (n.getAttribute('class') || '').split(/\s+/).filter(Boolean);

// Every class the server put on the node is still on the live one. A node the
// server gave no class to has to have none either — otherwise the test is
// vacuous and would match anything, including a node the client inserted.
function keepsClassesOf(live: Element, serverNode: Element): boolean {
  const want = classesOf(serverNode);
  if (!want.length) {
    return live.classList.length === 0;
  }
  for (const c of want) {
    if (!live.classList.contains(c)) {
      return false;
    }
  }
  return true;
}

function findLive(from: Node | null, serverNode: Node): Node | null {
  let loose: Element | null = null;
  if (!asElement(serverNode)) {
    for (let n = from; n; n = n.nextSibling) {
      if (isAnchor(n)) {
        continue;
      }
      if (n.nodeType === serverNode.nodeType) {
        return n;
      }
    }
    return null;
  }
  const key = keyOf(serverNode);
  for (let n = from; n; n = n.nextSibling) {
    if (isAnchor(n)) {
      continue;
    }
    if (!asElement(n)) {
      continue;
    }
    if (n.tagName !== serverNode.tagName) {
      continue;
    }
    // An explicit id cannot fall back to a different same-tag element. If
    // client code removed it, reloading is safer than editing its neighbour.
    if (key !== null) {
      if (keyOf(n) === key) {
        return n;
      }
      continue;
    }
    if (keepsClassesOf(n, serverNode)) {
      return n;
    }
    // Same tag, weaker evidence. Kept in case nothing better turns up: the
    // diff has already decided this node persists, so the only question left
    // is which one it is, and a same-tag sibling beats giving up and reloading.
    if (!loose) {
      loose = n;
    }
  }
  return loose;
}

// Class is merged rather than assigned: a class the server added or dropped is
// applied, and one the client added — `is-open`, `in-view` — is left in place.
function patchClass(live: Element, prev: Element, next: Element): void {
  const before = (prev.getAttribute('class') || '').split(/\s+/).filter(Boolean);
  const after = (next.getAttribute('class') || '').split(/\s+/).filter(Boolean);
  for (const c of before) {
    if (after.indexOf(c) === -1) {
      live.classList.remove(c);
    }
  }
  for (const c of after) {
    if (before.indexOf(c) === -1) {
      live.classList.add(c);
    }
  }
}

// Only where the two renderings disagree. An attribute the client set that the
// server never mentions is never seen here, so it stays.
function patchAttrs(live: Element, prev: Element, next: Element): void {
  const want = next.attributes;
  for (let i = 0; i < want.length; i++) {
    const a = want[i];
    if (!a) {
      continue;
    }
    if (prev.getAttribute(a.name) === a.value) {
      continue;
    }
    if (a.name === 'class') {
      patchClass(live, prev, next);
    } else {
      live.setAttribute(a.name, a.value);
    }
  }
  const had = prev.attributes;
  for (let i = had.length - 1; i >= 0; i--) {
    const a = had[i];
    if (!a) {
      continue;
    }
    if (next.hasAttribute(a.name)) {
      continue;
    }
    if (a.name === 'class') {
      patchClass(live, prev, next);
    } else {
      live.removeAttribute(a.name);
    }
  }
}

function patchNode(live: Node, prev: Node, next: Node): void {
  // An unchanged server subtree has no patch to contribute. Client code is
  // free to reorder, remove, or clone anything inside it, so descending into
  // that live subtree is both wasted work and actively unsafe: a slider or nav
  // can no longer resemble its server rendering even though the edit happened
  // somewhere else on the page.
  if (prev.isEqualNode(next)) {
    return;
  }
  if (live.nodeType === 3 || live.nodeType === 8) {
    // Only when the server changed it, and only if the live copy still says
    // what the server last said — client code that rewrote this text keeps it.
    const liveText = asText(live) ? live : asComment(live) ? live : null;
    const prevData = (asText(prev) ? prev : asComment(prev) ? prev : null)?.data;
    const nextData = (asText(next) ? next : asComment(next) ? next : null)?.data;
    if (liveText && prevData !== undefined && nextData !== undefined && prevData !== nextData && liveText.data === prevData) {
      liveText.data = nextData;
    }
    return;
  }
  if (!asElement(live) || pinned(live)) {
    return;
  }
  if (!asElement(prev) || !asElement(next)) {
    // The diff only pairs nodes of equal kind, so reach is impossible; the
    // guard keeps the types truthful rather than encoding a lie about it.
    return;
  }
  patchAttrs(live, prev, next);
  patchChildren(live, prev, next);
}

function patchChildren(liveParent: Element, prevParent: Element, nextParent: Element): void {
  const before: Node[] = [];
  for (let n = prevParent.firstChild; n; n = n.nextSibling) {
    before.push(n);
  }
  const after: Node[] = [];
  for (let n = nextParent.firstChild; n; n = n.nextSibling) {
    after.push(n);
  }

  let live: Node | null = liveParent.firstChild;
  const locate = (serverNode: Node): Node => {
    const target = findLive(live, serverNode);
    if (!target) {
      throw Ambiguous(describe(serverNode));
    }
    return target;
  };

  for (const [kind, i, j] of diffChildren(before.map(keyFor), after.map(keyFor))) {
    if (kind === 0) {
      const prevNode = before[i];
      const nextNode = after[j];
      // The diff only emits keep ops for valid indexes; a gap is a bug, and
      // the reload the catch performs is the right failure then too.
      if (prevNode === undefined || nextNode === undefined) {
        throw Ambiguous('index gap in diff');
      }
      const target = locate(prevNode);
      patchNode(target, prevNode, nextNode);
      live = target.nextSibling;
    } else if (kind === -1) {
      const prevNode = before[i];
      if (prevNode === undefined) {
        throw Ambiguous('index gap in diff');
      }
      const target = locate(prevNode);
      if (live === target) {
        live = target.nextSibling;
      }
      // remove() lives on the leaf kinds, not on Node itself.
      const removal = asElement(target) ? target : asText(target) ? target : asComment(target) ? target : null;
      removal?.remove();
    } else {
      const nextNode = after[j];
      if (nextNode !== undefined) {
        liveParent.insertBefore(document.importNode(nextNode, true), live);
      }
    }
  }
}

const describe = (n: Node): string => {
  if (asElement(n)) {
    return '<' + n.tagName.toLowerCase() + '>';
  }
  if (asComment(n)) {
    return 'marker ' + n.data;
  }
  return 'text';
};

// A component's <style> is delivered as a MODULE in dev — one
// `<script type="module" src="…?astro&type=style…">` per styled component that
// renders. So the page's list of scripts changes whenever the SET of rendered
// components changes, and that is exactly what switching a variant does: one
// card becomes another, an icon appears, and the page carries a different
// handful of stylesheets.
//
// Which made the rule below reload the page for a stylesheet — the flicker this
// file exists to avoid, on the one edit most likely to be made over and over.
// Style modules are held apart from real scripts and patched like anything
// else.
function isStyleModule(src: string | null): boolean {
  return /[?&]astro&type=style|\.(css|s[ac]ss|less|pcss|styl)(\?|$)/.test(src || '');
}

interface ScriptInfo {
  readonly src: string;
  readonly type: string;
  readonly attrs: readonly [name: string, value: string][];
  readonly signature: string;
}

// A script that CHANGED, or one that is GONE, cannot be patched in: rewriting
// one does not run it, and nothing can un-run one. Both are wrong, so the page
// reloads. (Kept below the erased interface: comments attached to a type
// declaration are dropped at emit, and test/morph.js slices this file by this
// comment.)
//
// A script that only APPEARED is a different matter, and it is the common one.
// Switching a variant is how a component starts rendering something it wasn't:
// a slider, a marquee, anything with behaviour, and in dev Astro hands each of
// those out as its own module — so the new rendering asks for a module the page
// has not run yet. Reloading for that threw away the scroll position, every
// running animation and whatever was open, on a page whose markup this had
// just finished patching in place. Worse where it hurts most: hovering down a
// list of variants reloaded the page per option.
//
// So a new module is loaded rather than reloaded around — the same thing
// loadStyles does for a stylesheet, for the same reason: an element made here
// runs, a cloned one does not.
function scriptsOf(doc: Document): ScriptInfo[] {
  const out: ScriptInfo[] = [];
  const list = doc.getElementsByTagName('script');
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (!s) {
      continue;
    }
    const src = s.getAttribute('src') || '';
    if (isStyleModule(src)) {
      continue;
    }
    let attrs: [string, string][] = Array.from(s.attributes, (a) => [a.name, a.value]);
    attrs = attrs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    out.push({
      src,
      type: s.getAttribute('type') || '',
      attrs,
      signature: JSON.stringify([attrs, s.textContent]),
    });
  }
  return out;
}

// Structured signatures cannot collide with separators in URLs or source.
function scriptSignature(doc: Document): string {
  return JSON.stringify(scriptsOf(doc).map((s) => s.signature));
}

/**
 * What the new rendering adds, or null when it does anything else to the
 * scripts — which is the reload.
 *
 * Only an external script can be added this way. An inline script has to run
 * where it sits, and this cannot put it there: the copy the patch inserted is
 * inert and replacing it is a different job. So an inline arrival still reloads.
 */
function addedScripts(prevDoc: Document, nextDoc: Document): ScriptInfo[] | null {
  const before = scriptsOf(prevDoc);
  const after = scriptsOf(nextDoc);
  const had = new Set(before.map((s) => s.signature));
  const added: ScriptInfo[] = [];
  let i = 0;
  for (const script of after) {
    if (script.signature === before[i]?.signature) {
      i++;
    } else {
      // Already-run scripts must keep their order and count. Neither a
      // reorder nor another execution of an existing script can be patched.
      if (had.has(script.signature) || !script.src) {
        return null;
      }
      added.push(script);
    }
  }
  return i === before.length ? added : null;
}

// The modules a rendering asks for that this page has never run. Made here, not
// cloned, so they run.
const loadedScripts = new Set<string>();
function noteScripts(doc: Document): void {
  for (const { src } of scriptsOf(doc)) {
    if (src) {
      loadedScripts.add(src);
    }
  }
}
function runScripts(added: readonly ScriptInfo[]): void {
  for (const { src, attrs } of added) {
    if (!src || loadedScripts.has(src)) {
      continue;
    }
    loadedScripts.add(src);
    const el = document.createElement('script');
    // Preserve loading semantics such as integrity, crossorigin and nonce.
    // Dynamic classic scripts default to async; source scripts without that
    // attribute must instead execute in insertion order.
    el.async = false;
    for (const [name, value] of attrs) {
      el.setAttribute(name, value);
    }
    document.head.appendChild(el);
  }
}

// The stylesheets a rendering asks for, loaded for real.
//
// The patch cannot do this itself: a <script> cloned out of a fetched document
// is inert — the parser that made it had no browsing context, so inserting it
// into this one runs nothing (measured; see test/morph.js). An element made
// here does run, and running one of these modules is what injects its CSS.
//
// A stylesheet whose component is no longer rendered is left loaded. Its rules
// match nothing now, and it is already in hand for the moment the variant is
// switched back.
const loadedStyles = new Set<string>();
function noteStyles(doc: Document): void {
  const list = doc.getElementsByTagName('script');
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (!s) {
      continue;
    }
    const src = s.getAttribute('src') ?? null;
    if (src !== null && isStyleModule(src)) {
      loadedStyles.add(src);
    }
  }
}
function loadStyles(doc: Document): void {
  const list = doc.getElementsByTagName('script');
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (!s) {
      continue;
    }
    const src = s.getAttribute('src') ?? null;
    if (src === null || !isStyleModule(src) || loadedStyles.has(src)) {
      continue;
    }
    loadedStyles.add(src);
    const el = document.createElement('script');
    el.type = 'module';
    el.src = src;
    document.head.appendChild(el);
  }
}

interface FetchedDoc {
  readonly withAnchors: Document;
  readonly clean: Document;
}

function fetchDoc(): Promise<FetchedDoc> {
  return fetch(location.href, { cache: 'no-store' })
    .then((r) => {
      if (!r.ok) {
        throw new Error('dev server answered ' + r.status);
      }
      return r.text();
    })
    .then((html) => {
      const withAnchors = new DOMParser().parseFromString(html, 'text/html');
      stripTemplateMarkers(withAnchors);
      const clone = withAnchors.cloneNode(true);
      // A cloned document is a Document; the guard is the types' only honest
      // way to say nodeType 9 without an assertion.
      if (!asDocument(clone)) {
        throw new Error('cloned rendering is not a document');
      }
      const clean = clone;
      stripAnchors(clean);
      return { withAnchors, clean };
    });
}

// The server's own rendering of this page, captured before any client code can
// alter it. The live DOM is not a substitute: a script that appends during
// parse has already run by the time this module does, and mistaking its work
// for server output would delete it on the first patch.
let prevDoc: Document | null = null;
const ready = fetchDoc().then(
  (d) => {
    prevDoc = d.clean;
    noteStyles(d.clean);
    noteScripts(d.clean);
  },
  () => {
    prevDoc = null;
  },
);

let busy = false;
let again = false;

async function update(): Promise<void> {
  if (busy) {
    again = true;
    return;
  }
  busy = true;
  try {
    await ready;
    if (!prevDoc) {
      throw new Error('no baseline rendering to compare against');
    }
    const next = await fetchDoc();
    const added = addedScripts(prevDoc, next.clean);
    if (added === null) {
      location.reload();
      return;
    }
    const liveRoot = document.documentElement;
    const prevRoot = prevDoc.documentElement;
    const nextRoot = next.clean.documentElement;
    if (!liveRoot || !prevRoot || !nextRoot) {
      throw new Error('missing <html> in one of the renderings');
    }
    patchAttrs(liveRoot, prevRoot, nextRoot);
    patchChildren(document.head, prevDoc.head, next.clean.head);
    patchChildren(document.body, prevDoc.body, next.clean.body);
    prevDoc = next.clean;
    // After the patch, so a component that has just appeared is styled by the
    // time anything measures it — and running by the time anything clicks it.
    loadStyles(next.clean);
    runScripts(added);
    const liveBody = document.body;
    const serverBody = next.withAnchors.body;
    if (!liveBody || !serverBody) {
      throw new Error('missing <body> in one of the renderings');
    }
    syncAnchors(liveBody, serverBody);
    document.dispatchEvent(new CustomEvent('avb:morphed'));
  } catch (err) {
    // Whatever went wrong, the page must still end up showing what the file
    // says. Falling back to the reload this replaced is always safe.
    // The original called console.warn, which no browser implements — the
    // throw it caused skipped the reload line below, which is the whole point
    // of the catch. Log and reload.
    console.error('[stacki] could not patch the page, reloading:', err);
    location.reload();
    return;
  } finally {
    busy = false;
  }
  if (again) {
    again = false;
    update();
  }
}

// Two ways the news arrives, because one of them is not reliable enough on its
// own. HMR is the fast path: the dev server saw the file change and said so.
// But that message rides a WebSocket the page opened when it loaded, and a
// socket has ways of going quiet — a dev server restarted under a canvas that
// stayed open, a laptop that slept, a reconnect that landed on something else
// listening on the same port. Nothing tells the page it has stopped hearing;
// it simply never updates again, and the only way to see an edit is to press
// refresh.
//
// The app watches the file system itself, for its own reasons, so it knows
// about every change either way — and it can say so straight to this frame.
// Patching twice for one edit costs a fetch and a diff that finds nothing.
if (import.meta.hot) {
  import.meta.hot.on('avb:page-changed', update);
}
window.addEventListener('message', (e: MessageEvent) => {
  const data: unknown = e.data;
  if (typeof data === 'object' && data !== null && 'type' in data && data['type'] === 'avb:patch-now') {
    update();
  }
});

// update is the module's entry; scriptSignature is not referenced internally
// but is part of the tested surface — test/morph.js slices it out of this
// source, so deleting it would delete coverage of the script-diff decision.
export { update, scriptSignature };
