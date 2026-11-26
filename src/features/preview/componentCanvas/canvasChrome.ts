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

/** The cascade layer the canvas's own rules are in (chromeStyles). */
const CHROME_LAYER = 'stacki-canvas';

/** The message the page and the editor exchange; `canvas` names the page, so a stale page's messages are ignored. */
export const CANVAS_MESSAGE = 'stacki:component-canvas';

/**
 * The page's own styles. `surface` is the project's canvas background (shared/properties/componentCanvas.ts): the canvas
 * draws on it, and a frame with no background of its own is transparent over it. Without one, the canvas is the app's
 * grey and such a frame shows the page's background, as the component sits on in the site.
 */
export function chromeStyles(theme: 'light' | 'dark', surface?: string): string {
  const grey = canvasGrey(theme);
  const label = theme === 'dark' ? '#a3a3a3' : '#6b6b6b';
  // The page is the canvas: its <html> (the canvas root, which the person selects and gives classes) is the surface, its
  // <body> the pannable, zoomable world, and each frame one element holding its instance, its caption drawn by the frame
  // itself (::before), so nothing but the root and the instances is an element anyone can point at.
  //
  // The surface is the canvas Background setting when one is set (a variable the project drops falls back to the grey);
  // otherwise the script paints it with the background the site's own page shows (canvasScript sitePage). The world and
  // the frames are scaffolding, immune to the project's CSS: every property that could move, paint or hide them is set
  // here !important, under selectors more specific than any element, universal, :where or attribute rule. A frame is
  // transparent unless a canvas Background setting paints it (inline, !important).
  //
  // In a cascade layer of its own, declared before any of the project's: for !important declarations the first layer
  // wins, over every later layer and over unlayered rules, so a project that imports its CSS into layers (Lumos does)
  // and marks a rule !important still cannot reach the scaffolding.
  const scaffold = 'html[data-stacki-ready] > body > stacki-frame[data-frame]';
  const css = `@layer ${CHROME_LAYER} {
html[data-stacki-ready] { height: 100% !important; overflow: hidden !important; margin: 0 !important; padding: 0 !important; border: 0 !important; touch-action: none; }
${surface === undefined ? '' : `html[data-stacki-ready][data-stacki-surface] { background: ${withFallback(surface, grey)} !important; }`}
html[data-stacki-ready] > body { position: absolute !important; left: 0 !important; top: 0 !important; right: auto !important; bottom: auto !important; margin: 0 !important; padding: 88px 64px 64px !important; border: 0 !important; box-sizing: content-box !important; display: grid !important; grid-auto-flow: row !important; gap: 96px 64px !important; align-items: start !important; justify-items: start !important; transform-origin: 0 0 !important; width: max-content !important; height: auto !important; min-width: 0 !important; min-height: 0 !important; max-width: none !important; max-height: none !important; overflow: visible !important; background: transparent !important; box-shadow: none !important; filter: none !important; opacity: 1 !important; float: none !important; }
html[data-stacki-panning], html[data-stacki-panning] * { cursor: grabbing !important; }
${scaffold} { display: block !important; position: relative !important; inset: auto !important; transform: translate(0) !important; box-sizing: border-box !important; width: max-content !important; height: auto !important; max-width: ${String(CHROME_LIMITS.hugWidthPxMax)}px !important; min-width: 24px !important; min-height: 24px !important; margin: 0 !important; padding: 0 !important; border: 0 !important; outline: 0 !important; background: transparent !important; box-shadow: none !important; filter: none !important; opacity: 1 !important; visibility: visible !important; float: none !important; overflow: visible !important; }
${scaffold}::before, ${scaffold}::after { content: attr(data-label) !important; display: block !important; box-sizing: content-box !important; margin: 0 !important; padding: 0 !important; border: 0 !important; background: transparent !important; box-shadow: none !important; font: 500 12px/16px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif !important; letter-spacing: 0 !important; word-spacing: 0 !important; text-transform: none !important; text-decoration: none !important; text-shadow: none !important; text-align: left !important; white-space: nowrap !important; opacity: 1 !important; transform: none !important; filter: none !important; width: auto !important; min-width: 0 !important; max-width: none !important; float: none !important; }
${scaffold}::before { position: absolute !important; left: 0 !important; bottom: 100% !important; top: auto !important; right: auto !important; height: 16px !important; margin-bottom: 8px !important; visibility: visible !important; color: ${label} !important; user-select: none !important; cursor: default !important; overflow: visible !important; }
${scaffold}::after { position: static !important; height: 0 !important; visibility: hidden !important; overflow: hidden !important; }
html[data-stacki-light] > body > stacki-frame[data-frame]::before { color: #5c5c5c !important; }
html[data-stacki-dark] > body > stacki-frame[data-frame]::before { color: #a3a3a3 !important; }
html[data-stacki-ready] > body > stacki-frame[data-frame][data-selected]::before { color: #2f80ff !important; }
${scaffold}[data-fixed-width] { max-width: none !important; overflow-x: clip !important; }
${scaffold}[data-fixed-height] { overflow-y: clip !important; }
${scaffold}[data-fixed-width][data-fixed-height] { content-visibility: auto !important; }
${scaffold}[data-fallback]:not([data-fixed-width]) { width: ${String(CHROME_LIMITS.fallbackWidthPx)}px !important; }
${scaffold}[data-fallback]:not([data-fixed-height]) { height: ${String(CHROME_LIMITS.fallbackHeightPx)}px !important; }
}
`;
  assert(!css.includes('</'), 'The chrome styles never close their element');
  return css;
}

/** The app's own canvas grey: the surface where neither a canvas Background setting nor the site's page paints one. */
export function canvasGrey(theme: 'light' | 'dark'): string {
  return theme === 'dark' ? '#1e1e1e' : '#e9e9e9';
}

// `var(--name)` with a fallback, so a variable that is gone draws the fallback; any other value unchanged.
export function withFallback(value: string, fallback: string): string {
  const reference = /^var\(\s*(--[^\s,()]+)\s*\)$/.exec(value.trim());
  return reference === null ? value : `var(${reference[1] ?? ''}, ${fallback})`;
}

/** The page's script. `id` is the canvas page's own name, checked by both ends of every message. */
export function chromeScript(id: string, theme: 'light' | 'dark' = 'dark'): string {
  assert(/^[a-f0-9-]{36}$/.test(id), 'A canvas page is named by a UUID');
  const grey = canvasGrey(theme);
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
    if (world.style.getPropertyValue('transform') !== transform) world.style.setProperty('transform', transform, 'important');
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
  // The surface where no canvas Background setting paints it: the background the site's own page shows, as a browser
  // paints a page's canvas (the root's background, else the body's), read with the canvas's own rules lifted for the
  // moment it takes; the app's grey where the site paints none. The site's styles arrive after this script and a theme
  // class on the root changes them, so it is read again as they settle. Written as a rule of the canvas's own, never as
  // a custom property the editor's variable picker would list, nor on the root's own style.
  var paint = document.createElement('style');
  paint.setAttribute('data-stacki-chrome', '');
  (document.head || root).appendChild(paint);
  function sitePage() {
    root.removeAttribute('data-stacki-ready');
    var html = getComputedStyle(root).backgroundColor, body = getComputedStyle(world).backgroundColor;
    root.setAttribute('data-stacki-ready', '');
    return !clear(html) ? html : !clear(body) ? body : ${JSON.stringify(grey)};
  }
  root.setAttribute('data-stacki-ready', '');
  function pageBackground() {
    var rule = root.hasAttribute('data-stacki-surface') ? '' : '@layer ${CHROME_LAYER} { html[data-stacki-ready] { background: ' + sitePage() + ' !important; } }';
    if (paint.textContent !== rule) paint.textContent = rule;
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
