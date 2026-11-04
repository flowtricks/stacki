// The box a node's ::before or ::after draws, for its outline.
//
// A pseudo-element is not in the DOM, so nothing measures it: no
// getBoundingClientRect, no Range. So a stand-in is measured instead: a span
// given every computed property of the pseudo-element (and its text, when
// `content` is plain strings), put where the browser puts it (first child for
// ::before, last for ::after). While the stand-in is there, a `:has()` rule
// hides the real pseudo-element, so an in-flow one does not push the
// stand-in aside: the stand-in takes exactly its place. It is added, measured
// and removed in one go, and carries the probe attribute, so the page's own
// mutation watch reads it as the canvas's own write (frameReports
// mutationKind) and starts no new measurement.

import { assert } from '../../shared/core/assert';
import { type PseudoLayer } from '../../shared/page/pseudoPath';
import { PROBE_ATTR, isElement, type Box, type Rect } from './frameBasics';
import { elementsWithPath, runsOf, toRect } from './frameRegions';

/** A node has at most this many places measured for its pseudo-element outline. */
const PSEUDO_PLACES_MAX = 64;
/** At most this many computed properties are copied to a stand-in. */
const PSEUDO_PROPERTIES_MAX = 1024;
const SHEET_ID = 'avb-pseudo-measure';

/** One box per place the node renders its `pseudo`, where it draws one. */
export function rectsForPseudo(nodePath: string, pseudo: PseudoLayer): Rect[] {
  const out: Rect[] = [];
  for (const element of placesOf(nodePath)) {
    if (out.length < PSEUDO_PLACES_MAX) {
      const box = measurePseudo(element, pseudo);
      if (box !== undefined) {
        out.push(toRect(box));
      }
    }
  }
  assert(out.length <= PSEUDO_PLACES_MAX, 'rectsForPseudo: places are capped');
  return out;
}

// The element of each place the node renders, first element of each run.
function placesOf(nodePath: string): Element[] {
  const elements: Element[] = [];
  for (const run of runsOf(nodePath) ?? []) {
    const element = run.find((node): node is Element => isElement(node) && node.tagName !== 'TEMPLATE');
    if (element !== undefined && element.isConnected) {
      elements.push(element);
    }
  }
  return elements.length > 0 ? elements : elementsWithPath(nodePath);
}

/** The box `host`'s `pseudo` draws, in viewport pixels, or undefined where it draws none. */
export function measurePseudo(host: Element, pseudo: PseudoLayer): Box | undefined {
  const style = window.getComputedStyle(host, `::${pseudo}`);
  if (!drawn(style)) {
    return undefined;
  }
  ensureSheet();
  const standIn = document.createElement('span');
  standIn.setAttribute(PROBE_ATTR, pseudo);
  const count = Math.min(style.length, PSEUDO_PROPERTIES_MAX);
  for (let index = 0; index < count; index++) {
    const name = style.item(index);
    standIn.style.setProperty(name, style.getPropertyValue(name), 'important');
  }
  standIn.style.setProperty('pointer-events', 'none', 'important');
  standIn.textContent = contentText(style.content);
  if (pseudo === 'before') {
    host.insertBefore(standIn, host.firstChild);
  } else {
    host.appendChild(standIn);
  }
  const rect = standIn.getBoundingClientRect();
  standIn.remove();
  assert(!standIn.isConnected, 'measurePseudo: the stand-in is gone');
  if (rect.width === 0 && rect.height === 0) {
    return undefined;
  }
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

// Whether a pseudo-element is drawn: `content` other than none/normal, and displayed.
function drawn(style: CSSStyleDeclaration): boolean {
  if (style.display === 'none') {
    return false;
  }
  return style.content !== 'none' && style.content !== 'normal' && style.content !== '';
}

// The text of a `content` made of quoted strings (`"" `, `"→"`, `"a" "b"`);
// empty for anything else (counter(), attr(), url()), whose box the copied
// width and height still give.
function contentText(content: string): string {
  const parts = content.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g) ?? [];
  return parts.map((part) => part.slice(1, -1).replace(/\\(.)/g, '$1')).join('');
}

// The rule that hides the real pseudo-element while its stand-in is measured.
function ensureSheet(): void {
  if (document.getElementById(SHEET_ID) !== null) {
    return;
  }
  const sheet = document.createElement('style');
  sheet.id = SHEET_ID;
  sheet.setAttribute(PROBE_ATTR, '');
  sheet.textContent = `:has(> [${PROBE_ATTR}="before"])::before{display:none!important}` + `:has(> [${PROBE_ATTR}="after"])::after{display:none!important}`;
  (document.head ?? document.documentElement).appendChild(sheet);
  assert(document.getElementById(SHEET_ID) === sheet, 'ensureSheet: the sheet is in place');
}
