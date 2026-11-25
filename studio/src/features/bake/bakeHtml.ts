// Turns a built page into a baked one: stylesheets become one `<style>` per
// authored source, and the page carries the baseline morph.js diffs against.
// Pure string work, so the whole transformation is testable without a build.
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { renderBaselineScript } from '../preview/renderBaseline';
import { BAKE_RENDERING_GLOBAL, BAKE_SECTION_ATTRIBUTE, splitStyleSections, type StyleSection } from './bakeProtocol';

export const BAKE_PAGE_BYTES_MAX = 4_000_000;

const STYLESHEET_LINK = /<link\b[^>]*\brel="stylesheet"[^>]*>/g;
const HEAD_TAG = /<head\b[^>]*>/;
const HREF = /\bhref="([^"]+)"/;

// A dev server answers a reload with the current page. A static host answers with the
// build, so a reload (morph.js's own fallback when a script has rearranged the DOM)
// would show the page without its edits. A module script runs after parsing and before
// every later module, so this one swaps in the current rendering while the site's own
// modules have yet to start. The root's attributes come too: a page's source stamp
// rides on `<html>`, and canvas text editing waits until it names the current source. Parsed nodes never re-run, and the deferred modules
// already queued still do, against the new content. `document.open` is no use here:
// it does nothing while the parser runs a script.
// DOMParser parses with scripting off, so a <noscript>'s markup arrives as real
// elements; moved into this page they would run — a fallback <style> applied to a
// page that has JavaScript. Each one is flattened to its text first, the shape this
// page's own parser gives it (inertNoscripts in electron/previewClient/morphNodes.ts
// does the same for morph.js).
const EARLY_RENDERING = `<script type="module">if(location.hash==="#avb-design"&&window.parent!==window){try{const read=window.parent.${BAKE_RENDERING_GLOBAL};const html=read&&read(location.pathname);if(html){const next=new DOMParser().parseFromString(html,"text/html");for(const noscript of next.querySelectorAll("noscript")){noscript.textContent=noscript.innerHTML;}const copy=(from,to)=>{for(const attribute of from.attributes){to.setAttribute(attribute.name,attribute.value);}};copy(next.documentElement,document.documentElement);document.head.replaceChildren(...next.head.childNodes);copy(next.body,document.body);document.body.replaceChildren(...next.body.childNodes);}}catch(error){}}</script>`;

/** What the bake writes after every page's `<head>` tag; the demo sets it aside like
 * anything else a page holds once (demo/componentRender.ts pageOnce). */
export const BAKE_HEAD_INSERTION = `<meta name="robots" content="noindex">${EARLY_RENDERING}`;

/** Escapes a `<style>` body so authored text can never close the tag early. */
function styleBody(css: string): string {
  return css.replaceAll('</style', '<\\/style');
}

function styleTag(piece: StyleSection): string {
  const attribute = piece.section === undefined ? '' : ` ${BAKE_SECTION_ATTRIBUTE}="${piece.section}"`;
  return `<style${attribute}>${styleBody(piece.css)}</style>`;
}

export interface BakedPage {
  readonly html: string;
  readonly sections: readonly string[];
}

export function bakePage(html: string, readStylesheet: (href: string) => string | undefined): BakedPage {
  const sections = new Set<string>();
  const inlined = html.replace(STYLESHEET_LINK, (link) => {
    const href = HREF.exec(link)?.[1];
    const css = href === undefined ? undefined : readStylesheet(href);
    if (css === undefined) {
      return link; // Not one of this build's stylesheets: an external link stays.
    }
    const pieces = splitStyleSections(css);
    for (const piece of pieces) {
      if (piece.section !== undefined) {
        sections.add(piece.section);
      }
    }
    return pieces.map(styleTag).join('');
  });
  const indexed = inlined.replace(HEAD_TAG, (tag) => `${tag}${BAKE_HEAD_INSERTION}`);
  assert(indexed !== inlined, 'A baked page has a head for its early script');
  const baked = indexed + renderBaselineScript(indexed);
  // morph.js and the render path both refuse a rendering past this size.
  assert(baked.length <= BAKE_PAGE_BYTES_MAX * 2, 'A baked page stays within the rendering limit');
  return { html: baked, sections: [...sections] };
}
