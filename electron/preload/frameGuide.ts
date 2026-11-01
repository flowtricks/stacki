// What the column guide is drawn from: the page's own layout values, measured
// where they apply. The guide is drawn by the app over the frame
// (src/features/preview/GuideOverlay.tsx); the frame only says how wide the
// page is and what its margin, gutter, maximum width and column count come to
// at that width.
//
// The values are read from the page, never written to it. A project that
// declares them (Lumos does: `--site-margin`, `--site-gutter`,
// `--max-width-main`) gets a guide that follows its fluid `clamp()` values at
// every preview width; a project that declares none gets `undefined` for each.
// A variable typed into the guide's menu (`--container-padding`) is sent here
// by name and measured the same way, so a project with its own names follows
// its own fluid values too; each name is also read as a whole number, for a
// column count of the project's own (`--grid-columns`). Which value wins is the app's to decide
// (src/features/preview/guideModel.ts).

import { PROBE_ATTR } from './frameBasics';

// The custom properties a guide is built from, as Lumos names them. The app
// keeps the same names (GUIDE_PROJECT_VARIABLES): the preload imports nothing
// of the renderer's.
const GUIDE_VARIABLES = {
  margin: '--site-margin',
  gutter: '--site-gutter',
  widthMax: '--max-width-main',
} as const;
const COLUMN_COUNT_PATTERN = /^\d{1,3}$/;
// One name per menu value plus the column fallback, each a custom property
// name within the app's own bound (guideModel.ts).
const MENU_VARIABLES_MAX = 5;
const MENU_VARIABLE_CHARS_MAX = 64;
const MENU_VARIABLE_PATTERN = /^--[A-Za-z0-9_-]+$/;

/** How the host sends to the editor: the desktop canvas and Studio each post their own way. */
export type GuidePost = (message: unknown) => void;

/** The page side of the column guide, as a host wires it. */
export interface GuideFrame {
  /** Handles a message from the editor, once the host has checked its sender. */
  readonly receive: (data: unknown) => void;
}

// What was last posted, so a measurement that changed nothing stays quiet.
let lastSent = '';
let measureQueued = false;
// The variables typed into the guide's menu, as the editor last sent them.
let menuVariables: readonly string[] = [];
let post: GuidePost = () => undefined;

/** Starts reporting the guide's measurements, now and whenever they may change. */
export function startGuide(send: GuidePost): GuideFrame {
  post = send;
  queueGuide();
  window.addEventListener('load', queueGuide);
  window.addEventListener('resize', queueGuide);
  // A page patched in place after an edit (electron/previewClient/morphClient.ts).
  document.addEventListener('avb:morphed', queueGuide);
  watchStyles();
  return { receive: receiveGuideMessage };
}

// The editor sends the menu's variables when a frame loads and whenever they
// change. Each message asks for a full report, even one that repeats the last:
// the editor listening now may not have heard the earlier ones.
function receiveGuideMessage(data: unknown): void {
  if (messageType(data) === 'avb:guide-variables') {
    menuVariables = parseMenuVariables(data);
    lastSent = '';
    queueGuide();
  }
}

// The dev server delivers CSS by swapping a <style> in <head>, so an edited
// margin arrives there. A changed root font size or layout arrives as a resize.
function watchStyles(): void {
  try {
    new MutationObserver(queueGuide).observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    new ResizeObserver(queueGuide).observe(document.documentElement);
  } catch {
    /* No observers: load and resize still report. */
  }
}

// One measurement per frame, however many changes asked for it.
function queueGuide(): void {
  if (measureQueued) {
    return;
  }
  measureQueued = true;
  requestAnimationFrame(() => {
    measureQueued = false;
    sendGuide();
  });
}

function sendGuide(): void {
  const body = document.body;
  if (!body) {
    return;
  }
  const message = measureGuide(body);
  const key = JSON.stringify(message);
  if (key === lastSent) {
    return;
  }
  lastSent = key;
  try {
    post(message);
  } catch {
    /* The editor went away. */
  }
}

// A throwaway element in the body takes each value as its width, and the
// engine resolves it: `clamp()`, `rem` and `100vw` come back as pixels at the
// frame's current width. Each probe is removed before the frame paints.
function measureGuide(body: HTMLElement) {
  const root = document.documentElement;
  const rootStyle = getComputedStyle(root);
  return {
    type: 'avb:guide',
    viewportWidth: root.clientWidth,
    rootFontSize: Number.parseFloat(rootStyle.fontSize),
    margin: lengthOf(body, rootStyle, GUIDE_VARIABLES.margin),
    gutter: lengthOf(body, rootStyle, GUIDE_VARIABLES.gutter),
    widthMax: lengthOf(body, rootStyle, GUIDE_VARIABLES.widthMax),
    variables: Object.fromEntries(menuVariables.map((name) => [name, lengthOf(body, rootStyle, name)])),
    // The same names read as a column count: a whole number on :root.
    counts: Object.fromEntries(menuVariables.map((name) => [name, countOf(rootStyle.getPropertyValue(name))])),
  };
}

// A declared length, in pixels, or undefined for one the page does not declare.
function lengthOf(body: HTMLElement, rootStyle: CSSStyleDeclaration, variable: string): number | undefined {
  const declared = rootStyle.getPropertyValue(variable).trim();
  if (declared === '' || declared === 'none') {
    return undefined;
  }
  const probe = appendProbe(body, `width:var(${variable})`);
  try {
    const width = probe.getBoundingClientRect().width;
    return Number.isFinite(width) ? width : undefined;
  } finally {
    probe.remove();
  }
}

// An invisible, zero-height element the canvas owns: its own writes never
// start a page walk (mutationKind in frameReports.ts).
function appendProbe(body: HTMLElement, style: string): HTMLElement {
  const probe = document.createElement('div');
  probe.setAttribute(PROBE_ATTR, '');
  probe.setAttribute(
    'style',
    'position:absolute;left:0;top:0;height:0;margin:0;padding:0;border:0;' + 'box-sizing:content-box;visibility:hidden;pointer-events:none;' + style,
  );
  body.appendChild(probe);
  return probe;
}

function countOf(declared: string): number | undefined {
  const value = declared.trim();
  return COLUMN_COUNT_PATTERN.test(value) ? Number.parseInt(value, 10) : undefined;
}

function messageType(input: unknown): unknown {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  return 'type' in input ? input.type : undefined;
}

// The names the app sent, checked here too: each is written into a probe's
// style attribute as `var(<name>)`, so only plain custom property names are
// accepted. A message with an invalid name, or too many, measures nothing.
function parseMenuVariables(input: unknown): readonly string[] {
  if (typeof input !== 'object' || input === null) {
    return [];
  }
  const names: unknown = 'names' in input ? input.names : undefined;
  if (!Array.isArray(names)) {
    return [];
  }
  if (names.length > MENU_VARIABLES_MAX) {
    return [];
  }
  const valid = names.filter(isMenuVariable);
  return valid.length === names.length ? valid : [];
}

function isMenuVariable(name: unknown): name is string {
  if (typeof name !== 'string') {
    return false;
  }
  if (name.length > MENU_VARIABLE_CHARS_MAX) {
    return false;
  }
  return MENU_VARIABLE_PATTERN.test(name);
}
