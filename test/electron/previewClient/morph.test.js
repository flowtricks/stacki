// Patching the preview, next to a page whose own JS marks things.
//
//   node test/electron/previewClient/morph.test.js
//
// The canvas patches the page instead of reloading it (electron/previewClient/morphClient.ts).
// The patch is a diff between the server's PREVIOUS rendering and its new one,
// applied to the live document — three trees, and the live one is written only
// where the other two disagree. Finding the live node that stands for a server
// node is the part this file is about.
//
// Switching a variant made the whole page flicker and the sections below it
// jump. It was reloading: the locator gave up, and giving up means
// `location.reload()`.
//
// Why it gave up: the page has tabs, and the tab script marks the open one
// `is-active`. The locator asked for a class EQUAL to the server's, so
// `tabs_link is-active` no longer matched `tabs_link` — it scanned on to the
// next tab, which still had the pristine class, and matched that. Two tabs were
// patched as each other, the third had nothing left to match, and the page
// reloaded. Every accordion, carousel and nav on the page does the same thing.
//
// The test is whether the live node still carries the classes the SERVER gave
// it. Client code may add its own; it may not take the element's identity away.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const { readFolderSource, readSource } = require('../../helpers/sourceText.js');
const loadMorphModules = require('../../helpers/morphModules.js');
const dom = new JSDOM('<!doctype html><body></body>');
global.document = dom.window.document;

// The client's modules, bundled for jsdom (test/helpers/morphModules.js); its
// whole source, for the checks below that read it as text.
const source = readFolderSource('electron/previewClient');
// Main prepends the patcher's bounds from shared/core/limits.ts (step 7); the
// bundle takes them as a parameter, so the cap tests below can shrink them.
const { LIMITS } = require('#dist/shared/core/limits.js');
const assert = require('node:assert/strict');
const lift = (limits) => loadMorphModules(limits);
const morph = lift({
  previewMarkersMax: LIMITS.previewMarkersMax,
  previewMorphWorkMax: LIMITS.previewMorphWorkMax,
});
const { patchChildren, findLive, syncAnchors, syncStamps } = morph;

// The other half of the same decision: whether to patch at all.
const { scriptSignature, isStyleModule, loadStyles, refreshDevStyles, addedScripts, runScripts } = morph;

// Every patch here goes through this: a throw is the failure mode under test
// (the client turns it into location.reload()), so it is reported as one rather
// than ending the run with a stack trace that says nothing about which case it
// was.
const patch = (live, previous, next) => {
  try {
    patchChildren(live, previous, next);
    return undefined;
  } catch (error) {
    return error.message;
  }
};

const tree = (html) => {
  const element = dom.window.document.createElement('div');
  element.innerHTML = html;
  return element;
};

// A tablist as the server renders it: three buttons, one class each.
const TABS = (labels) => `\n  ${labels.map((label) => `<button class="tabs_link" type="button">${label}</button>`).join('\n  ')}\n`;

// The same tablist after the page's own script has run: ids, roles, and
// `is-active` on whichever tab is open.
const LIVE_TABS = (labels, active) =>
  `\n  ${labels
    .map((label, i) => `<button class="tabs_link${i === active ? ' is-active' : ''}" type="button" ` + `id="tab-${i}" role="tab">${label}</button>`)
    .join('\n  ')}\n`;

// --- the report ---------------------------------------------------------------
//
// Nothing about the tabs changed: the edit was somewhere else on the page. The
// patch has no business touching them, and must not fall over them either.
{
  const previous = tree(TABS(['One', 'Two', 'Three']));
  const next = tree(TABS(['One', 'Two', 'Three']));
  const live = tree(LIVE_TABS(['One', 'Two', 'Three'], 0));
  const was = [...live.querySelectorAll('button')];

  const threw = patch(live, previous, next);
  check('a tablist the page has marked up does not defeat the patch', threw === undefined, threw);
  const now = [...live.querySelectorAll('button')];
  check('the same three buttons are still there', now.length === 3 && now.every((button, i) => button === was[i]));
  check(
    'the open tab is still open',
    live.querySelectorAll('.is-active').length === 1 && now[0].classList.contains('is-active'),
    [...now].map((button) => button.className).join(' / '),
  );
  check('and each one kept its id', now.map((button) => button.id).join() === 'tab-0,tab-1,tab-2', now.map((button) => button.id).join());
}

// The same tablist, with the server changing one tab's text — the node it lands
// on is the point. Matched by position, it is tab two; matched by "which one
// still has the pristine class", it was tab three.
{
  const previous = tree(TABS(['One', 'Two', 'Three']));
  const next = tree(TABS(['One', 'Renamed', 'Three']));
  const live = tree(LIVE_TABS(['One', 'Two', 'Three'], 0));
  const threw = patch(live, previous, next);
  check('the edit can be applied at all', threw === undefined, threw);
  const text = [...live.querySelectorAll('button')].map((button) => button.textContent);
  check('an edit lands on the tab it was made to', text.join() === 'One,Renamed,Three', text.join());
}

// Every tab marked, not just one — an accordion with several panels open, a
// carousel where every slide carries state.
{
  const previous = tree(TABS(['One', 'Two', 'Three']));
  const next = tree(TABS(['One', 'Two', 'Changed']));
  const live = tree('\n  ' + ['One', 'Two', 'Three'].map((label) => `<button class="tabs_link is-seen" type="button">${label}</button>`).join('\n  ') + '\n');
  const threw = patch(live, previous, next);
  check('a class on every sibling is fine too', threw === undefined, threw);
  check(
    'and the edit still lands last',
    [...live.querySelectorAll('button')].map((button) => button.textContent).join() === 'One,Two,Changed',
    [...live.querySelectorAll('button')].map((button) => button.textContent).join(),
  );
}

// --- what the class test is still for -----------------------------------------
//
// A class the client ADDED must not hide the node. A class the SERVER gave it
// is the evidence that this is the node: an element the client inserted, with a
// class of its own, is not it.
{
  const previous = tree('<div class="real">a</div>');
  const next = tree('<div class="real">b</div>');
  const live = tree('<div class="injected">ad</div><div class="real">a</div>');
  check('an inserted sibling does not stop the patch', patch(live, previous, next) === undefined);
  const divs = [...live.querySelectorAll('div')];
  check('an inserted element is stepped over, not patched', divs[0].textContent === 'ad', divs[0].outerHTML);
  check('and the server’s own element is the one that changes', divs[1].textContent === 'b', divs[1].outerHTML);
}

// A server node with no class at all: anything would satisfy "carries all of
// none", so that test would match the first same-tag node — including one the
// client put there. It has to have no class either.
{
  const previous = tree('<span>a</span>');
  const next = tree('<span>b</span>');
  const live = tree('<span class="tooltip">tip</span><span>a</span>');
  check('an inserted span does not stop it either', patch(live, previous, next) === undefined);
  const spans = [...live.querySelectorAll('span')];
  check('a classless server node does not match a classed live one', spans[0].textContent === 'tip', spans[0].outerHTML);
  check('it matches the classless one', spans[1].textContent === 'b', spans[1].outerHTML);
}

// The last resort is still there: when the client takes one of the server's own
// classes away, the first same-tag node is a better answer than reloading.
{
  const previous = tree('<p class="note">a</p>');
  const next = tree('<p class="note">b</p>');
  const live = tree('<p class="">a</p>');
  const threw = patch(live, previous, next);
  check('a class the client removed does not force a reload', threw === undefined, threw);
  check('the node is still patched', live.querySelector('p').textContent === 'b', live.innerHTML);
}

// A slider, nav, or tab script can replace an entire subtree after the server
// renders it. If the old and new server trees agree on that subtree, there is
// no edit to apply inside it and therefore no reason to line up its live
// descendants. Only the changed sibling should be visited.
{
  const server = (text) => '<div class="runtime"><div class="item">One</div><div class="item">Two</div></div>' + `<h1>${text}</h1>`;
  const previous = tree(server('Before'));
  const next = tree(server('After'));
  const live = tree('<div class="runtime"><div class="client-clone">Client state</div></div>' + '<h1>Before</h1>');
  const threw = patch(live, previous, next);
  check('an unchanged runtime-owned subtree does not force a reload', threw === undefined, threw);
  check('the text beside that subtree is still patched inline', live.querySelector('h1').textContent === 'After', live.innerHTML);
  check('the runtime-owned subtree remains untouched', live.querySelector('.client-clone').textContent === 'Client state', live.innerHTML);
}

// An id is still taken at its word, ahead of any class.
{
  const previous = tree('<div id="keep" class="a">x</div>');
  const next = tree('<div id="keep" class="a">y</div>');
  const live = tree('<div class="a">decoy</div><div id="keep" class="a b">x</div>');
  check('a decoy does not stop the patch', patch(live, previous, next) === undefined);
  check('an id wins over a same-class sibling', live.querySelector('#keep').textContent === 'y', live.innerHTML);
  check('and the decoy is untouched', live.firstElementChild.textContent === 'decoy', live.innerHTML);
}

// --- the locator, directly ------------------------------------------------------
{
  const server = tree('<button class="tabs_link">x</button>').firstElementChild;
  const live = tree('<button class="tabs_link is-active" id="tab-0">x</button>').firstElementChild;
  check('a live node that kept the server’s class matches', findLive(live, server) === live);

  const other = tree('<button class="something-else">x</button>').firstElementChild;
  check('one that never had it is only a last resort', findLive(other, server) === other, 'nothing else to match, so the same-tag fallback stands');
}

// --- switching a variant is a different set of stylesheets -------------------
//
// The flicker at the top of this file had a second cause, found the same way:
// the page reloaded. Not because the locator gave up this time — because the
// page's SCRIPTS had changed, and any change there means reload.
//
// They had changed because Astro serves a component's <style> as a module: one
// script tag per styled component that renders. Switching a variant renders a
// different handful of components, so the list differs, so the page reloaded —
// for a stylesheet, which is the one thing a patch handles well.
{
  const head = (scripts) => new JSDOM(`<!doctype html><html><head>${scripts}</head><body></body></html>`).window.document;
  const style = (name) => `<script type="module" ` + `src="/src/components/${name}.astro?astro&type=style&index=0&lang.css"></script>`;
  const script = (name) => `<script type="module" ` + `src="/src/components/${name}.astro?astro&type=script&index=0&lang.ts"></script>`;

  check('an Astro style module is recognised', isStyleModule('/src/components/Card.astro?astro&type=style&index=0&lang.css'));
  check('and so is a plain stylesheet import', isStyleModule('/src/styles/global.css'));
  check('a component script is not one', !isStyleModule('/src/components/Nav.astro?astro&type=script&index=0&lang.ts'));
  check('and neither is the module runtime', !isStyleModule('/@vite/client'));

  const before = head(style('Card') + script('Nav'));
  const withIcon = head(style('Card') + style('Icon') + script('Nav'));
  check(
    'a stylesheet appearing does not force a reload',
    scriptSignature(before) === scriptSignature(withIcon),
    `${JSON.stringify(scriptSignature(before))} vs ${JSON.stringify(scriptSignature(withIcon))}`,
  );
  const withoutCard = head(style('Icon') + script('Nav'));
  check('nor one disappearing', scriptSignature(before) === scriptSignature(withoutCard));

  // A script that appears is a module the page has not run yet, and running one
  // is something this can do. Switching a variant is how a component starts
  // rendering a slider, a marquee, anything with behaviour — and in dev each of
  // those is its own module, so reloading for it meant reloading for most
  // variant switches, one per option while hovering down the list.
  const withFooter = head(style('Card') + script('Nav') + script('Footer'));
  const added = addedScripts(before, withFooter);
  check('a script appearing is something to run, not to reload for', Array.isArray(added), JSON.stringify(added));
  check('and it is the one that appeared', added?.length === 1 && /Footer/.test(added[0].src), JSON.stringify(added));
  check('a rendering asking for nothing new adds nothing', addedScripts(before, withIcon)?.length === 0, JSON.stringify(addedScripts(before, withIcon)));

  // What the rule is actually for: a script that changed cannot be rewritten
  // into a page, and one that is gone cannot be un-run.
  const changed = head(style('Card') + '<script type="module">console.log(1)</script>');
  check('a script whose code changed still reloads', addedScripts(before, changed) === undefined);
  const withoutNav = head(style('Card'));
  check('and so does one that went away', addedScripts(before, withoutNav) === undefined);
  // An inline script has to run where it sits, which this cannot arrange.
  const withInline = head(style('Card') + script('Nav') + '<script>console.log(2)</script>');
  check('an inline arrival reloads too', addedScripts(before, withInline) === undefined);

  // Not reloading is only half of it: the new component's CSS has to arrive.
  // The patch cannot bring it — a <script> cloned from a fetched document is
  // inert, so it is loaded by hand, with an element that runs.
  const live = dom.window.document;
  const wanted = '/src/components/Icon.astro?astro&type=style&index=0&lang.css';
  loadStyles(withIcon);
  const loaded = () => [...live.querySelectorAll('script[src]')].map((node) => node.getAttribute('src'));
  check('a stylesheet the page has just started using is loaded', loaded().includes(wanted), loaded().join('|'));
  const count = loaded().length;
  loadStyles(withIcon);
  check('and not loaded twice', loaded().length === count, `${loaded().length} vs ${count}`);
  check('a real script is never loaded this way', !loaded().some((source) => /type=script/.test(source)), loaded().join('|'));

  // Running one means an element made here, not the inert copy a patch inserts.
  {
    const ran = () => [...dom.window.document.querySelectorAll('script[src*="Footer"]')];
    // A reload verdict has nothing to run, and saying so is the failure — not
    // a stack trace from handing null to a loop.
    runScripts(Array.isArray(added) ? added : []);
    check('the module the variant needs is put in the page', ran().length === 1, `${ran().length} tags`);
    runScripts(Array.isArray(added) ? added : []);
    check('and not put there twice', ran().length === 1, `${ran().length} tags`);
  }
}

// Stamps (step 7): each marked file's <!--avb-d:<checksum>:<file>--> names the
// bytes the rendering came from. They take no part in the diff, and after a
// patch the live page holds exactly the new rendering's stamps — gathered at
// the document's end, wherever each was — or the canvas would vouch for a
// rendering it no longer shows.
{
  const { JSDOM: Dom } = require('jsdom');
  const OLD = 'a'.repeat(64);
  const NEW = 'b'.repeat(64);
  const stamp = (sum, file) => `<!--avb-d:${sum}:${file}-->`;
  const html = (sum) =>
    `${stamp(sum, 'src/pages/index.astro')}<!doctype html><html>` +
    `<head>${stamp(sum, 'src/components/Seo.astro')}</head><body><!--avb-s:0--><p>One</p>` +
    `${stamp(sum, 'src/components/Card.astro')}<!--avb-e:0--></body></html>`;
  const live = new Dom(html(OLD)).window.document;
  const previous = new Dom(html(OLD)).window.document;
  const next = new Dom(html(NEW).replace('One', 'Two')).window.document;
  const stampsOf = (tree) => {
    const out = [];
    const walk = (parent, depth) => {
      assert.ok(depth <= LIMITS.treeDepthMax, 'walk: depth limit');
      for (let child = parent.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 8 && child.data.startsWith('avb-d:')) {
          out.push(child.data);
        }
        if (child.nodeType === 1) {
          walk(child, depth + 1);
        }
      }
    };
    walk(tree, 0);
    return out.sort();
  };
  const wanted = stampsOf(next);
  // The diff sees neither stamps nor markers: the clean copies lose them.
  for (const tree of [previous, next]) {
    for (const child of [...tree.body.childNodes]) {
      if (child.nodeType === 8 && /^avb-[sed]:/.test(child.data)) {
        child.remove();
      }
    }
  }
  const threw = patch(live.body, previous.body, next.body);
  check('a stamp in the live body does not stop the patch', threw === undefined, threw);
  check('and the text is patched past it', live.body.textContent.includes('Two'), live.body.innerHTML);
  const withAnchors = new Dom(html(NEW).replace('One', 'Two')).window.document;
  syncAnchors(live.body, withAnchors.body);
  syncStamps(live, withAnchors);
  check('the live page holds the new rendering’s stamps, and only them', JSON.stringify(stampsOf(live)) === JSON.stringify(wanted), stampsOf(live).join('\n'));
  check('none of the old ones survived, in <head> or before <html>', !stampsOf(live).some((stamp) => stamp.includes(OLD)));
  check('the node markers are back where they were', /<!--avb-s:0--><p>Two<\/p><!--avb-e:0-->/.test(live.body.innerHTML), live.body.innerHTML);
  check('and no stamp is put back beside them', !/avb-d:/.test(live.body.innerHTML), live.body.innerHTML);
}

// A moved node (step 6 ships moves as relocated bytes; the open question was
// left to step 7). The canvas patches from the two renderings, which see a move
// as a removal and an insertion: the page ends up exactly as the new rendering
// says, without a reload, and the siblings that stayed are the same live
// elements. The moved one is rebuilt — its client state is not carried along.
{
  const html = (order) => order.map((id) => `<section id="${id}"><p>${id}</p></section>`).join('');
  const live = tree(html(['a', 'b', 'c']));
  const [first, second, third] = [...live.children];
  const threw = patch(live, tree(html(['a', 'b', 'c'])), tree(html(['b', 'c', 'a'])));
  check('a moved node patches without a reload', threw === undefined, threw);
  check('and the page is the new rendering', live.innerHTML === tree(html(['b', 'c', 'a'])).innerHTML, live.innerHTML);
  check('the first sibling that stayed is the same element', live.children[0] === second);
  check('and so is the second', live.children[1] === third);
  check('the moved one is rebuilt, not carried', live.children[2] !== first && !first.isConnected);
}

// The caps (step 7). Past the marker cap or the diff-work cap the patch throws
// the cap's own reason, and update() turns that into an announced reload; under
// them it patches as before. A shrunken copy of the patcher shows both edges.
{
  const tiny = lift({ previewMarkersMax: 3, previewMorphWorkMax: 40 });
  const reasonOf = (run) => {
    try {
      run();
      return undefined;
    } catch (error) {
      return error instanceof tiny.OverCap ? error.reason : `not a cap: ${error.message}`;
    }
  };
  const marked = (i) => `<!--avb-s:${i}--><p>${i}</p><!--avb-e:${i}-->`;
  const markers = (count) => tree(Array.from({ length: count }, (_, i) => marked(i)).join(''));
  check('a rendering at the marker cap patches', reasonOf(() => tiny.checkMarkerCap(markers(3))) === undefined);
  check('one marker past it reloads, and says why', reasonOf(() => tiny.checkMarkerCap(markers(4))) === 'markers-over-cap');
  // A middle edit in a list of n children builds an (n+1)² matrix after the
  // shared prefix: five children changed at the head cost 36 cells, under 40.
  const list = (items) => items.map((item) => `<i id="${item}">${item}</i>`).join('');
  const five = ['a', 'b', 'c', 'd', 'e'];
  const small = [tree(list(five)), tree(list(five)), tree(list(['z', ...five.slice(1)]))];
  tiny.refillMorphWork();
  check('a diff inside the work cap patches', reasonOf(() => tiny.patchChildren(...small)) === undefined);
  check('and the live list shows the edit', small[0].firstElementChild.id === 'z', small[0].innerHTML);
  const names = Array.from({ length: 8 }, (_, i) => `n${i}`);
  const large = [tree(list(names)), tree(list(names)), tree(list(['x', ...names.slice(1)]))];
  tiny.refillMorphWork();
  check('a diff past the work cap reloads, and says why', reasonOf(() => tiny.patchChildren(...large)) === 'diff-over-cap');
  // The budget is per patch: refilled, the small edit fits again.
  tiny.refillMorphWork();
  const again = [tree(list(['a', 'b'])), tree(list(['a', 'b'])), tree(list(['q', 'b']))];
  check('the next patch starts with the whole budget', reasonOf(() => tiny.patchChildren(...again)) === undefined);
  // The shipped bounds are the ones in shared/core/limits.ts, prepended by main.
  const main = readSource('electron/handlers/devServers.ts');
  check(
    'main prepends the patcher its bounds from LIMITS',
    /const AVB_PREVIEW_LIMITS = Object\.freeze\(\$\{JSON\.stringify\(bounds\)\}\)/.test(main) &&
      /previewMarkersMax: (\w+_1\.)?LIMITS\.previewMarkersMax/.test(main) &&
      /previewMorphWorkMax: (\w+_1\.)?LIMITS\.previewMorphWorkMax/.test(main),
  );
  check('the patcher declares the bounds, never defines its own', !/AVB_PREVIEW_LIMITS\s*=/.test(source));
  check('and announces a reload before it happens', /postMessage\(\{ type: 'avb:preview-reload', reason \}/.test(source));
}

// --- a page's own stylesheet follows the edit ----------------------------------
//
// A page's <style> is inlined by the server, so its module was never imported
// and Vite answers an edit to the page with a reload, not a stylesheet update.
// The patch replaces that reload, so it is the only thing that can bring the new
// CSS: a live dev stylesheet takes the text the server has just changed. One
// the server renders as it did before is not written at all — a rewritten
// stylesheet restarts every animation it defines — and Vite's own stylesheets,
// which the server's rendering does not carry, are left to Vite.
//
// "As it did before" is the server's previous rendering, not the live text. A
// stylesheet reached through a CSS `@import` (global.css importing
// utilities.css) is rendered from the server's first compile for as long as it
// runs, while Vite hot-swaps the live one on every write. Compared against the
// live text, each patch put that first compile back: a padding dragged in the
// style panel reached the file and never the canvas.
{
  const head = dom.window.document.head;
  const devStyle = (id, css) => {
    const style = dom.window.document.createElement('style');
    style.setAttribute('data-vite-dev-id', id);
    style.textContent = css;
    return style;
  };
  const PAGE = '/src/pages/index.astro?astro&type=style&index=0&lang.css';
  const CARD = '/src/components/Card.astro?astro&type=style&index=0&lang.css';
  const OWN = '/src/styles/vite-only.css';
  const SHEET = '/src/styles/global.css';
  const page = devStyle(PAGE, '.box { color: red; }');
  const card = devStyle(CARD, '.card { gap: 1rem; }');
  const own = devStyle(OWN, '.vite { margin: 0; }');
  // Vite has hot-swapped this one since the server first compiled it.
  const sheet = devStyle(SHEET, '.pad { padding: 3rem; }');
  head.append(page, card, own, sheet);
  const rendering = (pageCss) =>
    new dom.window.DOMParser().parseFromString(
      '<!doctype html><html><head>' +
        `<style data-vite-dev-id="${PAGE}">${pageCss}</style>` +
        `<style data-vite-dev-id="${CARD}">.card { gap: 1rem; }</style>` +
        `<style data-vite-dev-id="${SHEET}">.pad { padding: 1rem; }</style>` +
        '</head><body></body></html>',
      'text/html',
    );
  const before = rendering('.box { color: red; }');
  const served = rendering('.box { color: blue; }');
  const writes = [];
  const observer = new dom.window.MutationObserver((records) => writes.push(...records));
  observer.observe(head, { childList: true, subtree: true, characterData: true });
  refreshDevStyles(before, served);
  writes.push(...observer.takeRecords());
  observer.disconnect();
  check('the page stylesheet takes the CSS the server rendered', page.textContent === '.box { color: blue; }');
  check('and stays the same element', head.contains(page));
  check(
    'an unchanged stylesheet is not written',
    writes.every((record) => record.target !== card && record.target.parentNode !== card),
    String(writes.length),
  );
  check('a stylesheet the rendering does not carry is left to Vite', own.textContent === '.vite { margin: 0; }');
  check('a stylesheet the server renders stale keeps the text Vite gave it', sheet.textContent === '.pad { padding: 3rem; }', sheet.textContent);
  // A stylesheet new to the server's rendering has no earlier text to agree with.
  const arrived = devStyle(CARD, '.card { gap: 0; }');
  head.append(arrived);
  const without = new dom.window.DOMParser().parseFromString('<!doctype html><html><head></head><body></body></html>', 'text/html');
  card.remove();
  refreshDevStyles(without, served);
  check('a stylesheet the previous rendering lacked takes the server text', arrived.textContent === '.card { gap: 1rem; }', arrived.textContent);
  arrived.remove();
  head.append(card);
  check(
    'exactly one stylesheet was written',
    new Set(writes.map((record) => (record.target.nodeType === 3 ? record.target.parentNode : record.target))).size === 1,
    String(writes.length),
  );
  page.remove();
  card.remove();
  own.remove();
  sheet.remove();
}

if (failures.length) {
  console.error(`\nmorph: ${failures.length} failed, ${checked - failures.length} passed\n`);
  console.error(failures.join('\n') + '\n');
  process.exit(1);
}
console.log(`morph: ${checked} passed  [patching a page whose own JS marks things; stylesheets are not ` + `scripts]`);
