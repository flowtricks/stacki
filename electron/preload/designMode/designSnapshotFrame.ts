// Design mode (experimental, removable: docs/design-mode/REMOVE.md), the canvas frame's half.
//
// A frame on Design mode's canvas is a copy of the page as the live canvas draws it: scripts removed, own-origin
// stylesheets and web fonts inlined so the copy looks the same from the app's origin (a font is fetched with CORS,
// and the dev server answers only its own origin), viewport-height units bound to a variable so a frame stretched
// to the whole page does not stretch its hero, and nested documents and media switched off, so eight frames cost
// eight documents and no more. Each element that stands for a node of the open file carries that node's path, the
// one a click on the live canvas would name (frameTargets.ts), so a click in a frame selects the same node.
//
// Nothing here changes the live document: the copy is made from a clone.
import {
  DESIGN_FRAME_WINDOW_NAME,
  DESIGN_ID_ATTRIBUTE,
  DESIGN_NODE_ATTRIBUTE,
  DESIGN_SNAPSHOT_LIMITS,
  parseDesignSnapshotRequest,
  type DesignCanvasMessage,
  type DesignSnapshotFailure,
  designNodeMark,
} from '../../../shared/ipc/designSnapshot';
import { PATH_ATTR, inScope, pathsOf, regions, runsOf } from '../frameRegions';
import { isElement } from '../frameBasics';
import { AssetBudget, inlinePictures, inlineStylePictures } from './designSnapshotAssets';
import { liveId, mirrorPreview } from './designLiveMirror';
import { FontInliner, freezeViewportUnits, rebaseCssURLs } from './designSnapshotCss';

/** Whether this document is one of the canvas's frames, where the preload installs nothing. */
export function isDesignFrameDocument(): boolean {
  try {
    return window.name === DESIGN_FRAME_WINDOW_NAME;
  } catch {
    return false;
  }
}

/** How long the page's styles must rest before the watch says they changed. */
const CHANGE_QUIET_MS = 120;

let watch: MutationObserver | undefined;

/** Answers the app's snapshot and watch requests, on the live canvas frame. */
export function listenForDesignSnapshots(): void {
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window.parent) {
      return;
    }
    const data: unknown = event.data;
    if (typeof data === 'object' && data && 'type' in data && typeof data.type === 'string') {
      mirrorPreview(data.type, post);
    }
    const request = parseDesignSnapshotRequest(event.data);
    if (request === undefined) {
      return;
    }
    if (request.type === 'stacki:design-watch') {
      watchStyles();
      return;
    }
    void snapshotMessage(request.nonce).then(post);
  });
}

function post(message: DesignCanvasMessage): void {
  window.parent.postMessage(message, '*');
}

// The head only: the dev server replaces a stylesheet's text there, and the editor's live rules are written there.
// The body's changes arrive as renderings, which the editor already hears of, and watching it would hear every
// frame of a page's own animation.
function watchStyles(): void {
  if (watch !== undefined || document.head === null) {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  watch = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => post({ type: 'stacki:design-changed' }), CHANGE_QUIET_MS);
  });
  watch.observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true });
}

async function snapshotMessage(nonce: string): Promise<DesignCanvasMessage> {
  const refused = (failure: DesignSnapshotFailure, detail: string): DesignCanvasMessage => ({
    type: 'stacki:design-snapshot-reply',
    nonce,
    ok: false,
    failure,
    detail: detail.slice(0, DESIGN_SNAPSHOT_LIMITS.detailCharsMax),
  });
  try {
    const root = document.documentElement;
    if (root === null || document.body === null) {
      return refused('no-document', 'no document yet');
    }
    const elements = root.getElementsByTagName('*').length;
    if (elements > DESIGN_SNAPSHOT_LIMITS.elementsMax) {
      return refused('too-many-elements', String(elements));
    }
    const html = await snapshotHTML(root);
    if (html.length > DESIGN_SNAPSHOT_LIMITS.htmlCharsMax) {
      return refused('too-large', String(html.length));
    }
    const bounded = (value: number): number => Math.max(0, Math.min(DESIGN_SNAPSHOT_LIMITS.pixelsMax, Math.round(value)));
    return {
      type: 'stacki:design-snapshot-reply',
      nonce,
      ok: true,
      snapshot: {
        html,
        url: (location.href.split('#')[0] ?? '').slice(0, DESIGN_SNAPSHOT_LIMITS.urlCharsMax),
        title: document.title.slice(0, DESIGN_SNAPSHOT_LIMITS.titleCharsMax),
        viewportWidthPx: bounded(window.innerWidth),
        viewportHeightPx: bounded(screenHeightPx()),
      },
    };
  } catch (error: unknown) {
    return refused('failed', String(error));
  }
}

/**
 * The screen height the page's `vh` units mean. A canvas frame is often stretched to the whole page, so its own
 * height says nothing; the canvas then freezes vh to the breakpoint's screen as `--avb-vh` (frameViewport.ts),
 * one hundredth of it. Without that, the frame is a screen and its height is the answer.
 */
function screenHeightPx(): number {
  const frozen = Number.parseFloat(document.documentElement.style.getPropertyValue('--avb-vh'));
  return Number.isFinite(frozen) && frozen > 0 ? frozen * 100 : window.innerHeight;
}

/** The editor's own pieces in the canvas document, the site's scripts, and what would redirect or fence a copy. */
const LEFT_OUT = [
  'script',
  'noscript',
  'template',
  'base',
  'meta[http-equiv]',
  'link[rel="modulepreload"]',
  'link[rel~="preload"]',
  'link[rel~="prefetch"]',
  // The live variable overrides stay: a picture taken while one is shown must show it.
  'style[id^="avb-"]:not(#avb-live-variables)',
  'link[id^="avb-"]',
  '[data-avb-text-marks]',
  '[data-avb-text-editor]',
  'astro-dev-toolbar',
  'vite-error-overlay',
].join(',');

/** A frame is a still picture that can be edited: nothing in it plays or arrives later. */
const STILL_CSS =
  '*, *::before, *::after { animation-duration: 1ms !important; animation-delay: 0s !important; animation-iteration-count: 1 !important; transition: none !important; caret-color: transparent !important; }';

/** Bounds the walk over a page's stylesheets. */
const SHEETS_MAX = 2_000;

async function snapshotHTML(root: HTMLElement): Promise<string> {
  // Cloned first, so the live page and the copy list their elements in the same order.
  const clone = root.cloneNode(true);
  if (!(clone instanceof HTMLElement)) {
    throw new Error('Assertion failed: a cloned root is an element');
  }
  markIds(root, clone);
  markNodes(root, clone);
  const assets = new AssetBudget();
  // Read while the copy still lists the page's elements one for one.
  await inlinePictures(root, clone, assets);
  copyFormState(root, clone);
  inlineStylesheets(root, clone);
  for (const piece of Array.from(clone.querySelectorAll(LEFT_OUT))) {
    piece.remove();
  }
  quiet(clone);
  const screen = screenHeightPx();
  clone.style.removeProperty('--avb-vh');
  clone.style.setProperty('--design-vh', `${String(screen / 100)}px`);
  for (const element of Array.from(clone.querySelectorAll('[style*="vh"]'))) {
    element.setAttribute('style', freezeViewportUnits(element.getAttribute('style') ?? ''));
  }
  for (const element of Array.from(clone.querySelectorAll('[style*="url("]'))) {
    element.setAttribute('style', await inlineStylePictures(rebaseCssURLs(element.getAttribute('style') ?? '', location.href), assets));
  }
  const fonts = new FontInliner(DESIGN_SNAPSHOT_LIMITS.fontsCharsMax, DESIGN_SNAPSHOT_LIMITS.fontsMax, fetchFontDataURL);
  for (const style of Array.from(clone.querySelectorAll('style')).slice(0, SHEETS_MAX)) {
    const base = style.getAttribute('data-design-base') ?? location.href;
    style.removeAttribute('data-design-base');
    const text = freezeViewportUnits(rebaseCssURLs(style.textContent ?? '', base));
    style.textContent = await inlineStylePictures(await fonts.inline(text), assets);
  }
  const head = clone.querySelector('head') ?? clone.insertBefore(document.createElement('head'), clone.firstChild);
  const base = document.createElement('base');
  base.setAttribute('href', document.baseURI);
  head.insertBefore(base, head.firstChild);
  const still = document.createElement('style');
  still.textContent = STILL_CSS;
  head.appendChild(still);
  return '<!DOCTYPE html>\n' + clone.outerHTML;
}

/** Writes on each element of the copy the id a live preview's report names its original by. */
function markIds(source: HTMLElement, target: HTMLElement): void {
  const sources = [source, ...Array.from(source.getElementsByTagName('*'))];
  const targets = [target, ...Array.from(target.getElementsByTagName('*'))];
  if (sources.length !== targets.length) {
    throw new Error('Assertion failed: markIds: a clone lists the same elements');
  }
  sources.forEach((element, index) => targets[index]?.setAttribute(DESIGN_ID_ATTRIBUTE, String(liveId(element))));
}

/** Writes on each element of the copy the nodes of the open file it stands for. */
function markNodes(source: HTMLElement, target: HTMLElement): void {
  const sources = [source, ...Array.from(source.getElementsByTagName('*'))];
  const targets = [target, ...Array.from(target.getElementsByTagName('*'))];
  if (sources.length !== targets.length) {
    throw new Error('Assertion failed: markNodes: a clone lists the same elements');
  }
  const marks = new Map<Element, Map<string, number>>();
  const mark = (element: Element, nodePath: string, copy: number): void => {
    const held = marks.get(element) ?? new Map<string, number>();
    if (!held.has(nodePath)) {
      held.set(nodePath, copy);
      marks.set(element, held);
    }
  };
  for (const nodePath of regions.keys()) {
    if (inScope(nodePath)) {
      (runsOf(nodePath) ?? []).forEach((run, copy) => {
        for (const node of run) {
          if (isElement(node)) {
            mark(node, nodePath, copy);
          }
        }
      });
    }
  }
  // A node addressed only by its tag (a link among a line's words) has no runs: its copies are its tagged
  // elements, counted in document order as a click counts them. Counted in one pass: asking per element
  // would walk the whole page once for each.
  const counted = new Map<string, number>();
  for (const element of Array.from(source.querySelectorAll(`[${PATH_ATTR}]`))) {
    for (const nodePath of pathsOf(element)) {
      if (inScope(nodePath) && !regions.has(nodePath)) {
        const copy = counted.get(nodePath) ?? 0;
        counted.set(nodePath, copy + 1);
        mark(element, nodePath, copy);
      }
    }
  }
  sources.forEach((element, index) => {
    const held = marks.get(element);
    const copy = targets[index];
    if (held !== undefined && copy !== undefined) {
      copy.setAttribute(DESIGN_NODE_ATTRIBUTE, [...held].map(([nodePath, at]) => designNodeMark(nodePath, at)).join(' '));
    }
  });
}

// A nested document could be another renderer process in every frame, and media would play in every one: each
// keeps its box and loses what it loads. Lazy pictures load now, since a frame shows the whole page at once.
function quiet(clone: HTMLElement): void {
  for (const nested of Array.from(clone.querySelectorAll('iframe, frame, object, embed'))) {
    for (const attribute of ['src', 'srcdoc', 'data']) {
      nested.removeAttribute(attribute);
    }
  }
  for (const media of Array.from(clone.querySelectorAll('video, audio'))) {
    media.removeAttribute('autoplay');
    media.removeAttribute('src');
    media.setAttribute('preload', 'none');
    for (const child of Array.from(media.querySelectorAll('source'))) {
      child.remove();
    }
  }
  for (const image of Array.from(clone.querySelectorAll('img[loading="lazy"]'))) {
    image.setAttribute('loading', 'eager');
  }
}

/** Form values live in properties, which a clone does not carry: written as attributes so the copy shows what was typed. */
function copyFormState(source: HTMLElement, target: HTMLElement): void {
  const sources = Array.from(source.querySelectorAll('input, textarea, select'));
  const targets = Array.from(target.querySelectorAll('input, textarea, select'));
  if (sources.length !== targets.length) {
    return;
  }
  sources.forEach((element, index) => {
    const copy = targets[index];
    if (element instanceof HTMLInputElement && copy instanceof HTMLInputElement) {
      // A password's text is never copied out of the page.
      if (element.type !== 'password' && element.type !== 'file') {
        copy.setAttribute('value', element.value);
      }
      copy.toggleAttribute('checked', element.checked);
    } else if (element instanceof HTMLTextAreaElement && copy instanceof HTMLTextAreaElement) {
      copy.textContent = element.value;
    } else if (element instanceof HTMLSelectElement && copy instanceof HTMLSelectElement) {
      Array.from(copy.options).forEach((option, optionIndex) => option.toggleAttribute('selected', optionIndex === element.selectedIndex));
    }
  });
}

/**
 * A stylesheet linked from this origin becomes a <style> of its rules, its relative URLs made absolute: the
 * copy is read from another origin, where a linked sheet's fonts would be refused. A sheet this frame cannot
 * read (another origin) keeps its link; its own fonts are that origin's business.
 */
function inlineStylesheets(source: HTMLElement, target: HTMLElement): void {
  const links = Array.from(source.querySelectorAll('link[rel~="stylesheet"]')).slice(0, SHEETS_MAX);
  const copies = Array.from(target.querySelectorAll('link[rel~="stylesheet"]')).slice(0, SHEETS_MAX);
  if (links.length !== copies.length) {
    return;
  }
  links.forEach((link, index) => {
    const copy = copies[index];
    if (!(link instanceof HTMLLinkElement) || copy === undefined || link.href === '') {
      return;
    }
    copy.setAttribute('href', link.href);
    const sheet = link.sheet;
    if (sheet === null) {
      return;
    }
    let text: string;
    try {
      text = Array.from(sheet.cssRules)
        .map((rule) => rule.cssText)
        .join('\n');
    } catch {
      return; // Another origin: the link stays, now absolute.
    }
    const style = document.createElement('style');
    const id = copy.getAttribute(DESIGN_ID_ATTRIBUTE);
    if (id !== null) {
      style.setAttribute(DESIGN_ID_ATTRIBUTE, id);
    }
    const media = link.getAttribute('media');
    if (media !== null) {
      style.setAttribute('media', media);
    }
    style.setAttribute('data-design-base', link.href);
    style.textContent = text;
    copy.replaceWith(style);
  });
}

/** Fonts already read for this document: a snapshot follows every change, and a font does not change under it. */
const fontData = new Map<string, string>();

async function fetchFontDataURL(url: string): Promise<string | undefined> {
  const held = fontData.get(url);
  if (held !== undefined) {
    return held;
  }
  const data = await readFontDataURL(url);
  if (data !== undefined && fontData.size < DESIGN_SNAPSHOT_LIMITS.fontsMax) {
    fontData.set(url, data);
  }
  return data;
}

async function readFontDataURL(url: string): Promise<string | undefined> {
  const response = await fetch(url, { cache: 'force-cache', credentials: 'same-origin' });
  if (!response.ok) {
    return undefined;
  }
  const blob = await response.blob();
  // Three base64 characters for every two bytes, rounded up: checked before reading the whole file in.
  if (Math.ceil((blob.size * 4) / 3) > DESIGN_SNAPSHOT_LIMITS.fontCharsMax) {
    return undefined;
  }
  return await new Promise<string | undefined>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : undefined);
    reader.onerror = () => resolve(undefined);
    reader.readAsDataURL(blob);
  });
}
