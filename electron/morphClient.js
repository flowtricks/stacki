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

  const walk = (live, server) => {
    let l = live.firstChild;
    for (let sv = server.firstChild; sv; sv = sv.nextSibling) {
      if (isAnchor(sv)) {
        live.insertBefore(document.createComment(sv.data), l);
        continue;
      }
      let t = l;
      while (t && !(t.nodeType === sv.nodeType && (sv.nodeType !== 1 || t.tagName === sv.tagName))) {
        t = t.nextSibling;
      }
      if (!t) continue;
      if (t.nodeType === 1) walk(t, sv);
      l = t.nextSibling;
    }
  };
  walk(liveRoot, serverRoot);
}

// Never written to. A dev stylesheet belongs to Vite, which swaps it in by
// data-vite-dev-id; an external script re-runs if it is re-inserted, which is
// the reload this exists to avoid.
const pinned = (n) =>
  n.nodeType === 1 &&
  ((n.tagName === 'SCRIPT' && !!n.getAttribute('src')) ||
    (n.tagName === 'STYLE' && n.hasAttribute('data-vite-dev-id')));

// An id, and deliberately nothing else. `data-avb-p` looks like a better key —
// it is the editor's own node path — but the canvas stamps it onto live
// elements as it records them, while the server's HTML mostly has no such
// attribute. Reading it here compared a stamped path against an id, decided
// every element was a different element, and fell back to reloading the page
// on every keystroke: the exact thing this was written to stop.
const keyOf = (n) => (n && n.nodeType === 1 ? n.getAttribute('id') || null : null);

// What makes two nodes the same kind of thing for the purpose of lining up two
// lists. An element is its tag plus whatever identity it has; every text node
// is interchangeable with every other, and so is every comment, because their
// content is what changes and the diff below is what decides which is which.
function keyFor(n) {
  if (n.nodeType === 1) {
    const k = keyOf(n);
    return 'e:' + n.tagName + '#' + (k !== null ? k : n.getAttribute('class') || '');
  }
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
// A key is taken at its word. Without one, an identical class is the best
// evidence, but it is only evidence: client code changes classes all the time,
// and refusing to match on that alone would send a page that merely added
// `is-visible` to something straight back to reloading. So a same-tag node is
// remembered and used if nothing better turns up. That fallback is safe here
// in a way it would not have been before: the diff has already decided this
// node persists, and all that is left is finding it — it is not being asked
// which node this is.
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
    if (ks === null && n.getAttribute('class') === serverNode.getAttribute('class')) return n;
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

// A script that appears, disappears or changes cannot be patched in: inserting
// one re-runs it, and rewriting one does not run it at all. Both are wrong, so
// the page reloads — which is what a changed script needs anyway. Rare next to
// the editing this exists for.
function scriptSignature(doc) {
  const out = [];
  const list = doc.getElementsByTagName('script');
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    out.push((s.getAttribute('src') || '') + ' | ' + (s.getAttribute('type') || '') + ' | ' + s.textContent);
  }
  return out.join('\n@@\n');
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
  (d) => { prevDoc = d.clean; },
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
