// Design mode (experimental, removable: src/app/designMode/REMOVE.md), the canvas frame's half.
//
// The renderer cannot read the canvas: the page is the dev server's origin and the app is another. So the
// frame answers three read-only requests, and nothing else (shared/designMode/designModeContract.ts):
//
// - `snapshot`: a copy of the document as it is drawn now, scripts removed, its own-origin stylesheets and
//   web fonts inlined so the copy looks the same from the app's origin (a font is fetched with CORS, and the
//   dev server answers only its own origin), and viewport-height units bound to a variable so a frame
//   stretched to the whole page does not stretch its hero.
// - `render` and `preview`: the frame fetches its own origin's design render route or palette preview and
//   hands the text back. Both routes only read (electron/previewServer/designMode/designRender.ts).
//
// Nothing here changes the live document: the copy is made from a clone, and the editor's own markers,
// overlays and styles are removed from the clone only.
import {
  DESIGN_MODE_ENABLED,
  DESIGN_MODE_LIMITS,
  DESIGN_RENDER_ROUTE,
  DESIGN_SANDBOX_FRAME_NAME,
  designModeReplyMessage,
  parseDesignModeRequest,
  type DesignModeReply,
  type DesignModeRequest,
} from '../../../shared/designMode/designModeContract';
import { FontInliner, freezeViewportUnits, rebaseCssURLs } from './designSnapshotCss';

/** Whether this frame is one of Design mode's sandbox copies: the renderer's own document, where the preload installs nothing. */
export function isDesignModeSandbox(): boolean {
  try {
    return window.name === DESIGN_SANDBOX_FRAME_NAME;
  } catch {
    return false;
  }
}

/** Answers Design mode's requests from the app. Inert when the feature is switched off. */
export function listenForDesignModeRequests(): void {
  if (!DESIGN_MODE_ENABLED) {
    return;
  }
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window.parent) {
      return;
    }
    const request = parseDesignModeRequest(event.data);
    if (request === undefined) {
      return;
    }
    void answer(request).then((reply) => {
      window.parent.postMessage(designModeReplyMessage(reply), '*');
    });
  });
}

async function answer(request: DesignModeRequest): Promise<DesignModeReply> {
  try {
    switch (request.op) {
      case 'snapshot':
        return await snapshotReply(request.nonce);
      case 'render':
        return await relayed(request.nonce, DESIGN_RENDER_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request.body),
        });
      case 'preview': {
        const query = new URLSearchParams({ p: request.component, layout: 'snapshot' });
        return await relayed(request.nonce, '/__avb/preview?' + query.toString(), { method: 'GET' });
      }
      default: {
        const exhaustive: never = request;
        return exhaustive;
      }
    }
  } catch (error: unknown) {
    return { nonce: request.nonce, ok: false, failure: 'fetch-failed', detail: String(error).slice(0, DESIGN_MODE_LIMITS.detailCharsMax) };
  }
}

async function relayed(nonce: string, route: string, init: RequestInit): Promise<DesignModeReply> {
  // Same origin only: the route is one of the two fixed paths above, resolved against this page.
  const target = new URL(route, location.href);
  if (target.origin !== location.origin) {
    return { nonce, ok: false, failure: 'refused', detail: 'cross-origin route' };
  }
  const response = await fetch(target.href, { ...init, cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
  const text = await response.text();
  if (text.length > DESIGN_MODE_LIMITS.replyCharsMax) {
    return { nonce, ok: false, failure: 'too-large', detail: String(text.length) };
  }
  if (!response.ok) {
    return { nonce, ok: false, failure: 'fetch-failed', detail: text.slice(0, DESIGN_MODE_LIMITS.detailCharsMax) };
  }
  return { nonce, ok: true, kind: 'html', html: text };
}

async function snapshotReply(nonce: string): Promise<DesignModeReply> {
  const root = document.documentElement;
  if (root === null || document.body === null) {
    return { nonce, ok: false, failure: 'no-document', detail: 'no document yet' };
  }
  const html = await snapshotHTML(root);
  if (html.length > DESIGN_MODE_LIMITS.snapshotCharsMax) {
    return { nonce, ok: false, failure: 'too-large', detail: String(html.length) };
  }
  return {
    nonce,
    ok: true,
    kind: 'snapshot',
    snapshot: {
      html,
      url: location.href.split('#')[0] ?? location.href,
      title: document.title.slice(0, DESIGN_MODE_LIMITS.titleCharsMax),
      viewportWidthPx: Math.max(0, Math.min(DESIGN_MODE_LIMITS.pixelsMax, window.innerWidth)),
      viewportHeightPx: Math.max(0, Math.min(DESIGN_MODE_LIMITS.pixelsMax, screenHeightPx())),
    },
  };
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

/** The editor's own pieces in the canvas document: styles, overlays and editors the preload adds, never the site's. */
const EDITOR_PIECES = [
  'script',
  'noscript',
  'template',
  'link[rel="modulepreload"]',
  'link[rel="preload"][as="script"]',
  'style[id^="avb-"]',
  'link[id^="avb-"]',
  '[data-avb-text-marks]',
  '[data-avb-text-editor]',
  'astro-dev-toolbar',
  'vite-error-overlay',
].join(',');

/** Bounds the walk over a page's elements and stylesheets. */
const ELEMENTS_MAX = 200_000;
const SHEETS_MAX = 2_000;

async function snapshotHTML(root: HTMLElement): Promise<string> {
  // Cloned first, so the live page and the copy list their elements in the same order.
  const clone = root.cloneNode(true);
  if (!(clone instanceof HTMLElement)) {
    throw new Error('Assertion failed: a cloned root is an element');
  }
  copyFormState(root, clone);
  inlineStylesheets(root, clone);
  for (const piece of Array.from(clone.querySelectorAll(EDITOR_PIECES)).slice(0, ELEMENTS_MAX)) {
    piece.remove();
  }
  clone.style.removeProperty('--avb-vh');
  if (clone.getAttribute('style') === '') {
    clone.removeAttribute('style');
  }
  for (const image of Array.from(clone.querySelectorAll('img[loading="lazy"], iframe[loading="lazy"]'))) {
    // A frame shows the whole page at once; a lazy image below a screen would stay empty in a screenshot.
    image.setAttribute('loading', 'eager');
  }
  for (const element of Array.from(clone.querySelectorAll('[style*="vh"]')).slice(0, ELEMENTS_MAX)) {
    element.setAttribute('style', freezeViewportUnits(element.getAttribute('style') ?? ''));
  }
  const fonts = new FontInliner(DESIGN_MODE_LIMITS.fontsCharsMax, DESIGN_MODE_LIMITS.fontsMax, fetchFontDataURL);
  for (const style of Array.from(clone.querySelectorAll('style')).slice(0, SHEETS_MAX)) {
    const base = style.getAttribute('data-design-base') ?? location.href;
    style.removeAttribute('data-design-base');
    const text = freezeViewportUnits(rebaseCssURLs(style.textContent ?? '', base));
    style.textContent = await fonts.inline(text);
  }
  const head = clone.querySelector('head') ?? clone.insertBefore(document.createElement('head'), clone.firstChild);
  const base = document.createElement('base');
  base.setAttribute('href', document.baseURI);
  for (const existing of Array.from(head.querySelectorAll('base'))) {
    existing.remove();
  }
  head.insertBefore(base, head.firstChild);
  return '<!DOCTYPE html>\n' + clone.outerHTML;
}

/** Form values live in properties, which a clone does not carry: written as attributes so the copy shows what was typed. */
function copyFormState(source: HTMLElement, target: HTMLElement): void {
  const sources = Array.from(source.querySelectorAll('input, textarea, select')).slice(0, ELEMENTS_MAX);
  const targets = Array.from(target.querySelectorAll('input, textarea, select')).slice(0, ELEMENTS_MAX);
  if (sources.length !== targets.length) {
    return;
  }
  sources.forEach((element, index) => {
    const copy = targets[index];
    if (element instanceof HTMLInputElement && copy instanceof HTMLInputElement) {
      copy.setAttribute('value', element.value);
      if (element.checked) {
        copy.setAttribute('checked', '');
      } else {
        copy.removeAttribute('checked');
      }
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
    if (!(link instanceof HTMLLinkElement) || copy === undefined) {
      return;
    }
    const href = link.href;
    if (href === '') {
      return;
    }
    copy.setAttribute('href', href);
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
    const media = link.getAttribute('media');
    if (media !== null) {
      style.setAttribute('media', media);
    }
    style.setAttribute('data-design-base', href);
    style.textContent = text;
    copy.replaceWith(style);
  });
}

async function fetchFontDataURL(url: string): Promise<string | undefined> {
  const response = await fetch(url, { cache: 'force-cache', credentials: 'same-origin' });
  if (!response.ok) {
    return undefined;
  }
  const blob = await response.blob();
  // Three base64 characters for every two bytes, rounded up: checked before reading the whole file in.
  if (Math.ceil((blob.size * 4) / 3) > DESIGN_MODE_LIMITS.fontCharsMax) {
    return undefined;
  }
  return await new Promise<string | undefined>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : undefined);
    reader.onerror = () => resolve(undefined);
    reader.readAsDataURL(blob);
  });
}
