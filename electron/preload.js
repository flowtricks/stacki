const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Preview iframes (nodeIntegrationInSubFrames runs this preload in them too):
// don't expose the app API to the previewed site — just report the page's
// content height to the app so the canvas view can size frames to the page.
if (!process.isMainFrame) {
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
        if (isDelete || isDuplicate) {
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
    if (rule.cssRules && rule.cssRules.length) {
      // Grouping rule (@media, @supports, @keyframes …) — recurse.
      let inner = '';
      for (const r of rule.cssRules) inner += filterRule(r);
      if (!inner) return '';
      const head = rule.cssText.slice(0, rule.cssText.indexOf('{'));
      return head + '{\n' + inner + '}\n';
    }
    const selector = rule.selectorText || rule.keyText;
    if (!rule.style || !selector) return '';
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
    return decls ? `${selector} { ${decls}}\n` : '';
  };

  const rewriteSheets = () => {
    if (!document.head) return;
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
  };

  const scheduleRewrite = () => {
    clearTimeout(rewriteTimer);
    rewriteTimer = setTimeout(() => {
      rewriteSheets();
      report();
    }, 100);
  };

  // --- Node outlines --------------------------------------------------------
  // Files served through the app's marker plugin wrap every model node in
  // <template data-avb-s/e="key"> pairs, where a key is "<file>#<path>" (see
  // serializePageMarked). Record each pair's run of sibling DOM nodes, then
  // strip the markers so they can't affect structural CSS selectors
  // (:first-child, :nth-child, …). The app tracks keys; their rects are pushed
  // back on scroll/resize/DOM changes, and hovering the page reports the
  // deepest node under the cursor plus the chain of files it sits inside.
  const regions = new Map(); // key -> [ [node, ...], ... ]
  // Marker document order, per RUN (not per key). Components are marked too,
  // so a page's instance region and that component's own root region can cover
  // the exact same element — the outer one's marker was written first, which is
  // the only thing that separates them (see chainAt). Per-run because a
  // component used three times contributes three runs under one key, each
  // interleaved with a different usage site's marker: keying the ordinal by
  // component would compare the second instance against the first's ordinal
  // and call the wrapper the inner one.
  const order = new Map(); // key -> [ordinal, ...], parallel to regions
  let trackedKeys = [];
  // While the app is drilled into a component, rects and hovers are confined
  // to the one instance being edited: the component's own markup renders at
  // every usage site, so its keys are ambiguous without this.
  let scopeKey = null;
  let lastHoverKey = undefined;
  let lastHoverOcc = 0;

  // Element nodes also carry their key as an attribute, because the node
  // references above go stale: the page's own scripts are free to rebuild
  // the DOM, and text-animation libraries do exactly that — GSAP SplitText
  // rewrites a paragraph as one clone per line, leaving the original element
  // (the one recorded here) holding just the last line. Attributes ride
  // along on clones, so the key can be re-resolved live. It has to be an
  // attribute rather than leaving the <template> markers in the DOM: marker
  // *nodes* would change what :first-child/:nth-child match.
  const PATH_ATTR = 'data-avb-p';

  const collectRegions = () => {
    const starts = document.querySelectorAll('template[data-avb-s]');
    let n0 = 0;
    for (const s of starts) {
      const p = s.getAttribute('data-avb-s');
      const run = [];
      for (let n = s.nextSibling; n; n = n.nextSibling) {
        if (n.nodeType === 1 && n.tagName === 'TEMPLATE' && n.getAttribute('data-avb-e') === p) break;
        run.push(n);
        // A chunk group's run contains its members, which are marked too —
        // document order puts the deeper path last, so it wins the tag.
        if (n.nodeType === 1 && n.tagName !== 'TEMPLATE') n.setAttribute(PATH_ATTR, p);
      }
      if (!regions.has(p)) {
        regions.set(p, []);
        order.set(p, []);
      }
      regions.get(p).push(run);
      order.get(p).push(n0++);
    }
    document
      .querySelectorAll('template[data-avb-s], template[data-avb-e]')
      .forEach((t) => t.remove());
  };

  // Does `run` (a recorded sibling run) cover `target`?
  const runHits = (run, target) => {
    for (const n of run) {
      if (!n.isConnected) continue;
      if (n === target || (n.nodeType === 1 && n.contains(target))) return true;
    }
    return false;
  };

  // Is `target` inside any rendered instance of `key`?
  const withinKey = (key, target) => {
    const runs = regions.get(key);
    if (!runs) return false;
    for (const run of runs) if (runHits(run, target)) return true;
    return false;
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

  // The runs of `key` that count right now: all of them normally, or only
  // those inside the scoped instance while the app is drilled into a
  // component (a component's markup renders at every usage site, so without
  // this its keys would outline all of them at once).
  const runsFor = (key) => {
    const runs = regions.get(key);
    if (!runs) return null;
    if (!scopeKey || key === scopeKey) return runs;
    const scoped = runs.filter((run) => run.some((n) => n.isConnected && withinKey(scopeKey, n)));
    return scoped.length ? scoped : runs;
  };

  // One rect per marker-pair occurrence (a loop child renders once per
  // item — each instance gets its own box), unioned across the nodes
  // inside each occurrence.
  const rectsForPath = (p) => {
    const runs = runsFor(p);
    if (!runs) return null;
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
      let acc = runs[0].reduce(addNode, null);
      // Keys are generated (project-relative path + index trail) and carry no
      // quote or backslash, so they need no escaping inside a quoted
      // attribute selector — '/', '.' and '#' are all literal there.
      for (const el of document.querySelectorAll(`[${PATH_ATTR}="${p}"]`)) {
        // Tagged clones outside the scoped instance belong to another usage
        // site of the same component — folding them in would stretch the box
        // across the page.
        if (scopeKey && p !== scopeKey && !withinKey(scopeKey, el)) continue;
        acc = addNode(acc, el);
      }
      return acc ? [toRect(acc)] : null;
    }
    return out.length ? out : null;
  };

  const sendRects = () => {
    if (!trackedKeys.length) return;
    const rects = {};
    for (const p of trackedKeys) rects[p] = rectsForPath(p);
    window.parent.postMessage({ type: 'avb:rects', rects }, '*');
  };

  // Selecting a node in the navigator brings it onto the page. Only scrolls
  // when the node is actually out of sight — re-selecting something already
  // on screen shouldn't move the page under the user.
  const SCROLL_MARGIN = 24;
  const scrollPathIntoView = (p) => {
    const rects = rectsForPath(p);
    if (!rects || !rects.length) return;
    const r = rects[0]; // viewport-relative
    const vh = window.innerHeight || document.documentElement.clientHeight;
    if (r.y >= SCROLL_MARGIN && r.y + r.h <= vh - SCROLL_MARGIN) return;
    // Taller than the viewport (a full section) — align its top rather than
    // centering, which would push the start of it off-screen.
    const offset = r.h >= vh - SCROLL_MARGIN * 2 ? SCROLL_MARGIN : (vh - r.h) / 2;
    window.scrollTo({ top: Math.max(0, window.scrollY + r.y - offset), behavior: 'smooth' });
  };

  let rectsQueued = false;
  const queueRects = () => {
    // Fed by the MutationObserver below, so this is also the moment a cached
    // chain could have gone stale.
    chainMemo = null;
    if (rectsQueued) return;
    rectsQueued = true;
    requestAnimationFrame(() => {
      rectsQueued = false;
      sendRects();
    });
  };

  // Which rendered copy of a node the target sits in. A node inside a loop
  // is recorded once per item, so the runs are the instances in order.
  // Indexes into the same list rectsForPath draws, scope included.
  const occurrenceOf = (path, target) => {
    const runs = runsFor(path);
    if (!runs || runs.length < 2) return 0;
    for (let i = 0; i < runs.length; i++) {
      if (runHits(runs[i], target)) return i;
    }
    return 0;
  };

  const domDepth = (el) => {
    let d = 0;
    for (let n = el; n; n = n.parentElement) d++;
    return d;
  };

  // Last chainAt result, invalidated whenever the DOM moves (queueRects runs
  // on the same MutationObserver that feeds the outlines).
  let chainMemo = null;

  // Every marked node whose rendered DOM contains the target, outermost first.
  //
  // Depth in the index trail can't order this any more: markup from several
  // files shares one page, and a component's "0.1" says nothing about where it
  // sits relative to the page's "0.3". DOM containment does — so each region
  // is ranked by the depth of the shallowest run node that covers the target.
  //
  // Ties are real and load-bearing: a component instance's region in the page
  // and that component's own root region cover the exact same element. Marker
  // document order separates them — the usage site is written before the
  // markup it pulls in — so the earlier marker is the outer one.
  const chainAt = (target) => {
    if (chainMemo && chainMemo.target === target) return chainMemo.chain;
    const hits = [];
    for (const [key, runs] of regions) {
      let carrier = null;
      let best = Infinity;
      let ord = 0;
      for (let i = 0; i < runs.length; i++) {
        for (const n of runs[i]) {
          if (!n.isConnected || n.nodeType !== 1) continue;
          if (n === target || n.contains(target)) {
            const d = domDepth(n);
            if (d < best) {
              best = d;
              carrier = n;
              ord = order.get(key)?.[i] ?? 0;
            }
            break;
          }
        }
      }
      if (carrier) hits.push({ key, depth: best, ord });
    }
    hits.sort((a, b) => a.depth - b.depth || a.ord - b.ord);
    const chain = hits.map((h) => h.key);
    // Clones the page's own scripts made aren't in any recorded run, so the
    // tag is the only way to reach them — without this, clicking a split
    // paragraph would select its parent instead. A tag already in the chain
    // was found structurally above; one that isn't belongs to a clone, and is
    // the innermost thing there is.
    const el = target instanceof Element ? target : target?.parentElement || null;
    const tagged = el ? el.closest(`[${PATH_ATTR}]`) : null;
    const tag = tagged ? tagged.getAttribute(PATH_ATTR) : null;
    if (tag && chain.indexOf(tag) === -1) chain.push(tag);
    // mousemove fires many times over one element and the walk above scans
    // every region; one slot is enough to make the repeats free.
    chainMemo = { target, chain };
    return chain;
  };

  // Innermost marked node containing the target, the files it sits inside, and
  // which instance of it was hit — the app picks the node it can address from
  // the chain and outlines only that occurrence.
  const nodeAt = (target) => {
    const chain = chainAt(target);
    const key = chain.length ? chain[chain.length - 1] : null;
    return { key, chain, occurrence: key ? occurrenceOf(key, target) : 0 };
  };

  const startOutlines = () => {
    collectRegions();
    if (!regions.size) return;
    window.addEventListener('scroll', queueRects, true);
    window.addEventListener('resize', queueRects);
    new MutationObserver(queueRects).observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    document.addEventListener('mousemove', (e) => {
      const { key, chain, occurrence } = nodeAt(e.target);
      if (key !== lastHoverKey || occurrence !== lastHoverOcc) {
        lastHoverKey = key;
        lastHoverOcc = occurrence;
        window.parent.postMessage({ type: 'avb:hover-node', key, chain, occurrence }, '*');
      }
    });
    document.documentElement.addEventListener('mouseleave', () => {
      if (lastHoverKey !== null) {
        lastHoverKey = null;
        window.parent.postMessage({ type: 'avb:hover-node', key: null, chain: [] }, '*');
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
        const { key, chain } = nodeAt(e.target);
        if (key) window.parent.postMessage({ type: 'avb:open-node', key, chain }, '*');
      },
      true
    );

    // In the design canvas (any frame the app tracks keys in), clicking
    // selects the node in the app instead of activating links/buttons.
    // Interactive preview frames never receive avb:track, so they keep
    // normal page behavior.
    document.addEventListener(
      'click',
      (e) => {
        if (!designMode) return;
        e.preventDefault();
        e.stopPropagation();
        // A click that hits no marked node still reports (key null) — the
        // app uses empty clicks to back out of component editing.
        const { key, chain, occurrence } = nodeAt(e.target);
        window.parent.postMessage(
          { type: 'avb:click-node', key: key || null, chain, occurrence },
          '*'
        );
      },
      true
    );
  };

  let designMode = false;

  let frozen = false;
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const d = e.data;
    if (d?.type === 'avb:track' && Array.isArray(d.keys)) {
      designMode = true;
      trackedKeys = d.keys;
      // Which component instance the app is drilled into, if any — everything
      // outside it is another usage site of the same markup.
      scopeKey = typeof d.scope === 'string' ? d.scope : null;
      sendRects();
    }
    if (d?.type === 'avb:scroll-to' && typeof d.key === 'string') {
      scrollPathIntoView(d.key);
    }
    if (d?.type === 'avb:set-vh' && typeof d.px === 'number') {
      document.documentElement.style.setProperty('--avb-vh', d.px / 100 + 'px');
      if (!frozen) {
        frozen = true;
        rewriteSheets();
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
  cmsMeta: invoke('cms:meta'),
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
  captureThumb: invoke('recents:captureThumb'),

  // Dev only: the project to reopen after a "Reload All Code" relaunch.
  devReopen: invoke('dev:reopen'),

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

  // Dev server
  startDevServer: invoke('dev:start'),
  stopDevServer: invoke('dev:stop'),
  diagnoseDev: invoke('dev:diagnose'),

  // Style panel targets
  listStyleFiles: invoke('style:listFiles'),
  readStyleFile: invoke('style:readFile'),
  writeStyleFile: invoke('style:writeFile'),

  // Git
  gitInfo: invoke('git:info'),
  ghStatus: invoke('git:ghStatus'),
  gitInit: invoke('git:init'),
  gitCheckout: invoke('git:checkout'),
  gitCommit: invoke('git:commit'),
  gitPush: invoke('git:push'),
  gitPublish: invoke('git:publish'),

  openExternal: invoke('shell:openExternal'),

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

  // Application menu events (macOS menu accelerators never reach the DOM)
  onMenu: (channel, cb) => {
    const listener = () => cb();
    ipcRenderer.on(`menu:${channel}`, listener);
    return () => ipcRenderer.removeListener(`menu:${channel}`, listener);
  },
  nativeCopy: invoke('native:copy'),
  nativePaste: invoke('native:paste'),
});
