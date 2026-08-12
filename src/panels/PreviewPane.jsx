import React from 'react';
import CanvasView from './CanvasView.jsx';
import { setCanvasFrame, receiveCanvasReply } from '../canvasQuery.js';
import {
  DesktopIcon,
  TabletIcon,
  PhoneIcon,
  CanvasIcon,
  ChevronRightIcon,
  ElementComponentIcon,
  astroAssetIcon,
  LayoutIcon,
  RepeatIcon,
  BranchIcon,
  CornerIcon,
  TextIcon,
  CommentIcon,
  CodeIcon,
  CustomElementIcon,
  elementIcon,
} from '../ui/Icons.jsx';

// The overlay label wears the same icon the Navigator row does, so a node
// looks the same wherever you meet it.
function outlineIcon(info) {
  const size = 11;
  if (info.isLayout) return <LayoutIcon size={size} />;
  if (info.nodeKind === 'component') {
    // Same order the Navigator uses: a dynamic tag (`const Tag = tag`) is an
    // element with no file behind it, then astro:assets, then real components.
    if (info.dynamicTag) return <CustomElementIcon size={size} />;
    return info.astroAsset
      ? astroAssetIcon(info.label, size)
      : <ElementComponentIcon size={size} />;
  }
  switch (info.nodeKind) {
    case 'map':
      return <RepeatIcon size={size} />;
    case 'cond':
      return <BranchIcon size={size} />;
    case 'branch':
      return <CornerIcon size={size} />;
    case 'text':
      return <TextIcon size={size} />;
    case 'comment':
      return <CommentIcon size={size} />;
    case 'expr':
    case 'raw':
      return <CodeIcon size={size} />;
    default:
      return info.tag ? elementIcon(info.tag, size) : <CustomElementIcon size={size} />;
  }
}

// Desktop fills the canvas (width: null = fill).
const DEVICES = [
  { key: 'desktop', Icon: DesktopIcon, title: 'Desktop — 1', width: null },
  { key: 'tablet', Icon: TabletIcon, title: 'Tablet (768px) — 2', width: 768 },
  { key: 'phone', Icon: PhoneIcon, title: 'Phone (375px) — 3', width: 375 },
  { key: 'canvas', Icon: CanvasIcon, title: 'Canvas — all breakpoints — 4', width: null },
];

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

export default function PreviewPane({
  devUrl,
  devStatus,
  devLog,
  devDiag,
  pathScope,
  route,
  refreshKey,
  crumbs,
  onCrumb,
  onRefresh,
  onRestart,
  selPath,
  navHoverPath,
  overlayInfo,
  onSelectPath,
  onOpenPath,
  onSelectedClasses,
  focusPath,
  device,
  onDevice,
}) {
  // The breakpoint lives in App so a re-mount of this pane can't silently
  // kick the user out of a view (which would reload every preview iframe).
  const setDevice = onDevice;
  const [customW, setCustomW] = React.useState(null); // drag override
  const [customH, setCustomH] = React.useState(null); // null = fill height
  const [resizing, setResizing] = React.useState(false);
  const url = devUrl && route ? devUrl + route : null;
  const width = customW ?? DEVICES.find((d) => d.key === device)?.width;

  // Deep trees produce long ancestor chains; showing every crumb shrinks them
  // all to unreadable stubs. Keep the page plus the last few levels and fold
  // the middle into a "…" that expands (and re-folds on the next selection).
  const CRUMB_HEAD = 1;
  const CRUMB_TAIL = 3;
  const [crumbsExpanded, setCrumbsExpanded] = React.useState(false);
  const crumbKey = (crumbs || []).map((c) => c.id).join('/');
  React.useEffect(() => setCrumbsExpanded(false), [crumbKey]);
  const shownCrumbs = React.useMemo(() => {
    const all = crumbs || [];
    if (crumbsExpanded || all.length <= CRUMB_HEAD + CRUMB_TAIL + 1) return all;
    return [
      ...all.slice(0, CRUMB_HEAD),
      { ellipsis: true, hidden: all.slice(CRUMB_HEAD, all.length - CRUMB_TAIL) },
      ...all.slice(all.length - CRUMB_TAIL),
    ];
  }, [crumbs, crumbsExpanded]);

  // Node outlines: the preview iframe reports rects for tracked node paths
  // (and the node hovered on the page); outlines render as an absolute
  // overlay in the frame, never inside the page itself.
  const iframeRef = React.useRef(null);
  const [rects, setRects] = React.useState({});
  const [canvasHover, setCanvasHover] = React.useState(null);

  // Set by a click on the page, so the scroll-into-view below can skip it.
  // `undefined` means no click is pending; a click stores its path, which is
  // NULL when it landed on markup the open file doesn't address (layout chrome)
  // — that still selects something, just not the path that was clicked, so the
  // skip can't be a path comparison.
  const clickedPathRef = React.useRef(undefined);
  // Which instance of a repeated node is outlined. Canvas clicks pick the one
  // under the pointer; selections from anywhere else fall back to the first.
  const lastClickRef = React.useRef(null);
  const [selOcc, setSelOcc] = React.useState(0);
  const [hoverOcc, setHoverOcc] = React.useState(0);
  // Read by the message handler, which is bound once — refs keep it looking at
  // the current selection instead of the one it closed over.
  const selPathRef = React.useRef(selPath);
  selPathRef.current = selPath;
  const selOccRef = React.useRef(selOcc);
  selOccRef.current = selOcc;
  const onSelectedClassesRef = React.useRef(onSelectedClasses);
  onSelectedClassesRef.current = onSelectedClasses;
  // Last reported class string, so repeated rect sends stay quiet.
  const selClassesRef = React.useRef('');
  // Selection changed: the app cleared its copy, so the next report must go
  // through even if the new element happens to carry the same classes.
  React.useEffect(() => {
    selClassesRef.current = '';
  }, [selPath, selOcc]);
  // Canvas clicks set the instance directly (below) — including when they
  // land on another instance of the node that's already selected, where
  // selPath never changes. Any other route to a new selection means "the
  // node", so it falls back to the first instance. The click marker is
  // consumed here so coming back to the same node later starts at the first
  // instance again.
  React.useEffect(() => {
    if (lastClickRef.current?.path === selPath) {
      lastClickRef.current = null;
      return;
    }
    lastClickRef.current = null;
    setSelOcc(0);
  }, [selPath]);

  React.useEffect(() => {
    const onMsg = (e) => {
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
      const d = e.data;
      if (d?.type === 'avb:rects') {
        setRects(d.rects || {});
        // The rendered classes of the selected instance, for the style panel:
        // an expression-valued class attribute has no text in the model, so
        // this is the only place the applied classes are knowable. Rects
        // re-send on scroll/resize, so only report an actual change.
        if (d.classes) {
          const runs = d.classes[selPathRef.current] || [];
          const list = runs[selOccRef.current] || runs[0] || [];
          const key = list.join(' ');
          if (key !== selClassesRef.current) {
            selClassesRef.current = key;
            onSelectedClassesRef.current?.(list);
          }
        }
      } else if (d?.type === 'avb:hover-node') {
        setCanvasHover(d.path || null);
        setHoverOcc(d.occurrence || 0);
      } else if (d?.type === 'avb:click-node' && onSelectPath) {
        clickedPathRef.current = d.path || null;
        // Which instance was clicked: a node inside a loop renders once per
        // item and only that one should light up. Set now, not from the
        // effect above, so clicking a different instance of the already
        // selected node still moves the outline.
        lastClickRef.current = { path: d.path || null, occ: d.occurrence || 0 };
        setSelOcc(d.occurrence || 0);
        onSelectPath(d.path || null);
      } else if (d?.type === 'avb:query-result') {
        // An answer from the page about what it really renders — see
        // canvasQuery.js. Routed here because this is the component that
        // knows which frame the message came from.
        receiveCanvasReply(d);
      } else if (d?.type === 'avb:open-node' && onOpenPath) {
        // A null path means the double-click landed on markup the open file
        // doesn't address — the layout's own chrome. App decides what that opens.
        onOpenPath(d.path || null);
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [onSelectPath, onOpenPath]);

  const hoverPath = navHoverPath || canvasHover;
  // A navigator hover means "the node", so every instance lights up; a canvas
  // hover means the one under the pointer.
  const hoverOccUsed = navHoverPath ? null : hoverOcc;
  // Newline-joined: a namespaced path (src/…/Card.astro|0.1) contains a pipe,
  // so that can no longer separate the tracked paths.
  const trackKey = [...new Set([selPath, hoverPath, focusPath].filter(Boolean))].join(String.fromCharCode(10));
  // The frame the style panel asks about the rendered DOM. Re-registered on
  // every load: a reloaded document is a different window to talk to.
  const registerFrame = React.useCallback(() => {
    setCanvasFrame(iframeRef.current?.contentWindow || null);
  }, []);
  React.useEffect(() => {
    registerFrame();
    return () => setCanvasFrame(null);
  }, [registerFrame, url, refreshKey]);

  const sendTrack = React.useCallback(() => {
    const w = iframeRef.current?.contentWindow;
    if (!w) return;
    w.postMessage({ type: 'avb:track', paths: trackKey ? trackKey.split('\n') : [], scope: pathScope || '' }, '*');
  }, [trackKey]);
  React.useEffect(sendTrack, [sendTrack, url, refreshKey]);

  // Selecting in the navigator (or via a breadcrumb) smooth-scrolls the page
  // to the node. A selection that came from clicking the page is skipped —
  // it's already on screen, and moving it would yank it out from under the
  // pointer. Not sent on reload: the frame has no regions mapped yet.
  const prevFocusRef = React.useRef(focusPath);
  React.useEffect(() => {
    const w = iframeRef.current?.contentWindow;
    const focusChanged = prevFocusRef.current !== focusPath;
    prevFocusRef.current = focusPath;
    if (!w || !selPath) return;
    // Any selection that came from a click on the page: whatever it resolved to
    // is already on screen under the pointer. Notably the layout, whose box is
    // the whole page — scrolling to it always jumps to the top.
    if (clickedPathRef.current !== undefined) {
      clickedPathRef.current = undefined;
      return;
    }
    // Drilling into a component (or backing out) opens a different file and
    // selects within it, which looks like a fresh selection — but the canvas
    // still shows the same page and the instance is already under the pointer.
    // Scrolling here would jump to whichever instance the new path resolves to.
    if (focusChanged) return;
    // Repeated nodes: aim at the instance in play, not the first on the page.
    w.postMessage({ type: 'avb:scroll-to', path: selPath, occ: selOccRef.current }, '*');
  }, [selPath, focusPath]);

  // A reload wipes iframe state — clear stale boxes until fresh rects arrive.
  React.useEffect(() => {
    setRects({});
    setCanvasHover(null);
  }, [url, refreshKey]);

  // Track the canvas width so "Fill" can be expressed in px too — CSS can
  // only animate the frame width between two lengths, not px ↔ 100%.
  const wrapRef = React.useRef(null);
  const frameRef = React.useRef(null);
  const [wrapWidth, setWrapWidth] = React.useState(null);
  React.useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setWrapWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const selectDevice = (key) => setDevice(key);

  // Any breakpoint change drops the drag-resize override — a click, a 1–4
  // keypress, or App resetting the pane to desktop when a project opens.
  // 'custom' is the drag itself, so it must not clear what the drag just set.
  React.useEffect(() => {
    if (device === 'custom') return;
    setCustomW(null);
    if (device === 'desktop' || device === 'canvas') setCustomH(null); // fills, so reset the height too
  }, [device]);

  // Sliding highlight behind the active device button.
  const btnRefs = React.useRef({});
  const [indicator, setIndicator] = React.useState(null);
  React.useLayoutEffect(() => {
    const el = btnRefs.current[device];
    if (!el) {
      setIndicator(null); // drag-resized "custom" state — no active tab
      return;
    }
    setIndicator({ left: el.offsetLeft, width: el.offsetWidth });
  }, [device]);

  // 1 / 2 / 3 switch to the desktop / tablet / phone breakpoints (ignored
  // while typing in a field so prop values can still contain digits).
  React.useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
      ) {
        return;
      }
      const key = { 1: 'desktop', 2: 'tablet', 3: 'phone', 4: 'canvas' }[e.key];
      if (key) selectDevice(key);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Drag-resize from the edge handles. The frame is horizontally centered,
  // so a side handle changes the width by twice the pointer movement.
  const startResize = (edge) => (e) => {
    e.preventDefault();
    const frame = frameRef.current;
    const wrap = wrapRef.current;
    if (!frame || !wrap) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = frame.offsetWidth;
    const startH = frame.offsetHeight;
    setResizing(true);
    document.body.style.cursor = edge === 's' ? 'row-resize' : 'col-resize';
    const onMove = (ev) => {
      if (edge === 's') {
        const h = Math.round(startH + (ev.clientY - startY));
        setCustomH(clamp(h, 160, Math.max(160, wrap.clientHeight - 32)));
      } else {
        const dx = ev.clientX - startX;
        const w = Math.round(startW + (edge === 'e' ? 2 : -2) * dx);
        setCustomW(clamp(w, 280, Math.max(280, wrap.clientWidth - 24)));
        setDevice('custom');
      }
    };
    const onUp = () => {
      setResizing(false);
      document.body.style.cursor = '';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <>
      <div className="preview-toolbar">
        <div className="crumbs">
          {shownCrumbs.map((c, i) => {
            const last = i === shownCrumbs.length - 1;
            if (c.ellipsis) {
              return (
                <React.Fragment key="ellipsis">
                  <span className="crumb-sep">
                    <ChevronRightIcon size={9} />
                  </span>
                  <span
                    className="crumb crumb-more"
                    title={`Show ${c.hidden.length} more: ${c.hidden
                      .map((h) => h.label)
                      .join(' › ')}`}
                    onClick={() => setCrumbsExpanded(true)}
                  >
                    …
                  </span>
                </React.Fragment>
              );
            }
            return (
              <React.Fragment key={`${c.id}-${i}`}>
                {i > 0 && (
                  <span className="crumb-sep">
                    <ChevronRightIcon size={9} />
                  </span>
                )}
                <span
                  className={`crumb ${last ? 'last' : ''}`}
                  title={c.label}
                  onClick={() => onCrumb && onCrumb(c.id)}
                >
                  {c.label}
                </span>
              </React.Fragment>
            );
          })}
        </div>
        <div className="device-btns">
          {indicator && <span className="device-indicator" style={indicator} />}
          {DEVICES.map(({ key, Icon, title }) => (
            <button
              key={key}
              ref={(el) => (btnRefs.current[key] = el)}
              className={device === key ? 'on' : ''}
              title={title}
              onClick={() => selectDevice(key)}
            >
              <Icon size={13} />
            </button>
          ))}
        </div>
      </div>

      <div className="preview-frame-wrap" ref={wrapRef}>
        {url && device === 'canvas' ? (
          <CanvasView url={url} refreshKey={refreshKey} />
        ) : url ? (
          <div
            ref={frameRef}
            className={`frame-sized ${width ? '' : 'full'} ${resizing ? 'resizing' : ''}`}
            style={{
              width: width ?? wrapWidth ?? '100%',
              maxWidth: width ? 'calc(100% - 24px)' : '100%',
              ...(customH != null ? { height: customH, bottom: 'auto' } : {}),
            }}
          >
            <div className="frame-clip">
              <iframe
                key={`${url}-${refreshKey}`}
                ref={iframeRef}
                src={`${url}#avb-design`}
                title="Site preview"
                onLoad={() => {
                  registerFrame();
                  sendTrack();
                }}
              />
              {/* Editing a component: the page stays in context and everything
                  around the instance dims, so the piece being worked on is
                  the only lit part of the canvas. */}
              {focusPath &&
                (rects[focusPath] || []).map((r, i) => (
                  <div
                    key={`focus-${i}`}
                    className="node-focus"
                    style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
                  />
                ))}
              {[
                hoverPath && hoverPath !== selPath
                  ? { path: hoverPath, type: 'hover', occ: hoverOccUsed }
                  : null,
                selPath ? { path: selPath, type: 'sel', occ: selOcc } : null,
              ]
                .filter(Boolean)
                .flatMap((o) => {
                  // A loop child renders once per item — one box per
                  // instance, each labelled, so an instance further down the
                  // page still says what it is.
                  const all = rects[o.path];
                  const info = overlayInfo ? overlayInfo(o.path) : null;
                  if (!all || !info) return [];
                  // One box, not one per loop item, unless the hover came from
                  // the navigator (which points at the node, not an instance).
                  const list =
                    o.occ == null ? all : all[o.occ] ? [all[o.occ]] : all.slice(0, 1);
                  return list.map((r, i) => (
                    <div
                      key={`${o.type}-${i}`}
                      className={`node-outline ${o.type} ${info.kind}${info.bound ? ' bound' : ''}`}
                      style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
                    >
                      <span className={`node-outline-tag ${r.y < 20 ? 'inside' : ''}`}>
                        {outlineIcon(info)}
                        {info.label}
                      </span>
                    </div>
                  ));
                })}
            </div>
            <div className="rz-handle rz-w" onPointerDown={startResize('w')} />
            <div className="rz-handle rz-e" onPointerDown={startResize('e')} />
            <div className="rz-handle rz-s" onPointerDown={startResize('s')} />
            {resizing && (
              <div className="rz-readout">
                {Math.round(width ?? wrapWidth ?? 0)} × {customH ?? frameRef.current?.offsetHeight ?? ''}
              </div>
            )}
          </div>
        ) : (
          <div className="preview-placeholder">
            {devStatus === 'starting' ? (
              <>
                <div className="spinner" />
                <div>Starting Astro dev server…</div>
              </>
            ) : (
              <DevOffline devLog={devLog} devDiag={devDiag} onRestart={onRestart} />
            )}
          </div>
        )}
      </div>
    </>
  );
}

// The offline state. A raw Astro log is only useful to someone who already
// knows what went wrong, so lead with the diagnosis (see dev:diagnose) and
// keep the log a click away for the cases it doesn't cover.
const NODE_URL = 'https://nodejs.org/en/download';

function DevOffline({ devLog, devDiag, onRestart }) {
  const [showLog, setShowLog] = React.useState(false);
  const kind = devDiag?.kind;
  const known = kind === 'no-node' || kind === 'node-too-old' || kind === 'no-deps';

  let title = 'Preview is offline.';
  let detail = null;
  let action = null;

  if (kind === 'no-node') {
    title = "Node.js isn't installed — or isn't where this app can see it.";
    detail =
      'Astro needs Node.js to run. Stacki looks on the system path, your login ' +
      "shell's path, and the usual Homebrew, nvm, fnm, volta, asdf and mise " +
      'locations, and found nothing. Install Node, then start the server again.';
    action = { label: 'Get Node.js', url: NODE_URL };
  } else if (kind === 'node-too-old') {
    title = `Node ${devDiag.nodeVersion} is too old for this project.`;
    detail = `astro ${devDiag.astroVersion} needs Node ${devDiag.requires}. Install a newer Node — if you use a version manager, the one it picks in this project's folder is the one Stacki will use.`;
    action = { label: 'Get Node.js', url: NODE_URL };
  } else if (kind === 'no-deps') {
    title = "This project's dependencies aren't installed.";
    detail =
      'Astro was not found in node_modules. Starting the server installs them ' +
      'automatically — if that keeps failing, the log below has the reason.';
  }

  return (
    <>
      <div className={known ? 'offline-title' : undefined}>{title}</div>
      {detail && <p className="offline-detail">{detail}</p>}
      <div className="offline-actions">
        <button onClick={onRestart}>Start dev server</button>
        {action && (
          <button className="ghost" onClick={() => window.avb.openExternal(action.url)}>
            {action.label}
          </button>
        )}
      </div>
      {/* Always available: the diagnosis names the common failures, not the
          project's own build errors, which is what the log is for. */}
      {devDiag?.nodePath && (
        <div className="offline-meta">
          Using Node {devDiag.nodeVersion || '?'} — {devDiag.nodePath}
        </div>
      )}
      {devLog && (
        <>
          <button className="ghost offline-log-toggle" onClick={() => setShowLog((v) => !v)}>
            {showLog ? 'Hide log' : 'Show log'}
          </button>
          {showLog && <pre className="offline-log">{devLog}</pre>}
        </>
      )}
    </>
  );
}
