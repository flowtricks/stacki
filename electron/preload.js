const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Preview iframes (nodeIntegrationInSubFrames runs this preload in them too):
// don't expose the app API to the previewed site — just report the page's
// content height to the app so the canvas view can size frames to the page.
if (!process.isMainFrame) {
  // Which frame the page is in, as a class on <html>, so a project can style
  // for the editor: `stacki-designer` in the canvas, `stacki-preview` in the
  // interactive preview. Read from the frame's own URL rather than waited for
  // over a message — the page paints before the app can say anything, and a
  // canvas that started out looking like the preview would flash.
  //
  // The patcher leaves it alone: it applies the classes the SERVER's two
  // renderings disagree about, and neither of them has ever heard of these.
  const stackiMode = location.hash.includes('avb-design') ? 'stacki-designer' : 'stacki-preview';
  const markMode = () => document.documentElement?.classList.add(stackiMode);
  markMode(); // <html> exists by the time a preload runs, but not always in a
  // frame that is still being created — so try again at the first two moments
  // it certainly does.
  document.addEventListener('readystatechange', markMode);
  window.addEventListener('DOMContentLoaded', markMode);

  // Design-mode frames (canvas + editor preview) are marked with #avb-design.
  // They get an editor cursor (no I-beam over text) and links/forms are
  // inert — navigation only happens in the interactive preview mode.
  if (location.hash.includes('avb-design')) {
    const injectDesignStyle = () => {
      if (document.getElementById('avb-design-style')) return;
      const style = document.createElement('style');
      style.id = 'avb-design-style';
      style.textContent =
        '*, *::before, *::after { cursor: default !important; }';
      (document.head || document.documentElement)?.appendChild(style);
    };
    if (document.readyState === 'loading') {
      window.addEventListener('DOMContentLoaded', injectDesignStyle);
    } else {
      injectDesignStyle();
    }
    // Block navigation and submits at capture so page handlers never fire.
    window.addEventListener(
      'click',
      (e) => {
        const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
        if (a) e.preventDefault();
      },
      true
    );
    window.addEventListener('submit', (e) => e.preventDefault(), true);
    // Which modifiers are held, forwarded for the same reason as the shortcuts
    // below: clicking an element on the canvas puts keyboard focus in here, so
    // every key after that is delivered to this frame and never reaches the
    // app. The style panel reads Shift and Option to decide how much of the
    // spacing box a hover or a drag applies to — and from the app's side,
    // nobody was pressing anything.
    let held = { shiftKey: false, altKey: false };
    const tellModifiers = (e) => {
      const next = { shiftKey: !!e.shiftKey, altKey: !!e.altKey };
      if (next.shiftKey === held.shiftKey && next.altKey === held.altKey) return;
      held = next;
      try {
        window.parent.postMessage({ type: 'avb:modifiers', ...held }, '*');
      } catch {
        /* no parent to tell */
      }
    };
    // Any key event, not just the modifiers themselves — see the style panel's
    // hover hook: what matters is the state now, so a keyup missed while this
    // frame was out of focus is corrected by whatever happens next.
    window.addEventListener('keydown', tellModifiers, true);
    window.addEventListener('keyup', tellModifiers, true);
    // Nothing is held once the page stops receiving keys.
    window.addEventListener('blur', () => tellModifiers({ shiftKey: false, altKey: false }));
    // Forward app shortcuts when the canvas has keyboard focus — otherwise
    // ⌘F/⌘E die inside the iframe and the insert palette never opens.
    window.addEventListener(
      'keydown',
      (e) => {
        const mod = e.metaKey || e.ctrlKey;
        if (mod && (e.key.toLowerCase() === 'f' || e.key.toLowerCase() === 'e')) {
          e.preventDefault();
          try {
            window.parent.postMessage({ type: 'avb:shortcut', name: 'insert' }, '*');
          } catch {
            /* ignore */
          }
          return;
        }
        const t = e.target;
        const typing =
          t &&
          t.nodeType === 1 &&
          (t.tagName === 'INPUT' ||
            t.tagName === 'TEXTAREA' ||
            t.tagName === 'SELECT' ||
            t.isContentEditable);
        if (typing) return;

        // Clicking the canvas puts keyboard focus inside this frame, so the
        // app's own arrow-key navigation would never see the keys. Forward
        // them (and swallow them here, so the page doesn't scroll instead).
        if (
          !mod &&
          !e.altKey &&
          !e.shiftKey &&
          ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)
        ) {
          e.preventDefault();
          try {
            window.parent.postMessage({ type: 'avb:shortcut', name: 'arrow', key: e.key }, '*');
          } catch {
            /* ignore */
          }
          return;
        }

        // Editing the selected node from the canvas. Undo, copy and paste
        // already survive an iframe-focused canvas because they're native
        // menu accelerators, which fire whatever holds focus; delete and
        // duplicate have no menu item, so without this they only work when
        // the selection was made in the navigator.
        const isDelete = !mod && !e.altKey && (e.key === 'Delete' || e.key === 'Backspace');
        const isDuplicate = mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'd';
        // ⌘Enter jumps to the class field. The canvas is where the selection is
        // usually made, so it has to reach the app from in here too.
        const isClassJump = mod && !e.altKey && !e.shiftKey && e.key === 'Enter';
        if (isDelete || isDuplicate || isClassJump) {
          e.preventDefault();
          try {
            window.parent.postMessage(
              { type: 'avb:shortcut', name: 'key', key: e.key, meta: mod },
              '*'
            );
          } catch {
            /* ignore */
          }
        }
      },
      true
    );
  }

  // documentElement.scrollHeight is clamped to the viewport (= the iframe),
  // so once the frame is stretched it can never report a smaller page — a
  // one-way ratchet. Measure the body's own content height instead; the
  // frozen-mode override un-stretches html/body so this reflects content.
  const report = () => {
    try {
      const body = document.body;
      let height;
      if (body) {
        const styles = getComputedStyle(body);
        height = body.offsetTop + body.scrollHeight + (parseFloat(styles.marginBottom) || 0);
      } else {
        height = document.documentElement.scrollHeight;
      }
      window.parent.postMessage({ type: 'avb:page-height', height: Math.ceil(height) }, '*');
    } catch {
      /* ignore */
    }
  };

  // Canvas frames stretch to the full page height, which would make vh units
  // (viewport = iframe) track the frame instead of a screen — a 100vh hero
  // would fill the whole frame and the measured height would chase its own
  // tail (every breakpoint converging to the same height). The app posts
  // `avb:set-vh` with the breakpoint's real viewport height; we freeze vh by
  // copying every rule that uses vh units into an override stylesheet with
  // `Xvh` → `calc(X * var(--avb-vh))`, where --avb-vh is 1% of that height.
  const VH_RE = /(-?\d*\.?\d+)(vh|svh|lvh|dvh)\b/g;
  const FIXED_RE = /position:\s*fixed/g;
  let overrideEl = null;
  let rewriteTimer = null;

  // Copies ONLY the declarations that need freezing (vh units, position:
  // fixed) into the override — never whole rule bodies. Re-asserting entire
  // rules at the end of the cascade would let base rules beat utility
  // classes that legitimately override them later in source order.
  const filterRule = (rule) => {
    // An @import brings a whole stylesheet in, and its rules hang off
    // `rule.styleSheet`, not `rule.cssRules` — so a sheet reached this way was
    // invisible here. That's where a design system's `body { min-height:
    // 100svh }` usually lives, and leaving it live is what makes a stretched
    // canvas frame grow without end: svh tracks the frame, body grows, the
    // page reports a taller height, the frame stretches again.
    if (rule.type === 3 /* CSSImportRule */ || rule.styleSheet) {
      // Still loading: nothing to copy yet, and no <head> mutation will
      // announce it later, so ask for another pass.
      if (!rule.styleSheet) {
        importsPending = true;
        return '';
      }
      let inner = '';
      try {
        for (const r of rule.styleSheet.cssRules) inner += filterRule(r);
      } catch {
        return ''; // cross-origin import — can't read it
      }
      if (!inner) return '';
      // Keep whatever layer it was imported into, or the copy would outrank
      // (or be outranked by) the original.
      const layer = /\blayer\(([^)]*)\)/i.exec(rule.cssText || '');
      return layer ? `@layer ${layer[1].trim()} {\n${inner}}\n` : inner;
    }
    const selector = rule.selectorText || rule.keyText;
    const isStyleRule = !!rule.style && !!selector;
    if (rule.cssRules && rule.cssRules.length && !isStyleRule) {
      // Grouping rule (@media, @supports, @layer, @keyframes …) — recurse.
      let inner = '';
      for (const r of rule.cssRules) inner += filterRule(r);
      if (!inner) return '';
      const head = rule.cssText.slice(0, rule.cssText.indexOf('{'));
      return head + '{\n' + inner + '}\n';
    }
    if (!isStyleRule) return '';
    // With CSS nesting a style rule is BOTH: it has its own declarations and
    // it contains rules. Taking the grouping branch above on the strength of
    // `cssRules` alone skipped everything the rule itself declared — which is
    // exactly where `body { min-height: 100svh; > main { … } }` hides, and why
    // a frame with that in its stylesheet grew without end.
    let nested = '';
    if (rule.cssRules && rule.cssRules.length) {
      for (const r of rule.cssRules) nested += filterRule(r);
    }
    let decls = '';
    for (const prop of rule.style) {
      const val = rule.style.getPropertyValue(prop);
      const prio = rule.style.getPropertyPriority(prop);
      VH_RE.lastIndex = 0;
      const hasVh = VH_RE.test(val);
      const isFixed = prop === 'position' && /fixed/.test(val);
      if (!hasVh && !isFixed) continue;
      VH_RE.lastIndex = 0;
      // position:fixed anchors to the stretched frame, so it becomes
      // absolute — headers/overlays sit at their page position instead of
      // floating mid-frame.
      const newVal = isFixed
        ? 'absolute'
        : val.replace(VH_RE, 'calc($1 * var(--avb-vh, 1$2))');
      decls += `${prop}: ${newVal}${prio ? ' !important' : ''}; `;
    }
    // Nested matches are re-emitted inside their parent, keeping the nesting
    // (and so the `&` context) they were written with.
    if (!decls && !nested) return '';
    return `${selector} { ${decls}${nested ? '\n' + nested : ''}}\n`;
  };

  let importsPending = false;
  let importRetries = 0;
  const rewriteSheets = () => {
    if (!document.head) return;
    importsPending = false;
    // Un-stretch html/body so the frame's height comes from content, not
    // from the (stretched) viewport — kills height:100% feedback.
    let css = 'html, body { height: auto !important; }\n';
    for (const sheet of document.styleSheets) {
      if (sheet.ownerNode === overrideEl) continue;
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // cross-origin stylesheet — can't read, leave it be
      }
      for (const rule of rules) css += filterRule(rule);
    }
    if (!overrideEl) {
      overrideEl = document.createElement('style');
      overrideEl.id = 'avb-vh-override';
    }
    if (overrideEl.textContent !== css) overrideEl.textContent = css;
    if (document.head.lastElementChild !== overrideEl) document.head.appendChild(overrideEl);
    // An @import that hadn't finished loading has rules we still need, and it
    // won't touch <head> when it arrives — so nothing else would bring us
    // back. Try again shortly, a bounded number of times.
    if (importsPending && importRetries < 25) {
      importRetries += 1;
      setTimeout(rewriteSheets, 120);
    }
  };

  const scheduleRewrite = () => {
    clearTimeout(rewriteTimer);
    rewriteTimer = setTimeout(() => {
      rewriteSheets();
      report();
    }, 100);
  };

  // --- Node outlines --------------------------------------------------------
  // Pages served through the app's marker plugin wrap every model node in
  // <!--avb-s:path--> / <!--avb-e:path--> comment pairs. Record each pair's
  // run of sibling DOM nodes, then take the markers out.
  //
  // Comments, not elements: a <template> counts for :nth-child, :first-child,
  // + and ~ like anything else, so the markers this replaced shifted the
  // page's own structural selectors for as long as they were in the DOM —
  // through first paint, since they can only be removed once the run has been
  // recorded. A comment is invisible to all of those. The exception is a
  // slotted node, whose markers must carry its `slot` attribute to travel
  // with it: an attribute needs an element, so those stay <template>s and are
  // read here too. The app tracks paths; their rects are pushed back on
  // scroll/resize/DOM changes, and hovering the page reports the deepest node
  // under the cursor.
  const regions = new Map(); // path -> [ [node, ...], ... ]
  let trackedPaths = [];
  // The file the app is addressing: empty for the page, or a component's
  // namespace while one is open. Every .astro under src carries markers now,
  // so hover and click must resolve within the file being edited.
  let activeScope = '';
  const inScope = (p) => (activeScope ? p.startsWith(activeScope) : !p.includes('|'));

  // Which rendered copy of the open component is being edited. A component
  // used inside a loop renders once per item, and drilling into one card
  // means THAT card — so everything below (outlines, hit testing, the classes
  // the style panel reads) narrows to the nodes that one instance put on the
  // page. Its siblings stay as dim and as unclickable as the rest of it.
  let focusPath = '';
  let focusOcc = 0;
  // A run whose every node has left the document isn't an instance any more:
  // a patched page collects fresh runs and leaves the old ones in the map.
  const isLive = (run) => run.some((n) => n.isConnected);
  // Undefined until asked, then null (nothing to narrow) or the run of nodes
  // the focused instance rendered. Recomputed whenever the DOM moves — a
  // patched page rebuilds the regions these come from.
  let focusCache;
  const focusRoots = () => {
    if (focusCache !== undefined) return focusCache;
    focusCache = null;
    if (focusPath) {
      const runs = (regions.get(focusPath) || []).filter(isLive);
      // Any run at all is the instance that was opened, and everything below —
      // outlines, hit testing, what a scroll-to aims at — should mean THAT one.
      // This used to require two: with `<Button/>` written three times in a
      // page, each has its own path, so the one that was opened has a single
      // run, no narrowing happened, and the component's own paths resolved to
      // all three instances at once — three outlines on screen, and a scroll
      // that went to whichever came first in the document.
      //
      // Zero runs still doesn't narrow: a layout's marker pair is split across
      // <head> and <body> and never pairs up, and narrowing to nothing would
      // hide the page.
      if (runs.length) focusCache = runs[focusOcc] || runs[0];
    }
    return focusCache;
  };
  const inFocus = (n) => {
    const roots = focusRoots();
    if (!roots) return true;
    return roots.some((f) => f === n || (f.nodeType === 1 && f.contains(n)));
  };
  // The occurrences of a path that are on the page, narrowed to the focused
  // instance when there is one. Rects, classes and occurrence numbering all
  // read this, so "the second copy" means the same thing to all of them.
  const runsOf = (p) => {
    const runs = regions.get(p);
    if (!runs) return runs;
    const live = runs.filter(isLive);
    return focusRoots() ? live.filter((run) => run.some(inFocus)) : live;
  };
  let lastHoverPath = undefined;
  let lastHoverOcc = 0;
  // Whether the markers have been walked yet. The app can ask about a node
  // before then — a selection made while the page is still parsing, or in the
  // instant after a patch — and the honest answer is "not yet", not "no such
  // element". Every answer carries this so the asker can tell the two apart,
  // and the announcement below tells it when to try again.
  let mapped = false;
  const announceMapped = () => {
    mapped = true;
    try {
      window.parent.postMessage({ type: 'avb:canvas-ready' }, '*');
    } catch {
      /* no parent to tell */
    }
  };

  // Element nodes also carry their path as an attribute, because the node
  // references above go stale: the page's own scripts are free to rebuild
  // the DOM, and text-animation libraries do exactly that — GSAP SplitText
  // rewrites a paragraph as one clone per line, leaving the original element
  // (the one recorded here) holding just the last line. Attributes ride
  // along on clones, so the path can be re-resolved live. It has to be an
  // attribute rather than leaving the <template> markers in the DOM: marker
  // *nodes* would change what :first-child/:nth-child match.
  const PATH_ATTR = 'data-avb-p';

  // An element can carry more than one path, space separated. The page
  // addresses a slotted element by its page path (written into the markup by
  // the serializer, since a slotted node can't be wrapped in markers); the
  // component that renders the slot addresses that same element by its own
  // path. Whichever file is open picks its namespace out of the list.
  const pathsOf = (el) => (el.getAttribute(PATH_ATTR) || '').split(' ').filter(Boolean);
  const addPath = (el, p) => {
    const list = pathsOf(el);
    if (list.includes(p)) return;
    list.push(p);
    el.setAttribute(PATH_ATTR, list.join(' '));
  };
  // The elements a path is on, one per copy — outermost only. A path can land
  // on an element AND on something inside it: inside slot content the marker
  // is written onto the markup (see serializeNodeMarked), and a component that
  // spreads its rest props puts it on whatever element it spreads onto, which
  // may sit inside the one the collector tagged. Those are one copy addressed
  // twice, and counting them as two made a node with a single instance report
  // "copy 2" for a click in the wrong half of itself — and the classes and
  // spacing lists, which are one entry per occurrence, disagree with the boxes.
  const elementsWithPath = (p) => {
    const all = [...document.querySelectorAll(`[${PATH_ATTR}]`)].filter(
      (el) => pathsOf(el).includes(p) && inFocus(el)
    );
    return all.filter((el) => !all.some((other) => other !== el && other.contains(el)));
  };

  // The path a node marks, or null when it isn't a marker. `kind` is 's'/'e'.
  const markerPath = (n, kind) => {
    if (!n) return null;
    if (n.nodeType === 8) {
      const tag = `avb-${kind}:`;
      return n.data.startsWith(tag) ? n.data.slice(tag.length) : null;
    }
    if (n.nodeType === 1 && n.tagName === 'TEMPLATE') return n.getAttribute(`data-avb-${kind}`);
    return null;
  };

  const collectRegions = () => {
    // Runs that have left the document go first. A patched page collects
    // again, and what it collected last time is either the same nodes (the
    // patch morphed them in place) or nodes that are gone — never a second
    // copy of the node, however many times the page is edited.
    for (const [p, runs] of regions) {
      const live = runs.filter(isLive);
      if (live.length) regions.set(p, live);
      else regions.delete(p);
    }
    // One pass in document order over both marker forms — the deeper path has
    // to be seen last so that it wins the tag on an element they share.
    // Walked by hand rather than with a TreeWalker: this runs in the preload's
    // isolated world, and depending on nothing but firstChild/nextSibling
    // keeps it working whatever that world does or doesn't expose. It is also
    // the only thing standing between the page and no outlines at all —
    // startOutlines gives up entirely when nothing is recorded.
    const starts = [];
    const markers = [];
    const visit = (parent) => {
      for (let n = parent.firstChild; n; n = n.nextSibling) {
        const isStart = markerPath(n, 's') !== null;
        if (isStart) starts.push(n);
        if (isStart || markerPath(n, 'e') !== null) markers.push(n);
        if (n.nodeType === 1) visit(n);
      }
    };
    visit(document);
    // What each path was found to hold this pass, so a tag left on an element
    // the region no longer contains can be taken off again (below).
    const collected = new Map();
    for (const s of starts) {
      const p = markerPath(s, 's');
      // The run ends at the matching close marker, and a run with no close
      // marker among its siblings is EMPTY — never "everything after it".
      // Both markers are written as siblings around the node, so a start
      // whose end isn't there has lost it, and the honest reading of that is
      // that the region holds nothing. Swallowing instead put the following
      // element inside the region, which then answered for clicks on it: the
      // docs footer reported a comment when its fine print was clicked.
      let end = null;
      for (let n = s.nextSibling; n; n = n.nextSibling) {
        if (markerPath(n, 'e') === p) { end = n; break }
      }
      const run = [];
      for (let n = s.nextSibling; n && n !== end; n = n.nextSibling) {
        if (!end) break;
        run.push(n);
        // A chunk group's run contains its members, which are marked too —
        // document order puts the deeper path last, so it wins the tag.
        if (n.nodeType === 1 && n.tagName !== 'TEMPLATE') addPath(n, p);
      }
      if (!collected.has(p)) collected.set(p, new Set());
      for (const n of run) collected.get(p).add(n);
      if (!regions.has(p)) regions.set(p, []);
      const runs = regions.get(p);
      // The same place, collected again: it replaces itself. Appending would
      // make one node look like many — the same box drawn over and over (and
      // the overlays are translucent, so a node hovered after fourteen edits
      // was painted fourteen times, an opaque wash over the page), and every
      // count of "which copy" off by however many edits had been made.
      const again = runs.findIndex((r) => r.some((n) => run.includes(n)));
      if (again >= 0) runs[again] = run;
      else runs.push(run);
    }
    // A tag is only good while the region still holds the element. They used to
    // accumulate and never come off, so one bad pass — a marker briefly out of
    // place — left an element permanently answering to a path it wasn't in.
    for (const el of document.querySelectorAll(`[${PATH_ATTR}]`)) {
      const kept = pathsOf(el).filter((p) => !collected.has(p) || collected.get(p).has(el));
      if (kept.length === pathsOf(el).length) continue;
      if (kept.length) el.setAttribute(PATH_ATTR, kept.join(' '));
      else el.removeAttribute(PATH_ATTR);
    }
    for (const n of markers) n.remove();
    focusCache = undefined; // new runs — the focused instance may be among them
  };

  // Grows `acc` (a left/top/right/bottom box, or null) by one node's box.
  const addNode = (acc, n) => {
    if (!n.isConnected) return acc;
    let b = null;
    if (n.nodeType === 1) {
      if (n.tagName === 'TEMPLATE') return acc;
      b = n.getBoundingClientRect();
      // `display: contents` generates no box of its own, so the element
      // measures zero however big its content is. Astro sets it on
      // <astro-island>/<astro-slot>, which is every client: component — they
      // selected fine (hover walks the DOM) but drew no outline. Fall back to
      // the children, which do generate boxes.
      if (b.width === 0 && b.height === 0) {
        for (const c of n.childNodes) acc = addNode(acc, c);
        return acc;
      }
    } else if (n.nodeType === 8) {
      return acc; // a marker still sitting in a recorded run — no box to add
    } else if (n.nodeType === 3 && n.textContent.trim()) {
      const range = document.createRange();
      range.selectNode(n);
      b = range.getBoundingClientRect();
    }
    if (!b || (b.width === 0 && b.height === 0)) return acc;
    if (!acc) return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    return {
      left: Math.min(acc.left, b.left),
      top: Math.min(acc.top, b.top),
      right: Math.max(acc.right, b.right),
      bottom: Math.max(acc.bottom, b.bottom),
    };
  };

  const toRect = (a) => ({ x: a.left, y: a.top, w: a.right - a.left, h: a.bottom - a.top });

  // One rect per marker-pair occurrence (a loop child renders once per
  // item — each instance gets its own box), unioned across the nodes
  // inside each occurrence.
  // The box of the nearest descendants that DO have regions, unioned. Used for
  // a node whose own markers could not survive the HTML parser: a layout wraps
  // <html>, so its start marker is hoisted into <head> and its end into <body>
  // — never siblings, so the pair is never found. Its children are inside the
  // body and marked normally, and their union is exactly the layout's box.
  const rectsFromDescendants = (p) => {
    const prefix = p + '.';
    let best = Infinity;
    const paths = [];
    for (const key of regions.keys()) {
      if (!key.startsWith(prefix)) continue;
      const depth = key.split('.').length;
      if (depth < best) {
        best = depth;
        paths.length = 0;
      }
      if (depth === best) paths.push(key);
    }
    let acc = null;
    for (const key of paths) {
      for (const run of runsOf(key) || []) {
        for (const n of run) acc = addNode(acc, n);
      }
    }
    return acc ? [toRect(acc)] : null;
  };

  // A box with no width or no height, sitting beside boxes that have both.
  //
  // A line-splitter (GSAP's SplitText, Splitting.js) rebuilds a heading into
  // one element per line and leaves the original inline elements behind, empty.
  // Emptied, they still carry the path tag and still have a box — zero wide and
  // a line tall — so the node that WAS a word now reported two places: a hollow
  // one and the real one. The hollow one is first in the document, so it is the
  // one an outline drew: a 1px bar against the left edge of the line.
  //
  // Kept when it is all there is: an element that genuinely renders nothing wide
  // should still show where it sits.
  const withoutHollow = (list) => {
    const real = list.filter((r) => r.w > 0 && r.h > 0);
    return real.length ? real : list;
  };

  // The tagged elements that are really PLACES, each with its box.
  //
  // No marker pair — a slotted element, or a word inside an inline run, carries
  // its path as an attribute instead: a marker beside either would land in the
  // wrong slot or add a space between words. Inside a loop that means one
  // tagged element per item, and they are the occurrences of that node.
  //
  // One list, read by the boxes AND by the click that picks one of them, so
  // "the second copy" means the same thing to both. It didn't: the outlines
  // counted tagged elements and the click counted marker runs, of which a
  // tagged node has none — so clicking the second link in a list reported
  // occurrence 0 and the first one lit up.
  const taggedPlaces = (p) => {
    const out = [];
    for (const el of elementsWithPath(p)) {
      const acc = addNode(null, el);
      if (acc) out.push({ el, rect: toRect(acc) });
    }
    // A line splitter leaves hollow copies of an element behind; they are not
    // places, and counting them would shift every occurrence after them.
    const real = out.filter((e) => e.rect.w > 0 && e.rect.h > 0);
    return real.length ? real : out;
  };

  const rectsForPath = (p) => {
    const runs = runsOf(p);
    if (!runs) {
      const places = taggedPlaces(p);
      return places.length ? places.map((e) => e.rect) : rectsFromDescendants(p);
    }
    const out = [];
    for (const run of runs) {
      let acc = null;
      for (const n of run) acc = addNode(acc, n);
      if (acc) out.push(toRect(acc));
    }
    // A single node can still be many elements on the page — see PATH_ATTR:
    // a split paragraph's original element covers only its last line, and
    // the rest of it lives in clones. Union every tagged piece back into one
    // box. Repeated occurrences (a loop child, once per item) are meant to
    // stay separate boxes, so they keep the per-run rects above.
    if (runs.length === 1) {
      let acc = (runs[0] || []).reduce(addNode, null);
      for (const el of elementsWithPath(p)) acc = addNode(acc, el);
      // Nothing measurable: fall through to the children (see below).
      if (acc) return [toRect(acc)];
    }
    if (out.length) return out;
    // Every run measured nothing, yet the node may well be on screen: a page
    // script can replace the recorded nodes outright (a marquee that clones its
    // track, a slider that rebuilds slides). The tag survives on the clones, so
    // re-resolve from the live DOM — one box per tagged element, in document
    // order, which is the order occurrences are counted in. Without this a
    // looped node under such a script draws no outline at all, even though
    // clicking it still selects (nodeAt reads the same tag).
    const tagged = elementsWithPath(p);
    if (tagged.length) {
      for (const el of tagged) {
        const acc = addNode(null, el);
        if (acc) out.push(toRect(acc));
      }
      const real = withoutHollow(out);
      if (real.length) return real;
    }
    // A region that exists but contains nothing with a box — the layout case:
    // its start marker is orphaned in <head>, so the walk collected the head's
    // scripts and links rather than the page. Its children still measure.
    return rectsFromDescendants(p);
  };

  // The classes actually on the page for a node, one entry per occurrence (a
  // node inside a loop renders once per item). The model can't answer this:
  // `class:list={[...]}` and `class={expr}` are expressions, so the authored
  // source has no class text to read — only the rendered element knows what
  // the expression evaluated to for THIS instance.
  // The classes this file puts on the page itself, which the app must never see
  // among the element's own: they would show up in the class picker, in the
  // selector well, and in the navigator's labels as if the project had written
  // them.
  const STACKI_CLASSES = new Set(['stacki-opened', 'stacki-designer', 'stacki-preview']);
  const ownClasses = (el) => [...el.classList].filter((c) => !STACKI_CLASSES.has(c));

  const classesForPath = (p) => {
    const out = [];
    for (const run of runsOf(p) || []) {
      const el = run.find((n) => n.nodeType === 1 && n.tagName !== 'TEMPLATE');
      if (el) out.push(ownClasses(el));
    }
    if (!out.length) {
      for (const el of elementsWithPath(p)) {
        out.push(ownClasses(el));
      }
    }
    return out;
  };

  // The element's own spacing, in px, for the box the style panel draws over the
  // canvas: hovering `padding-top` there lights the strip of this element that
  // padding-top actually occupies. Read from the computed style rather than the
  // authored value, because that is the question being asked — where is it on
  // the page, not what was typed.
  const SIDES = ['top', 'right', 'bottom', 'left'];

  // Where an element's `gap` actually is, as rectangles.
  //
  // Padding and margin are four numbers on the element itself, so the panel can
  // draw them from the box alone. A gap is not: it lives BETWEEN children, and
  // where those children are is a question only the laid-out page can answer —
  // flex wraps, grid places, and neither is reconstructable from the parent's
  // rectangle. So the bands are measured here, in the same viewport coordinates
  // as every other rect, and the app only has to draw them.
  //
  // Measured, but never larger than the gap: with `justify-content:
  // space-between` the space between two children is the gap PLUS the free
  // space shared out between them, and lighting all of that would say `gap` is
  // bigger than it is. The band is capped at the computed gap and sits against
  // the child before it, which is the part of that space the property is
  // actually responsible for.
  const gapBandsFor = (el, cs) => {
    const display = cs.display;
    if (!/(^|\s)(flex|grid|inline-flex|inline-grid)$/.test(display)) return [];
    const colGap = parseFloat(cs.columnGap) || 0;
    const rowGap = parseFloat(cs.rowGap) || 0;
    if (colGap <= 0 && rowGap <= 0) return [];

    const kids = [];
    for (const child of el.children) {
      if (child.tagName === 'TEMPLATE') continue;
      const r = child.getBoundingClientRect();
      // A child with no box is not somewhere a gap can be seen.
      if (r.width <= 0 && r.height <= 0) continue;
      const cd = window.getComputedStyle(child).display;
      if (cd === 'none' || cd === 'contents') continue;
      kids.push(r);
    }
    if (kids.length < 2) return [];

    // Children grouped into visual rows: two that overlap vertically are on
    // the same line, whether that line came from flex-wrap or from grid.
    const byTop = [...kids].sort((a, b) => a.top - b.top || a.left - b.left);
    const rows = [];
    for (const r of byTop) {
      const row = rows[rows.length - 1];
      const overlaps = row && r.top < row.bottom - 1 && r.bottom > row.top + 1;
      if (overlaps) {
        row.items.push(r);
        row.top = Math.min(row.top, r.top);
        row.bottom = Math.max(row.bottom, r.bottom);
      } else {
        rows.push({ top: r.top, bottom: r.bottom, items: [r] });
      }
    }

    const bands = [];
    // Between columns, within each row.
    if (colGap > 0) {
      for (const row of rows) {
        const across = [...row.items].sort((a, b) => a.left - b.left);
        for (let i = 1; i < across.length; i++) {
          const space = across[i].left - across[i - 1].right;
          const w = Math.min(space, colGap);
          if (w <= 0.5) continue;
          bands.push({ axis: 'column', x: across[i - 1].right, y: row.top, w, h: row.bottom - row.top });
        }
      }
    }
    // Between rows, across the width the children occupy.
    if (rowGap > 0) {
      for (let i = 1; i < rows.length; i++) {
        const space = rows[i].top - rows[i - 1].bottom;
        const h = Math.min(space, rowGap);
        if (h <= 0.5) continue;
        const span = [...rows[i - 1].items, ...rows[i].items];
        const left = Math.min(...span.map((r) => r.left));
        const right = Math.max(...span.map((r) => r.right));
        bands.push({ axis: 'row', x: left, y: rows[i - 1].bottom, w: right - left, h });
      }
    }
    return bands;
  };

  const spacingForPath = (p) => {
    const out = [];
    for (const run of runsOf(p) || []) {
      const el = run.find((n) => n.nodeType === 1 && n.tagName !== 'TEMPLATE');
      if (el) out.push(el);
    }
    if (!out.length) out.push(...elementsWithPath(p));
    return out.map((el) => {
      try {
        const cs = window.getComputedStyle(el);
        const box = (kind) =>
          Object.fromEntries(SIDES.map((s) => [s, parseFloat(cs.getPropertyValue(`${kind}-${s}`)) || 0]));
        return { padding: box('padding'), margin: box('margin'), gaps: gapBandsFor(el, cs) };
      } catch {
        // Whatever went wrong measuring one element, the boxes everything else
        // depends on still have to be reported.
        return null;
      }
    });
  };

  const sendRects = () => {
    if (!trackedPaths.length) return;
    const rects = {};
    const classes = {};
    const spacing = {};
    for (const p of trackedPaths) {
      rects[p] = rectsForPath(p);
      classes[p] = classesForPath(p);
      spacing[p] = spacingForPath(p);
    }
    window.parent.postMessage({ type: 'avb:rects', rects, classes, spacing }, '*');
  };

  // Nodes that put nothing on the page: a component that returns null for the
  // props it was given (an <Img> with no src, a grid with no children) still
  // has its marker pair, with nothing between them. Structural only — no
  // measuring — so this can cover every node in the file rather than the two
  // or three whose rects are tracked. A node that renders only whitespace
  // counts as empty; one that renders a zero-size element does not, because
  // something IS there.
  // What actually reached the page. Reported the positive way round, because
  // a node can put nothing on screen in two ways: its markers are there with
  // nothing between them (a component that returned null), or its markers
  // never got emitted at all — everything inside a component that rendered
  // nothing, whose slot content was never evaluated. Only the app knows the
  // full node list, so it takes this set and treats the rest as unrendered.
  //
  // Structural only, no measuring, so it can cover every node in the file.
  let lastRenderedKey = '';
  const sendRendered = () => {
    const rendered = [];
    for (const p of regions.keys()) {
      if (!inScope(p)) continue;
      let live = false;
      for (const run of runsOf(p) || []) {
        for (const n of run) {
          if (!n.isConnected) continue;
          if (n.nodeType === 1 && n.tagName !== 'TEMPLATE') live = true;
          else if (n.nodeType === 3 && n.textContent.trim()) live = true;
          if (live) break;
        }
        if (live) break;
      }
      // The tag survives on clones when a script rebuilds the DOM, so a node
      // whose recorded run went stale is still rendering something.
      if (!live && elementsWithPath(p).length) live = true;
      if (live) rendered.push(p);
    }
    // A slotted node is never wrapped in markers — it's addressed by the tag
    // alone (see pathsOf) — so it has no region to be found above. Anything
    // carrying a tag is on the page by definition.
    for (const el of document.querySelectorAll(`[${PATH_ATTR}]`)) {
      if (!inFocus(el)) continue;
      for (const p of pathsOf(el)) if (inScope(p) && !rendered.includes(p)) rendered.push(p);
    }
    sendStates(rendered);
    const key = rendered.join('\n');
    if (key === lastRenderedKey) return;
    lastRenderedKey = key;
    window.parent.postMessage({ type: 'avb:rendered-nodes', paths: rendered }, '*');
  };

  // Nodes that are on the page but not taking part in it: `display: none` (there
  // and not drawn) and `pointer-events: none` (drawn and not clickable). Both
  // are true of the element as the page computes it — they can arrive from any
  // rule in any stylesheet, so the source cannot answer and the navigator has
  // no way to ask per row.
  //
  // Read in the same pass, and only for nodes that put an element on the page:
  // a computed style is cheap to read one at a time and not free by the
  // hundred, so this rides the walk that already happens rather than adding
  // one of its own.
  let lastStatesKey = '';
  const firstElementFor = (p) => {
    for (const run of runsOf(p) || []) {
      const el = run.find((n) => n.nodeType === 1 && n.tagName !== 'TEMPLATE');
      if (el && el.isConnected) return el;
    }
    return elementsWithPath(p)[0] || null;
  };
  const sendStates = (rendered) => {
    const hidden = [];
    const inert = [];
    for (const p of rendered) {
      const el = firstElementFor(p);
      if (!el) continue;
      try {
        const cs = window.getComputedStyle(el);
        if (cs.display === 'none') hidden.push(p);
        if (cs.pointerEvents === 'none') inert.push(p);
      } catch {
        /* an element that cannot be measured says nothing about itself */
      }
    }
    const key = `${hidden.join(' ')}|${inert.join(' ')}`;
    if (key === lastStatesKey) return;
    lastStatesKey = key;
    window.parent.postMessage({ type: 'avb:node-states', hidden, inert }, '*');
  };

  // The classes each node actually ended up with. `class:list={[...]}` and
  // `class={expr}` are expressions, so the source can't say what they resolve
  // to — only the rendered element knows, and the navigator has no way to ask
  // per row. Reported for every node in the open file, first instance only:
  // a label needs one answer, and where instances differ the first is the one
  // the outline and the props panel are already showing.
  let lastClassKey = '';
  const sendClasses = () => {
    const out = {};
    for (const p of regions.keys()) {
      if (!inScope(p)) continue;
      const list = classesForPath(p)[0];
      if (list && list.length) out[p] = list;
    }
    // Slotted nodes have no marker pair, so they never appear above.
    for (const el of document.querySelectorAll(`[${PATH_ATTR}]`)) {
      const own = ownClasses(el);
      if (!own.length || !inFocus(el)) continue;
      for (const p of pathsOf(el)) {
        if (inScope(p) && !out[p]) out[p] = own;
      }
    }
    const key = JSON.stringify(out);
    if (key === lastClassKey) return;
    lastClassKey = key;
    window.parent.postMessage({ type: 'avb:node-classes', classes: out }, '*');
  };

  // Selecting a node in the navigator brings it onto the page. Only scrolls
  // when the node is actually out of sight — re-selecting something already
  // on screen shouldn't move the page under the user.
  const SCROLL_MARGIN = 24;
  const scrollPathIntoView = (p, occ) => {
    const rects = rectsForPath(p);
    if (!rects || !rects.length) return;
    // One path can render many times (a node inside a loop, a component used
    // repeatedly). Scroll to the instance being worked in, not whichever one
    // happens to come first in the document.
    const r = rects[occ] || rects[0]; // viewport-relative
    const vh = window.innerHeight || document.documentElement.clientHeight;
    if (r.y >= SCROLL_MARGIN && r.y + r.h <= vh - SCROLL_MARGIN) return;
    // Taller than the viewport (a full section) — align its top rather than
    // centering, which would push the start of it off-screen.
    const offset = r.h >= vh - SCROLL_MARGIN * 2 ? SCROLL_MARGIN : (vh - r.h) / 2;
    window.scrollTo({ top: Math.max(0, window.scrollY + r.y - offset), behavior: 'smooth' });
  };

  // `stacki-opened` on the instance being edited — the one that was actually
  // double-clicked, not every copy of the component. It goes on the element(s)
  // the instance rendered at its top level, which for a component with one root
  // is that root; a component that renders two siblings marks both, because it
  // has no single root to speak of.
  //
  // Painted from focusRoots(), so it means exactly what the outline, the hit
  // testing and the scroll-to mean by "the open instance" — one place decides,
  // and a component used inside a loop marks the card that was opened.
  let openedEls = [];
  const paintOpened = () => {
    const roots = focusRoots();
    const next = roots ? roots.filter((n) => n.nodeType === 1 && n.tagName !== 'TEMPLATE') : [];
    for (const el of openedEls) if (!next.includes(el)) el.classList.remove('stacki-opened');
    for (const el of next) el.classList.add('stacki-opened');
    openedEls = next;
  };

  let rectsQueued = false;
  const queueRects = () => {
    thinCache = null; // scrolled, resized or rebuilt — every box moved
    focusCache = undefined; // …including the instance being edited
    if (rectsQueued) return;
    rectsQueued = true;
    requestAnimationFrame(() => {
      rectsQueued = false;
      paintOpened();
      sendRects();
      sendRendered();
      sendClasses();
    });
  };

  // Measure on the next frame, and once more a moment later. The second pass is
  // for changes whose effect lands after the change itself: a stylesheet swapped
  // into <head> by the dev server is applied, then the page relayouts, and a box
  // read in between is the box from before. Dragging a padding value writes CSS
  // several times a second, so a measurement one beat behind is an outline that
  // never catches up.
  let settleTimer = null;
  const remeasure = () => {
    queueRects();
    clearTimeout(settleTimer);
    settleTimer = setTimeout(queueRects, 120);
  };

  // Which rendered copy of a node the target sits in. A node inside a loop
  // is recorded once per item, so the runs are the instances in order.
  const occurrenceOf = (path, target) => {
    const runs = runsOf(path);
    if (runs && runs.length > 1) {
      for (let i = 0; i < runs.length; i++) {
        for (const n of runs[i]) {
          if (!n.isConnected) continue;
          if (n === target || (n.nodeType === 1 && n.contains(target))) return i;
        }
      }
      return 0;
    }
    // A node addressed by its tag rather than by markers has no runs at all —
    // a link inside a list item is written as part of an inline run, and a
    // marker between the words would render as a space. Its copies are the
    // tagged elements, counted in the same order the boxes are measured in.
    const places = taggedPlaces(path);
    if (places.length > 1) {
      for (let i = 0; i < places.length; i++) {
        const el = places[i].el;
        if (el === target || el.contains(target)) return i;
      }
    }
    return 0;
  };

  // Nodes that render as a line — an empty <div>, an <hr>, a wrapper whose
  // children are all absolutely positioned. They have a box, and the app draws
  // it, but nothing can be *inside* something zero pixels tall, so the hit test
  // below always lands on the parent and they'd be reachable only from the
  // navigator. Hit-test those with a few pixels of slack instead, which is how
  // wide the outline looks anyway.
  const THIN = 3; // a box this flat can't be entered
  const THIN_SLACK = 5; // …so accept the cursor this near it
  let thinCache = null;
  const thinTargets = () => {
    if (thinCache) return thinCache;
    thinCache = [];
    for (const el of document.querySelectorAll(`[${PATH_ATTR}]`)) {
      if (!inFocus(el)) continue;
      const p = pathsOf(el).find(inScope);
      if (!p) continue;
      const b = el.getBoundingClientRect();
      // Fully collapsed (0×0) is left alone: the app draws no outline for it,
      // so snapping to it would highlight nothing.
      if (b.width < 1 && b.height < 1) continue;
      if (b.height > THIN && b.width > THIN) continue;
      thinCache.push({ path: p, el, box: b });
    }
    return thinCache;
  };

  // The deepest line-thin node the cursor is within slack of. Constrained to
  // descendants of what the normal hit test found, so this only ever refines
  // the answer — it can't jump to something else on the page.
  const thinAt = (x, y, best) => {
    let hit = null;
    let hitDepth = best ? best.split('.').length : 0;
    for (const t of thinTargets()) {
      if (best && !t.path.startsWith(best + '.')) continue;
      const depth = t.path.split('.').length;
      if (depth <= hitDepth) continue;
      const b = t.box;
      if (x < b.left - THIN_SLACK || x > b.right + THIN_SLACK) continue;
      if (y < b.top - THIN_SLACK || y > b.bottom + THIN_SLACK) continue;
      hit = t;
      hitDepth = depth;
    }
    return hit;
  };

  // Deepest marked node whose rendered DOM contains the target, plus which
  // instance of it was hit — the app outlines only that one.
  const nodeAt = (target, x = null, y = null) => {
    // Clones the page's own scripts made aren't in any recorded run, so the
    // tag is the only way to reach them — without this, clicking a split
    // paragraph would select its parent instead.
    let tagged = target instanceof Element ? target.closest(`[${PATH_ATTR}]`) : null;
    // Walk out of any nested namespace until the tag belongs to the open file
    // — and, while an instance is focused, until it belongs to that instance:
    // a click on one of its siblings resolves to nothing, which is how the app
    // hears "done in here".
    while (tagged && !(inFocus(tagged) && pathsOf(tagged).some(inScope))) {
      tagged = tagged.parentElement ? tagged.parentElement.closest(`[${PATH_ATTR}]`) : null;
    }
    // Whether anything at all was under the pointer, focus aside. `null` means
    // the canvas could not place the click; `outside` means it could, somewhere
    // this file/instance doesn't own — and only the second is somebody looking
    // away from what they are editing. The app needs them apart: it backs out
    // of a component on one and must sit still for the other.
    const anyTag = target instanceof Element ? target.closest(`[${PATH_ATTR}]`) : null;
    let best = tagged ? pathsOf(tagged).find(inScope) ?? null : null;
    let bestDepth = best ? best.split('.').length : -1;
    for (const p of regions.keys()) {
      if (!inScope(p)) continue;
      const runs = runsOf(p) || [];
      const depth = p.split('.').length;
      if (depth <= bestDepth) continue;
      for (const run of runs) {
        let hit = false;
        for (const n of run) {
          if (n.isConnected && n.nodeType === 1 && (n === target || n.contains(target))) {
            hit = true;
            break;
          }
        }
        if (hit) {
          best = p;
          bestDepth = depth;
          break;
        }
      }
    }
    // Nothing containing the cursor can be flat, so this runs last, over the
    // node that did win: a zero-height child of it takes precedence.
    if (x !== null) {
      const thin = thinAt(x, y, best);
      if (thin) return { path: thin.path, occurrence: occurrenceOf(thin.path, thin.el), outside: false };
    }
    // Resolved separately from the search above: when the winning path came
    // from the tag, its own runs were never scanned.
    return {
      path: best,
      occurrence: best ? occurrenceOf(best, target) : 0,
      outside: !best && !!anyTag,
    };
  };

  // What the pointer is actually over. A page script that calls
  // setPointerCapture — drag carousels, sliders, anything with a grab
  // cursor — makes every later pointer event, INCLUDING the click, report
  // the capturing element as its target. Trusting e.target there selects the
  // whole carousel however deep you click. Hit-test the cursor instead; a
  // synthesised event with no coordinates keeps e.target.
  const targetAt = (e) =>
    (e.clientX || e.clientY ? document.elementFromPoint(e.clientX, e.clientY) : null) || e.target;

  // Same resolution for hover, click and dblclick, so what lights up under the
  // cursor is exactly what a click selects.
  const nodeAtEvent = (e) =>
    e.clientX || e.clientY
      ? nodeAt(targetAt(e), e.clientX, e.clientY)
      : nodeAt(targetAt(e));

  const startOutlines = () => {
    // A page edit now patches the document instead of reloading it, so the
    // markers this map is built from move without the page ever going away.
    // Registered before the early return: the first collection can come up
    // empty (a page whose markup arrives with the first patch), and this is
    // what gets it a second chance.
    document.addEventListener('avb:morphed', () => {
      collectRegions();
      announceMapped();
      queueRects();
    });
    collectRegions();
    // Said even when the page has no markers at all: "nothing here" is a real
    // answer, and withholding it would leave every question waiting out its
    // timeout.
    announceMapped();
    if (!regions.size) return;
    window.addEventListener('scroll', queueRects, true);
    window.addEventListener('resize', remeasure);
    // The whole document, not just the body: styling something writes CSS, and
    // the dev server delivers CSS by swapping a <style> in <head>. Watching the
    // body alone meant the element moved under an outline that had no idea
    // anything had happened — the outline only caught up when something else
    // (a scroll, an edit to the markup) asked for a fresh measurement.
    new MutationObserver(remeasure).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    // A layout that changed without changing the DOM at all — a rule edited
    // through the CSSOM, a font finishing loading, a container query flipping.
    // Nothing to observe there but the boxes themselves.
    try {
      const ro = new ResizeObserver(remeasure);
      ro.observe(document.documentElement);
      if (document.body) ro.observe(document.body);
    } catch {
      /* no ResizeObserver: the observers above still cover the common cases */
    }
    document.addEventListener('mousemove', (e) => {
      const { path: p, occurrence } = nodeAtEvent(e);
      if (p !== lastHoverPath || occurrence !== lastHoverOcc) {
        lastHoverPath = p;
        lastHoverOcc = occurrence;
        window.parent.postMessage({ type: 'avb:hover-node', path: p, occurrence }, '*');
      }
    });
    document.documentElement.addEventListener('mouseleave', () => {
      if (lastHoverPath !== null) {
        lastHoverPath = null;
        window.parent.postMessage({ type: 'avb:hover-node', path: null }, '*');
      }
    });
    // Double-clicking a component opens it for editing, the way Webflow
    // drills into one.
    document.addEventListener(
      'dblclick',
      (e) => {
        if (!designMode) return;
        e.preventDefault();
        e.stopPropagation();
        // Report even when nothing in scope matched: markup the layout renders
        // itself (nav, footer — anything outside the page's <slot>) has no
        // in-scope marker, and the app opens the layout for those.
        // With the occurrence: a component inside a loop renders once per
        // item, and opening it means the one under the cursor.
        const { path: p, occurrence } = nodeAtEvent(e);
        window.parent.postMessage(
          { type: 'avb:open-node', path: p || null, occurrence },
          '*'
        );
      },
      true
    );

    // In the design canvas (any frame the app tracks paths in), clicking
    // selects the node in the app instead of activating links/buttons.
    // Interactive preview frames never receive avb:track, so they keep
    // normal page behavior.
    document.addEventListener(
      'click',
      (e) => {
        if (!designMode) return;
        e.preventDefault();
        e.stopPropagation();
        // A click that hits no marked node still reports (path null), with
        // `outside` saying whether it landed on something the open file simply
        // doesn't own — which is what the app backs out of a component on.
        const { path: p, occurrence, outside } = nodeAtEvent(e);
        window.parent.postMessage(
          { type: 'avb:click-node', path: p || null, occurrence, outside: !!outside },
          '*'
        );
      },
      true
    );
  };

  let designMode = false;

  let frozen = false;
  // --- Asking the page itself ------------------------------------------------
  //
  // The style panel used to answer "does this selector target this element?"
  // by walking the app's source tree, which stops at a component's edge: a
  // rule hinging on a class the component renders (`.section > *`) looked like
  // no match, and a class added by a script was invisible. The rendered page
  // is right here, so ask it — Chromium's own selector engine, over the real
  // DOM, knows every element and every class however it got there.
  const elementsForPath = (p) => {
    const out = [];
    for (const run of runsOf(p) || []) {
      for (const n of run) {
        if (n.nodeType !== 1) continue;
        // A run holds everything between the marker pair, which includes the
        // markers of anything nested — a component instance starts with its
        // own <template data-avb-s="…">. Those are detached once collected,
        // and they never describe the element: reporting one as the node's
        // identity tells the style panel the tag is `template` and there are
        // no classes. Same rule the rect measuring uses.
        if (!n.isConnected || n.tagName === 'TEMPLATE') continue;
        out.push(n);
      }
    }
    for (const el of elementsWithPath(p)) {
      if (!out.includes(el)) out.push(el);
    }
    // A node that renders nothing of its own (a component wrapping a fragment,
    // `display: contents`) still has descendants that do — the first of those
    // stands in for it, the same fallback the rect measuring uses.
    if (!out.length) {
      const first = [...document.querySelectorAll(`[${PATH_ATTR}]`)].find((el) =>
        pathsOf(el).some((x) => x.startsWith(p + '.'))
      );
      if (first) out.push(first);
    }
    return out;
  };

  const identityOf = (el) => ({
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    classes: ownClasses(el),
    attributes: Object.fromEntries(
      [...el.attributes]
        .filter((a) => a.name !== PATH_ATTR)
        .map((a) => [a.name, a.value])
    ),
  });

  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const d = e.data;
    if (d?.type === 'avb:query' && typeof d.id === 'number') {
      const els = typeof d.path === 'string' ? elementsForPath(d.path) : [];
      const matched = {};
      // What a value actually resolves to ON THIS ELEMENT. `var(--background)`
      // means nothing in the app's own document — the panel painted it there
      // and got transparent — and it can mean different things on two elements
      // of the same page (a theme class, a container query, a colour scheme).
      // Only the page can say, so it is asked: a throwaway span in the element
      // inherits its custom properties, takes the value as a colour, and the
      // engine hands back the computed one.
      const computed = {};
      const wanted = Array.isArray(d.compute) ? d.compute : [];
      if (wanted.length && els[0]) {
        const probe = document.createElement('span');
        probe.setAttribute('style', 'position:absolute;width:0;height:0;visibility:hidden');
        els[0].appendChild(probe);
        for (const value of wanted) {
          try {
            // A sentinel first: assigning a value the engine rejects leaves the
            // previous one in place, and reading that back would report a
            // colour the value never had.
            probe.style.color = 'rgb(1, 2, 3)';
            probe.style.color = value;
            computed[value] =
              probe.style.color === 'rgb(1, 2, 3)' ? null : getComputedStyle(probe).color;
          } catch {
            computed[value] = null;
          }
        }
        probe.remove();
      }
      // What the element's style ACTUALLY is for a property nothing in the panel
      // sets — inherited from a parent, painted by a `*` rule the panel can't see
      // past a component edge, or a user-agent default. The panel highlights that
      // value in its dropdowns so an unset control still shows what's on the page.
      const computedProps = {};
      const props = Array.isArray(d.props) ? d.props : [];
      if (props.length && els[0]) {
        // Design mode paints `cursor: default !important` over everything (see the
        // top of this file), so the page's own cursor is hidden behind it. Lift that
        // sheet for the read and put it straight back — nothing paints in between,
        // and otherwise every element would report `default`.
        const designStyle = document.getElementById('avb-design-style');
        try {
          if (designStyle) designStyle.disabled = true;
          const cs = getComputedStyle(els[0]);
          for (const prop of props) {
            if (typeof prop !== 'string') continue;
            computedProps[prop] = cs.getPropertyValue(prop) || null;
          }
        } catch {
          // A detached or cross-document element answers nothing; the panel
          // falls back to its own defaults.
        } finally {
          if (designStyle) designStyle.disabled = false;
        }
      }
      for (const sel of d.selectors || []) {
        try {
          // Any of the element's occurrences matching counts — a loop child is
          // one node in the tree and many elements on the page.
          matched[sel] = els.some((el) => el.matches(sel));
        } catch {
          matched[sel] = null; // not a selector this engine accepts
        }
      }
      window.parent.postMessage(
        {
          type: 'avb:query-result',
          id: d.id,
          ready: mapped,
          found: els.length > 0,
          computed,
          computedProps,
          identity: els[0] ? identityOf(els[0]) : null,
          matched,
        },
        '*'
      );
      return;
    }
    if (d?.type === 'avb:track' && Array.isArray(d.paths)) {
      designMode = true;
      trackedPaths = d.paths;
      activeScope = typeof d.scope === 'string' ? d.scope : '';
      focusPath = typeof d.focus === 'string' ? d.focus : '';
      focusOcc = typeof d.focusOcc === 'number' ? d.focusOcc : 0;
      focusCache = undefined;
      thinCache = null; // scope decides what's hit-testable
      lastRenderedKey = ''; // scope decides which nodes are even asked about
      lastClassKey = '';
      paintOpened();
      sendRects();
      sendRendered();
      sendClasses();
    }
    if (d?.type === 'avb:scroll-to' && typeof d.path === 'string') {
      scrollPathIntoView(d.path, typeof d.occ === 'number' ? d.occ : 0);
    }
    if (d?.type === 'avb:set-vh' && typeof d.px === 'number') {
      document.documentElement.style.setProperty('--avb-vh', d.px / 100 + 'px');
      if (!frozen) {
        frozen = true;
        rewriteSheets();
        // Subresources — @import among them — are done by `load`, so take one
        // more pass then even if the retries above have run out.
        window.addEventListener('load', scheduleRewrite);
        // Vite HMR injects/replaces <style> tags — keep the override current
        // (and last in the cascade).
        new MutationObserver(scheduleRewrite).observe(document.head || document.documentElement, {
          childList: true,
          subtree: true,
        });
      }
      report();
    }
  });

  const start = () => {
    report();
    startOutlines();
    // Tell the app which route this frame is on (used by interactive
    // preview mode to follow link navigation).
    try {
      window.parent.postMessage(
        { type: 'avb:navigated', path: location.pathname + location.search },
        '*'
      );
    } catch {
      /* ignore */
    }
    try {
      const ro = new ResizeObserver(report);
      ro.observe(document.documentElement);
      if (document.body) ro.observe(document.body);
    } catch {
      /* old engines: load event still reports */
    }
    window.addEventListener('load', report);
  };
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
  return;
}

const invoke = (channel) => (payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('avb', {
  platform: process.platform,

  // Project
  openProjectDialog: invoke('project:openDialog'),
  newProjectDialog: invoke('project:newDialog'),
  scaffoldProject: invoke('project:scaffold'),
  createAstroProject: invoke('project:createAstro'),
  parentDialog: invoke('project:parentDialog'),
  createStarter: invoke('project:createStarter'),
  hasNodeModules: invoke('project:hasNodeModules'),
  installDeps: invoke('project:install'),
  scanProject: invoke('project:scan'),
  listProjectClasses: invoke('project:classes'),
  watchProject: invoke('watch:start'),

  // Assets (public/)
  listAssets: invoke('assets:list'),
  pickUploadAssets: invoke('assets:pickUpload'),
  uploadAssets: invoke('assets:upload'),
  moveAsset: invoke('assets:move'),
  renameAsset: invoke('assets:rename'),
  mkdirAssets: invoke('assets:mkdir'),
  readAssetText: invoke('assets:readText'),
  writeAssetText: invoke('assets:writeText'),
  // The source file an imported symbol is defined in — data files, consts,
  // anything the page pulls values from.
  readSymbolSource: invoke('src:readSymbol'),
  resolveSourcePath: invoke('src:resolvePath'),
  assetDimensions: invoke('assets:dimensions'),
  readSourceText: invoke('src:readText'),
  writeSourceText: invoke('src:writeText'),
  // OS drag-and-drop: resolve a DOM File to its filesystem path.
  getFilePath: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return file?.path || null;
    }
  },
  onAssetsChanged: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('assets:changed', listener);
    return () => ipcRenderer.removeListener('assets:changed', listener);
  },

  // ⇧⌘C — the canvas selection as file:line pointers, for an AI chat.
  copySelection: invoke('selection:copy'),

  // CMS (JSON data under src/)
  listCms: invoke('cms:list'),
  readCms: invoke('cms:read'),
  writeCms: invoke('cms:write'),
  createCms: invoke('cms:create'),
  deleteCms: invoke('cms:delete'),
  cmsUsage: invoke('cms:usage'),
  resolveImport: invoke('project:resolveImport'),
  cmsMeta: invoke('cms:meta'),
  contentConfig: invoke('content:config'),
  // Variables (CSS custom properties)
  cssVariables: invoke('css:variables'),
  setCssVariable: invoke('css:setVariable'),
  moveCssVariables: invoke('css:moveVariables'),
  addCssVariables: invoke('css:addVariables'),
  renameCssVariables: invoke('css:renameVariables'),
  setCssSectionTitle: invoke('css:setSectionTitle'),
  removeCssSection: invoke('css:removeSection'),
  addCssSection: invoke('css:addSection'),
  moveCssHeading: invoke('css:moveHeading'),
  onCssChanged: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('css:changed', listener);
    return () => ipcRenderer.removeListener('css:changed', listener);
  },

  contentCollections: invoke('content:collections'),
  contentEntries: invoke('content:entries'),
  writeContentEntry: invoke('content:writeEntry'),
  validateContentEntry: invoke('content:validate'),
  contentTargets: invoke('content:targets'),
  contentRenamePlan: invoke('content:renamePlan'),
  renameContentEntry: invoke('content:rename'),
  setCmsMeta: invoke('cms:setMeta'),
  onCmsChanged: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('cms:changed', listener);
    return () => ipcRenderer.removeListener('cms:changed', listener);
  },

  // Recent projects
  listRecents: invoke('recents:list'),
  addRecent: invoke('recents:add'),
  removeRecent: invoke('recents:remove'),
  refreshThumb: invoke('recents:refreshThumb'),
  onThumbUpdated: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('recents:thumb', listener);
    return () => ipcRenderer.removeListener('recents:thumb', listener);
  },

  // Pages
  readPage: invoke('page:read'),
  writePage: invoke('page:write'),
  writePageRaw: invoke('page:writeRaw'),
  createPage: invoke('page:create'),
  deletePage: invoke('page:delete'),
  movePage: invoke('page:move'),
  createPageFolder: invoke('pagefolder:create'),
  renamePageFolder: invoke('pagefolder:rename'),
  deletePageFolder: invoke('pagefolder:delete'),
  importPathFor: invoke('page:importPathFor'),
  createComponent: invoke('component:create'),
  componentUsage: invoke('component:usage'),
  dynamicPaths: invoke('page:dynamicPaths'),
  injectedRoutes: invoke('project:injectedRoutes'),
  sampleEntry: invoke('content:sampleEntry'),

  // Dev server
  startDevServer: invoke('dev:start'),
  stopDevServer: invoke('dev:stop'),
  diagnoseDev: invoke('dev:diagnose'),
  probeDevPage: invoke('dev:probe'),

  // Style panel targets
  listStyleFiles: invoke('style:listFiles'),
  listAstroStyleFiles: invoke('style:listAstroStyles'),
  readStyleFile: invoke('style:readFile'),
  writeStyleFile: invoke('style:writeFile'),

  // Git
  gitInfo: invoke('git:info'),
  ghStatus: invoke('git:ghStatus'),
  gitInit: invoke('git:init'),
  gitCheckout: invoke('git:checkout'),
  previewAtCommit: invoke('preview:atCommit'),
  previewStop: invoke('preview:stop'),
  gitLog: invoke('git:log'),
  gitCommitFiles: invoke('git:commitFiles'),
  gitAllFiles: invoke('git:allFiles'),
  gitStatus: invoke('git:status'),
  gitFileAt: invoke('git:fileAt'),
  gitWorktrees: invoke('git:worktrees'),
  gitPark: invoke('git:park'),
  gitUnpark: invoke('git:unpark'),
  gitMerge: invoke('git:merge'),
  gitResolveMerge: invoke('git:resolveMerge'),
  gitDeleteBranch: invoke('git:deleteBranch'),
  gitCommit: invoke('git:commit'),
  gitRestoreFile: invoke('git:restoreFile'),
  gitRestoreProject: invoke('git:restoreProject'),
  gitPush: invoke('git:push'),
  gitPublish: invoke('git:publish'),

  openExternal: invoke('shell:openExternal'),

  // Dev only: the project to reopen after a "Reload All Code" relaunch.
  devReopen: invoke('dev:reopen'),

  // Terminal (node-pty). Keystrokes and render acks are `send`, not `invoke`:
  // they're high-frequency and one-way, so they shouldn't pay for a round trip.
  startTerminal: invoke('terminal:start'),
  resizeTerminal: invoke('terminal:resize'),
  closeTerminal: invoke('terminal:close'),
  terminalInput: (id, data) => ipcRenderer.send('terminal:input', { id, data }),
  terminalAck: (id, count) => ipcRenderer.send('terminal:ack', { id, count }),
  terminalClipboardImage: (bytes, mime) =>
    ipcRenderer.invoke('terminal:clipboardImage', { bytes, mime }),
  onTerminalData: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('terminal:data', listener);
    return () => ipcRenderer.removeListener('terminal:data', listener);
  },
  onTerminalExit: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('terminal:exit', listener);
    return () => ipcRenderer.removeListener('terminal:exit', listener);
  },
  onTerminalProcess: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('terminal:process', listener);
    return () => ipcRenderer.removeListener('terminal:process', listener);
  },

  // Events
  onPageMaybeChanged: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('page:maybe-changed', listener);
    return () => ipcRenderer.removeListener('page:maybe-changed', listener);
  },
  onDevLog: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('dev:log', listener);
    return () => ipcRenderer.removeListener('dev:log', listener);
  },
  onDevExit: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('dev:exit', listener);
    return () => ipcRenderer.removeListener('dev:exit', listener);
  },
  onProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('progress', listener);
    return () => ipcRenderer.removeListener('progress', listener);
  },
  // Live output from `npm create astro@latest`, shown in the new-project wizard.
  onCreateLog: (cb) => {
    const listener = (_e, chunk) => cb(chunk);
    ipcRenderer.on('create:log', listener);
    return () => ipcRenderer.removeListener('create:log', listener);
  },
  onFsChanged: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('fs:changed', listener);
    return () => ipcRenderer.removeListener('fs:changed', listener);
  },

  // App preferences — read once on load; the menu pushes changes as they happen.
  settings: invoke('settings:get'),

  // Application menu events (macOS menu accelerators never reach the DOM)
  onMenu: (channel, cb) => {
    // The payload is forwarded: a checkbox item sends its new state, and the
    // items that send nothing simply call back with undefined as before.
    const listener = (_e, data) => cb(data);
    ipcRenderer.on(`menu:${channel}`, listener);
    return () => ipcRenderer.removeListener(`menu:${channel}`, listener);
  },
  nativeCopy: invoke('native:copy'),
  nativePaste: invoke('native:paste'),
});
