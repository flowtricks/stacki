// A rendered page as the shared rendered checks read it (shared/page/auditRendered.ts):
// the dev server's HTML parsed by the browser into a plain tree, each element
// with the source location its `<!--avb-s:…-->` marker names. For contrast the
// page is laid out in a hidden, script-less frame, and each element carries its
// computed colour, the background composited behind it, and its font size.
//
// Hand-rolled rather than axe-core (docs/dependencies.md, "Evaluated, not
// adopted"): the checks map straight onto source locations and fixes, and the
// frame never runs the page's scripts.
import { assert } from '../../../shared/core/assert';
import { AUDIT_LIMITS } from '../../../shared/page/auditFindings';
import { LIMITS } from '../../../shared/core/limits';
import { blend, parseCssColor, type Rgba } from '../../../shared/page/auditContrast';
import { parseMarker, type RenderedElement, type RenderedNode, type RenderedSource, type RenderedStyle } from '../../../shared/page/auditRendered';

const FRAME_LOAD_MS_MAX = 6_000;
const STYLED_ELEMENTS_MAX = 6_000;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const WHITE: Rgba = { red: 255, green: 255, blue: 255, alpha: 1 };

/** The plain tree of `document`, its locations read from markers naming `pageFile`. */
export function renderedTree(document: Document, pageFile: string, styleOf?: (element: Element) => RenderedStyle | undefined): RenderedElement {
  const root = document.documentElement;
  assert(root !== null, 'renderedTree: a document has a root');
  let budget = AUDIT_LIMITS.elementsPerFileMax * 4;
  // Recursion follows the DOM; below the depth bound an element is read without its children, and the budget bounds the total.
  const convert = (element: Element, source: RenderedSource | undefined, depth: number): RenderedElement => {
    budget -= 1;
    assert(budget >= 0, 'renderedTree: a rendered page stays bounded');
    assert(depth <= LIMITS.ipcDepthMax + 1, 'renderedTree: the walk stops descending at the depth bound');
    const children: RenderedNode[] = [];
    const nodes = depth <= LIMITS.ipcDepthMax ? Array.from(element.childNodes) : [];
    let marker: RenderedSource | undefined;
    for (const child of nodes) {
      if (child.nodeType === 8) {
        marker = parseMarker(child.textContent ?? '', pageFile) ?? marker;
      } else if (child.nodeType === 3) {
        const value = child.textContent ?? '';
        if (value.trim().length > 0) {
          // A text's own marker is written right before it; it is that text node's location.
          children.push(marker === undefined ? { kind: 'text', value } : { kind: 'text', value, source: marker });
          marker = undefined;
        } else {
          children.push({ kind: 'text', value });
        }
      } else if (child.nodeType === 1 && child instanceof Element) {
        children.push(convert(child, marker ?? inherited(source), depth + 1));
        marker = undefined;
      }
    }
    const attrs: Record<string, string> = {};
    for (const attribute of Array.from(element.attributes)) {
      attrs[attribute.name.toLowerCase()] = attribute.value;
    }
    return {
      kind: 'element', // SVG keeps its camel case (`clipPath`); HTML is lower case, as the checks compare it.
      tag: element.namespaceURI === SVG_NAMESPACE ? element.tagName : element.tagName.toLowerCase(),
      attrs,
      children,
      source,
      style: styleOf?.(element),
    };
  };
  return convert(root, undefined, 0);
}

/** The location an unmarked element takes from its parent: the parent's own, marked as an ancestor's. */
function inherited(source: RenderedSource | undefined): RenderedSource | undefined {
  return source === undefined || source.ancestor === true ? source : { ...source, ancestor: true };
}

/** `html` parsed without layout: every check but contrast. */
export function parsedTree(html: string, pageFile: string): RenderedElement {
  const document = new DOMParser().parseFromString(html, 'text/html');
  return renderedTree(document, pageFile);
}

/** `html` laid out in a hidden frame that runs no scripts, with computed styles for contrast. */
export async function styledTree(html: string, pageFile: string, baseURL: string): Promise<RenderedElement> {
  const frame = document.createElement('iframe');
  // allow-same-origin without allow-scripts: the page's styles load, its code never runs.
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  Object.assign(frame.style, { position: 'fixed', left: '-20000px', top: '0', width: '1280px', height: '900px', opacity: '0', pointerEvents: 'none' });
  const base = `<base href="${baseURL.replace(/"/g, '&quot;')}">`;
  frame.srcdoc = /<head[^>]*>/i.test(html) ? html.replace(/<head([^>]*)>/i, `<head$1>${base}`) : `${base}${html}`;
  document.body.appendChild(frame);
  try {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, FRAME_LOAD_MS_MAX);
      frame.addEventListener('load', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    const inner = frame.contentDocument;
    const view = frame.contentWindow;
    if (inner === null || view === null) {
      return parsedTree(html, pageFile);
    }
    let styled = 0;
    return renderedTree(inner, pageFile, (element) => {
      styled += 1;
      return styled <= STYLED_ELEMENTS_MAX ? computedStyle(view, element) : undefined;
    });
  } finally {
    frame.remove();
  }
}

// The colours an element's own text is drawn in and over; undefined when it draws none or is not shown.
function computedStyle(view: Window, element: Element): RenderedStyle | undefined {
  const ownText = Array.from(element.childNodes).some((child) => child.nodeType === 3 && (child.textContent ?? '').trim().length > 0);
  if (!ownText || element.getClientRects().length === 0) {
    return undefined;
  }
  const style = view.getComputedStyle(element);
  if (style.visibility === 'hidden' || Number.parseFloat(style.opacity) === 0) {
    return undefined;
  }
  return {
    color: style.color,
    background: backgroundBehind(view, element),
    fontSizePx: Number.parseFloat(style.fontSize) || 16,
    fontWeight: Number.parseInt(style.fontWeight, 10) || 400,
  };
}

// The backgrounds of the element and its ancestors composited up to the first opaque
// one (white when none is); `unknown` behind an image or gradient, which a colour cannot describe.
function backgroundBehind(view: Window, element: Element): string | 'unknown' {
  const layers: Rgba[] = [];
  let current: Element | undefined = element;
  for (let depth = 0; current !== undefined && depth < LIMITS.ipcDepthMax * 4; depth++) {
    const style = view.getComputedStyle(current);
    if (style.backgroundImage !== 'none' && style.backgroundImage !== '') {
      return 'unknown';
    }
    const color = parseCssColor(style.backgroundColor);
    if (color === undefined) {
      return 'unknown';
    }
    if (color.alpha > 0) {
      layers.push(color);
    }
    if (color.alpha >= 1) {
      break;
    }
    current = current.parentElement ?? undefined;
  }
  const shown = layers.reduceRight((under, layer) => blend(layer, under), WHITE);
  return `rgb(${Math.round(shown.red)}, ${Math.round(shown.green)}, ${Math.round(shown.blue)})`;
}
