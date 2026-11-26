// What the canvas page draws around the frames: the pannable, zoomable world, the frame labels and bodies, and a small
// script that pans, zooms, reports which frame was pressed and follows the frame the editor selected. It is text the
// generated page carries, not code the app runs, so it is written as plain browser script with no imports.
//
// Why inside the page: one page holds every frame, so the editor's ordinary canvas (one frame, one preview session)
// measures, selects and edits all of them, and the dev server renders the component once per frame in one request
// instead of one preview per frame. Panning and zooming transform the world, which the canvas measures through, so
// the outlines stay on what they outline at every zoom.
import { assert } from '../../../../shared/core/assert';
import { CANVAS_LIMITS } from '../../../../shared/properties/componentCanvas';

export const CHROME_LIMITS = {
  /** The widest a frame grows while it hugs its component: the Desktop frame width of the all-breakpoints canvas. */
  hugWidthPxMax: 1_440,
  /** The size a hugging frame takes when everything its component draws is out of flow (a fixed modal or a dialog). */
  fallbackWidthPx: 960,
  fallbackHeightPx: 640,
  zoomMin: 0.05,
  zoomMax: 4,
} as const satisfies Record<string, number>;

/** The message the page and the editor exchange; `canvas` names the page, so a stale page's messages are ignored. */
export const CANVAS_MESSAGE = 'stacki:component-canvas';

/**
 * The page's own styles. `surface` is the project's canvas background (shared/properties/componentCanvas.ts): the canvas
 * draws on it, and a frame with no background of its own is transparent over it. Without one, the canvas is the app's
 * grey and such a frame shows the page's background, as the component sits on in the site.
 */
export function chromeStyles(theme: 'light' | 'dark', surface?: string): string {
  const grey = theme === 'dark' ? '#1e1e1e' : '#e9e9e9';
  // A variable the project no longer defines falls back to the grey rather than to nothing.
  const canvas = surface === undefined ? grey : withFallback(surface, grey);
  const label = theme === 'dark' ? '#a3a3a3' : '#6b6b6b';
  // The page is the canvas: its <html> (the canvas root, which the person selects and gives classes) is the surface, its
  // <body> the pannable, zoomable world, and each frame one element holding its instance, its label a caption drawn by
  // the frame itself (::before), so nothing but the root and the instances is an element anyone can point at. The
  // surface and the frames' page background apply once the script has read the site's own (data-stacki-ready).
  const css = `
html { height: 100% !important; overflow: hidden !important; touch-action: none; }
html[data-stacki-ready] { background: ${canvas} !important; }
html[data-stacki-ready] body { background: transparent !important; }
body { position: absolute !important; left: 0; top: 0; margin: 0 !important; padding: 64px !important; box-sizing: content-box; display: grid !important; grid-auto-flow: row; gap: 96px 64px; align-items: start; justify-items: start; transform-origin: 0 0; width: max-content; min-height: 0 !important; }
html[data-stacki-panning], html[data-stacki-panning] * { cursor: grabbing !important; }
stacki-frame { display: block; position: relative; transform: translate(0); box-sizing: border-box; width: max-content; max-width: ${String(CHROME_LIMITS.hugWidthPxMax)}px; min-width: 24px; min-height: 24px; }
stacki-frame::before { content: attr(data-label); position: absolute; left: 0; bottom: 100%; margin-bottom: 8px; max-width: max(100%, 320px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 12px/16px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; letter-spacing: 0; text-transform: none; color: ${label}; user-select: none; cursor: default; }
html[data-stacki-light] stacki-frame::before { color: #5c5c5c; }
html[data-stacki-dark] stacki-frame::before { color: #a3a3a3; }
stacki-frame[data-selected]::before { color: #2f80ff !important; }
stacki-frame[data-transparent] { background: ${surface === undefined ? '#fff' : 'transparent'}; }
stacki-frame[data-fixed-width] { max-width: none; overflow-x: clip; }
stacki-frame[data-fixed-height] { overflow-y: clip; }
stacki-frame[data-fixed-width][data-fixed-height] { content-visibility: auto; }
stacki-frame[data-fallback]:not([data-fixed-width]) { width: ${String(CHROME_LIMITS.fallbackWidthPx)}px; }
stacki-frame[data-fallback]:not([data-fixed-height]) { height: ${String(CHROME_LIMITS.fallbackHeightPx)}px; }
`;
  assert(!css.includes('</'), 'The chrome styles never close their element');
  return css;
}

// `var(--name)` with a fallback, so a variable that is gone draws the fallback; any other value unchanged.
export function withFallback(value: string, fallback: string): string {
  const reference = /^var\(\s*(--[^\s,()]+)\s*\)$/.exec(value.trim());
  return reference === null ? value : `var(${reference[1] ?? ''}, ${fallback})`;
}

/** The page's script. `id` is the canvas page's own name, checked by both ends of every message. */
export function chromeScript(id: string): string {
  assert(/^[a-f0-9-]{36}$/.test(id), 'A canvas page is named by a UUID');
  const script = `(function () {
  var ID = ${JSON.stringify(id)};
  var TYPE = ${JSON.stringify(CANVAS_MESSAGE)};
  var ZOOM_MIN = ${String(CHROME_LIMITS.zoomMin)}, ZOOM_MAX = ${String(CHROME_LIMITS.zoomMax)};
  var root = document.documentElement;
  var world = document.body;
  if (!world) return;
  var KEY = 'stacki-canvas-view:' + ID;
  var view = null;
  var restoredMoved = false;
  var selected = null;
  var space = false;
  // Until the person pans or zooms, the view keeps fitting the frames as they load and change size.
  var moved = false;
  // The part of the canvas the editor covers on its right (the frame settings popover), left out when fitting.
  var insetRight = 0;
  try { var stored = JSON.parse(sessionStorage.getItem(KEY) || 'null'); if (stored && isFinite(stored.x) && isFinite(stored.y) && stored.scale > 0) { view = { x: stored.x, y: stored.y, scale: stored.scale }; restoredMoved = stored.moved === true; } } catch (e) {}
  function post(message) { message.type = TYPE; message.canvas = ID; try { window.parent.postMessage(message, '*'); } catch (e) {} }
  function clamp(value, low, high) { return Math.min(Math.max(value, low), high); }
  function flag(element, name, on) { if (on !== element.hasAttribute(name)) { if (on) element.setAttribute(name, ''); else element.removeAttribute(name); } }
  function apply() {
    if (!view) return;
    var transform = 'translate(' + view.x + 'px, ' + view.y + 'px) scale(' + view.scale + ')';
    if (world.style.transform !== transform) world.style.transform = transform;
  }
  function remember() { try { sessionStorage.setItem(KEY, JSON.stringify({ x: view.x, y: view.y, scale: view.scale, moved: moved })); } catch (e) {} post({ event: 'view', scale: view.scale }); }
  function set(next) { view = next; apply(); remember(); }
  function fit() {
    var width = world.offsetWidth, height = world.offsetHeight;
    var boxWidth = window.innerWidth, boxHeight = window.innerHeight;
    var room = Math.max(boxWidth - insetRight, boxWidth / 3);
    if (!width || !height || !room || !boxHeight) return;
    var scale = clamp(Math.min(room / width, boxHeight / height), ZOOM_MIN, 1);
    set({ scale: scale, x: Math.max((room - width * scale) / 2, 0), y: Math.max((boxHeight - height * scale) / 2, 0) });
  }
  function zoomAt(scale, x, y) {
    moved = true;
    var next = clamp(scale, ZOOM_MIN, ZOOM_MAX), ratio = next / view.scale;
    set({ scale: next, x: x - (x - view.x) * ratio, y: y - (y - view.y) * ratio });
  }
  function frameOf(node) { return node && node.closest ? node.closest('stacki-frame') : null; }
  function frames() { return document.querySelectorAll('stacki-frame'); }
  function mark() {
    var all = frames();
    for (var i = 0; i < all.length; i++) flag(all[i], 'data-selected', all[i].getAttribute('data-frame') === selected);
  }
  // A hugging frame whose component draws only out-of-flow boxes (a fixed modal, an absolute popover) has no size of
  // its own, so it takes a window-like size for them to fill; every other frame keeps hugging.
  function fallbacks() {
    var all = frames();
    for (var i = 0; i < all.length; i++) {
      var frame = all[i], kids = frame.children, outside = kids.length > 0;
      for (var k = 0; k < kids.length && outside; k++) {
        var position = getComputedStyle(kids[k]).position;
        outside = position === 'fixed' || position === 'absolute';
      }
      flag(frame, 'data-fallback', outside);
    }
  }
  var clear = function (color) { return !color || color === 'transparent' || /rgba\\(.*,\\s*0\\)$/.test(color); };
  // The site's own page background, read with the canvas's surface lifted for the moment it takes (the site's styles
  // arrive after this script, and a theme class on the root changes it): without a project canvas background, a frame
  // without a background of its own shows it, as the component sits on in the site (its text colours are chosen for
  // it). Written on the frames themselves, never as a custom property the editor's variable picker would list.
  function sitePage() {
    root.removeAttribute('data-stacki-ready');
    var body = getComputedStyle(world).backgroundColor, html = getComputedStyle(root).backgroundColor;
    root.setAttribute('data-stacki-ready', '');
    return !clear(body) ? body : !clear(html) ? html : '#fff';
  }
  root.setAttribute('data-stacki-ready', '');
  function pageBackground() {
    if (root.hasAttribute('data-stacki-surface')) return;
    var page = sitePage();
    var all = document.querySelectorAll('stacki-frame[data-transparent]');
    for (var i = 0; i < all.length; i++) { if (all[i].style.getPropertyValue('background') !== page) all[i].style.setProperty('background', page); }
  }
  // Captions stay legible on any canvas colour: dark on a light canvas, light on a dark one.
  function labelColor() {
    var match = /rgba?\\(([^)]+)\\)/.exec(getComputedStyle(root).backgroundColor || '');
    var parts = match ? match[1].split(',').map(parseFloat) : [30, 30, 30, 1];
    var alpha = parts.length > 3 ? parts[3] : 1;
    var light = alpha > 0.5 && (0.299 * parts[0] + 0.587 * parts[1] + 0.114 * parts[2]) > 150;
    flag(root, 'data-stacki-light', light);
    flag(root, 'data-stacki-dark', !light);
  }
  var queued = false;
  function settle() { queued = false; apply(); mark(); fallbacks(); pageBackground(); labelColor(); }
  function queue() { if (!queued) { queued = true; requestAnimationFrame(settle); } }
  // The editor patches the page in place after each edit, which can put the server's attributes back: reapply ours.
  new MutationObserver(queue).observe(world, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'data-selected', 'class'] });
  // The site's styles arrive in <head> after this script runs (the dev server injects them): settle again as they do.
  if (document.head) new MutationObserver(queue).observe(document.head, { childList: true });
  window.addEventListener('load', queue);
  window.addEventListener('wheel', function (event) {
    event.preventDefault();
    if (!view) return;
    if (event.ctrlKey || event.metaKey) {
      zoomAt(view.scale * Math.exp(-clamp(event.deltaY, -40, 40) * 0.01), event.clientX, event.clientY);
    } else {
      moved = true;
      set({ scale: view.scale, x: view.x - event.deltaX, y: view.y - event.deltaY });
    }
  }, { passive: false });
  window.addEventListener('keydown', function (event) { if (event.code === 'Space' && !event.repeat && !(event.target && event.target.isContentEditable)) space = true; }, true);
  window.addEventListener('keyup', function (event) { if (event.code === 'Space') space = false; }, true);
  // Clicks belong to the editor (it selects the frame's instance, or the root between frames); a press tells it
  // whether it was on the frame itself (its caption, the space around its instance), which opens the frame's settings.
  window.addEventListener('pointerdown', function (event) {
    var frame = frameOf(event.target);
    var background = !frame;
    if (frame && event.button === 0 && !space) {
      post({ event: 'select', frame: frame.getAttribute('data-frame'), chrome: event.target === frame });
    }
    if (!view || !(event.button === 1 || (event.button === 0 && (space || background)))) return;
    event.preventDefault();
    var startX = event.clientX, startY = event.clientY, from = view;
    root.setAttribute('data-stacki-panning', '');
    var move = function (next) { moved = true; set({ scale: from.scale, x: from.x + next.clientX - startX, y: from.y + next.clientY - startY }); };
    var end = function () { root.removeAttribute('data-stacki-panning'); window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', end, true); window.removeEventListener('pointercancel', end, true); };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', end, true);
  }, true);
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (event.source !== window.parent || !data || data.type !== TYPE || data.canvas !== ID) return;
    if (data.command === 'inset' && isFinite(data.right) && data.right >= 0) {
      insetRight = data.right;
      if (!moved) fit();
    }
    if (data.command === 'select') { selected = typeof data.frame === 'string' ? data.frame : null; mark(); }
    if (data.command === 'zoom' && view) {
      if (data.action === 'fit') { moved = false; fit(); }
      else zoomAt(data.action === 'reset' ? (isFinite(data.unit) && data.unit > 0 ? data.unit : 1) : data.action === 'in' ? view.scale * 1.25 : view.scale / 1.25, window.innerWidth / 2, window.innerHeight / 2);
    }
  });
  if (typeof ResizeObserver === 'function') {
    var refit = new ResizeObserver(function () { if (!moved) fit(); });
    refit.observe(world);
    refit.observe(root);
  }
  fallbacks();
  pageBackground();
  labelColor();
  if (view) { moved = restoredMoved; apply(); if (moved) remember(); else fit(); } else { fit(); }
  if (!view) set({ scale: 1, x: 0, y: 0 });
  post({ event: 'ready' });
})();`;
  assert(!script.includes('</script'), 'The chrome script never closes its element');
  return script;
}

interface CanvasMessage {
  readonly event: 'select' | 'view' | 'ready';
  readonly frame: string | undefined;
  readonly chrome: boolean;
  readonly scale: number | undefined;
}

// What the page posts is untrusted until read here: the site's own scripts share its window.
export function canvasMessage(input: unknown, id: string): CanvasMessage | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  const read = (key: string): unknown => Reflect.get(input, key);
  if (read('type') !== CANVAS_MESSAGE || read('canvas') !== id) {
    return undefined;
  }
  const event = read('event');
  if (event !== 'select' && event !== 'view' && event !== 'ready') {
    return undefined;
  }
  const frameValue = read('frame');
  const scaleValue = read('scale');
  const frame = typeof frameValue === 'string' && frameValue.length <= CANVAS_LIMITS.keyCharsMax ? frameValue : undefined;
  const scale = typeof scaleValue === 'number' && Number.isFinite(scaleValue) && scaleValue > 0 ? scaleValue : undefined;
  assert(id.length > 0, 'A canvas message is read for one canvas');
  return { event, frame, chrome: read('chrome') === true, scale };
}
