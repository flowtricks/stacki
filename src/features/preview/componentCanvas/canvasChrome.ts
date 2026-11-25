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
  const frame = surface === undefined ? 'var(--stacki-page-background, #fff)' : 'transparent';
  const label = theme === 'dark' ? '#a3a3a3' : '#6b6b6b';
  const css = `
html, body { margin: 0 !important; padding: 0 !important; height: 100% !important; overflow: hidden !important; }
stacki-canvas { position: fixed; inset: 0; display: block; overflow: clip; background: ${canvas}; touch-action: none; }
stacki-canvas.is-panning, stacki-canvas.is-panning * { cursor: grabbing !important; }
stacki-canvas-world { position: absolute; left: 0; top: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 96px; padding: 64px; transform-origin: 0 0; width: max-content; }
stacki-canvas-row { display: flex; align-items: flex-start; gap: 64px; }
stacki-frame { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
stacki-frame-label { display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 12px/16px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; letter-spacing: 0; text-transform: none; color: var(--stacki-label, ${label}); user-select: none; cursor: default; }
stacki-frame[data-selected] > stacki-frame-label { color: #2f80ff; }
stacki-frame-body { display: block; position: relative; transform: translate(0); box-sizing: border-box; width: max-content; max-width: ${String(CHROME_LIMITS.hugWidthPxMax)}px; min-width: 24px; min-height: 24px; }
stacki-frame-body[data-transparent] { background: ${frame}; }
stacki-frame-body[data-fixed-width] { max-width: none; overflow-x: clip; }
stacki-frame-body[data-fixed-height] { overflow-y: clip; }
stacki-frame-body[data-fixed-width][data-fixed-height] { content-visibility: auto; }
stacki-frame-body[data-fallback]:not([data-fixed-width]) { width: ${String(CHROME_LIMITS.fallbackWidthPx)}px; }
stacki-frame-body[data-fallback]:not([data-fixed-height]) { height: ${String(CHROME_LIMITS.fallbackHeightPx)}px; }
stacki-frame[data-selected] > stacki-frame-body { box-shadow: 0 0 0 calc(2px * var(--stacki-unzoom, 1)) #2f80ff; }
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
  var canvas = document.querySelector('stacki-canvas');
  var world = document.querySelector('stacki-canvas-world');
  if (!canvas || !world) return;
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
  function apply() {
    if (!view) return;
    var transform = 'translate(' + view.x + 'px, ' + view.y + 'px) scale(' + view.scale + ')';
    if (world.style.transform !== transform) world.style.transform = transform;
    // The selection ring keeps its screen width at every zoom. The labels do not: they are in the frames' layout, so a
    // label that grew as the view zoomed out would widen the world, and fitting it would zoom out again without end.
    var unzoom = String(1 / view.scale);
    if (world.style.getPropertyValue('--stacki-unzoom') !== unzoom) world.style.setProperty('--stacki-unzoom', unzoom);
  }
  function remember() { try { sessionStorage.setItem(KEY, JSON.stringify({ x: view.x, y: view.y, scale: view.scale, moved: moved })); } catch (e) {} post({ event: 'view', scale: view.scale }); }
  function set(next) { view = next; apply(); remember(); }
  function fit() {
    var width = world.offsetWidth, height = world.offsetHeight;
    var box = canvas.getBoundingClientRect();
    var room = Math.max(box.width - insetRight, box.width / 3);
    if (!width || !height || !room || !box.height) return;
    var scale = clamp(Math.min(room / width, box.height / height), ZOOM_MIN, 1);
    set({ scale: scale, x: Math.max((room - width * scale) / 2, 0), y: Math.max((box.height - height * scale) / 2, 0) });
  }
  function zoomAt(scale, x, y) {
    moved = true;
    var next = clamp(scale, ZOOM_MIN, ZOOM_MAX), ratio = next / view.scale;
    set({ scale: next, x: x - (x - view.x) * ratio, y: y - (y - view.y) * ratio });
  }
  function frameOf(node) { return node && node.closest ? node.closest('stacki-frame') : null; }
  function mark() {
    var frames = document.querySelectorAll('stacki-frame');
    for (var i = 0; i < frames.length; i++) {
      var frame = frames[i];
      var on = frame.getAttribute('data-frame') === selected;
      if (on !== frame.hasAttribute('data-selected')) { if (on) frame.setAttribute('data-selected', ''); else frame.removeAttribute('data-selected'); }
    }
  }
  // A hugging frame whose component draws only out-of-flow boxes (a fixed modal, an absolute popover) has no size of
  // its own, so it takes a window-like size for them to fill; every other frame keeps hugging.
  function fallbacks() {
    var bodies = document.querySelectorAll('stacki-frame-body');
    for (var i = 0; i < bodies.length; i++) {
      var body = bodies[i], kids = body.children, outside = kids.length > 0;
      for (var k = 0; k < kids.length && outside; k++) {
        var position = getComputedStyle(kids[k]).position;
        outside = position === 'fixed' || position === 'absolute';
      }
      if (outside !== body.hasAttribute('data-fallback')) { if (outside) body.setAttribute('data-fallback', ''); else body.removeAttribute('data-fallback'); }
    }
  }
  // A frame without a background of its own shows the page's, as the component sits on in the site: the site's text
  // colours are chosen for it, and over the canvas's grey a dark link or a light button vanished.
  function pageBackground() {
    var clear = function (color) { return !color || color === 'transparent' || /rgba\(.*,\s*0\)$/.test(color); };
    var body = getComputedStyle(document.body).backgroundColor, root = getComputedStyle(document.documentElement).backgroundColor;
    var color = !clear(body) ? body : !clear(root) ? root : '#fff';
    if (canvas.style.getPropertyValue('--stacki-page-background') !== color) canvas.style.setProperty('--stacki-page-background', color);
  }
  // Labels stay legible on any canvas colour: dark on a light canvas, light on a dark one.
  function labelColor() {
    var match = /rgba?\(([^)]+)\)/.exec(getComputedStyle(canvas).backgroundColor || '');
    var parts = match ? match[1].split(',').map(parseFloat) : [30, 30, 30, 1];
    var alpha = parts.length > 3 ? parts[3] : 1;
    var light = alpha > 0.5 && (0.299 * parts[0] + 0.587 * parts[1] + 0.114 * parts[2]) > 150;
    var color = light ? '#5c5c5c' : '#a3a3a3';
    if (canvas.style.getPropertyValue('--stacki-label') !== color) canvas.style.setProperty('--stacki-label', color);
  }
  var queued = false;
  function settle() { queued = false; apply(); mark(); fallbacks(); pageBackground(); labelColor(); }
  function queue() { if (!queued) { queued = true; requestAnimationFrame(settle); } }
  // The editor patches the page in place after each edit, which can put the server's attributes back: reapply ours.
  new MutationObserver(queue).observe(canvas, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'data-selected', 'class'] });
  canvas.addEventListener('wheel', function (event) {
    event.preventDefault();
    if (!view) return;
    var box = canvas.getBoundingClientRect();
    if (event.ctrlKey || event.metaKey) {
      zoomAt(view.scale * Math.exp(-clamp(event.deltaY, -40, 40) * 0.01), event.clientX - box.left, event.clientY - box.top);
    } else {
      moved = true;
      set({ scale: view.scale, x: view.x - event.deltaX, y: view.y - event.deltaY });
    }
  }, { passive: false });
  window.addEventListener('keydown', function (event) { if (event.code === 'Space' && !event.repeat && !(event.target && event.target.isContentEditable)) space = true; }, true);
  window.addEventListener('keyup', function (event) { if (event.code === 'Space') space = false; }, true);
  // Clicks belong to the editor (it selects what was clicked); a press is where the page learns which frame it was in.
  canvas.addEventListener('pointerdown', function (event) {
    var frame = frameOf(event.target);
    var background = !frame;
    if (frame && event.button === 0 && !space) {
      var body = frame.querySelector('stacki-frame-body');
      var chrome = !body || event.target === body || !body.contains(event.target);
      post({ event: 'select', frame: frame.getAttribute('data-frame'), chrome: chrome });
    }
    if (!view || !(event.button === 1 || (event.button === 0 && (space || background)))) return;
    event.preventDefault();
    var startX = event.clientX, startY = event.clientY, from = view;
    canvas.classList.add('is-panning');
    var move = function (next) { moved = true; set({ scale: from.scale, x: from.x + next.clientX - startX, y: from.y + next.clientY - startY }); };
    var end = function () { canvas.classList.remove('is-panning'); window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', end, true); window.removeEventListener('pointercancel', end, true); };
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
      var box = canvas.getBoundingClientRect();
      if (data.action === 'fit') { moved = false; fit(); }
      else zoomAt(data.action === 'reset' ? (isFinite(data.unit) && data.unit > 0 ? data.unit : 1) : data.action === 'in' ? view.scale * 1.25 : view.scale / 1.25, box.width / 2, box.height / 2);
    }
  });
  if (typeof ResizeObserver === 'function') {
    var refit = new ResizeObserver(function () { if (!moved) fit(); });
    refit.observe(world);
    refit.observe(canvas);
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
