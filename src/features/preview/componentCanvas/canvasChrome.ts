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
  /** The room between a frame's blue outline and its component, in the canvas's own pixels. */
  framePaddingPx: 32,
  /** On screen, from a component's top to its frame's caption: room for the editor's tag over a selected component. */
  tagRoomScreenPx: 28,
  // The canvas's spacing, in its own pixels, each step clearly wider than the one inside it: that is all that shows
  // what belongs together, since the boxes around groups paint nothing.
  captionHeightPx: 16,
  captionGapPx: 8,
  headingHeightPx: 18,
  headingGapPx: 12,
  frameGapPx: 20,
  subgroupGapPx: 40,
  groupGapPx: 52,
  zoomMin: 0.05,
  zoomMax: 4,
} as const satisfies Record<string, number>;

// A fixed side cuts off what runs past it, while the caption above the frame stays: `overflow` would cut that too. Each
// shape keeps a strip above the frame, as wide as any caption, and clips at the fixed edges only.
const CLIP_SIDES = 'polygon(0 -100px, 3000px -100px, 3000px 0, 100% 0, 100% 100000px, 0 100000px)';
const CLIP_BOTTOM = 'polygon(-100000px -100px, 100000px -100px, 100000px 100%, -100000px 100%)';
const CLIP_BOTH = 'polygon(0 -100px, 3000px -100px, 3000px 0, 100% 0, 100% 100%, 0 100%)';

// A frame in a group starts below its caption; a frame that heads itself starts as far down as the frames of the groups
// beside it do (heading, gap, caption, gap), so frames line up from group to group.
const CAPTION_ROOM_PX = CHROME_LIMITS.captionHeightPx + CHROME_LIMITS.captionGapPx;
const LONE_HEADING_GAP_PX = CHROME_LIMITS.headingGapPx + CAPTION_ROOM_PX;
const GROUP_PADDING_TOP_PX = CHROME_LIMITS.headingHeightPx + CHROME_LIMITS.headingGapPx;

// The three levels of type, brightest first: a group's heading, a heading inside a group, a frame's caption.
const TYPE_COLORS = {
  dark: { heading: '#ededed', subheading: '#bdbdbd', caption: '#8c8c8c' },
  light: { heading: '#161616', subheading: '#404040', caption: '#6e6e6e' },
} as const;
const FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const HEADING_FONT = `600 13px/${String(CHROME_LIMITS.headingHeightPx)}px`;
const SUBHEADING_FONT = `500 13px/${String(CHROME_LIMITS.headingHeightPx)}px`;

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
  const label = TYPE_COLORS[theme].caption;
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
  const scaffold = 'html[data-stacki-ready] > body stacki-frame[data-frame]';
  // A group of the frames that share a split value (canvasGroups.ts): it paints nothing, and is only its heading at the
  // top left and the spacing of what it holds.
  const group = 'html[data-stacki-ready] > body stacki-group';
  // A frame is a box with room around its component and a blue outline: faint at rest, stronger under the pointer on its
  // own padding, full when the box itself is selected. Pressing the component selects that, and the editor outlines it;
  // the box then stays faint, so there is never a second strong outline. The widths here are for 100%; the page's script
  // rewrites them for the zoom, so an outline is as thin on screen at every zoom (frameSizes).
  const css = `@layer ${CHROME_LAYER} {
html[data-stacki-ready] { height: 100% !important; overflow: hidden !important; margin: 0 !important; padding: 0 !important; border: 0 !important; touch-action: none; }
${surface === undefined ? '' : `html[data-stacki-ready][data-stacki-surface] { background: ${withFallback(surface, grey)} !important; }`}
html[data-stacki-ready] > body { position: absolute !important; left: 0 !important; top: 0 !important; right: auto !important; bottom: auto !important; margin: 0 !important; padding: 88px 64px 64px !important; border: 0 !important; box-sizing: content-box !important; display: flex !important; flex-flow: row nowrap !important; gap: ${String(CHROME_LIMITS.frameGapPx)}px !important; align-items: stretch !important; justify-content: flex-start !important; transform-origin: 0 0 !important; width: max-content !important; height: auto !important; min-width: 0 !important; min-height: 0 !important; max-width: none !important; max-height: none !important; overflow: visible !important; background: transparent !important; box-shadow: none !important; filter: none !important; opacity: 1 !important; float: none !important; }
html[data-stacki-ready] > body[data-flow="column"] { flex-direction: column !important; align-items: flex-start !important; gap: ${String(CHROME_LIMITS.groupGapPx)}px !important; }
html[data-stacki-panning], html[data-stacki-panning] * { cursor: grabbing !important; }
${group} { display: flex !important; flex-flow: row nowrap !important; align-items: stretch !important; justify-content: flex-start !important; gap: ${String(CHROME_LIMITS.frameGapPx)}px !important; flex: 0 0 auto !important; position: relative !important; inset: auto !important; transform: none !important; box-sizing: border-box !important; width: max-content !important; height: auto !important; max-width: none !important; max-height: none !important; min-width: 0 !important; min-height: 0 !important; margin: 0 !important; padding: ${String(GROUP_PADDING_TOP_PX)}px 0 0 !important; border: 0 !important; border-radius: 0 !important; outline: 0 !important; background: transparent !important; box-shadow: none !important; filter: none !important; opacity: 1 !important; visibility: visible !important; float: none !important; overflow: visible !important; }
${group}:has(> stacki-group) { gap: ${String(CHROME_LIMITS.subgroupGapPx)}px !important; }
${group}::before { content: attr(data-label) !important; display: block !important; position: absolute !important; left: 0 !important; top: 0 !important; right: auto !important; bottom: auto !important; margin: 0 !important; padding: 0 !important; border: 0 !important; background: transparent !important; box-shadow: none !important; font: ${HEADING_FONT} ${FONT_STACK} !important; letter-spacing: 0 !important; text-transform: none !important; text-shadow: none !important; white-space: nowrap !important; color: ${TYPE_COLORS[theme].heading} !important; opacity: 1 !important; transform: none !important; filter: none !important; width: auto !important; height: ${String(CHROME_LIMITS.headingHeightPx)}px !important; user-select: none !important; visibility: visible !important; }
${group}:not([data-depth="0"])::before { font: ${SUBHEADING_FONT} ${FONT_STACK} !important; color: ${TYPE_COLORS[theme].subheading} !important; }
${group}::after { content: none !important; }
${scaffold} { flex: 0 0 auto !important; display: block !important; position: relative !important; inset: auto !important; transform: translate(0) !important; box-sizing: border-box !important; width: max-content !important; height: auto !important; max-width: ${String(CHROME_LIMITS.hugWidthPxMax)}px !important; min-width: 24px !important; min-height: 24px !important; margin: 0 !important; padding: ${String(CHROME_LIMITS.framePaddingPx)}px !important; border: 0 !important; border-radius: 0 !important; outline: 1px solid rgba(47, 128, 255, 0.3) !important; outline-offset: -1px !important; background: transparent !important; box-shadow: none !important; filter: none !important; opacity: 1 !important; visibility: visible !important; float: none !important; overflow: visible !important; }
${scaffold}:hover:not(:has(> :hover)) { outline-color: rgba(47, 128, 255, 0.7) !important; }
${scaffold}[data-box-selected] { outline: 2px solid #2f80ff !important; outline-offset: -2px !important; }
${scaffold}::before { content: attr(data-label) !important; display: block !important; box-sizing: content-box !important; margin: 0 !important; padding: 0 !important; border: 0 !important; background: transparent !important; box-shadow: none !important; font: 400 12px/${String(CHROME_LIMITS.captionHeightPx)}px ${FONT_STACK} !important; letter-spacing: 0 !important; word-spacing: 0 !important; text-transform: none !important; text-decoration: none !important; text-shadow: none !important; text-align: left !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; opacity: 1 !important; transform: none !important; filter: none !important; width: auto !important; min-width: 0 !important; max-width: 100% !important; float: none !important; }
${scaffold}::before { position: absolute !important; left: 0 !important; bottom: 100% !important; top: auto !important; right: auto !important; height: ${String(CHROME_LIMITS.captionHeightPx)}px !important; margin-bottom: ${String(CHROME_LIMITS.captionGapPx)}px !important; visibility: visible !important; color: ${label} !important; user-select: none !important; cursor: default !important; }
${scaffold}::after { content: none !important; }
html[data-stacki-ready] > body stacki-group > stacki-frame[data-frame] { margin-top: ${String(CAPTION_ROOM_PX)}px !important; }
${scaffold}[data-heading] { margin-top: ${String(GROUP_PADDING_TOP_PX + CAPTION_ROOM_PX)}px !important; }
${scaffold}[data-heading]::before { height: ${String(CHROME_LIMITS.headingHeightPx)}px !important; margin-bottom: ${String(LONE_HEADING_GAP_PX)}px !important; font: ${HEADING_FONT} ${FONT_STACK} !important; color: ${TYPE_COLORS[theme].heading} !important; }
${typeColorRules('light')}
${typeColorRules('dark')}
html[data-stacki-ready] > body stacki-frame[data-frame][data-selected]::before, ${scaffold}[data-box-selected]::before { color: #2f80ff !important; }
${scaffold}[data-fixed-width] { max-width: none !important; clip-path: ${CLIP_SIDES} !important; }
${scaffold}[data-fixed-height] { clip-path: ${CLIP_BOTTOM} !important; }
${scaffold}[data-fixed-width][data-fixed-height] { clip-path: ${CLIP_BOTH} !important; }
${scaffold}[data-fallback]:not([data-fixed-width]) { width: ${String(CHROME_LIMITS.fallbackWidthPx)}px !important; }
${scaffold}[data-fallback]:not([data-fixed-height]) { height: ${String(CHROME_LIMITS.fallbackHeightPx)}px !important; }
}
`;
  assert(!css.includes('</'), 'The chrome styles never close their element');
  return css;
}

// The type's colours over a light or a dark canvas, whatever the app's theme: the script says which it drew on.
function typeColorRules(on: 'light' | 'dark'): string {
  const colors = TYPE_COLORS[on];
  const within = `html[data-stacki-${on}] > body`;
  return [
    `${within} stacki-group[data-depth]::before { color: ${colors.subheading} !important; }`,
    `${within} stacki-group[data-depth="0"]::before, ${within} stacki-frame[data-heading]::before { color: ${colors.heading} !important; }`,
    `${within} stacki-frame[data-frame]:not([data-heading])::before { color: ${colors.caption} !important; }`,
  ].join('\n');
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
  var boxed = false;
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
    frameSizes(view.scale);
  }
  // Outlines keep their width on screen at any zoom. The spacing never changes with the zoom; only the caption of the
  // frame whose component is selected moves, to clear the editor's tag: up as far as the gap above it allows, and out
  // of sight where even that is not enough, never under the tag or over what is above.
  var sizes = document.createElement('style');
  sizes.setAttribute('data-stacki-chrome', '');
  (document.head || root).appendChild(sizes);
  function frameSizes(scale) {
    var thin = Math.round(1000 / scale) / 1000;
    var scaffold = 'html[data-stacki-ready] > body stacki-frame[data-frame]';
    var rule = '@layer ${CHROME_LAYER} { ' + scaffold + ' { outline-width: ' + thin + 'px !important; outline-offset: ' + -thin + 'px !important; } ' + scaffold + '[data-box-selected] { outline-width: ' + thin * 2 + 'px !important; outline-offset: ' + -thin * 2 + 'px !important; } ';
    var need = Math.ceil(${String(CHROME_LIMITS.tagRoomScreenPx)} / scale - ${String(CHROME_LIMITS.framePaddingPx)});
    var tagged = scaffold + '[data-selected]:not([data-box-selected])';
    [[':not([data-heading])', ${String(CHROME_LIMITS.captionGapPx)}], ['[data-heading]', ${String(LONE_HEADING_GAP_PX)}]].forEach(function (kind) {
      if (need <= kind[1]) return;
      var declaration = need <= kind[1] + ${String(CHROME_LIMITS.headingGapPx)} ? 'margin-bottom: ' + need + 'px' : 'visibility: hidden';
      rule += tagged + kind[0] + '::before { ' + declaration + ' !important; } ';
    });
    rule += '}';
    if (sizes.textContent !== rule) sizes.textContent = rule;
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
  function groups() { return document.querySelectorAll('stacki-group'); }
  // A caption wider than its small component widens a hugging frame, equally on both sides so the component stays
  // centred, and the space between frames stays what it is. A fixed frame keeps its width and its caption is cut short.
  var room = document.createElement('style');
  room.setAttribute('data-stacki-chrome', '');
  (document.head || root).appendChild(room);
  var measure = document.createElement('canvas').getContext('2d');
  var widened = {};
  function textWidth(element, font) {
    measure.font = font + ' ${FONT_STACK}';
    return Math.ceil(measure.measureText(element.getAttribute('data-label') || '').width) + 1;
  }
  function captionRoom() {
    if (!measure) return;
    var all = frames(), rules = '', next = {};
    for (var i = 0; i < all.length; i++) {
      var frame = all[i];
      if (frame.hasAttribute('data-fixed-width') || frame.hasAttribute('data-fallback')) continue;
      var key = frame.getAttribute('data-frame');
      var natural = frame.offsetWidth - 2 * (widened[key] || 0);
      var extra = Math.max(0, Math.ceil((textWidth(frame, frame.hasAttribute('data-heading') ? '600 13px' : '400 12px') - natural) / 2));
      next[key] = extra;
      if (extra > 0) rules += 'html[data-stacki-ready] > body stacki-frame[data-frame="' + key + '"] { padding-inline: ' + (${String(CHROME_LIMITS.framePaddingPx)} + extra) + 'px !important; } ';
    }
    var boxes = groups();
    for (var g = 0; g < boxes.length; g++) {
      var header = textWidth(boxes[g], boxes[g].getAttribute('data-depth') === '0' ? '600 13px' : '500 13px');
      rules += 'html[data-stacki-ready] > body stacki-group[data-group="' + boxes[g].getAttribute('data-group') + '"] { min-width: ' + header + 'px !important; } ';
    }
    var rule = '@layer ${CHROME_LAYER} { ' + rules + '}';
    if (room.textContent !== rule) {
      room.textContent = rule;
      widened = next;
    }
  }
  function mark() {
    var all = frames();
    for (var i = 0; i < all.length; i++) {
      var mine = all[i].getAttribute('data-frame') === selected;
      flag(all[i], 'data-selected', mine);
      flag(all[i], 'data-box-selected', mine && boxed);
    }
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
  function settle() { queued = false; apply(); mark(); fallbacks(); captionRoom(); pageBackground(); labelColor(); }
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
    if (data.command === 'select') { selected = typeof data.frame === 'string' ? data.frame : null; boxed = data.box === true; mark(); }
    if (data.command === 'zoom' && view) {
      if (data.action === 'fit') { moved = false; fit(); }
      else zoomAt(data.action === 'reset' ? (isFinite(data.unit) && data.unit > 0 ? data.unit : 1) : data.action === 'in' ? view.scale * 1.25 : view.scale / 1.25, window.innerWidth / 2, window.innerHeight / 2);
    }
  });
  if (typeof ResizeObserver === 'function') {
    var refit = new ResizeObserver(function () { captionRoom(); if (!moved) fit(); });
    refit.observe(world);
    refit.observe(root);
  }
  fallbacks();
  captionRoom();
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
