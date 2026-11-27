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
  /** The room between a group's blue outline and what it holds (its heading at the top). */
  groupPaddingPx: 16,
  // The canvas's spacing, in its own pixels, each step clearly wider than the one inside it, so the levels read apart
  // although every box is drawn the same way: a quiet square outline and nothing painted.
  captionHeightPx: 16,
  captionGapPx: 8,
  headingHeightPx: 18,
  headingGapPx: 12,
  frameGapPx: 16,
  subgroupGapPx: 24,
  groupGapPx: 32,
  /** Where wrapped frames start a new row: the Desktop width, the widest a hugging frame grows. */
  wrapWidthPx: 1_440,
  zoomMin: 0.05,
  zoomMax: 4,
  /**
   * The least a caption or heading shrinks to on screen, against its size at 100%, when the canvas is zoomed out past
   * the room it keeps for them: 9px captions, still read at a glance. Below it, a label that has no room is hidden.
   */
  labelScaleMin: 0.75,
  /** On screen, how near the selected frame's right or bottom edge a press resizes it, either side of the edge. */
  resizeEdgeScreenPx: 6,
  /** On screen, how near the size a hugging frame had a drag may end and leave it hugging. */
  resizeSnapScreenPx: 6,
} as const satisfies Record<string, number>;

// A fixed side cuts off what runs past it, while the caption above the frame stays: `overflow` would cut that too. Each
// shape keeps a strip above the frame, as wide as any caption, and clips at the fixed edges only.
const CLIP_SIDES = 'polygon(0 -100px, 3000px -100px, 3000px 0, 100% 0, 100% 100000px, 0 100000px)';
const CLIP_BOTTOM = 'polygon(-100000px -100px, 100000px -100px, 100000px 100%, -100000px 100%)';
const CLIP_BOTH = 'polygon(0 -100px, 3000px -100px, 3000px 0, 100% 0, 100% 100%, 0 100%)';

// A frame starts below its caption (a lone top-level frame's caption is a heading, as tall as a group's); a group's
// contents start below its heading, inside its padding.
const CAPTION_ROOM_PX = CHROME_LIMITS.captionHeightPx + CHROME_LIMITS.captionGapPx;
const HEADING_ROOM_PX = CHROME_LIMITS.headingHeightPx + CHROME_LIMITS.captionGapPx;
const GROUP_PADDING_TOP_PX = CHROME_LIMITS.groupPaddingPx + CHROME_LIMITS.headingHeightPx + CHROME_LIMITS.headingGapPx;

/** A box's outline at rest: quiet, so the editor's own hover and selection outlines (the same blue) stand out on it. */
const BOX_OUTLINE = 'rgba(47, 128, 255, 0.3)';

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
  // <body> the pannable, zoomable world, and in it the boxes: one per frame around its instance, and one per group
  // around the frames that share its values. Boxes are real elements the editor selects as divs; each draws its own
  // caption or heading (::before), which is not an element anyone can point at.
  //
  // The surface is the canvas Background setting when one is set (a variable the project drops falls back to the grey);
  // otherwise the script paints it with the background the site's own page shows (canvasScript sitePage). The world and
  // the boxes are scaffolding, immune to the project's CSS: every property that could move, paint or hide them is set
  // here !important, under selectors more specific than any element, universal, :where or attribute rule. A frame is
  // transparent unless a canvas Background setting paints it (inline, !important).
  //
  // In a cascade layer of its own, declared before any of the project's: for !important declarations the first layer
  // wins, over every later layer and over unlayered rules, so a project that imports its CSS into layers (Lumos does)
  // and marks a rule !important still cannot reach the scaffolding.
  const scaffold = 'html[data-stacki-ready] > body stacki-frame[data-frame]';
  const group = 'html[data-stacki-ready] > body stacki-group';
  // Every box is square, paints nothing and has a quiet blue outline at rest; hover and selection are the editor's own
  // outlines, as on any element. The widths here are for 100%; the page's script rewrites them for the zoom, so an
  // outline is as thin on screen at every zoom (frameSizes).
  const reset = `inset: auto !important; transform: none !important; box-sizing: border-box !important; max-height: none !important; min-height: 0 !important; margin: 0 !important; border: 0 !important; border-radius: 0 !important; outline: 1px solid ${BOX_OUTLINE} !important; outline-offset: -1px !important; background: transparent !important; box-shadow: none !important; filter: none !important; opacity: 1 !important; visibility: visible !important; float: none !important; overflow: visible !important;`;
  const type = `display: block !important; position: absolute !important; left: 0 !important; right: auto !important; padding: 0 !important; border: 0 !important; background: transparent !important; box-shadow: none !important; letter-spacing: 0 !important; word-spacing: 0 !important; text-transform: none !important; text-decoration: none !important; text-shadow: none !important; text-align: left !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; opacity: 1 !important; transform: none !important; filter: none !important; width: auto !important; min-width: 0 !important; float: none !important; user-select: none !important; cursor: default !important; visibility: visible !important;`;
  const css = `@layer ${CHROME_LAYER} {
html[data-stacki-ready] { height: 100% !important; overflow: hidden !important; margin: 0 !important; padding: 0 !important; border: 0 !important; touch-action: none; }
${surface === undefined ? '' : `html[data-stacki-ready][data-stacki-surface] { background: ${withFallback(surface, grey)} !important; }`}
html[data-stacki-ready] > body { position: absolute !important; left: 0 !important; top: 0 !important; right: auto !important; bottom: auto !important; margin: 0 !important; padding: 64px !important; border: 0 !important; box-sizing: content-box !important; display: flex !important; flex-flow: row nowrap !important; gap: ${String(CHROME_LIMITS.frameGapPx)}px !important; align-items: flex-start !important; justify-content: flex-start !important; transform-origin: 0 0 !important; width: max-content !important; height: auto !important; min-width: 0 !important; min-height: 0 !important; max-width: none !important; max-height: none !important; overflow: visible !important; background: transparent !important; box-shadow: none !important; filter: none !important; opacity: 1 !important; float: none !important; }
html[data-stacki-ready] > body[data-flow="column"] { flex-direction: column !important; gap: ${String(CHROME_LIMITS.groupGapPx)}px !important; }
${arrangementRules()}
html[data-stacki-panning], html[data-stacki-panning] * { cursor: grabbing !important; }
html[data-stacki-resize="x"], html[data-stacki-resize="x"] * { cursor: ew-resize !important; }
html[data-stacki-resize="y"], html[data-stacki-resize="y"] * { cursor: ns-resize !important; }
html[data-stacki-resize="xy"], html[data-stacki-resize="xy"] * { cursor: nwse-resize !important; }
${group} { display: flex !important; flex-flow: row nowrap !important; align-items: flex-start !important; justify-content: flex-start !important; gap: ${String(CHROME_LIMITS.frameGapPx)}px !important; flex: 0 0 auto !important; position: relative !important; width: max-content !important; height: auto !important; max-width: none !important; min-width: 0 !important; padding: ${String(GROUP_PADDING_TOP_PX)}px ${String(CHROME_LIMITS.groupPaddingPx)}px ${String(CHROME_LIMITS.groupPaddingPx)}px !important; ${reset} }
${group}:has(> stacki-group) { gap: ${String(CHROME_LIMITS.subgroupGapPx)}px !important; }
${group}::before { content: attr(data-label) !important; ${type} top: ${String(CHROME_LIMITS.groupPaddingPx)}px !important; left: ${String(CHROME_LIMITS.groupPaddingPx)}px !important; bottom: auto !important; margin: 0 !important; max-width: calc(100% - ${String(CHROME_LIMITS.groupPaddingPx * 2)}px) !important; height: ${String(CHROME_LIMITS.headingHeightPx)}px !important; font: ${HEADING_FONT} ${FONT_STACK} !important; color: ${TYPE_COLORS[theme].heading} !important; }
${group}:not([data-depth="0"])::before { font: ${SUBHEADING_FONT} ${FONT_STACK} !important; color: ${TYPE_COLORS[theme].subheading} !important; }
${group}::after { content: none !important; }
${scaffold} { flex: 0 0 auto !important; display: block !important; position: relative !important; width: max-content !important; height: auto !important; max-width: ${String(CHROME_LIMITS.hugWidthPxMax)}px !important; min-width: 24px !important; padding: ${String(CHROME_LIMITS.framePaddingPx)}px !important; ${reset} transform: translate(0) !important; margin-top: ${String(CAPTION_ROOM_PX)}px !important; }
${scaffold}::before { content: attr(data-label) !important; ${type} bottom: 100% !important; top: auto !important; margin: 0 0 ${String(CHROME_LIMITS.captionGapPx)}px !important; max-width: 100% !important; height: ${String(CHROME_LIMITS.captionHeightPx)}px !important; font: 400 12px/${String(CHROME_LIMITS.captionHeightPx)}px ${FONT_STACK} !important; color: ${label} !important; }
${scaffold}::after { content: none !important; }
${scaffold}[data-heading] { margin-top: ${String(HEADING_ROOM_PX)}px !important; }
${scaffold}[data-heading]::before { height: ${String(CHROME_LIMITS.headingHeightPx)}px !important; max-width: 100% !important; font: ${HEADING_FONT} ${FONT_STACK} !important; color: ${TYPE_COLORS[theme].heading} !important; }
${typeColorRules('light')}
${typeColorRules('dark')}
html[data-stacki-ready] > body stacki-frame[data-frame][data-selected]::before { color: #2f80ff !important; }
${scaffold}[data-target] { outline-color: #2f80ff !important; }
${scaffold}[data-under-tag]::before, ${group}[data-group][data-under-tag]::before, ${scaffold}[data-crowded]::before, ${group}[data-group][data-crowded]::before { visibility: hidden !important; }
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

// Each level's arrangement (canvasPage.ts), on the one element that holds that level's direct children, so no level
// reaches another's: the canvas's own on the root (data-stacki-arrange, over the page's flow), a group's on the group
// (data-arrange; none is side by side). Stacked puts what sits there in a column; wrap breaks its row at the wrap width.
function arrangementRules(): string {
  const root = (value: string): string => `html[data-stacki-ready][data-stacki-arrange="${value}"] > body`;
  const group = (value: string): string => `html[data-stacki-ready] > body stacki-group[data-arrange="${value}"]`;
  const groupPadding = CHROME_LIMITS.groupPaddingPx * 2;
  return [
    `${root('row')}, ${root('wrap')} { flex-direction: row !important; }`,
    `${root('column')} { flex-direction: column !important; }`,
    `${root('wrap')} { flex-wrap: wrap !important; max-width: ${String(CHROME_LIMITS.wrapWidthPx)}px !important; }`,
    `${group('column')} { flex-direction: column !important; }`,
    `${group('wrap')} { flex-wrap: wrap !important; max-width: ${String(CHROME_LIMITS.wrapWidthPx + groupPadding)}px !important; }`,
  ].join('\n');
}

// The type's colours over a light or a dark canvas, whatever the app's theme: the script says which it drew on.
function typeColorRules(on: 'light' | 'dark'): string {
  const colors = TYPE_COLORS[on];
  const within = `html[data-stacki-${on}] > body`;
  return [
    `${within} stacki-group[data-depth]::before { color: ${colors.subheading} !important; }`,
    `${within} stacki-group[data-depth="0"]::before, ${within} stacki-frame[data-frame][data-heading]::before { color: ${colors.heading} !important; }`,
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
  // What the editor has selected (useDesktopComponentCanvas.ts selectionOf) and the size of its tag on screen.
  var selected = null;
  var target = 'none';
  var selectedGroup = null;
  var tag = null;
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
  // Outlines keep their width on screen at any zoom; the spacing never changes with it. Captions and headings keep their
  // size on screen too, as a design tool's frame names do: their type, height and gap are written for the zoom, so they
  // read the same zoomed out as at 100%. Each is cut short at its box's width, so it never runs over the next frame's.
  // Zoomed out far enough, the room the canvas keeps above a frame (a few of its own pixels, under its group's heading)
  // can no longer hold them at that size: they then shrink, as little as keeps every label clear of the others and of
  // its neighbours' boxes (labelScale), but never below labelScaleMin, so they stay readable. A label that would still
  // overlap is hidden, headings kept before captions (crowd). The editor's tag over the selection keeps its size on
  // screen as well, so zoomed out it reaches over captions and headings nearby: those it covers are hidden while it
  // does (hideUnderTag), never drawn under it.
  var sizes = document.createElement('style');
  sizes.setAttribute('data-stacki-chrome', '');
  (document.head || root).appendChild(sizes);
  var SCAFFOLD = 'html[data-stacki-ready] > body stacki-frame[data-frame]', GROUP = 'html[data-stacki-ready] > body stacki-group';
  // The labels' size on screen against their size at 100%: 1 while they fit, less once the canvas is zoomed out past it.
  var typeScale = 1, labelledAt = null;
  function typeRule(selector, font, line, unit, gap) {
    var px = function (value) { return Math.round(value * unit * 1000) / 1000 + 'px !important'; };
    return selector + '::before { font-size: ' + px(font) + '; line-height: ' + px(line) + '; height: ' + px(line) + ';' + (gap ? ' margin-bottom: ' + px(gap) + ';' : '') + ' }';
  }
  function frameSizes(scale) {
    var thin = Math.round(1000 / scale) / 1000;
    var boxes = [SCAFFOLD, GROUP];
    var rule = '@layer ${CHROME_LAYER} { ' + boxes.map(function (box) { return box + ' { outline-width: ' + thin + 'px !important; outline-offset: ' + -thin + 'px !important; }'; }).join(' ');
    // The frames a scope choice would change, while it is pointed at: twice as strong.
    rule += ' ' + SCAFFOLD + '[data-target] { outline-width: ' + thin * 2 + 'px !important; outline-offset: ' + -thin * 2 + 'px !important; }';
    // The same selectors as the page's own type rules (chromeStyles), later in the same layer, so these sizes win.
    // Chosen again only for a new zoom (or new frames, relabel): a pan moves every box alike and changes no overlap.
    var next = scale === labelledAt ? typeScale : labelScale(scale), unit = next / scale;
    labelledAt = scale;
    rule += ' ' + typeRule(SCAFFOLD, 12, ${String(CHROME_LIMITS.captionHeightPx)}, unit, ${String(CHROME_LIMITS.captionGapPx)});
    rule += ' ' + typeRule(SCAFFOLD + '[data-heading]', 13, ${String(CHROME_LIMITS.headingHeightPx)}, unit, 0);
    rule += ' ' + typeRule(GROUP, 13, ${String(CHROME_LIMITS.headingHeightPx)}, unit, 0);
    rule += ' ' + typeRule(GROUP + ':not([data-depth="0"])', 13, ${String(CHROME_LIMITS.headingHeightPx)}, unit, 0) + ' }';
    if (sizes.textContent !== rule) {
      sizes.textContent = rule;
      typeScale = next;
      crowd(scale);
    }
    hideUnderTag();
  }
  // The element the editor's tag sits on: the selected frame's component, its box, or a group's box.
  function tagged() {
    if (target === 'group') return document.querySelector('stacki-group[data-group="' + selectedGroup + '"]');
    var all = frames();
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute('data-frame') !== selected) continue;
      return target === 'box' ? all[i] : target === 'component' ? all[i].firstElementChild : null;
    }
    return null;
  }
  // Where a box's caption or heading is on screen, at type times its size at 100%, cut short at the box's width: a
  // frame's above it, a group's inside its padding at the top. The bounds are the box's own, when already measured.
  function labelRect(box, scale, type, bounds) {
    bounds = bounds || box.getBoundingClientRect();
    var isGroup = box.tagName.toLowerCase() === 'stacki-group';
    var heading = isGroup || box.hasAttribute('data-heading');
    var height = (heading ? ${String(CHROME_LIMITS.headingHeightPx)} : ${String(CHROME_LIMITS.captionHeightPx)}) * type;
    var text = textWidth(box, isGroup ? (box.getAttribute('data-depth') === '0' ? '600 13px' : '500 13px') : heading ? '600 13px' : '400 12px') * type;
    if (isGroup) {
      var inset = ${String(CHROME_LIMITS.groupPaddingPx)} * scale;
      var room = Math.max(bounds.width - 2 * inset, 0);
      return { left: bounds.left + inset, top: bounds.top + inset, right: bounds.left + inset + Math.min(text, room), bottom: bounds.top + inset + height };
    }
    var bottom = bounds.top - ${String(CHROME_LIMITS.captionGapPx)} * type;
    return { left: bounds.left, top: bottom - height, right: bounds.left + Math.min(text, bounds.width), bottom: bottom };
  }
  function overlaps(a, b) { return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom; }
  // The boxes in the order their labels are kept: group headings first (the outermost first), then frames' captions.
  function boxesByRank() {
    var all = [].slice.call(document.querySelectorAll('stacki-frame, stacki-group'));
    var rank = function (box) { return box.tagName.toLowerCase() === 'stacki-group' ? Number(box.getAttribute('data-depth')) || 0 : ${String(CANVAS_LIMITS.splitPropsMax + 1)}; };
    return all.sort(function (a, b) { return rank(a) - rank(b); });
  }
  // Each box's label at the type size, and whether it would overlap a label kept before it, or a box that is neither its own
  // nor around it. A group's heading may reach over what the group holds, never over its neighbours.
  function placeLabels(scale, type, all, rects) {
    var kept = [], crowded = [];
    for (var i = 0; i < all.length; i++) {
      var box = all[i], label = labelRect(box, scale, type, rects[i]), over = false;
      var isGroup = box.tagName.toLowerCase() === 'stacki-group';
      for (var k = 0; k < kept.length && !over; k++) over = overlaps(label, kept[k]);
      for (var b = 0; b < all.length && !over; b++) {
        var other = all[b];
        if (other === box || other.contains(box) || (isGroup && box.contains(other))) continue;
        over = overlaps(label, rects[b]);
      }
      crowded.push(over);
      if (!over) kept.push(label);
    }
    return crowded;
  }
  // The largest label size, from their size at 100% down to the least they shrink to, at which no label overlaps: a few
  // steps, the zoom's own size among them where it is larger (the canvas's spacing always holds labels at that size).
  var TYPE_MIN = ${String(CHROME_LIMITS.labelScaleMin)};
  function labelScale(scale) {
    if (scale >= 1) return 1;
    var all = boxesByRank(), rects = all.map(function (box) { return box.getBoundingClientRect(); });
    var steps = [1, 0.9, 0.8, Math.max(scale, TYPE_MIN)];
    for (var i = 0; i < steps.length; i++) {
      if (steps[i] >= scale && placeLabels(scale, steps[i], all, rects).indexOf(true) < 0) return steps[i];
    }
    return Math.max(scale, TYPE_MIN);
  }
  // Labels that overlap even at the size chosen are hidden.
  function crowd(scale) {
    var all = boxesByRank(), rects = all.map(function (box) { return box.getBoundingClientRect(); });
    var crowded = placeLabels(scale, typeScale, all, rects);
    for (var i = 0; i < all.length; i++) flag(all[i], 'data-crowded', crowded[i]);
  }
  function hideUnderTag() {
    var anchor = tag && view ? tagged() : null;
    var cover = null;
    if (anchor) {
      var at = anchor.getBoundingClientRect();
      var top = tag.inside ? at.top : at.top - tag.height;
      cover = { left: at.left - 1, top: top - 1, right: at.left + tag.width + 1, bottom: top + tag.height + 1 };
    }
    var all = document.querySelectorAll('stacki-frame, stacki-group');
    for (var i = 0; i < all.length; i++) {
      var label = cover ? labelRect(all[i], view.scale, typeScale) : null;
      flag(all[i], 'data-under-tag', !!label && label.left < cover.right && cover.left < label.right && label.top < cover.bottom && cover.top < label.bottom);
    }
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
  function boxOf(node) { return node && node.closest ? node.closest('stacki-frame, stacki-group') : null; }
  function frames() { return document.querySelectorAll('stacki-frame'); }
  function groups() { return document.querySelectorAll('stacki-group'); }
  // A caption wider than its small component widens a hugging frame, equally on both sides so the component stays
  // centred, and the space between frames stays what it is. A fixed frame keeps its width and its caption is cut short.
  var room = document.createElement('style');
  room.setAttribute('data-stacki-chrome', '');
  (document.head || root).appendChild(room);
  var measure = document.createElement('canvas').getContext('2d');
  var widened = {};
  // Measured once per label and font: the labels' fit is weighed many times over at each zoom.
  var measured = {};
  function textWidth(element, font) {
    var text = element.getAttribute('data-label') || '', key = font + '|' + text;
    if (!(key in measured)) {
      measure.font = font + ' ${FONT_STACK}';
      measured[key] = Math.ceil(measure.measureText(text).width) + 1;
    }
    return measured[key];
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
      var header = textWidth(boxes[g], boxes[g].getAttribute('data-depth') === '0' ? '600 13px' : '500 13px') + ${String(CHROME_LIMITS.groupPaddingPx * 2)};
      rules += 'html[data-stacki-ready] > body stacki-group[data-group="' + boxes[g].getAttribute('data-group') + '"] { min-width: ' + header + 'px !important; } ';
    }
    var rule = '@layer ${CHROME_LAYER} { ' + rules + '}';
    if (room.textContent !== rule) {
      room.textContent = rule;
      widened = next;
    }
  }
  // The selected frame's caption is marked while its component or its box is selected.
  function mark() {
    var all = frames();
    for (var i = 0; i < all.length; i++) {
      flag(all[i], 'data-selected', all[i].getAttribute('data-frame') === selected && (target === 'component' || target === 'box'));
    }
    hideUnderTag();
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
  // Every image on the canvas loads now. A component's lazy image (Lumos's Img is lazy unless told otherwise) waits
  // for the browser to judge it near the viewport, and the canvas is a panned, zoomed world inside a root that never
  // scrolls: a frame's image could stay unloaded, its box showing only the image's placeholder fill. On a canvas every
  // frame is there to be seen, so none waits. Only the attribute on the rendered page changes, never the component.
  function eager() {
    var lazy = world.querySelectorAll('img[loading="lazy"], iframe[loading="lazy"]');
    for (var i = 0; i < lazy.length; i++) lazy[i].setAttribute('loading', 'eager');
  }
  // Each frame's size as drawn, told to the editor when it changes: a size turned Fixed starts at what the frame shows.
  var told = '';
  function tellSizes() {
    var all = frames(), sizes = {};
    for (var i = 0; i < all.length; i++) sizes[all[i].getAttribute('data-frame')] = [all[i].offsetWidth, all[i].offsetHeight];
    var text = JSON.stringify(sizes);
    if (text !== told) { told = text; post({ event: 'sizes', frames: sizes }); }
  }
  var queued = false;
  function settle() { queued = false; eager(); apply(); mark(); fallbacks(); captionRoom(); pageBackground(); labelColor(); tellSizes(); if (view) relabel(); }
  // After the frames change size or place, the labels' size is chosen again for the zoom as it is.
  function relabel() { labelledAt = null; sizes.textContent = ''; frameSizes(view.scale); }
  function queue() { if (!queued) { queued = true; requestAnimationFrame(settle); } }
  // The editor patches the page in place after each edit, which can put the server's attributes back: reapply ours.
  new MutationObserver(queue).observe(world, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'data-selected', 'class', 'loading', 'data-arrange'] });
  // The site's styles arrive in <head> after this script runs (the dev server injects them): settle again as they do.
  if (document.head) new MutationObserver(queue).observe(document.head, { childList: true });
  // An edit of the canvas root's classes changes <html> alone, in place: the page's background follows its theme. Only
  // what a theme can hang on is watched, never the attributes this script sets on the root.
  new MutationObserver(queue).observe(root, { attributes: true, attributeFilter: ['class', 'data-theme', 'data-stacki-surface', 'data-stacki-arrange'] });
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
  // Clicks belong to the editor (it selects a box, an instance, or the root between boxes). A press on the space
  // between boxes, a middle press or one with Space held pans.
  // Resizing the selected frame from its right edge (width), bottom edge (height) or corner (both), at any zoom: the
  // frame follows the pointer at once and the editor is told each new size, once a frame; letting go tells it the size
  // to save, once; Escape puts the frame back. A side that hugged and is let go of within a few pixels of its own size
  // keeps hugging. Nothing is saved here: the editor writes the size where a typed one would go.
  var resizing = null;
  var EDGE = ${String(CHROME_LIMITS.resizeEdgeScreenPx)}, SNAP = ${String(CHROME_LIMITS.resizeSnapScreenPx)};
  function selectedFrame() {
    if (target !== 'component' && target !== 'box') return null;
    var all = frames();
    for (var i = 0; i < all.length; i++) if (all[i].getAttribute('data-frame') === selected) return all[i];
    return null;
  }
  function edgeAt(x, y) {
    var frame = selectedFrame();
    if (!frame || space) return null;
    var r = frame.getBoundingClientRect();
    var right = Math.abs(x - r.right) <= EDGE && y >= r.top && y <= r.bottom + EDGE;
    var bottom = Math.abs(y - r.bottom) <= EDGE && x >= r.left && x <= r.right + EDGE;
    var side = right && bottom ? 'xy' : right ? 'x' : bottom ? 'y' : null;
    return side ? { frame: frame, side: side } : null;
  }
  function sizeOf(frame) { return { width: frame.offsetWidth, height: frame.offsetHeight }; }
  function tellResize(phase) {
    if (!resizing) return;
    var size = sizeOf(resizing.frame), message = { event: 'resize', frame: resizing.key, phase: phase };
    // A side let go of near the size it hugged at goes back to hugging.
    var hug = function (axis) { return phase === 'end' && resizing.hugged[axis] && Math.abs(size[axis] - resizing.start[axis]) * view.scale <= SNAP; };
    if (resizing.side !== 'y') message.width = hug('width') ? 'hug' : size.width;
    if (resizing.side !== 'x') message.height = hug('height') ? 'hug' : size.height;
    post(message);
  }
  function endResize(phase) {
    if (!resizing) return;
    var done = resizing;
    if (phase === 'cancel') {
      done.frame.setAttribute('style', done.style);
      if (!done.fixed.width) done.frame.removeAttribute('data-fixed-width');
      if (!done.fixed.height) done.frame.removeAttribute('data-fixed-height');
      post({ event: 'resize', frame: done.key, phase: 'cancel' });
    } else {
      tellResize('end');
    }
    resizing = null;
    root.removeAttribute('data-stacki-resize');
    window.removeEventListener('pointermove', onResizeMove, true);
    window.removeEventListener('pointerup', onResizeUp, true);
    window.removeEventListener('pointercancel', onResizeCancel, true);
  }
  var resizeQueued = false;
  function onResizeMove(event) {
    if (!resizing || !view) return;
    var r = resizing, scale = view.scale;
    if (r.side !== 'y') {
      var width = clamp(Math.round(r.start.width + (event.clientX - r.x) / scale), ${String(CANVAS_LIMITS.sizePxMin)}, ${String(CANVAS_LIMITS.sizePxMax)});
      r.frame.style.setProperty('width', width + 'px', 'important');
      r.frame.setAttribute('data-fixed-width', '');
    }
    if (r.side !== 'x') {
      var height = clamp(Math.round(r.start.height + (event.clientY - r.y) / scale), ${String(CANVAS_LIMITS.sizePxMin)}, ${String(CANVAS_LIMITS.sizePxMax)});
      r.frame.style.setProperty('height', height + 'px', 'important');
      r.frame.setAttribute('data-fixed-height', '');
    }
    if (!resizeQueued) { resizeQueued = true; requestAnimationFrame(function () { resizeQueued = false; tellResize('live'); }); }
  }
  function onResizeUp() { endResize('end'); }
  function onResizeCancel() { endResize('cancel'); }
  window.addEventListener('pointermove', function (event) {
    if (resizing || event.buttons !== 0) return;
    var edge = edgeAt(event.clientX, event.clientY);
    if (edge) root.setAttribute('data-stacki-resize', edge.side); else if (root.hasAttribute('data-stacki-resize')) root.removeAttribute('data-stacki-resize');
  }, true);
  window.addEventListener('keydown', function (event) { if (event.key === 'Escape' && resizing) { event.preventDefault(); endResize('cancel'); } }, true);
  window.addEventListener('pointerdown', function (event) {
    var edge = event.button === 0 ? edgeAt(event.clientX, event.clientY) : null;
    if (edge && view) {
      event.preventDefault();
      var frame = edge.frame;
      resizing = { frame: frame, key: frame.getAttribute('data-frame'), side: edge.side, x: event.clientX, y: event.clientY, start: sizeOf(frame), style: frame.getAttribute('style') || '',
        fixed: { width: frame.hasAttribute('data-fixed-width'), height: frame.hasAttribute('data-fixed-height') },
        hugged: { width: !frame.hasAttribute('data-fixed-width'), height: !frame.hasAttribute('data-fixed-height') } };
      root.setAttribute('data-stacki-resize', edge.side);
      try { frame.setPointerCapture(event.pointerId); } catch (e) {}
      window.addEventListener('pointermove', onResizeMove, true);
      window.addEventListener('pointerup', onResizeUp, true);
      window.addEventListener('pointercancel', onResizeCancel, true);
      return;
    }
    var background = !boxOf(event.target);
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
    if (data.command === 'select') {
      selected = typeof data.frame === 'string' ? data.frame : null;
      target = data.target === 'component' || data.target === 'box' || data.target === 'group' ? data.target : 'none';
      selectedGroup = target === 'group' && typeof data.group === 'string' && /^[^"\\\]]*$/.test(data.group) ? data.group : null;
      tag = null;
      mark();
    }
    // A colour being dragged in a picker, painted at once on the frames it will change (or the canvas root), before it
    // is saved: the page's own rewrite brings the saved value. Without a value, what was painted is taken back.
    if (data.command === 'paint' && Array.isArray(data.frames)) {
      var color = typeof data.value === 'string' && data.value.length <= 512 && !/[;{}<>]/.test(data.value) ? data.value : undefined;
      var painted = data.root === true ? [root] : [].filter.call(frames(), function (frame) { return data.frames.indexOf(frame.getAttribute('data-frame')) >= 0; });
      for (var p = 0; p < painted.length; p++) {
        var element = painted[p];
        if (!element.hasAttribute('data-stacki-paint')) element.setAttribute('data-stacki-paint', element.style.getPropertyValue('background'));
        if (color === undefined) {
          var before = element.getAttribute('data-stacki-paint');
          if (data.restore === true) {
            if (before) element.style.setProperty('background', before, 'important'); else element.style.removeProperty('background');
          }
          element.removeAttribute('data-stacki-paint');
        } else {
          element.style.setProperty('background', color, 'important');
        }
      }
    }
    if (data.command === 'cancelResize') endResize('cancel');
    if (data.command === 'targets' && Array.isArray(data.frames)) {
      var all = frames();
      for (var t = 0; t < all.length; t++) flag(all[t], 'data-target', data.frames.indexOf(all[t].getAttribute('data-frame')) >= 0);
    }
    if (data.command === 'tag' && isFinite(data.width) && isFinite(data.height) && data.width > 0 && data.height > 0) {
      tag = { width: data.width, height: data.height, inside: data.inside === true };
      hideUnderTag();
    }
    if (data.command === 'zoom' && view) {
      if (data.action === 'fit') { moved = false; fit(); }
      else zoomAt(data.action === 'reset' ? (isFinite(data.unit) && data.unit > 0 ? data.unit : 1) : data.action === 'in' ? view.scale * 1.25 : view.scale / 1.25, window.innerWidth / 2, window.innerHeight / 2);
    }
  });
  if (typeof ResizeObserver === 'function') {
    var refit = new ResizeObserver(function () { captionRoom(); tellSizes(); if (!moved) fit(); if (view) relabel(); });
    refit.observe(world);
    refit.observe(root);
  }
  eager();
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

/** A side's size a resize reports: pixels, or back to hugging. */
export type ResizeLength = number | 'hug';

interface CanvasMessage {
  readonly event: 'view' | 'ready' | 'sizes' | 'resize';
  /** A resize on the canvas (`resize`): the frame, how far along, and the sides it changes. */
  readonly resize?: {
    readonly frame: string;
    readonly phase: 'live' | 'end' | 'cancel';
    readonly width: ResizeLength | undefined;
    readonly height: ResizeLength | undefined;
  };
  readonly scale: number | undefined;
  /** Each frame's drawn width and height in the canvas's own pixels, by key (`sizes`). */
  readonly sizes: ReadonlyMap<string, { readonly width: number; readonly height: number }>;
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
  if (event === 'resize') {
    return resizeMessage(read);
  }
  if (event !== 'view' && event !== 'ready' && event !== 'sizes') {
    return undefined;
  }
  const scaleValue = read('scale');
  const scale = typeof scaleValue === 'number' && Number.isFinite(scaleValue) && scaleValue > 0 ? scaleValue : undefined;
  assert(id.length > 0, 'A canvas message is read for one canvas');
  return { event, scale, sizes: event === 'sizes' ? frameSizesOf(read('frames')) : new Map() };
}

const RESIZE_PHASES = ['live', 'end', 'cancel'] as const;

// A `resize` message: a frame key, a phase, and for each side it changes whole bounded pixels or `hug`.
function resizeMessage(read: (key: string) => unknown): CanvasMessage | undefined {
  const frame = read('frame');
  const phase = RESIZE_PHASES.find((candidate) => candidate === read('phase'));
  if (typeof frame !== 'string' || frame.length > CANVAS_LIMITS.keyCharsMax || phase === undefined) {
    return undefined;
  }
  const length = (value: unknown): ResizeLength | undefined =>
    value === 'hug'
      ? 'hug'
      : typeof value === 'number' && Number.isSafeInteger(value) && value >= CANVAS_LIMITS.sizePxMin && value <= CANVAS_LIMITS.sizePxMax
        ? value
        : undefined;
  const resize = { frame, phase, width: length(read('width')), height: length(read('height')) };
  assert(resize.phase === phase, 'A resize keeps its phase');
  return { event: 'resize', scale: undefined, sizes: new Map(), resize };
}

// The frames' sizes a `sizes` message holds: string keys to two whole, bounded pixel lengths; anything else is left out.
function frameSizesOf(input: unknown): ReadonlyMap<string, { readonly width: number; readonly height: number }> {
  const sizes = new Map<string, { readonly width: number; readonly height: number }>();
  if (typeof input !== 'object' || input === null) {
    return sizes;
  }
  const length = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= CANVAS_LIMITS.sizePxMax ? value : undefined;
  for (const [key, value] of Object.entries(input).slice(0, CANVAS_LIMITS.framesMax)) {
    const width = Array.isArray(value) ? length(value[0]) : undefined;
    const height = Array.isArray(value) ? length(value[1]) : undefined;
    if (key.length <= CANVAS_LIMITS.keyCharsMax && width !== undefined && height !== undefined) {
      sizes.set(key, { width, height });
    }
  }
  assert(sizes.size <= CANVAS_LIMITS.framesMax, 'A canvas reports a bounded number of frames');
  return sizes;
}
