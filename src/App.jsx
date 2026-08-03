import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import WelcomeScreen from './panels/WelcomeScreen.jsx';
import PagesPanel from './panels/PagesPanel.jsx';
import PalettePanel from './panels/PalettePanel.jsx';
import StructurePanel from './panels/StructurePanel.jsx';
import PropsPanel from './panels/PropsPanel.jsx';
import StylePanel from './panels/StylePanel.jsx';
import PreviewPane from './panels/PreviewPane.jsx';
import GitChip from './panels/GitChip.jsx';
import LeftRail from './ui/LeftRail.jsx';
import CodeWindow from './ui/CodeWindow.jsx';
import PageSwitcher from './ui/PageSwitcher.jsx';
import InsertSearch from './ui/InsertSearch.jsx';
import AssetsPanel from './panels/AssetsPanel.jsx';
import CmsPanel from './panels/CmsPanel.jsx';
import TerminalPanel, { terminalClipboard } from './panels/TerminalPanel.jsx';
import CmsView from './panels/CmsView.jsx';
import { getElementSchema, GLOBAL_ATTRS, canContainTag } from './elementSchemas.js';
import { onAssetRequest, clearAssetRequest } from './assetPick.js';
import { isDataBound } from './bindings.js';
import {
  PreviewIcon,
  RefreshIcon,
  ExternalIcon,
  ChevronLeftIcon,
  ElementComponentIcon,
} from './ui/Icons.jsx';

let idCounter = 1000;
const newId = () => `c${idCounter++}`;

// HTML elements that can never have children.
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// Placeholder copy for newly inserted text elements, so they're visible on the
// canvas straight away instead of collapsing to a zero-height box.
const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Suspendisse varius ' +
  'enim in eros elementum tristique. Duis cursus, mi quis viverra ornare, eros ' +
  'dolor interdum nulla, ut commodo diam libero vitae erat. Aenean faucibus nibh ' +
  'et justo cursus id rutrum lorem imperdiet. Nunc ut sem vitae risus tristique ' +
  'posuere.';
const DEFAULT_TEXT = {
  h1: 'Heading',
  h2: 'Heading',
  h3: 'Heading',
  h4: 'Heading',
  h5: 'Heading',
  h6: 'Heading',
  p: LOREM,
};

// ---------------------------------------------------------------------------
// Tree helpers (model.nodes is a tree of {id, kind, name?, props?, children?})
// ---------------------------------------------------------------------------

function findNodeById(nodes, id) {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (Array.isArray(node.children)) {
      const found = findNodeById(node.children, id);
      if (found) return found;
    }
  }
  return null;
}

// Returns {list, index} of the array containing the node.
function findParentList(model, id) {
  const search = (list) => {
    const index = list.findIndex((n) => n.id === id);
    if (index !== -1) return { list, index };
    for (const node of list) {
      if (Array.isArray(node.children)) {
        const found = search(node.children);
        if (found) return found;
      }
    }
    return null;
  };
  return search(model.nodes);
}

function isDescendantOf(candidateParent, id) {
  if (!Array.isArray(candidateParent.children)) return false;
  return !!findNodeById(candidateParent.children, id) || candidateParent.id === id;
}

// Position (index trail) of a node in the tree, for re-selecting the
// equivalent node after an external reload regenerates ids.
function pathOfNode(nodes, id, trail = []) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.id === id) return [...trail, i];
    if (Array.isArray(n.children)) {
      const p = pathOfNode(n.children, id, [...trail, i]);
      if (p) return p;
    }
  }
  return null;
}

// Ancestor chain (root → … → node) for breadcrumbs.
function ancestorChain(nodes, id, trail = []) {
  for (const node of nodes) {
    if (node.id === id) return [...trail, node];
    if (Array.isArray(node.children)) {
      const r = ancestorChain(node.children, id, [...trail, node]);
      if (r) return r;
    }
  }
  return null;
}

function nodeAtPath(nodes, trail) {
  let list = nodes;
  let node = null;
  for (const i of trail) {
    node = list?.[i];
    if (!node) return null;
    list = Array.isArray(node.children) ? node.children : [];
  }
  return node;
}

// ---------------------------------------------------------------------------
// Renaming a loop variable
//
// `services.map((service) => …)` — renaming `service` has to follow every
// reference below it, or the loop's own children stop compiling. Text-level
// rewriting, since the children hold code as strings.
// ---------------------------------------------------------------------------

const MAP_HEAD_RE = /^([\s\S]+?)\.map\(\s*\(\s*([\w$]+)\s*(?:,\s*([\w$]+)\s*)?\)\s*=>\s*\($/;

function splitMapHead(head) {
  const m = String(head).trim().match(MAP_HEAD_RE);
  return m ? { data: m[1].trim(), item: m[2], index: m[3] || '' } : null;
}

// Whole identifier only: `service` but never the `service` in `x.service`
// (a property of something else) or in `services`.
const renameIdent = (code, from, to) =>
  String(code ?? '').replace(new RegExp(`(?<![.\\w$])${from}(?![\\w$])`, 'g'), to);

// Text nodes are prose with {expressions} in it — rewrite only the braces,
// so a loop variable named `title` doesn't rewrite the word in a sentence.
const renameInBraces = (text, from, to) =>
  String(text ?? '').replace(/\{([^{}]*)\}/g, (_, inner) => `{${renameIdent(inner, from, to)}}`);

function renameLoopVar(nodes, from, to) {
  for (const n of nodes) {
    if (n.kind === 'map') {
      const p = splitMapHead(n.head);
      if (p) {
        // Only the data expression is a reference; the parameters are this
        // loop's own declarations.
        const data = renameIdent(p.data, from, to);
        if (data !== p.data) {
          n.head = `${data}.map((${p.item}${p.index ? `, ${p.index}` : ''}) => (`;
        }
        // A nested loop that re-declares the name shadows the outer one, so
        // everything below it means something else by it.
        if (p.item === from || p.index === from) continue;
      } else {
        n.head = renameIdent(n.head, from, to); // custom head — best effort
      }
    } else if (n.kind === 'expr') {
      n.value = renameIdent(n.value, from, to);
    } else if (n.kind === 'text') {
      n.value = renameInBraces(n.value, from, to);
    }
    for (const [key, v] of Object.entries(n.props || {})) {
      if (v?.type === 'expr') n.props[key] = { ...v, value: renameIdent(v.value, from, to) };
    }
    if (Array.isArray(n.children)) renameLoopVar(n.children, from, to);
  }
}

function collectUsedNames(model) {
  const used = new Set();
  const walk = (list) => {
    for (const node of list) {
      if (node.name) used.add(node.name);
      if (Array.isArray(node.children)) walk(node.children);
    }
  };
  walk(model.nodes);
  return used;
}

// Only prune imports of .astro files; leave assets, utilities, etc. alone.
function pruneImports(model) {
  const used = collectUsedNames(model);
  model.imports = model.imports.filter(
    (i) => !i.path.endsWith('.astro') || used.has(i.name)
  );
}

// Chooses an import path matching the page's existing style: if it already
// imports via a src alias (e.g. "@/components/X.astro"), reuse that alias
// root for the new import; otherwise fall back to a relative path.
function chooseImportPath(model, { relative, srcRelative }) {
  if (srcRelative) {
    for (const imp of model.imports) {
      if (imp.path.startsWith('.')) continue;
      for (const marker of ['/components/', '/layouts/']) {
        const idx = imp.path.indexOf(marker);
        if (idx > 0) return imp.path.slice(0, idx + 1) + srcRelative;
      }
    }
  }
  return relative;
}

// `data.map((item[, index]) => (` → its pieces, or null when the head is
// hand-written code the loop editor can't model.
function parseLoopHead(head) {
  const m = String(head || '').match(
    /^([\s\S]*?)\.map\(\s*\(\s*([A-Za-z_$][\w$]*)\s*(?:,\s*([A-Za-z_$][\w$]*)\s*)?\)\s*=>\s*\($/
  );
  return m ? { data: m[1].trim(), item: m[2], index: m[3] || '' } : null;
}

// Whether `expr` reads from the variable `v` (`service`, `service.tags`) —
// not merely contains its letters (`services`, `x.service`).
const readsVar = (expr, v) =>
  new RegExp(`(^|[^\\w$.])${v}\\b`).test(String(expr || ''));

// Switching a loop's data source orphans any loop beneath it that reads from
// the item — `service.tags.map(...)` under `services.map((service) => …)`
// would call .map on undefined once the parent points somewhere else. Those
// loops are repointed at an empty array: still valid code, renders nothing,
// and the child markup is preserved for re-pointing by hand.
function disconnectDependentLoops(list, vars) {
  for (const n of list || []) {
    if (!Array.isArray(n.children)) continue;
    if (n.kind === 'map') {
      const h = parseLoopHead(n.head);
      if (h && vars.some((v) => readsVar(h.data, v))) {
        n.head = `[].map((${h.item}${h.index ? `, ${h.index}` : ''}) => (`;
      }
      // A nested loop that reuses the name shadows it, so anything deeper
      // refers to the inner one and is still valid.
      const shadowed = new Set([h?.item, h?.index].filter(Boolean));
      const rest = vars.filter((v) => !shadowed.has(v));
      if (rest.length) disconnectDependentLoops(n.children, rest);
    } else {
      disconnectDependentLoops(n.children, vars);
    }
  }
}

// The loop variables in scope at a node: every enclosing map's item/index.
function loopVarsAt(nodes, id) {
  const vars = [];
  const walk = (list, scope) => {
    for (const n of list) {
      if (n.id === id) {
        vars.push(...scope);
        return true;
      }
      if (Array.isArray(n.children)) {
        const next =
          n.kind === 'map'
            ? [...scope, ...[parseLoopHead(n.head)?.item, parseLoopHead(n.head)?.index].filter(Boolean)]
            : scope;
        if (walk(n.children, next)) return true;
      }
    }
    return false;
  };
  walk(nodes, []);
  return [...new Set(vars)];
}

// What a dropped binding is replaced with, so the element keeps rendering
// something you can select and retype.
const UNBOUND_TEXT = 'content';

// Moving or pasting a node out of its loop leaves its bindings pointing at a
// variable that no longer exists — `{service.text}` becomes a hard
// ReferenceError that blanks the whole page. Replace exactly those bindings:
// `{…}` children and interpolations become placeholder text, expression props
// are dropped (a stale `href="content"` would just be a broken link), and
// nested loops that read from the departed item are pointed at an empty
// array.
function stripLostBindings(node, vars) {
  if (!vars.length) return 0;
  let removed = 0;
  const walk = (n) => {
    for (const [k, v] of Object.entries(n.props || {})) {
      if (v?.type === 'expr' && vars.some((x) => readsVar(v.value, x))) {
        delete n.props[k];
        removed++;
      }
    }
    // A dropped binding leaves placeholder text rather than a hole, so the
    // element stays visible and editable on the canvas.
    if (n.kind === 'expr' && vars.some((x) => readsVar(n.value, x))) {
      removed++;
      n.kind = 'text';
      n.value = UNBOUND_TEXT;
      delete n.head;
      delete n.children;
      return;
    }
    if (n.kind === 'text' && n.value.includes('{')) {
      const next = n.value.replace(/\{([^{}]*)\}/g, (whole, inner) =>
        vars.some((x) => readsVar(inner, x)) ? UNBOUND_TEXT : whole
      );
      if (next !== n.value) {
        removed++;
        n.value = next;
      }
    }
    if (n.kind === 'map') {
      const h = parseLoopHead(n.head);
      if (h && vars.some((x) => readsVar(h.data, x))) {
        n.head = `[].map((${h.item}${h.index ? `, ${h.index}` : ''}) => (`;
        removed++;
      }
    }
    if (Array.isArray(n.children)) {
      n.children.forEach(walk);
      n.children = n.children.filter((c) => !c.__drop);
    }
  };
  walk(node);
  return removed;
}

// Left panel width, dragged by the handle on its right edge and remembered
// per tab: a terminal wants more room than a page list.
const PANEL_MIN = 200;
const PANEL_MAX = 900;
const PANEL_WIDTH = { terminal: 460 };
const panelWidthOf = (tab) =>
  Number(localStorage.getItem(`avb.panelWidth.${tab}`)) || PANEL_WIDTH[tab] || 260;

export default function App() {
  const [project, setProject] = useState(null); // {path, name}
  const [scan, setScan] = useState({ pages: [], layouts: [], components: [] });
  const [projectClasses, setProjectClasses] = useState([]);
  const [currentPage, setCurrentPage] = useState(null); // active file {path, name, route?, kind}
  // Drill-down trail: [page, component, nested component, …]. The last entry
  // is what's on screen; anything before it is what Back/Escape returns to.
  const [editStack, setEditStack] = useState([]);
  const [pageState, setPageState] = useState(null); // {editable, model, source, reason}
  const [selectedId, setSelectedId] = useState(null);
  const [hoverNodeId, setHoverNodeId] = useState(null); // navigator row hover
  const [devUrl, setDevUrl] = useState(null);
  const [devStatus, setDevStatus] = useState('off'); // off | starting | on
  const [devLog, setDevLog] = useState('');
  const [devDiag, setDevDiag] = useState(null); // {kind, nodePath, nodeVersion, …}
  const [busy, setBusy] = useState(null); // string message
  const [toast, setToast] = useState(null); // {msg, kind}
  const [refreshKey, setRefreshKey] = useState(0);
  const [leftTab, setLeftTab] = useState('navigator'); // pages | navigator | components | assets | cms | terminal | null
  const [panelWidth, setPanelWidth] = useState(() => panelWidthOf('navigator'));

  // Drag the panel's right edge. The pointer crosses the preview iframe, a
  // separate document that would otherwise swallow every move: capturing it
  // on the handle keeps the events coming to this window.
  const startPanelResize = (e) => {
    e.preventDefault();
    const handle = e.currentTarget;
    const startX = e.clientX;
    const startW = panelWidth;
    const widthAt = (x) => Math.min(PANEL_MAX, Math.max(PANEL_MIN, startW + x - startX));
    handle.setPointerCapture(e.pointerId);
    document.body.style.cursor = 'col-resize';
    const onMove = (ev) => setPanelWidth(widthAt(ev.clientX));
    const onUp = (ev) => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.releasePointerCapture?.(ev.pointerId);
      document.body.style.cursor = '';
      if (leftTab) localStorage.setItem(`avb.panelWidth.${leftTab}`, String(widthAt(ev.clientX)));
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  };
  const [cmsRel, setCmsRel] = useState(null); // JSON file open in the CMS editor
  const [cmsTick, setCmsTick] = useState(0); // bumped on save, refreshes counts
  const [cmsSettings, setCmsSettings] = useState(false); // editing that collection's fields
  const [inPreview, setInPreview] = useState(false); // interactive full-site preview
  const [previewSrc, setPreviewSrc] = useState(null);
  const [codeWin, setCodeWin] = useState(null); // {targetId|kind:'file', title, language}
  const openCodeWindowRef = useRef(null); // latest openCodeWindow, for the Enter shortcut
  const [fileText, setFileText] = useState(''); // loaded text for kind:'file'
  // Breakpoint lives here, not in PreviewPane: a re-mount of that pane must
  // not silently drop the user out of the view they picked (which would
  // reload every preview iframe and flash the canvas white).
  const [device, setDevice] = useState('desktop');
  // Bumped every time the page itself makes the selection, so the navigator
  // scrolls the row into view — a counter, not the id, so clicking the same
  // element twice still reveals it.
  const [revealTick, setRevealTick] = useState(0);
  const [rightTab, setRightTab] = useState('style'); // style | settings
  // Sliding highlight behind the active Style/Settings tab, measured from the
  // buttons so it tracks their real geometry (and any panel resize).
  const rightTabRefs = useRef({});
  const [rightTabInd, setRightTabInd] = useState(null);
  // The asset request a field is waiting on, and the tab to go back to once
  // it's answered — "Choose Image…" borrows the left panel rather than
  // opening a window over the canvas.
  const [assetPick, setAssetPick] = useState(null);
  const tabBeforePick = useRef(null);

  // A layout is just a component that lives in src/layouts — it can be
  // placed on a page like any other. Every lookup that answers "what do we
  // know about the component named X" has to search both lists, or a placed
  // layout would come back with no props, no slots and no rest support.
  // Components win a name collision: they're the more likely intent.
  const insertables = useMemo(
    () => [...scan.components, ...scan.layouts],
    [scan.components, scan.layouts]
  );

  const saveTimer = useRef(null);
  const devLogRef = useRef('');
  const pageStateRef = useRef(null);
  pageStateRef.current = { currentPage, pageState };
  const selectedIdRef = useRef(null);
  selectedIdRef.current = selectedId;
  const editStackRef = useRef([]);
  editStackRef.current = editStack;
  const inPreviewRef = useRef(false);
  inPreviewRef.current = inPreview;
  const previewPathRef = useRef(null);
  const previewIframeRef = useRef(null);

  // ----------------------------------------------------------------
  // Toasts & events
  // ----------------------------------------------------------------

  // Why the dev server isn't running (missing Node, a Node too old for the
  // project's Astro, uninstalled deps). Only asked for once it has failed —
  // the answer is what the offline pane explains instead of a raw log.
  // projectRef is declared further down, but this only reads it when called.
  const diagnose = useCallback(() => {
    const p = projectRef.current?.path;
    if (!p) return;
    window.avb
      .diagnoseDev(p)
      .then((d) => setDevDiag(d))
      .catch(() => setDevDiag(null));
  }, []);

  const endAssetPick = useCallback(() => {
    clearAssetRequest();
    setAssetPick(null);
    // Back to whatever was open before, so answering a field doesn't leave
    // the user parked in the asset browser.
    setLeftTab((t) => (t === 'assets' && tabBeforePick.current ? tabBeforePick.current : t));
    tabBeforePick.current = null;
  }, []);

  useEffect(() => {
    return onAssetRequest((req) => {
      if (!req) return; // cleared from this side already
      setAssetPick({
        ...req,
        onPick: (rel) => {
          req.onPick(rel);
          endAssetPick();
        },
      });
      setLeftTab((t) => {
        if (t !== 'assets') tabBeforePick.current = t;
        return 'assets';
      });
    });
  }, [endAssetPick]);

  const showToast = useCallback((msg, kind = 'info') => {
    setToast({ msg, kind });
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => setToast(null), 5000);
  }, []);

  useEffect(() => {
    const offProgress = window.avb.onProgress(({ message }) => setBusy(message || null));
    const offExit = window.avb.onDevExit(({ log }) => {
      setDevStatus('off');
      setDevUrl(null);
      if (log) {
        devLogRef.current = log;
        setDevLog(log);
      }
      diagnose();
    });
    const offLog = window.avb.onDevLog((chunk) => {
      devLogRef.current = stripAnsi(devLogRef.current + chunk).slice(-4000);
      setDevLog(devLogRef.current);
    });
    return () => {
      offProgress();
      offExit();
      offLog();
    };
  }, []);

  // ----------------------------------------------------------------
  // Project lifecycle
  // ----------------------------------------------------------------

  const rescan = useCallback(async (projectPath) => {
    const result = await window.avb.scanProject(projectPath);
    setScan(result);
    window.avb
      .listProjectClasses(projectPath)
      .then((c) => setProjectClasses(c || []))
      .catch(() => {});
    return result;
  }, []);

  const startPreview = useCallback(
    async (projectPath) => {
      setDevStatus('starting');
      try {
        const { url, external } = await window.avb.startDevServer(projectPath);
        setDevUrl(url);
        setDevStatus('on');
        setDevDiag(null);
        if (external) {
          showToast(
            `Reusing the dev server already running for this project (${url}) — canvas outlines need the app's own server, so stop that one to enable them.`,
            'info'
          );
        }
      } catch (err) {
        setDevStatus('off');
        setBusy(null);
        showToast(`Preview failed to start — see the log in the preview area.`, 'error');
        const msg = cleanError(err);
        devLogRef.current = msg;
        setDevLog(msg);
        diagnose();
      }
    },
    [showToast, diagnose]
  );

  const loadProject = useCallback(
    async (projectPath) => {
      const name = projectPath.split(/[\\/]/).filter(Boolean).pop();
      setProject({ path: projectPath, name });
      setLeftTab('navigator');
      // Every project opens on desktop — a breakpoint left over from the
      // last project isn't a choice the user made about this one.
      setDevice('desktop');
      window.avb.addRecent(projectPath);
      const result = await rescan(projectPath);

      const hasDeps = await window.avb.hasNodeModules(projectPath);
      if (!hasDeps) {
        try {
          await window.avb.installDeps(projectPath);
        } catch (err) {
          showToast(cleanError(err), 'error');
        }
        setBusy(null);
      }
      startPreview(projectPath);
      window.avb.watchProject(projectPath);

      const first =
        result.pages.find((p) => p.name === 'index.astro') || result.pages[0] || null;
      if (first) selectPage(first);
    },
    [rescan, startPreview] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ----------------------------------------------------------------
  // Page loading & saving
  // ----------------------------------------------------------------

  const flushSave = useCallback(async () => {
    clearTimeout(saveTimer.current);
    const { currentPage: page, pageState: state } = pageStateRef.current;
    if (!page || !state || !state.dirty) return;
    if (state.editable) {
      await window.avb.writePage({ pagePath: page.path, model: state.model });
    } else {
      await window.avb.writePageRaw({ pagePath: page.path, source: state.source });
    }
    setPageState((s) => (s ? { ...s, dirty: false } : s));
  }, []);

  // Opens any .astro file for editing — a page, or a component drilled into.
  // `currentPage` is simply whatever is being edited, so saving, undo, the
  // navigator, and the props panel all follow without special cases.
  const openFile = useCallback(
    async (entry) => {
      await flushSave();
      setCurrentPage(entry);
      setSelectedId(null);
      const result = await window.avb.readPage(entry.path);
      setPageState({ ...result, dirty: false });
      historyRef.current = { past: [], future: [], lastPush: 0, lastKey: null };
    },
    [flushSave]
  );

  const selectPage = useCallback(
    async (page) => {
      // Opening a page from the switcher leaves any component drill-down.
      setEditStack([{ ...page, kind: 'page' }]);
      await openFile({ ...page, kind: 'page' });
    },
    [openFile]
  );

  // Re-reads whatever is open straight from disk. A git checkout rewrites the
  // working tree wholesale, and the file watcher can't be relied on for it:
  // events for files the app itself wrote moments earlier are suppressed (so
  // its own save isn't echoed back), which is exactly the case when you edit,
  // switch branch, and expect to see the other branch's content.
  const reloadFromDisk = useCallback(async () => {
    const proj = projectRef.current;
    const open = pageStateRef.current.currentPage;
    if (!proj) return;
    const result = await rescan(proj.path);
    if (!open) return;
    // The open file may not exist on the branch just switched to.
    const stillThere =
      result.pages.some((p) => p.path === open.path) ||
      result.components.some((c) => c.path === open.path) ||
      result.layouts.some((l) => l.path === open.path);
    if (stillThere) {
      const fresh = await window.avb.readPage(open.path);
      setPageState({ ...fresh, dirty: false });
      setSelectedId(null);
      historyRef.current = { past: [], future: [], lastPush: 0, lastKey: null };
    } else {
      const next = result.pages[0] || null;
      setEditStack(next ? [{ ...next, kind: 'page' }] : []);
      if (next) await openFile({ ...next, kind: 'page' });
      else {
        setCurrentPage(null);
        setPageState(null);
        setSelectedId(null);
      }
    }
    setRefreshKey((k) => k + 1); // the preview is showing the old branch too
  }, [rescan, openFile]);

  // Drill into a component: its own file becomes the edited document, and the
  // stack remembers what to come back to (pages and components alike, so
  // nesting works to any depth).
  const openComponent = useCallback(
    async (name, hostPath) => {
      const comp =
        scan.components.find((c) => c.name === name) ||
        scan.layouts.find((l) => l.name === name);
      if (!comp) {
        showToast(`Can't find a file for <${name}>.`, 'error');
        return;
      }
      const stack = editStackRef.current;
      // The canvas keeps showing the page, so remember which instance was
      // opened — that region stays lit while the rest dims. Drilling deeper
      // keeps the outermost instance as the focus: a nested component's
      // internals aren't addressable in the page's own markers.
      const focusPath = stack[stack.length - 1]?.focusPath ?? hostPath ?? null;
      const entry = { kind: 'component', name: comp.name, path: comp.path, focusPath };
      setEditStack((s) =>
        s.some((e) => e.path === comp.path) ? s : [...s, entry]
      );
      await openFile(entry);
    },
    [scan.components, scan.layouts, openFile, showToast]
  );

  // Back out one level: to the parent component if nested, else to the page.
  const closeComponent = useCallback(async () => {
    const stack = editStackRef.current;
    if (stack.length < 2) return;
    const next = stack.slice(0, -1);
    setEditStack(next);
    await openFile(next[next.length - 1]);
  }, [openFile]);

  // ----------------------------------------------------------------
  // Undo / redo — per-page history of model (or source) snapshots.
  // ----------------------------------------------------------------

  const historyRef = useRef({ past: [], future: [], lastPush: 0, lastKey: null });

  const snapshotOf = (state) =>
    state.editable
      ? { kind: 'model', model: structuredClone(state.model) }
      : { kind: 'source', source: state.source };

  // Records the state *before* a mutation. Consecutive edits with the same
  // coalesceKey within 800 ms collapse into one undo step (typing bursts,
  // dropdown hover-scrubs); structural edits (no key) always get their own.
  const pushHistory = useCallback((coalesceKey = null) => {
    const state = pageStateRef.current.pageState;
    if (!state) return;
    const h = historyRef.current;
    const now = Date.now();
    const coalesce =
      coalesceKey !== null && coalesceKey === h.lastKey && now - h.lastPush < 800 && h.past.length > 0;
    if (!coalesce) {
      h.past.push(snapshotOf(state));
      if (h.past.length > 100) h.past.shift();
    }
    h.future = [];
    h.lastKey = coalesceKey;
    h.lastPush = now;
  }, []);

  const applySnapshot = useCallback((entry) => {
    setPageState((s) => {
      if (!s) return s;
      if (entry.kind === 'model') {
        return { ...s, editable: true, model: structuredClone(entry.model), dirty: true };
      }
      return { ...s, source: entry.source, dirty: true };
    });
    // Clear selection if the restored model no longer has the selected node.
    if (entry.kind === 'model') {
      setSelectedId((id) =>
        id && id !== 'layout' && !findNodeById(entry.model.nodes || [], id) ? null : id
      );
    }
    scheduleSaveRef.current?.(true);
  }, []);

  const scheduleSaveRef = useRef(null);

  const undo = useCallback(() => {
    const h = historyRef.current;
    const state = pageStateRef.current.pageState;
    if (!h.past.length || !state) return;
    const entry = h.past.pop();
    h.future.push(snapshotOf(state));
    h.lastKey = null;
    h.lastPush = 0;
    applySnapshot(entry);
  }, [applySnapshot]);

  const redo = useCallback(() => {
    const h = historyRef.current;
    const state = pageStateRef.current.pageState;
    if (!h.future.length || !state) return;
    const entry = h.future.pop();
    h.past.push(snapshotOf(state));
    h.lastKey = null;
    h.lastPush = 0;
    applySnapshot(entry);
  }, [applySnapshot]);

  // Discrete edits (dropdown, checkbox, drag, delete) save immediately;
  // typing batches keystrokes for 300 ms so the preview doesn't rebuild
  // per character. The timeout-0 for immediate saves lets React commit the
  // state update first so flushSave sees the new model.
  const scheduleSave = useCallback(
    (immediate = false) => {
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(
        () => {
          flushSave().catch((err) => showToast(`Save failed: ${cleanError(err)}`, 'error'));
        },
        immediate ? 0 : 300
      );
    },
    [flushSave, showToast]
  );
  scheduleSaveRef.current = scheduleSave;

  const mutateModel = useCallback(
    (fn, immediate = false, coalesceKey = null) => {
      pushHistory(coalesceKey);
      setPageState((s) => {
        if (!s || !s.editable) return s;
        const model = fn(structuredClone(s.model));
        return { ...s, model, dirty: true };
      });
      scheduleSave(immediate);
    },
    [scheduleSave, pushHistory]
  );

  const setRawSource = useCallback(
    (source) => {
      pushHistory('raw-source');
      setPageState((s) => (s ? { ...s, source, dirty: true } : s));
      scheduleSave();
    },
    [scheduleSave, pushHistory]
  );

  // ----------------------------------------------------------------
  // External file changes → refresh panels
  // ----------------------------------------------------------------

  useEffect(() => {
    const off = window.avb.onFsChanged(async ({ files }) => {
      const proj = projectRef.current;
      if (!proj) return;

      // Refresh pages list, palette, and prop schemas.
      const scanResult = await rescan(proj.path);

      const { currentPage: page, pageState: state } = pageStateRef.current;
      if (!page) return;
      // Chunk .html files feed the open page's Fragment subtrees — treat a
      // change to any of them like a change to the page itself.
      const affectsPage =
        files.includes(page.path) || files.some((f) => f.toLowerCase().endsWith('.html'));
      if (!affectsPage) return;

      // Current page deleted externally.
      if (!scanResult.pages.some((p) => p.path === page.path)) {
        setCurrentPage(null);
        setPageState(null);
        setSelectedId(null);
        return;
      }

      // Hot-reload the current page's model unless the user has unsaved
      // edits in flight (their pending save would win anyway).
      if (state?.dirty) return;

      let result;
      try {
        result = await window.avb.readPage(page.path);
      } catch {
        return;
      }

      // Re-select the node at the same tree position (ids regenerate).
      const selId = selectedIdRef.current;
      let nextSelected = selId;
      if (selId && selId !== 'layout' && selId !== 'frontmatter') {
        if (state?.editable && result.editable) {
          const trail = pathOfNode(state.model.nodes, selId);
          nextSelected = trail ? (nodeAtPath(result.model.nodes, trail)?.id ?? null) : null;
        } else {
          nextSelected = null;
        }
      }
      setPageState({ ...result, dirty: false });
      setSelectedId(nextSelected);
    });
    return off;
  }, [rescan]);

  // ----------------------------------------------------------------
  // Model operations
  // ----------------------------------------------------------------

  const projectRef = useRef(null);
  projectRef.current = project;

  const resolveImportPath = useCallback(async (targetPath) => {
    const page = pageStateRef.current.currentPage;
    return window.avb.importPathFor({
      pagePath: page.path,
      targetPath,
      projectPath: projectRef.current?.path,
    });
  }, []);

  // target: {parentId: string|null, index: number} | null (append at end)
  const addComponent = useCallback(
    async (componentName, target) => {
      const comp = insertables.find((c) => c.name === componentName);
      const page = pageStateRef.current.currentPage;
      if (!comp || !page) return;
      const paths = await resolveImportPath(comp.path);
      const id = newId();
      mutateModel((model) => {
        if (!model.imports.some((i) => i.name === comp.name)) {
          model.imports.push({
            name: comp.name,
            path: chooseImportPath(model, paths),
          });
        }
        const node = { id, kind: 'component', name: comp.name, props: {}, children: null };
        insertIntoModel(model, node, target);
        return model;
      }, true);
      setSelectedId(id);
    },
    [insertables, mutateModel, resolveImportPath]
  );

  const moveNode = useCallback(
    (nodeId, target) => {
      mutateModel((model) => {
        const found = findParentList(model, nodeId);
        if (!found) return model;
        const node = found.list[found.index];

        // Prevent dropping a node into its own subtree.
        if (target?.parentId) {
          if (target.parentId === nodeId) return model;
          if (isDescendantOf(node, target.parentId)) return model;
        }

        // Capture target list before removal to fix up indices.
        const sameList =
          (target?.parentId == null && found.list === model.nodes) ||
          (target?.parentId != null &&
            findNodeById(model.nodes, target.parentId)?.children === found.list);

        const before = loopVarsAt(model.nodes, nodeId);

        found.list.splice(found.index, 1);
        let index = target?.index ?? Number.MAX_SAFE_INTEGER;
        if (sameList && index > found.index) index -= 1;
        insertIntoModel(model, node, target ? { ...target, index } : null);

        // Left a loop? Anything still reading its item would throw.
        const after = loopVarsAt(model.nodes, nodeId);
        const lost = before.filter((v) => !after.includes(v));
        const removed = stripLostBindings(node, lost);
        if (removed) {
          showToast(
            `Removed ${removed} binding${removed === 1 ? '' : 's'} that referenced ${lost.join(', ')}.`,
            'info'
          );
        }
        return model;
      }, true);
    },
    [mutateModel, showToast]
  );

  const removeNode = useCallback(
    (nodeId) => {
      const state = pageStateRef.current.pageState;
      const target = state?.editable ? findNodeById(state.model.nodes, nodeId) : null;
      if (target?.kind === 'chunk-group') {
        showToast('This section comes from the page frontmatter — remove it from the code instead.', 'error');
        return;
      }
      mutateModel((model) => {
        const found = findParentList(model, nodeId);
        if (found) found.list.splice(found.index, 1);
        pruneImports(model);
        return model;
      }, true);
      setSelectedId((id) => (id === nodeId ? null : id));
    },
    [mutateModel, showToast]
  );

  // ----------------------------------------------------------------
  // Clipboard: copy / paste / duplicate nodes
  // ----------------------------------------------------------------

  const nodeClipboardRef = useRef(null);

  const cloneWithNewIds = (node) => {
    const clone = structuredClone(node);
    const walk = (n) => {
      n.id = newId();
      if (Array.isArray(n.children)) n.children.forEach(walk);
    };
    walk(clone);
    return clone;
  };

  const copyNode = useCallback(
    (nodeId) => {
      const state = pageStateRef.current.pageState;
      if (!state?.editable) return;
      const node = findNodeById(state.model.nodes, nodeId);
      if (!node) return;
      nodeClipboardRef.current = {
        node: structuredClone(node),
        // The loop variables this subtree may reference; pasting somewhere
        // they don't exist has to drop those bindings.
        vars: loopVarsAt(state.model.nodes, nodeId),
      };
      showToast(`Copied ${node.name || 'text'}`, 'success');
    },
    [showToast]
  );

  const duplicateNode = useCallback(
    (nodeId) => {
      const state = pageStateRef.current.pageState;
      if (!state?.editable) return;
      const src = findNodeById(state.model.nodes, nodeId);
      if (!src) return;
      if (src.kind === 'chunk-group' || src.chunkFile) {
        showToast('Chunk sections are defined in the page frontmatter and cannot be duplicated here.', 'error');
        return;
      }
      const clone = cloneWithNewIds(src);
      mutateModel((model) => {
        const found = findParentList(model, nodeId);
        if (!found) return model;
        found.list.splice(found.index + 1, 0, clone);
        return model;
      }, true);
      setSelectedId(clone.id);
    },
    [mutateModel]
  );

  // Pastes into the current selection when it can host children (a non-void
  // element, or a component with a default slot), otherwise after it (same
  // parent), or at the end of the page. Imports for components in the pasted
  // subtree are added if the target page is missing them (cross-page paste).
  const pasteNode = useCallback(async () => {
    const clip = nodeClipboardRef.current;
    const state = pageStateRef.current.pageState;
    if (!clip || !state?.editable) return;

    const names = new Set();
    (function walk(n) {
      if (n.kind === 'component' && n.name) names.add(n.name);
      if (Array.isArray(n.children)) n.children.forEach(walk);
    })(clip.node);
    const missing = [...names].filter(
      (nm) => !state.model.imports.some((i) => i.name === nm)
    );
    const resolved = [];
    for (const nm of missing) {
      const target =
        insertables.find((c) => c.name === nm);
      if (target) resolved.push({ name: nm, paths: await resolveImportPath(target.path) });
    }

    const clone = cloneWithNewIds(clip.node);
    const selId = selectedIdRef.current;
    const acceptsChildren = (n) => {
      if (n.id === 'layout') return true;
      if (n.kind === 'element') return !VOID_ELEMENTS.has(String(n.name).toLowerCase());
      if (n.kind === 'component') {
        return (insertables.find((c) => c.name === n.name)?.slots || []).includes('default');
      }
      return false;
    };
    mutateModel((model) => {
      for (const r of resolved) {
        if (!model.imports.some((i) => i.name === r.name)) {
          model.imports.push({ name: r.name, path: chooseImportPath(model, r.paths) });
        }
      }
      if (selId) {
        const sel = findNodeById(model.nodes, selId);
        if (sel && acceptsChildren(sel)) {
          if (!Array.isArray(sel.children)) sel.children = [];
          sel.children.push(clone);
          return model;
        }
        const found = findParentList(model, selId);
        if (found) {
          found.list.splice(found.index + 1, 0, clone);
          return model;
        }
      }
      model.nodes.push(clone);
      return model;
    }, true);

    // Pasted outside the loop it was copied from? Its bindings would throw.
    mutateModel((model) => {
      const landed = findNodeById(model.nodes, clone.id);
      if (!landed) return model;
      const inScope = loopVarsAt(model.nodes, clone.id);
      const lost = (clip.vars || []).filter((v) => !inScope.includes(v));
      const removed = stripLostBindings(landed, lost);
      if (removed) {
        showToast(
          `Removed ${removed} binding${removed === 1 ? '' : 's'} that referenced ${lost.join(', ')}.`,
          'info'
        );
      }
      return model;
    }, true);
    setSelectedId(clone.id);
  }, [mutateModel, scan, resolveImportPath]);

  // ----------------------------------------------------------------
  // Insert palette (⌘F / ⌘E) — quick-add components, tags, loops, …
  // ----------------------------------------------------------------

  const [insertOpen, setInsertOpen] = useState(false);

  // Open requests from the app menu (⌘E accelerator) and from canvas
  // iframes (which forward ⌘F/⌘E when they hold keyboard focus).
  useEffect(() => {
    const openIfEditable = () => {
      if (pageStateRef.current.pageState?.editable && !inPreviewRef.current) {
        setInsertOpen(true);
      }
    };
    const offMenu = window.avb.onMenu('insert', openIfEditable);
    const onMsg = (e) => {
      if (e.data?.type !== 'avb:shortcut') return;
      if (e.data.name === 'insert') openIfEditable();
      // Arrow keys pressed while the canvas iframe holds focus: replay them
      // on the app window so tree navigation behaves the same whether the
      // selection was made on the canvas or in the navigator.
      else if (e.data.name === 'arrow' && e.data.key) {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: e.data.key, bubbles: true, cancelable: true })
        );
      }
      // Delete / ⌘D from the canvas. Replayed on the document rather than
      // handled here so they go through the same guards as a keypress in the
      // app — one definition of what those keys do, and the handler's own
      // "am I typing in a field" check still sees a non-field target.
      else if (e.data.name === 'key' && e.data.key) {
        document.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: e.data.key,
            metaKey: !!e.data.meta,
            ctrlKey: !!e.data.meta,
            bubbles: true,
            cancelable: true,
          })
        );
      }
    };
    window.addEventListener('message', onMsg);
    return () => {
      offMenu();
      window.removeEventListener('message', onMsg);
    };
  }, []);

  // Where a new node goes: inside the selection when it accepts children,
  // otherwise right after it; with no selection, at the end of the page.
  const insertTargetFor = useCallback(
    (model, selId, item) => {
      // The tag being inserted, when it's a plain element — components and
      // other node kinds have no fixed content model to check against.
      const childTag = item && item.type === 'element' ? item.tag : null;
      const acceptsChildren = (n) => {
        if (n.id === 'layout') return true;
        if (n.kind === 'element') {
          const tag = String(n.name).toLowerCase();
          if (VOID_ELEMENTS.has(tag)) return false;
          // A <p> inside an <h1> is invalid HTML the browser would reparent —
          // insert alongside instead of inside.
          return childTag ? canContainTag(tag, childTag) : true;
        }
        if (n.kind === 'map' || n.kind === 'chunk-group') return true;
        if (n.kind === 'component') {
          return (insertables.find((c) => c.name === n.name)?.slots || []).includes('default');
        }
        return false;
      };
      const findParentOf = (nodes, id, parentId = null) => {
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          if (n.id === id) return { parentId, index: i };
          if (Array.isArray(n.children)) {
            const r = findParentOf(n.children, id, n.id);
            if (r) return r;
          }
        }
        return null;
      };
      if (selId && selId !== 'frontmatter') {
        const sel = findNodeById(model.nodes, selId);
        if (sel && acceptsChildren(sel)) {
          return { parentId: sel.id, index: Array.isArray(sel.children) ? sel.children.length : 0 };
        }
        // Otherwise drop in as a sibling — climbing out of any ancestor that
        // can't legally hold it either (a <div> next to a <span> inside a <p>
        // still isn't valid, so it lands after the <p>).
        let childId = selId;
        for (let depth = 0; depth < 50; depth++) {
          const fp = findParentOf(model.nodes, childId);
          if (!fp) break;
          if (fp.parentId === null) return { parentId: null, index: fp.index + 1 };
          const parent = findNodeById(model.nodes, fp.parentId);
          if (!parent || acceptsChildren(parent)) {
            return { parentId: fp.parentId, index: fp.index + 1 };
          }
          childId = fp.parentId;
        }
      }
      return { parentId: null, index: model.nodes.length };
    },
    [insertables]
  );

  const insertItem = useCallback(
    (item) => {
      setInsertOpen(false);
      const state = pageStateRef.current.pageState;
      if (!state?.editable) return;
      const target = insertTargetFor(state.model, selectedIdRef.current, item);

      if (item.type === 'component') {
        addComponent(item.name, target);
        return;
      }

      const id = newId();
      let node = null;
      if (item.type === 'element') {
        const placeholder = DEFAULT_TEXT[item.tag];
        node = {
          id,
          kind: 'element',
          name: item.tag,
          props: {},
          children: VOID_ELEMENTS.has(item.tag)
            ? null
            : placeholder
              ? [{ id: newId(), kind: 'text', value: placeholder }]
              : [],
        };
      } else if (item.type === 'map') {
        // No source until one is picked in the props panel. An empty literal
        // renders nothing; a placeholder name would throw "x is not defined"
        // and take the preview down the moment the loop lands on the page.
        node = { id, kind: 'map', head: '[].map((item) => (', children: [] };
      } else if (item.type === 'comment') {
        node = { id, kind: 'comment', value: ' Comment ' };
      } else if (item.type === 'text') {
        node = { id, kind: 'text', value: 'Text' };
      } else if (item.type === 'expr') {
        node = { id, kind: 'expr', value: '{/* code */}' };
      } else if (item.type === 'style' || item.type === 'script') {
        node = { id, kind: 'raw', name: item.type, props: {}, inner: '' };
      }
      if (!node) return;
      mutateModel((model) => {
        insertIntoModel(model, node, target);
        return model;
      }, true);
      setSelectedId(id);
    },
    [insertTargetFor, addComponent, mutateModel]
  );

  // True while the CMS covers the canvas: the page-editing shortcuts below
  // would act on a selection the user can't see.
  const cmsOpenRef = useRef(false);
  cmsOpenRef.current = leftTab === 'cms' && !!cmsRel;

  // Keyboard: ⌘Z undoes, ⇧⌘Z / ⌘Y redoes (app-wide, even inside fields —
  // field edits live in the same history); Delete/Backspace removes, ⌘C
  // copies, ⌘D duplicates, ⌘V pastes — unless the user is typing in a field.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (cmsOpenRef.current) return;
      const mod = e.metaKey || e.ctrlKey;

      // Undo/redo take priority over native field undo so history stays
      // consistent no matter where focus is.
      if (mod && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
        if (!pageStateRef.current.pageState) return;
        e.preventDefault();
        if (e.key.toLowerCase() === 'y' || e.shiftKey) redo();
        else undo();
        return;
      }

      // ⌘F / ⌘E open the insert palette (works from anywhere except the
      // code editor, which keeps its own find).
      if (mod && (e.key.toLowerCase() === 'f' || e.key.toLowerCase() === 'e')) {
        if (!pageStateRef.current.pageState?.editable) return;
        const el = e.target;
        if (el instanceof HTMLElement && el.closest('.cm-editor')) return;
        e.preventDefault();
        setInsertOpen(true);
        return;
      }

      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.closest('input, textarea, select, [contenteditable="true"]') || t.isContentEditable)
      ) {
        return;
      }
      const state = pageStateRef.current.pageState;
      if (!state?.editable) return;
      const selId = selectedIdRef.current;
      const hasNodeSel = !!selId && selId !== 'frontmatter';

      // Enter opens the floating editor for a selection that has one
      // (frontmatter, <style>, <script>) — same as its "Edit code" button.
      // Not gated on hasNodeSel: frontmatter is exactly one of these.
      if (!mod && !e.altKey && !e.shiftKey && e.key === 'Enter') {
        // On a focused control Enter means "activate this", not "open the
        // selection" — leave those alone (including the Edit code button
        // itself, which would otherwise fire twice).
        if (t instanceof HTMLElement && t.closest('button, a, [role="button"]')) return;
        if (openCodeWindowRef.current?.()) e.preventDefault();
        return;
      }

      // S / D swap the right panel — plain keys, so they only fire outside
      // fields (the check above) and never collide with ⌘D (duplicate).
      if (!mod && !e.altKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        setRightTab('style');
        return;
      }
      if (!mod && !e.altKey && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        setRightTab('settings');
        return;
      }

      if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) {
        if (!hasNodeSel) return;
        e.preventDefault();
        removeNode(selId);
      } else if (mod && e.key.toLowerCase() === 'c') {
        // Let native copy win when actual text is selected.
        if (!hasNodeSel || String(window.getSelection() || '')) return;
        e.preventDefault();
        copyNode(selId);
      } else if (mod && e.key.toLowerCase() === 'd') {
        if (!hasNodeSel) return;
        e.preventDefault();
        duplicateNode(selId);
      } else if (mod && e.key.toLowerCase() === 'v') {
        if (!nodeClipboardRef.current) return;
        e.preventDefault();
        pasteNode();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [removeNode, copyNode, duplicateNode, pasteNode, undo, redo]);

  // Application-menu shortcuts: on macOS the native menu consumes ⌘Z/⌘C/⌘V
  // before the DOM sees them, so those arrive here via IPC instead. Copy and
  // paste route to the focused text field when one is active, otherwise to
  // the selected node.
  useEffect(() => {
    const inEditable = () => {
      const el = document.activeElement;
      return (
        el &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      );
    };
    const offs = [
      window.avb.onMenu('undo', () => {
        if (pageStateRef.current.pageState && !cmsOpenRef.current) undo();
      }),
      window.avb.onMenu('redo', () => {
        if (pageStateRef.current.pageState && !cmsOpenRef.current) redo();
      }),
      window.avb.onMenu('copy', () => {
        // The terminal first: its selection lives on a canvas, invisible to
        // both getSelection() and the native copy below.
        const term = terminalClipboard();
        if (term) {
          term.copy();
          return;
        }
        if (inEditable() || String(window.getSelection() || '')) {
          window.avb.nativeCopy();
          return;
        }
        const selId = selectedIdRef.current;
        if (selId && pageStateRef.current.pageState?.editable && !cmsOpenRef.current) {
          copyNode(selId);
        }
      }),
      window.avb.onMenu('paste', () => {
        const term = terminalClipboard();
        if (term) {
          term.paste();
          return;
        }
        if (inEditable()) {
          window.avb.nativePaste();
          return;
        }
        if (nodeClipboardRef.current && pageStateRef.current.pageState?.editable && !cmsOpenRef.current) {
          pasteNode();
        }
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [undo, redo, copyNode, pasteNode]);

  // ----------------------------------------------------------------
  // Interactive preview mode — browse the site inside the app; on exit,
  // the editor follows whichever page was navigated to.
  // ----------------------------------------------------------------

  const enterPreview = useCallback(() => {
    if (!devUrl) return;
    const route = pageStateRef.current.currentPage?.route || '/';
    previewPathRef.current = route;
    setPreviewSrc(devUrl + route);
    setInPreview(true);
  }, [devUrl]);

  const exitPreview = useCallback(() => {
    setInPreview(false);
    const raw = previewPathRef.current;
    if (!raw) return;
    let p = raw.split('?')[0].split('#')[0];
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    const page = scan.pages.find((pg) => pg.route === (p || '/'));
    if (page && page.path !== pageStateRef.current.currentPage?.path) {
      selectPage(page);
    }
  }, [scan.pages, selectPage]);

  // Track navigation inside the preview iframe (the preload posts
  // avb:navigated from every loaded frame).
  useEffect(() => {
    const onMsg = (e) => {
      if (e.data?.type !== 'avb:navigated' || !inPreviewRef.current) return;
      const ifr = previewIframeRef.current;
      if (ifr && e.source === ifr.contentWindow) {
        previewPathRef.current = e.data.path;
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  // Escape exits preview mode.
  useEffect(() => {
    if (!inPreview) return;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        exitPreview();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [inPreview, exitPreview]);

  // Escape backs out of a drilled-into component, one level at a time.
  useEffect(() => {
    if (inPreview || editStack.length < 2) return;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      const t = e.target;
      // Let fields, menus, and dialogs consume their own Escape first.
      if (
        t instanceof HTMLElement &&
        (t.closest('input, textarea, select, [contenteditable="true"]') ||
          t.closest('.modal-overlay, .dd-popup, .insert-overlay, .code-window'))
      ) {
        return;
      }
      e.preventDefault();
      closeComponent();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [inPreview, editStack.length, closeComponent]);

  // Capture a preview thumbnail for the welcome screen's recents list a few
  // seconds after the preview settles (page switch, refresh, or edit).
  useEffect(() => {
    if (!project || devStatus !== 'on' || !currentPage) return;
    const t = setTimeout(() => {
      const iframe = document.querySelector('.frame-clip iframe');
      if (!iframe) return;
      const r = iframe.getBoundingClientRect();
      if (r.width < 100 || r.height < 100) return;
      // capturePage photographs the WINDOW at these coordinates, not the frame
      // itself — and several things sit over the canvas without unmounting it
      // (the CMS view, preview mode, the code window, the insert palette, a
      // modal). Capturing then files a picture of that panel as the project's
      // thumbnail. Rather than enumerate them, ask the document what is
      // actually on top at a few points across the frame: unless every one of
      // them lands inside the canvas, something is covering it — skip this
      // round and keep the thumbnail we already have.
      const covered = [0.25, 0.5, 0.75].some((f) => {
        const el = document.elementFromPoint(r.x + r.width * f, r.y + r.height * 0.25);
        return !el || !el.closest('.frame-clip');
      });
      if (covered) return;
      // Only the top of tall frames — thumbnails show above-the-fold content.
      window.avb.captureThumb({
        projectPath: project.path,
        rect: { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, r.width * 0.75) },
      });
    }, 4000);
    return () => clearTimeout(t);
  }, [project, devStatus, currentPage, refreshKey, pageState, leftTab, inPreview, codeWin]);

  const setProp = useCallback(
    (nodeId, propName, value, immediate = false) => {
      mutateModel(
        (model) => {
          const node = findNodeById(model.nodes, nodeId);
          if (!node) return model;
          if (!node.props) node.props = {};
          if (value === undefined) delete node.props[propName];
          else node.props[propName] = value;
          return model;
        },
        immediate,
        `prop:${nodeId}:${propName}`
      );
    },
    [mutateModel]
  );

  // Renames an attribute in place, preserving its value and position.
  const renameProp = useCallback(
    (nodeId, oldName, newName) => {
      mutateModel((model) => {
        const node = findNodeById(model.nodes, nodeId);
        if (!node?.props || !(oldName in node.props)) return model;
        if (!newName || newName === oldName) return model;
        const next = {};
        for (const [k, v] of Object.entries(node.props)) {
          if (k === oldName) next[newName] = v;
          else if (k !== newName) next[k] = v;
        }
        node.props = next;
        return model;
      }, true);
    },
    [mutateModel]
  );

  // Switches a plain element's tag. Attributes that belonged to the old
  // tag's built-in schema but aren't valid for the new one are dropped
  // (loading="eager" on img → div); global, data-* and aria-* attributes
  // and anything custom stay.
  const changeElementTag = useCallback(
    (nodeId, newTag) => {
      const tag = String(newTag || '').trim().toLowerCase();
      if (!/^[a-z][a-z0-9-]*$/.test(tag)) return;
      mutateModel((model) => {
        const node = findNodeById(model.nodes, nodeId);
        if (!node || node.kind !== 'element' || node.name === tag) return model;
        const oldNames = new Set(getElementSchema(node.name).map((f) => f.name));
        const newNames = new Set(getElementSchema(tag).map((f) => f.name));
        for (const attr of Object.keys(node.props || {})) {
          if (
            oldNames.has(attr) &&
            !newNames.has(attr) &&
            !GLOBAL_ATTRS.has(attr) &&
            !/^(data-|aria-)/.test(attr)
          ) {
            delete node.props[attr];
          }
        }
        node.name = tag;
        // Void elements can't have children; paired tags serialize as a pair.
        if (VOID_ELEMENTS.has(tag)) node.children = null;
        else if (node.children === null) node.children = [];
        return model;
      }, true);
    },
    [mutateModel]
  );

  // `renames` (loop editor only) carries the variable names this edit is
  // changing, so references below the node follow along. A rename touches
  // many nodes at once, so it saves immediately and gets its own history
  // entry instead of coalescing with the keystrokes around it.
  // `immediate` skips the typing coalesce for an edit that arrives already committed
  // (the style panel writing a <style> block): waiting 300 ms there just delays the
  // canvas, since the next keystroke it was batching with never comes.
  const setNodeText = useCallback(
    (nodeId, value, renames, immediate = false) => {
      const renaming = (renames || []).some((r) => r.from && r.to && r.from !== r.to);
      mutateModel(
        (model) => {
          const node = findNodeById(model.nodes, nodeId);
          if (!node) return model;
          if (node.kind === 'map') {
            const prev = parseLoopHead(node.head);
            node.head = value;
            for (const { from, to } of renames || []) {
              if (from && to && from !== to) renameLoopVar(node.children || [], from, to);
            }
            // Renames above already re-pointed the children, so compare the
            // data sources and orphan-proof what reads from this item.
            const next = parseLoopHead(value);
            if (prev && next && prev.data !== next.data) {
              const vars = [next.item, next.index].filter(Boolean);
              if (vars.length) disconnectDependentLoops(node.children || [], vars);
            }
          } else if (node.kind === 'raw') node.inner = value;
          else if (node.kind === 'text' || node.kind === 'expr' || node.kind === 'comment') {
            node.value = value;
          }
          return model;
        },
        renaming || immediate,
        renaming ? undefined : `text:${nodeId}`
      );
    },
    [mutateModel]
  );

  // Replaces the page frontmatter: default imports are re-extracted so the
  // model's import list (used for palettes, pruning, chunk resolution) stays
  // in sync with the edited code.
  const setFrontmatter = useCallback(
    (code) => {
      mutateModel(
        (model) => {
          const importRe = /import\s+(\w+)\s+from\s+['"]([^'"]+)['"];?/g;
          const imports = [];
          let extra = code;
          let m;
          while ((m = importRe.exec(code)) !== null) {
            imports.push({ name: m[1], path: m[2] });
            extra = extra.replace(m[0], '');
          }
          model.imports = imports;
          model.extraFrontmatter = extra.trim();
          return model;
        },
        false,
        'frontmatter'
      );
    },
    [mutateModel]
  );

  // Sets the text content of a component (single text child convenience).
  const setNodeContent = useCallback(
    (nodeId, value) => {
      mutateModel(
        (model) => {
          const node = findNodeById(model.nodes, nodeId);
          if (!node || node.kind === 'text') return model;
          if (!Array.isArray(node.children)) node.children = [];
          const textChild = node.children.find((c) => c.kind === 'text');
          if (textChild) textChild.value = value;
          else node.children.push({ id: newId(), kind: 'text', value });
          return model;
        },
        false,
        `content:${nodeId}`
      );
    },
    [mutateModel]
  );

  // Replaces a node's inline children wholesale (rich Content field edits).
  // Nodes arrive from the editor without ids — assign fresh ones.
  const setNodeInline = useCallback(
    (nodeId, kids) => {
      const withIds = (list) =>
        list.map((n) => ({
          ...n,
          id: newId(),
          ...(Array.isArray(n.children) ? { children: withIds(n.children) } : {}),
        }));
      mutateModel(
        (model) => {
          const node = findNodeById(model.nodes, nodeId);
          if (!node || node.kind === 'text') return model;
          node.children = withIds(kids);
          return model;
        },
        false,
        `content:${nodeId}`
      );
    },
    [mutateModel]
  );

  const layoutSeq = useRef(0);
  const changeLayout = useCallback(
    async (layoutName) => {
      const seq = ++layoutSeq.current;
      if (!layoutName) {
        // Unwrap: replace the wrapper node with its children.
        mutateModel((model) => {
          const found = findParentList(model, 'layout');
          if (found) {
            const node = found.list[found.index];
            const kids = Array.isArray(node.children) ? node.children : [];
            found.list.splice(found.index, 1, ...kids);
          }
          pruneImports(model);
          return model;
        }, true);
        setSelectedId((id) => (id === 'layout' ? null : id));
        return;
      }
      const layout = scan.layouts.find((l) => l.name === layoutName);
      if (!layout) return;
      const paths = await resolveImportPath(layout.path);
      if (seq !== layoutSeq.current) return; // superseded by a newer change
      mutateModel((model) => {
        const existing = findNodeById(model.nodes, 'layout');
        if (existing) {
          existing.name = layout.name;
        } else {
          // No wrapper yet — wrap the whole page in the new layout.
          model.nodes = [
            { id: 'layout', kind: 'component', name: layout.name, props: {}, children: model.nodes },
          ];
        }
        if (!model.imports.some((i) => i.name === layout.name)) {
          model.imports.push({
            name: layout.name,
            path: chooseImportPath(model, paths),
          });
        }
        pruneImports(model);
        return model;
      }, true);
    },
    [scan.layouts, mutateModel, resolveImportPath]
  );

  // ----------------------------------------------------------------
  // Page management
  // ----------------------------------------------------------------

  const createPage = useCallback(
    async (name, layoutName) => {
      const layout = scan.layouts.find((l) => l.name === layoutName) || null;
      try {
        const { pagePath } = await window.avb.createPage({
          projectPath: project.path,
          name,
          layout,
        });
        const result = await rescan(project.path);
        const page = result.pages.find((p) => p.path === pagePath);
        if (page) selectPage(page);
        showToast(`Created ${name}.astro`, 'success');
      } catch (err) {
        showToast(cleanError(err), 'error');
      }
    },
    [project, scan.layouts, rescan, selectPage, showToast]
  );

  const deletePage = useCallback(
    async (page) => {
      if (!confirm(`Delete ${page.name}? This removes the file from disk.`)) return;
      await window.avb.deletePage(page.path);
      const result = await rescan(project.path);
      if (currentPage?.path === page.path) {
        const next = result.pages[0] || null;
        if (next) selectPage(next);
        else {
          setCurrentPage(null);
          setPageState(null);
        }
      }
      showToast(`Deleted ${page.name}`, 'success');
    },
    [project, currentPage, rescan, selectPage, showToast]
  );

  // Moves/renames a page (drag between folders, inline rename). `to` is the
  // new path relative to src/pages including the extension.
  const movePageTo = useCallback(
    async (page, to) => {
      try {
        const { newPath } = await window.avb.movePage({
          projectPath: project.path,
          from: page.path,
          to,
        });
        const result = await rescan(project.path);
        if (pageStateRef.current.currentPage?.path === page.path) {
          const np = result.pages.find((p) => p.path === newPath);
          if (np) selectPage(np);
        }
      } catch (err) {
        showToast(cleanError(err), 'error');
      }
    },
    [project, rescan, selectPage, showToast]
  );

  // Creates an (empty) folder with a placeholder name; the panel opens an
  // inline rename right after. Returns the created folder's name.
  const createPageFolder = useCallback(async () => {
    const existing = new Set(scan.pageFolders || []);
    let name = 'new-folder';
    for (let i = 2; existing.has(name); i++) name = `new-folder-${i}`;
    try {
      await window.avb.createPageFolder({ projectPath: project.path, dir: name });
      await rescan(project.path);
      return name;
    } catch (err) {
      showToast(cleanError(err), 'error');
      return null;
    }
  }, [project, scan, rescan, showToast]);

  const renamePageFolder = useCallback(
    async (from, to) => {
      try {
        await window.avb.renamePageFolder({ projectPath: project.path, from, to });
        const result = await rescan(project.path);
        // Re-select the current page if it lived inside the renamed folder.
        const cur = pageStateRef.current.currentPage;
        if (cur && !result.pages.some((p) => p.path === cur.path)) {
          const newName = cur.name.startsWith(from + '/')
            ? to + cur.name.slice(from.length)
            : null;
          const np = newName && result.pages.find((p) => p.name === newName);
          if (np) selectPage(np);
        }
      } catch (err) {
        showToast(cleanError(err), 'error');
      }
    },
    [project, rescan, selectPage, showToast]
  );

  const deletePageFolder = useCallback(
    async (dir, pageCount) => {
      const suffix = pageCount
        ? ` and the ${pageCount} page${pageCount === 1 ? '' : 's'} inside it`
        : '';
      if (!confirm(`Delete the folder "${dir}"${suffix}? This removes files from disk.`)) return;
      try {
        await window.avb.deletePageFolder({ projectPath: project.path, dir });
        const result = await rescan(project.path);
        const cur = pageStateRef.current.currentPage;
        if (cur && !result.pages.some((p) => p.path === cur.path)) {
          const next = result.pages[0] || null;
          if (next) selectPage(next);
          else {
            setCurrentPage(null);
            setPageState(null);
          }
        }
      } catch (err) {
        showToast(cleanError(err), 'error');
      }
    },
    [project, rescan, selectPage, showToast]
  );

  // ----------------------------------------------------------------
  // Selection helpers
  // ----------------------------------------------------------------

  const model = pageState?.editable ? pageState.model : null;

  // The frontmatter as one editable code block (imports + everything else,
  // matching how the file is serialized).
  const frontmatterCode = model
    ? [
        ...model.imports.map((i) => `import ${i.name} from '${i.path}';`),
        ...(model.extraFrontmatter ? ['', model.extraFrontmatter] : []),
      ].join('\n')
    : '';

  const selectedNode =
    model && selectedId
      ? selectedId === 'frontmatter'
        ? { id: 'frontmatter', kind: 'frontmatter', value: frontmatterCode }
        : findNodeById(model.nodes, selectedId)
      : null;
  const layoutNode = model ? findNodeById(model.nodes, 'layout') : null;
  // The page may import its layout under any local name (e.g. `import Layout
  // from '../layouts/BaseLayout.astro'`) — resolve the wrapper back to a
  // scanned layout file name for display, pickers, and schema lookup.
  const currentLayoutName = (() => {
    if (!layoutNode) return '';
    const imp = (model.imports || []).find((i) => i.name === layoutNode.name);
    const base = imp?.path.split('/').pop()?.replace(/\.astro$/i, '');
    if (base && scan.layouts.some((l) => l.name === base)) return base;
    return layoutNode.name;
  })();
  // A component whose Props extends HTMLAttributes<"tag"> also accepts that
  // element's built-in attributes — merge them in after its own props.
  const schemaFor = (entry) => {
    if (!entry) return [];
    const own = entry.schema || [];
    if (!entry.extendsTag) return own;
    const ownNames = new Set(own.map((f) => f.name));
    const inherited = getElementSchema(entry.extendsTag).filter((f) => !ownNames.has(f.name));
    return [...own, ...inherited];
  };
  const selectedSchema =
    selectedNode && selectedNode.kind !== 'text'
      ? selectedId === 'layout'
        ? schemaFor(scan.layouts.find((l) => l.name === currentLayoutName))
        : selectedNode.kind === 'element'
          ? getElementSchema(selectedNode.name)
          : schemaFor(insertables.find((c) => c.name === selectedNode.name))
      : [];

  // Slots offered by the selected node's parent (the component or layout the
  // node is slotted into) — turns the `slot` attribute into a dropdown.
  const findParentNode = (nodes, id) => {
    for (const n of nodes) {
      if (!Array.isArray(n.children)) continue;
      if (n.children.some((c) => c.id === id)) return n;
      const found = findParentNode(n.children, id);
      if (found) return found;
    }
    return null;
  };
  let slotOptions = null;
  if (model && selectedNode && selectedId !== 'layout') {
    const parent = findParentNode(model.nodes, selectedId);
    if (parent) {
      if (parent.id === 'layout') {
        slotOptions = scan.layouts.find((l) => l.name === currentLayoutName)?.slots || null;
      } else if (parent.kind === 'component') {
        slotOptions = insertables.find((c) => c.name === parent.name)?.slots || null;
      }
    }
  }

  // In-scope data at the selection: the page's frontmatter declarations and
  // imports, plus the item/index variables of every enclosing loop. Feeds the
  // loop editor's source list and the content editor's expression chips.
  const loopContext =
    model && selectedNode
      ? {
          frontmatter: model.extraFrontmatter || '',
          imports: model.imports || [],
          ancestorHeads: (ancestorChain(model.nodes, selectedId) || [])
            .slice(0, -1)
            .filter((n) => n.kind === 'map')
            .map((n) => n.head),
        }
      : null;

  // Link settings (href fields): pages to link to and the ids on this page
  // that anchor links can target.
  const sectionIds = [];
  if (model) {
    const walkIds = (list) =>
      list.forEach((n) => {
        const idv = n.props?.id;
        if (idv && idv.type === 'string' && idv.value) sectionIds.push(idv.value);
        if (Array.isArray(n.children)) walkIds(n.children);
      });
    walkIds(model.nodes);
  }
  const linkContext = { pages: scan.pages, sectionIds };

  // Breadcrumb trail for the canvas toolbar: page → ancestors → selection.
  const crumbLabel = (n) => {
    if (n.id === 'layout') return currentLayoutName || n.name;
    switch (n.kind) {
      case 'text':
        return 'text';
      case 'comment':
        return 'comment';
      case 'expr':
        return 'code';
      case 'map': {
        const at = n.head.indexOf('.map');
        return at > 0 ? n.head.slice(0, at + 4) : 'loop';
      }
      case 'element':
      case 'raw': {
        // First class wins; fall back to the bare tag when the element has none.
        const cls = n.props?.class;
        const first =
          cls && cls.type === 'string' ? cls.value.trim().split(/\s+/)[0] : null;
        return first || n.name;
      }
      default:
        return n.name;
    }
  };
  // Floating code window target value: page frontmatter, a raw node's inner
  // content, or a text file from public/ (loaded into fileText).
  const isFileWin = codeWin?.kind === 'file';
  const codeWinNode =
    codeWin && !isFileWin && codeWin.targetId !== 'frontmatter' && model
      ? findNodeById(model.nodes, codeWin.targetId)
      : null;
  const codeWinValue = !codeWin
    ? null
    : isFileWin
      ? fileText
      : codeWin.targetId === 'frontmatter'
        ? model
          ? frontmatterCode
          : null
        : codeWinNode?.inner ?? null;

  // Returns whether the selection actually has a code editor, so the Enter
  // shortcut below knows whether it handled the key.
  const openCodeWindow = () => {
    if (!selectedNode) return false;
    if (selectedNode.kind === 'frontmatter') {
      setCodeWin({ targetId: 'frontmatter', title: 'Frontmatter', language: 'javascript' });
      return true;
    }
    if (selectedNode.kind === 'raw') {
      setCodeWin({
        targetId: selectedNode.id,
        title: `<${selectedNode.name}>`,
        language: selectedNode.name === 'style' ? 'css' : 'javascript',
      });
      return true;
    }
    return false;
  };
  // Read by the keydown effect, which is set up long before this exists.
  openCodeWindowRef.current = openCodeWindow;

  // Opens a public/ text file in the floating editor.
  const openAssetFile = useCallback(
    async ({ rel, name }) => {
      try {
        const { text } = await window.avb.readAssetText({ projectPath: project.path, rel });
        setFileText(text);
        setCodeWin({
          kind: 'file',
          rel,
          title: name,
          language: /\.css$/i.test(name) ? 'css' : 'javascript',
        });
      } catch (err) {
        showToast(cleanError(err), 'error');
      }
    },
    [project, showToast]
  );

  // File edits stream to disk (debounced) — the dev server picks them up.
  const fileSaveTimer = useRef(null);
  const setAssetFileText = useCallback(
    (text) => {
      setFileText(text);
      if (!codeWin || codeWin.kind !== 'file') return;
      const { rel } = codeWin;
      clearTimeout(fileSaveTimer.current);
      fileSaveTimer.current = setTimeout(() => {
        window.avb
          .writeAssetText({ projectPath: project.path, rel, text })
          .catch((err) => showToast(`Save failed: ${cleanError(err)}`, 'error'));
      }, 300);
    },
    [codeWin, project, showToast]
  );

  // Close the window if its target disappears (page switch, node deleted).
  useEffect(() => {
    if (codeWin && !isFileWin && codeWinValue === null) setCodeWin(null);
  }, [codeWin, isFileWin, codeWinValue]);

  const crumbs = [];
  if (currentPage) crumbs.push({ id: null, label: currentPage.name.replace(/\.(astro|md)$/i, '') });
  if (model && selectedId === 'frontmatter') {
    crumbs.push({ id: 'frontmatter', label: 'Frontmatter' });
  } else if (model && selectedId) {
    const chain = ancestorChain(model.nodes, selectedId) || [];
    crumbs.push(...chain.map((n) => ({ id: n.id, label: crumbLabel(n) })));
  }

  // Canvas outlines: nodes are addressed by their index path in the tree
  // (matching the marker paths the dev server's plugin injects).
  const pathFor = (id) => {
    if (!model || !id) return null;
    const trail = pathOfNode(model.nodes, id);
    return trail ? trail.join('.') : null;
  };

  // Picking a component swaps the right panel to Settings — its props are the
  // only thing there is to edit on it; picking a plain element (or a dynamic
  // tag, which renders one) swaps back to Style. Anything else — frontmatter,
  // text, a <style> block — leaves whatever tab the user had open alone.
  const tabSelRef = useRef(null);
  useEffect(() => {
    if (selectedId === tabSelRef.current) return;
    tabSelRef.current = selectedId;
    if (!selectedNode) return;
    const isComponent = selectedNode.kind === 'component' && !selectedNode.dynamicTag;
    if (isComponent) setRightTab('settings');
    else if (selectedNode.kind === 'element' || selectedNode.dynamicTag) setRightTab('style');
  }, [selectedId, selectedNode]);

  // Position the Style/Settings highlight: on tab change, when the panel first
  // appears, and whenever the tab strip's width changes.
  useLayoutEffect(() => {
    const measure = () => {
      const el = rightTabRefs.current[rightTab];
      setRightTabInd(el ? { left: el.offsetLeft, width: el.offsetWidth } : null);
    };
    measure();
    const strip = rightTabRefs.current[rightTab]?.parentElement;
    if (!strip || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(strip);
    return () => ro.disconnect();
  }, [rightTab, pageState?.editable]);

  const overlayInfo = (p) => {
    if (!model || !p) return null;
    const n = nodeAtPath(model.nodes, p.split('.').map(Number));
    if (!n) return null;
    const label = n.id === 'layout' ? currentLayoutName || n.name : crumbLabel(n);
    // A dynamic tag renders an element, so it shouldn't wear the component
    // colour on the canvas either.
    const kind =
      n.kind === 'component' && !n.dynamicTag
        ? 'component'
        : n.kind === 'map'
          ? 'map'
          : 'element';
    // The tag drives the overlay's icon, so it matches the Navigator row.
    const tag = n.kind === 'element' || n.kind === 'raw' ? n.name : null;
    return {
      label,
      kind,
      tag,
      nodeKind: n.kind,
      isLayout: n.id === 'layout',
      bound: kind === 'element' && isDataBound(n),
    };
  };

  // ----------------------------------------------------------------
  // Render
  // ----------------------------------------------------------------

  if (!project) {
    // welcome-mode floats the title bar over the start screen so the
    // interactive backdrop runs edge to edge, behind the window controls.
    return (
      <div className="app welcome-mode">
        <div className="titlebar">
          <span className="spacer" />
        </div>
        <WelcomeScreen onOpen={loadProject} setBusy={setBusy} showToast={showToast} />
        {busy && <BusyOverlay message={busy} />}
        {toast && <Toast toast={toast} />}
      </div>
    );
  }

  // The canvas always renders the page — editing a component just dims
  // everything outside the instance being worked on.
  const pageEntry = editStack[0] || currentPage;
  const pageRoute = pageEntry?.route;
  const focusPath = currentPage?.kind === 'component' ? currentPage.focusPath : null;
  const liveUrl = devUrl && pageRoute ? devUrl + pageRoute : null;

  return (
    <div className="app">
      <div className="titlebar">
        <span className="app-title">{project.name}</span>
        <span className="spacer" />
        {editStack.length > 1 ? (
          <button
            className="page-switch-btn comp-back"
            title="Back (Esc)"
            onClick={closeComponent}
          >
            <ChevronLeftIcon size={13} />
            <span className="comp-back-sep" />
            <ElementComponentIcon size={13} />
            <span className="page-switch-label">{currentPage?.name}</span>
          </button>
        ) : (
          <PageSwitcher pages={scan.pages} currentPage={currentPage} onSelect={selectPage} />
        )}
        <div className="url-group">
          <span
            className={`status-dot ${devStatus === 'on' ? 'on' : devStatus === 'starting' ? 'starting' : 'off'}`}
            title={`Dev server: ${devStatus}`}
          />
          <button
            className="ghost"
            title="Reload preview"
            disabled={!liveUrl}
            onClick={() => setRefreshKey((k) => k + 1)}
          >
            <RefreshIcon size={13} />
          </button>
          <span className="url">
            {liveUrl || (devStatus === 'starting' ? 'Starting Astro dev server…' : 'Preview offline')}
          </span>
        </div>
        <span className="spacer" />
        {/* Both ways of viewing the site, kept together. */}
        <div className="titlebar-actions">
          <button
            className="titlebar-btn"
            title="Open in browser"
            disabled={!liveUrl}
            onClick={() => window.avb.openExternal(liveUrl)}
          >
            <ExternalIcon size={14} />
          </button>
          <button
            className={`titlebar-btn preview-btn ${inPreview ? 'on' : ''}`}
            title={inPreview ? 'Exit preview (Esc)' : 'Preview the site'}
            disabled={!devUrl}
            onClick={() => (inPreview ? exitPreview() : enterPreview())}
          >
            <PreviewIcon size={15} />
          </button>
        </div>
        <GitChip
          project={project}
          showToast={showToast}
          flushSave={flushSave}
          onWorktreeChanged={reloadFromDisk}
        />
      </div>

      <div className="main">
        <LeftRail
          active={leftTab}
          onSelect={(id) => {
            const next = leftTab === id ? null : id;
            if (next) setPanelWidth(panelWidthOf(next));
            setLeftTab(next);
          }}
        />

        {/* Always rendered, only hidden: the terminal panel lives in here, and
            unmounting it would kill its PTYs — and any harness running in them
            — every time the rail is collapsed. The terminal also floats over
            the canvas rather than taking layout width: resizing the preview
            iframe reflows and repaints the whole page under it. */}
        <div
          className={`panel left ${leftTab === 'terminal' ? 'floating' : ''}`}
          style={{ width: panelWidth, display: leftTab ? 'flex' : 'none' }}
        >
            <div className="panel-resizer" onPointerDown={startPanelResize} />
            {leftTab === 'pages' && (
              <PagesPanel
                scan={scan}
                currentPage={currentPage}
                onSelect={selectPage}
                onCreate={createPage}
                onDelete={deletePage}
                onRescan={() => rescan(project.path)}
                onMovePage={movePageTo}
                onCreateFolder={createPageFolder}
                onRenameFolder={renamePageFolder}
                onDeleteFolder={deletePageFolder}
              />
            )}
            {leftTab === 'navigator' && (
              <StructurePanel
                pageState={pageState}
                layouts={scan.layouts}
                currentLayoutName={currentLayoutName}
                selectedId={selectedId}
                revealTick={revealTick}
                onSelect={setSelectedId}
                onHoverNode={setHoverNodeId}
                onOpenComponent={(name, id) => openComponent(name, pathFor(id))}
                onChangeLayout={changeLayout}
                onDropComponent={addComponent}
                onMoveNode={moveNode}
                onRemoveNode={removeNode}
                onCopyNode={copyNode}
                onDuplicateNode={duplicateNode}
                onPasteNode={pasteNode}
                hasClipboard={() => !!nodeClipboardRef.current}
                onRawChange={setRawSource}
              />
            )}
            {leftTab === 'components' && (
              <PalettePanel
                components={insertables}
                devUrl={devUrl}
                onInsert={(name) => addComponent(name, null)}
                onDragBegin={() => setLeftTab('navigator')}
              />
            )}
            {leftTab === 'cms' && (
              <CmsPanel
                project={project}
                selectedRel={cmsRel}
                refreshKey={cmsTick}
                onSelect={(r) => {
                  setCmsRel(r);
                  setCmsSettings(false);
                }}
                onOpenSettings={(r) => {
                  setCmsRel(r);
                  setCmsSettings(true);
                }}
                showToast={showToast}
              />
            )}
            {leftTab === 'assets' && (
              <AssetsPanel
                project={project}
                showToast={showToast}
                onOpenFile={openAssetFile}
                pick={assetPick}
                onPickCancel={endAssetPick}
              />
            )}
            {/* Always mounted: unmounting kills the PTY, and with it any
                harness running in it. `contents` keeps it out of the rail's
                layout while another tab is open. */}
            <div style={{ display: leftTab === 'terminal' ? 'contents' : 'none' }}>
              <TerminalPanel project={project} active={leftTab === 'terminal'} />
            </div>
        </div>

        <div className="center">
          <PreviewPane
            devUrl={devUrl}
            devStatus={devStatus}
            devLog={devLog}
            devDiag={devDiag}
            route={pageRoute}
            refreshKey={refreshKey}
            crumbs={crumbs}
            onCrumb={(id) => setSelectedId(id)}
            onRefresh={() => setRefreshKey((k) => k + 1)}
            onRestart={() => startPreview(project.path)}
            selPath={pathFor(selectedId)}
            navHoverPath={pathFor(hoverNodeId)}
            overlayInfo={overlayInfo}
            focusPath={focusPath}
            device={device}
            onDevice={setDevice}
            onSelectPath={(p) => {
              // Editing a component: the canvas still shows the whole page, so
              // a click in the dimmed area (or on nothing) means "I'm done in
              // here" and backs out. Clicks on the lit instance stay put —
              // the page's markers don't address a component's internals, so
              // there's no node here to map them onto.
              if (focusPath) {
                const inside = p && (p === focusPath || p.startsWith(focusPath + '.'));
                if (!inside) closeComponent();
                return;
              }
              // Chrome the layout renders itself — header, footer, anything
              // outside the page's <slot> — carries no page-model marker, so a
              // click there arrives with no path. The layout owns that markup,
              // so select it instead of doing nothing.
              if (!p) {
                const layout = model && findNodeById(model.nodes, 'layout');
                if (layout) {
                  setSelectedId(layout.id);
                  setLeftTab('navigator');
                  setRevealTick((t) => t + 1);
                }
                return;
              }
              const n = model && nodeAtPath(model.nodes, p.split('.').map(Number));
              if (n) {
                setSelectedId(n.id);
                // Selecting from the canvas jumps to the node in the tree.
                setLeftTab('navigator');
                setRevealTick((t) => t + 1);
              }
            }}
            onOpenPath={(p) => {
              // Double-clicking a component on the canvas drills into it.
              const n = model && nodeAtPath(model.nodes, p.split('.').map(Number));
              if (n?.kind === 'component') openComponent(n.name, p);
            }}
          />

          {/* The CMS edits content, not layout — it covers the canvas rather
              than replacing it, so the preview keeps its loaded page. */}
          {cmsRel && (
            <CmsView
              project={project}
              rel={cmsRel}
              hidden={leftTab !== 'cms'}
              settings={cmsSettings}
              showToast={showToast}
              onSaved={() => setCmsTick((t) => t + 1)}
              onCloseSettings={() => setCmsSettings(false)}
              onDeleted={() => {
                setCmsRel(null);
                setCmsSettings(false);
              }}
              onClose={() => setCmsRel(null)}
            />
          )}
        </div>

        {inPreview && previewSrc && (
          <div className="preview-mode">
            <iframe ref={previewIframeRef} src={previewSrc} title="Site preview (interactive)" />
          </div>
        )}

        {pageState?.editable && (
          <div className="panel right">
            <div className="right-tabs">
              {rightTabInd && <span className="right-tabs-indicator" style={rightTabInd} />}
              {[
                { id: 'style', label: 'Style' },
                { id: 'settings', label: 'Settings' },
              ].map((t) => (
                <button
                  key={t.id}
                  ref={(el) => (rightTabRefs.current[t.id] = el)}
                  className={rightTab === t.id ? 'on' : ''}
                  onClick={() => setRightTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {rightTab === 'style' && (
              <StylePanel
                project={project}
                model={model}
                node={selectedNode}
                device={device}
                onWriteStyleNode={(nodeId, css, immediate) =>
                  setNodeText(nodeId, css, undefined, immediate)
                }
                onSelectNode={setSelectedId}
              />
            )}
            <div style={{ display: rightTab === 'settings' ? 'contents' : 'none' }}>
            <PropsPanel
              node={selectedNode}
              isLayout={selectedId === 'layout'}
              layouts={scan.layouts}
              currentLayoutName={currentLayoutName}
              onChangeLayout={changeLayout}
              schema={selectedSchema}
              slotOptions={slotOptions}
              loopContext={loopContext}
              linkContext={linkContext}
              projectClasses={projectClasses}
              allowAttrs={
                selectedNode?.kind === 'element' ||
                // A dynamic tag renders a real element, so it takes attributes
                // even though it has no component file behind it.
                !!selectedNode?.dynamicTag ||
                (selectedNode?.kind === 'component' &&
                  !!insertables.find((c) => c.name === selectedNode.name)?.hasRest)
              }
              onSetProp={(propName, value, immediate) =>
                setProp(selectedId, propName, value, immediate)
              }
              onRenameProp={(oldName, newName) => renameProp(selectedId, oldName, newName)}
              onChangeTag={(tag) => changeElementTag(selectedId, tag)}
              onSetText={(value, renames) =>
                selectedId === 'frontmatter'
                  ? setFrontmatter(value)
                  : setNodeText(selectedId, value, renames)
              }
              onSetContent={(value) => setNodeContent(selectedId, value)}
              onSetInline={(kids) => setNodeInline(selectedId, kids)}
              onOpenCode={openCodeWindow}
              projectPath={project.path}
            />
            </div>
          </div>
        )}
      </div>

      {codeWin && codeWinValue !== null && (
        <CodeWindow
          title={codeWin.title}
          language={codeWin.language}
          value={codeWinValue}
          editorKey={isFileWin ? `file:${codeWin.rel}` : codeWin.targetId}
          onChange={(value) =>
            isFileWin
              ? setAssetFileText(value)
              : codeWin.targetId === 'frontmatter'
                ? setFrontmatter(value)
                : setNodeText(codeWin.targetId, value)
          }
          onClose={() => setCodeWin(null)}
        />
      )}

      {insertOpen && (
        <InsertSearch
          components={insertables}
          onInsert={insertItem}
          onClose={() => setInsertOpen(false)}
        />
      )}

      {busy && <BusyOverlay message={busy} />}
      {toast && <Toast toast={toast} />}
    </div>
  );
}

function insertIntoModel(model, node, target) {
  if (!target || target.parentId == null) {
    const index = target ? Math.min(target.index, model.nodes.length) : model.nodes.length;
    model.nodes.splice(index, 0, node);
    return;
  }
  const parent = findNodeById(model.nodes, target.parentId);
  if (!parent) {
    model.nodes.push(node);
    return;
  }
  if (!Array.isArray(parent.children)) parent.children = [];
  const index = Math.min(target.index, parent.children.length);
  parent.children.splice(index, 0, node);
}

function BusyOverlay({ message }) {
  return (
    <div className="busy-overlay">
      <div className="spinner" />
      <div>{message}</div>
    </div>
  );
}

function Toast({ toast }) {
  return <div className={`toast ${toast.kind}`}>{toast.msg}</div>;
}

export function cleanError(err) {
  const msg = err?.message || String(err);
  return stripAnsi(msg.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''));
}

function stripAnsi(s) {
  return String(s)
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1b/g, '')
    .replace(/\[(\d{1,2})m/g, '');
}
