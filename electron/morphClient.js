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

// A <template> marker is an element, and the page removes those from itself on
// load, so they are taken out of the fetched copies too — otherwise they are
// nodes on one side with nothing to match on the other.
//
// The comment markers are left in place, and they are what makes this safe.
// They wrap every node the editor knows about, they carry its path, and they
// sit in the live document as well as in both fetched ones. Matching walks
// from one to the next, so it can never drift onto the wrong element the way
// guessing from tag names does.
function stripTemplateMarkers(root) {
  const gone = root.querySelectorAll('template[data-avb-s],template[data-avb-e]');
  for (let i = 0; i < gone.length; i++) gone[i].remove();
}

const isAnchor = (n) => n && n.nodeType === 8 && /^avb-[se]:/.test(n.data);

// Markers take no part in the comparison. Their path is an index, so removing
// one node renumbers every marker after it, and a diff that reads them as
// content sees the whole rest of the page change. They are stripped from both
// fetched copies, skipped over in the live page, and put back afterwards.
function stripAnchors(root) {
  const gone = [];
  const walk = (p) => {
    for (let n = p.firstChild; n; n = n.nextSibling) {
      if (isAnchor(n)) gone.push(n);
      else if (n.nodeType === 1) walk(n);
    }
  };
  walk(root);
  for (const n of gone) n.remove();
}

// Markers are comments: invisible to layout, to selectors and to animation, so
// they can be taken out and put back without the page noticing. Done in one
// pass after the content is settled, from a copy of the new rendering that
// still has them, so the editor's paths point at what is on the page now.
function syncAnchors(liveRoot, serverRoot) {
  const gone = [];
  const collect = (p) => {
    for (let n = p.firstChild; n; n = n.nextSibling) {
      if (isAnchor(n)) gone.push(n);
      else if (n.nodeType === 1) collect(n);
    }
  };
  collect(liveRoot);
  for (const n of gone) n.remove();

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
  const blank = (n) => n.nodeType === 3 && !n.data.trim();
  const sameKind = (a, b) =>
    a.nodeType === b.nodeType && (b.nodeType !== 1 || a.tagName === b.tagName);

  const walk = (live, server) => {
    let l = live.firstChild;
    for (let sv = server.firstChild; sv; sv = sv.nextSibling) {
      if (isAnchor(sv)) {
        live.insertBefore(document.createComment(sv.data), l);
        continue;
      }
      if (blank(sv)) continue;
      let t = l;
      while (t && (blank(t) || !sameKind(t, sv))) t = t.nextSibling;
      if (!t) continue;
      if (t.nodeType === 1) walk(t, sv);
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
const pinned = (n) =>
  n.nodeType === 1 &&
  (n.tagName === 'NOSCRIPT' ||
    n.tagName === 'TEMPLATE' ||
    (n.tagName === 'SCRIPT' && !!n.getAttribute('src')) ||
    (n.tagName === 'STYLE' && n.hasAttribute('data-vite-dev-id')));

// An id, and deliberately nothing else. `data-avb-p` looks like a better key —
// it is the editor's own node path — but the canvas stamps it onto live
// elements as it records them, while the server's HTML mostly has no such
// attribute. Reading it here compared a stamped path against an id, decided
// every element was a different element, and fell back to reloading the page
// on every keystroke: the exact thing this was written to stop.
const keyOf = (n) => (n && n.nodeType === 1 ? n.getAttribute('id') || null : null);

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
function keyFor(n) {
  if (n.nodeType === 1) return 'e:' + n.tagName + '#' + (keyOf(n) || '');
  return n.nodeType === 8 ? 'c' : 't';
}

// Longest common subsequence over the two child lists.
//
// This replaces the obvious thing — walk both lists and guess, when they stop
// agreeing, whether something was inserted or removed. That guess is wrong far
// too often: whitespace text nodes are everywhere and all alike, so a look
// ahead always finds one, decides a node was inserted, and from there every
// remaining sibling is rebuilt. An element that was only meant to keep still
// loses its animation, its scroll position and anything the client hung on it.
// The subsequence is worked out rather than guessed, so what stayed is known
// exactly, and lists here are short enough that the cost does not matter.
function diffChildren(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push([0, i++, j++]); continue; }      // keep
    if (dp[i + 1][j] >= dp[i][j + 1]) ops.push([-1, i++, -1]);      // removed
    else ops.push([1, -1, j++]);                                    // inserted
  }
  while (i < n) ops.push([-1, i++, -1]);
  while (j < m) ops.push([1, -1, j++]);
  return ops;
}

// Raised when the live document cannot be lined up with the server's, which
// happens when client code has rearranged something this cannot reason about.
// The caller turns it into the reload it replaced: losing the running state is
// a disappointment, patching the wrong element is a bug.
function Ambiguous(what) {
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
const classesOf = (n) => (n.getAttribute('class') || '').split(/\s+/).filter(Boolean);

// Every class the server put on the node is still on the live one. A node the
// server gave no class to has to have none either — otherwise the test is
// vacuous and would match anything, including a node the client inserted.
function keepsClassesOf(live, serverNode) {
  const want = classesOf(serverNode);
  const have = classesOf(live);
  if (!want.length) return !have.length;
  for (const c of want) if (have.indexOf(c) === -1) return false;
  return true;
}

function findLive(from, serverNode) {
  let loose = null;
  for (let n = from; n; n = n.nextSibling) {
    if (isAnchor(n)) continue;
    if (serverNode.nodeType !== 1) {
      if (n.nodeType === serverNode.nodeType) return n;
      if (n.nodeType !== 1 && !loose) loose = n;
      continue;
    }
    if (n.nodeType !== 1) continue;
    if (n.tagName !== serverNode.tagName) continue;
    const ks = keyOf(serverNode);
    if (ks !== null && keyOf(n) === ks) return n;
    if (ks === null && keepsClassesOf(n, serverNode)) return n;
    // Same tag, weaker evidence. Kept in case nothing better turns up: the
    // diff has already decided this node persists, so the only question left
    // is which one it is, and a same-tag sibling beats giving up and reloading.
    if (!loose) loose = n;
  }
  return loose;
}

// Class is merged rather than assigned: a class the server added or dropped is
// applied, and one the client added — `is-open`, `in-view` — is left in place.
function patchClass(live, prev, next) {
  const before = (prev.getAttribute('class') || '').split(/\s+/).filter(Boolean);
  const after = (next.getAttribute('class') || '').split(/\s+/).filter(Boolean);
  for (const c of before) if (after.indexOf(c) === -1) live.classList.remove(c);
  for (const c of after) if (before.indexOf(c) === -1) live.classList.add(c);
}

// Only where the two renderings disagree. An attribute the client set that the
// server never mentions is never seen here, so it stays.
function patchAttrs(live, prev, next) {
  const want = next.attributes;
  for (let i = 0; i < want.length; i++) {
    const a = want[i];
    if (prev.getAttribute(a.name) === a.value) continue;
    if (a.name === 'class') patchClass(live, prev, next);
    else live.setAttribute(a.name, a.value);
  }
  const had = prev.attributes;
  for (let i = had.length - 1; i >= 0; i--) {
    const a = had[i];
    if (next.hasAttribute(a.name)) continue;
    if (a.name === 'class') patchClass(live, prev, next);
    else live.removeAttribute(a.name);
  }
}

function patchNode(live, prev, next) {
  if (live.nodeType === 3 || live.nodeType === 8) {
    // Only when the server changed it, and only if the live copy still says
    // what the server last said — client code that rewrote this text keeps it.
    if (prev.data !== next.data && live.data === prev.data) live.data = next.data;
    return;
  }
  if (live.nodeType !== 1 || pinned(live)) return;
  patchAttrs(live, prev, next);
  patchChildren(live, prev, next);
}

function patchChildren(liveParent, prevParent, nextParent) {
  const before = [];
  for (let n = prevParent.firstChild; n; n = n.nextSibling) before.push(n);
  const after = [];
  for (let n = nextParent.firstChild; n; n = n.nextSibling) after.push(n);

  let live = liveParent.firstChild;
  const locate = (serverNode) => {
    const target = findLive(live, serverNode);
    if (!target) throw Ambiguous(describe(serverNode));
    return target;
  };

  for (const [kind, i, j] of diffChildren(before.map(keyFor), after.map(keyFor))) {
    if (kind === 0) {
      const target = locate(before[i]);
      patchNode(target, before[i], after[j]);
      live = target.nextSibling;
    } else if (kind === -1) {
      const target = locate(before[i]);
      if (live === target) live = target.nextSibling;
      target.remove();
    } else {
      liveParent.insertBefore(document.importNode(after[j], true), live);
    }
  }
}

const describe = (n) =>
  n.nodeType === 1 ? '<' + n.tagName.toLowerCase() + '>' : n.nodeType === 8 ? 'marker ' + n.data : 'text';

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
function isStyleModule(src) {
  return /[?&]astro&type=style|\.(css|s[ac]ss|less|pcss|styl)(\?|$)/.test(src || '');
}

// A script that appears, disappears or changes cannot be patched in: inserting
// one re-runs it, and rewriting one does not run it at all. Both are wrong, so
// the page reloads — which is what a changed script needs anyway. Rare next to
// the editing this exists for.
function scriptSignature(doc) {
  const out = [];
  const list = doc.getElementsByTagName('script');
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const src = s.getAttribute('src') || '';
    if (isStyleModule(src)) continue;
    out.push(src + ' | ' + (s.getAttribute('type') || '') + ' | ' + s.textContent);
  }
  return out.join('\n@@\n');
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
const loadedStyles = new Set();
function noteStyles(doc) {
  const list = doc.getElementsByTagName('script');
  for (let i = 0; i < list.length; i++) {
    const src = list[i].getAttribute('src');
    if (isStyleModule(src)) loadedStyles.add(src);
  }
}
function loadStyles(doc) {
  const list = doc.getElementsByTagName('script');
  for (let i = 0; i < list.length; i++) {
    const src = list[i].getAttribute('src');
    if (!isStyleModule(src) || loadedStyles.has(src)) continue;
    loadedStyles.add(src);
    const el = document.createElement('script');
    el.type = 'module';
    el.src = src;
    document.head.appendChild(el);
  }
}

function fetchDoc() {
  return fetch(location.href, { cache: 'no-store' })
    .then((r) => {
      if (!r.ok) throw new Error('dev server answered ' + r.status);
      return r.text();
    })
    .then((html) => {
      const withAnchors = new DOMParser().parseFromString(html, 'text/html');
      stripTemplateMarkers(withAnchors);
      const clean = withAnchors.cloneNode(true);
      stripAnchors(clean);
      return { withAnchors, clean };
    });
}

// The server's own rendering of this page, captured before any client code can
// alter it. The live DOM is not a substitute: a script that appends during
// parse has already run by the time this module does, and mistaking its work
// for server output would delete it on the first patch.
let prevDoc = null;
const ready = fetchDoc().then(
  (d) => { prevDoc = d.clean; noteStyles(d.clean); },
  () => { prevDoc = null; }
);

let busy = false;
let again = false;

async function update() {
  if (busy) { again = true; return; }
  busy = true;
  try {
    await ready;
    if (!prevDoc) throw new Error('no baseline rendering to compare against');
    const next = await fetchDoc();
    if (scriptSignature(prevDoc) !== scriptSignature(next.clean)) {
      location.reload();
      return;
    }
    patchAttrs(document.documentElement, prevDoc.documentElement, next.clean.documentElement);
    patchChildren(document.head, prevDoc.head, next.clean.head);
    patchChildren(document.body, prevDoc.body, next.clean.body);
    prevDoc = next.clean;
    // After the patch, so a component that has just appeared is styled by the
    // time anything measures it.
    loadStyles(next.clean);
    syncAnchors(document.body, next.withAnchors.body);
    document.dispatchEvent(new CustomEvent('avb:morphed'));
  } catch (err) {
    // Whatever went wrong, the page must still end up showing what the file
    // says. Falling back to the reload this replaced is always safe.
    console.warn('[stacki] could not patch the page, reloading:', err);
    location.reload();
    return;
  } finally {
    busy = false;
  }
  if (again) { again = false; update(); }
}

if (import.meta.hot) import.meta.hot.on('avb:page-changed', update);
