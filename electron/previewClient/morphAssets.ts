// The scripts and stylesheets a rendering asks for: whether the new one can
// be patched in at all, the modules it adds, loaded for real, and the dev
// stylesheets whose text the edit changed.

// A component's <style> is delivered as a MODULE in dev — one
// `<script type="module" src="…?astro&type=style…">` per styled component that
// renders. So the page's list of scripts changes whenever the SET of rendered
// components changes, and that is exactly what switching a variant does: one
// card becomes another, an icon appears, and the page carries a different
// handful of stylesheets.
//
// Which made the rule below reload the page for a stylesheet — the flicker this
// file exists to avoid, on the one edit most likely to be made over and over.
// Style modules are held apart from real scripts and patched like anything
// else.
export function isStyleModule(source: string): boolean {
  return /[?&]astro&type=style|\.(css|s[ac]ss|less|pcss|styl)(\?|$)/.test(source || '');
}

/** Every attribute the canvas markers add starts with this (data-avb-p, data-avb-d). */
const MARKER_ATTRIBUTE_PREFIX = 'data-avb-';

interface ScriptInfo {
  readonly src: string;
  readonly type: string;
  readonly attrs: readonly [name: string, value: string][];
  readonly signature: string;
}

// A script that CHANGED, or one that is GONE, cannot be patched in: rewriting
// one does not run it, and nothing can un-run one. Both are wrong, so the page
// reloads.
//
// A script that only APPEARED is a different matter, and it is the common one.
// Switching a variant is how a component starts rendering something it wasn't:
// a slider, a marquee, anything with behaviour, and in dev Astro hands each of
// those out as its own module — so the new rendering asks for a module the page
// has not run yet. Reloading for that threw away the scroll position, every
// running animation and whatever was open, on a page whose markup this had
// just finished patching in place. Worse where it hurts most: hovering down a
// list of variants reloaded the page per option.
//
// So a new module is loaded rather than reloaded around — the same thing
// loadStyles does for a stylesheet, for the same reason: an element made here
// runs, a cloned one does not.
function scriptsOf(page: Document): ScriptInfo[] {
  const out: ScriptInfo[] = [];
  const list = page.getElementsByTagName('script');
  for (let i = 0; i < list.length; i++) {
    const script = list[i];
    if (!script) {
      continue;
    }
    const source = script.getAttribute('src') || '';
    if (isStyleModule(source)) {
      continue;
    }
    let attrs: [string, string][] = Array.from(script.attributes, (attribute) => [attribute.name, attribute.value]);
    attrs = attrs.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    out.push({
      src: source,
      type: script.getAttribute('type') || '',
      attrs,
      // Marker attributes are left out: they name where a node came from, and the stamp
      // among them (data-avb-d) changes with every save of the file. A page whose layout
      // spreads its props onto a JSON-LD <script> (stacki.build's BaseHead) carried the
      // page's stamp there, so every prop edit read as "scripts changed" and reloaded
      // the canvas: the flicker, and a second of delay per keystroke.
      signature: JSON.stringify([attrs.filter(([name]) => !name.startsWith(MARKER_ATTRIBUTE_PREFIX)), script.textContent]),
    });
  }
  return out;
}

// Structured signatures cannot collide with separators in URLs or source.
export function scriptSignature(page: Document): string {
  return JSON.stringify(scriptsOf(page).map((script) => script.signature));
}

/**
 * What the new rendering adds, or undefined when it does anything else to the
 * scripts — which is the reload.
 *
 * Only an external script can be added this way. An inline script has to run
 * where it sits, and this cannot put it there: the copy the patch inserted is
 * inert and replacing it is a different job. So an inline arrival still reloads.
 */
export function addedScripts(previousDocument: Document, nextDocument: Document): ScriptInfo[] | undefined {
  const before = scriptsOf(previousDocument);
  const after = scriptsOf(nextDocument);
  const had = new Set(before.map((script) => script.signature));
  const added: ScriptInfo[] = [];
  let i = 0;
  for (const script of after) {
    if (script.signature === before[i]?.signature) {
      i++;
    } else {
      // Already-run scripts must keep their order and count. Neither a
      // reorder nor another execution of an existing script can be patched.
      if (had.has(script.signature) || !script.src) {
        return undefined;
      }
      added.push(script);
    }
  }
  return i === before.length ? added : undefined;
}

// The modules a rendering asks for that this page has never run. Made here, not
// cloned, so they run.
const loadedScripts = new Set<string>();
export function noteScripts(page: Document): void {
  for (const { src: source } of scriptsOf(page)) {
    if (source) {
      loadedScripts.add(source);
    }
  }
}
export function runScripts(added: readonly ScriptInfo[]): void {
  for (const { src: source, attrs } of added) {
    if (!source || loadedScripts.has(source)) {
      continue;
    }
    loadedScripts.add(source);
    const element = document.createElement('script');
    // Preserve loading semantics such as integrity, crossorigin and nonce.
    // Dynamic classic scripts default to async; source scripts without that
    // attribute must instead execute in insertion order.
    element.async = false;
    for (const [name, value] of attrs) {
      element.setAttribute(name, value);
    }
    document.head.appendChild(element);
  }
}

// The stylesheets a rendering asks for, loaded for real.
//
// The patch cannot do this itself: a <script> cloned out of a fetched document
// is inert — the parser that made it had no browsing context, so inserting it
// into this one runs nothing (measured; see test/electron/previewClient/morph.test.js). An
// element made here does run, and running one of these modules is what injects its CSS.
//
// A stylesheet whose component is no longer rendered is left loaded. Its rules
// match nothing now, and it is already in hand for the moment the variant is
// switched back.
const loadedStyles = new Set<string>();
export function noteStyles(page: Document): void {
  const list = page.getElementsByTagName('script');
  for (let i = 0; i < list.length; i++) {
    const script = list[i];
    if (!script) {
      continue;
    }
    const source = script.getAttribute('src');
    if (source !== null && isStyleModule(source)) {
      loadedStyles.add(source);
    }
  }
}
export function loadStyles(page: Document): void {
  const list = page.getElementsByTagName('script');
  for (let i = 0; i < list.length; i++) {
    const script = list[i];
    if (!script) {
      continue;
    }
    const source = script.getAttribute('src');
    if (source === null || !isStyleModule(source) || loadedStyles.has(source)) {
      continue;
    }
    loadedStyles.add(source);
    const element = document.createElement('script');
    element.type = 'module';
    element.src = source;
    document.head.appendChild(element);
  }
}

// Vite swaps a dev stylesheet itself only when the browser imported its
// module. A page's own <style> never was — the server inlines it — so an edit
// to the page reaches the browser as a reload, which this patch replaces, and
// nothing else would ever bring the page's new CSS: the canvas kept the
// stylesheet the page loaded with, whatever the style panel wrote. The
// rendering just fetched holds that stylesheet as the server compiled it for
// this edit, so a live one takes the text the server has just changed. One the
// server renders as it did before is left alone, for two reasons. A rewritten
// stylesheet restarts every animation it defines, on every keystroke of a text
// edit. And the server's text is not always the newest: a stylesheet that
// reaches the page through a CSS \`@import\` is rendered from the server's
// first compile for as long as it runs, while Vite hot-swaps the live one on
// every write. Comparing against the live text put that first compile back on
// each patch, and the canvas dropped every style edit made to such a file.
export function refreshDevStyles(previous: Document, next: Document): void {
  const before = devStyleTexts(previous);
  const fresh = devStyleTexts(next);
  const live = document.querySelectorAll('style[data-vite-dev-id]');
  for (let i = 0; i < live.length; i++) {
    const style = live[i];
    const id = style?.getAttribute('data-vite-dev-id') ?? '';
    const text = fresh.get(id);
    if (style === undefined || text === undefined) {
      continue; // Not in this rendering: Vite's own, or a component that left.
    }
    if (before.get(id) === text) {
      continue; // The server did not change it: the live text is Vite's to keep.
    }
    if (style.textContent !== text) {
      style.textContent = text;
    }
  }
}

// Each dev stylesheet of a server rendering, by the id Vite gave it.
function devStyleTexts(page: Document): Map<string, string> {
  const texts = new Map<string, string>();
  const served = page.querySelectorAll('style[data-vite-dev-id]');
  for (let i = 0; i < served.length; i++) {
    const id = served[i]?.getAttribute('data-vite-dev-id');
    if (id !== null && id !== undefined) {
      texts.set(id, served[i]?.textContent ?? '');
    }
  }
  return texts;
}
