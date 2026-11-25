// Goal: a prop edit never reloads the canvas for a page whose scripts took server nodes apart. A hero that
// "adopts" its server markup moves a link into its own header, trims the whitespace between pieces and
// drops the wrappers it replaced; the patch used to give up there (`cannot line up text`, then `<div>`),
// the canvas reloaded and the page's intro animation replayed on every prop toggle (a Button's `arrow`).
//
// Method: three trees as in the morph client, built by hand in jsdom: the server's previous rendering, its
// new rendering, and the live page as the script left it. The patch runs through the bundled client modules
// (test/helpers/morphModules.js). Sentinel nodes stand for running animation state: they must be the same
// objects after the patch. Negative space: an element no marker can find, one the markers cannot tell apart,
// and a change that has nowhere to land (a child added to a parent that is gone) still throw, which is the
// reload the client turns them into, and the reload line says why (morphClient.ts reloadFor).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const loadMorphModules = require('../../helpers/morphModules.js');

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
global.document = dom.window.document;
const morph = loadMorphModules();

// The live page is the global document (the client finds a moved node through it); a rendering is a detached tree.
const liveBody = (html) => {
  document.body.innerHTML = html;
  return document.body;
};
const body = (html) => {
  const parsed = new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document;
  return parsed.body;
};

const link = (arrow) =>
  `<a class="pill" data-avb-p="Button|0">` +
  `<span class="roll" data-avb-p="Button|0.0">Talk</span>${arrow ? '<i class="arrow" data-avb-p="Button|0.1"></i>' : ''}</a>`;
const server = (arrow) =>
  `<header data-avb-p="Nav|0"><div class="pill-slot" data-avb-p="Nav|0.0"></div></header>\n` +
  `<div id="hero" data-avb-p="Hero|0">\n  <div data-hero-cta data-avb-p="Hero|0.1">\n    ${link(arrow)}\n  </div>\n</div>`;

// What the hero's script leaves: the link lives in the header, the cta wrapper is gone, the whitespace is gone.
function adoptedPage() {
  return liveBody(
    `<header data-avb-p="Nav|0"><div class="pill-slot" data-avb-p="Nav|0.0">${link(false)}</div></header><div id="hero" data-avb-p="Hero|0"><canvas id="intro"></canvas></div>`,
  );
}

test('a prop that adds markup inside a node a script moved patches it where it went', () => {
  const live = adoptedPage();
  const sentinel = live.querySelector('#intro');
  const roll = live.querySelector('.roll');
  morph.patchChildren(live, body(server(false)), body(server(true)));
  assert.equal(live.querySelector('a.pill .arrow')?.tagName, 'I', 'the arrow arrived in the moved link');
  assert.equal(live.querySelector('#intro'), sentinel, 'the running canvas is the same node');
  assert.equal(live.querySelector('.roll'), roll, 'the label was not rebuilt');
});

test('and takes the markup away again', () => {
  const live = adoptedPage();
  morph.patchChildren(live, body(server(false)), body(server(true)));
  morph.patchChildren(live, body(server(true)), body(server(false)));
  assert.equal(live.querySelector('.arrow') ?? undefined, undefined);
  assert.ok(live.querySelector('#intro'));
});

test('a text node a script removed is nothing to patch', () => {
  const live = liveBody('<p id="keep">label</p>');
  const before = body('<p id="keep">label</p>\n<!--c-->\ntext');
  const after = body('<p id="keep">label</p>\n<!--c-->\nother text');
  assert.doesNotThrow(() => morph.patchChildren(live, before, after));
  assert.equal(live.querySelector('#keep').textContent, 'label');
});

test('an element no marker finds still throws, and says where', () => {
  const live = liveBody('<div id="hero"></div>');
  const before = body('<div id="hero"><p>gone</p></div>');
  const after = body('<div id="hero"><p>gone</p><p>new</p></div>');
  // The hero is found; its <p> is not, and has no marker to be found by: a neighbour must not be patched instead.
  const changed = body('<div id="hero"><p>changed</p></div>');
  assert.throws(() => morph.patchChildren(live.firstChild, before.firstChild, changed.firstChild), /cannot line up <p> \(in <div>\)/);
  assert.ok(after);
});

test('two live elements with one marker are no answer', () => {
  const live = liveBody('<div id="x"><a data-avb-p="B|0"></a><a data-avb-p="B|0"></a></div><div id="y"></div>');
  const before = body('<div id="x"><b data-avb-p="B|9"><a data-avb-p="B|0">t</a></b></div><div id="y"></div>');
  const after = body('<div id="x"><b data-avb-p="B|9"><a data-avb-p="B|0">t</a><i></i></b></div><div id="y"></div>');
  assert.throws(() => morph.patchChildren(live, before, after), /cannot line up/);
});

test('a child added to a parent that is gone has nowhere to land', () => {
  const live = liveBody('<div id="hero"></div>');
  const before = body('<div id="hero"><ul data-avb-p="H|0"><li data-avb-p="H|0.0">a</li></ul></div>');
  const after = body('<div id="hero"><ul data-avb-p="H|0"><li data-avb-p="H|0.0">a</li><li data-avb-p="H|0.1">b</li></ul></div>');
  assert.throws(() => morph.patchChildren(live, before, after), /cannot line up/);
});

test('an unchanged node a script took away is left alone', () => {
  const live = liveBody('<div id="hero"></div>');
  const before = body('<div id="hero"><ul data-avb-p="H|0"><li>a</li></ul></div>');
  assert.doesNotThrow(() => morph.patchChildren(live, before, before.cloneNode(true)));
});

test('every reload leaves a reason in the preview log', () => {
  const client = fs.readFileSync(repoPath('electron/previewClient/morphClient.ts'), 'utf8');
  assert.match(client, /fetch\('\/__avb\/reload\?r='/);
  assert.doesNotMatch(client, /send(?:Beacon)/, 'Studio ships this file and its no-tracking scan forbids the beacon API');
  assert.equal((client.match(/reloadFor\('/g) ?? []).length, 2, 'both reload sites say why');
  const config = fs.readFileSync(repoPath('electron/preview/markerConfig.ts'), 'utf8');
  assert.match(config, /server\.middlewares\.use\('\/__avb\/reload'/);
  assert.match(client, /reloaded instead of patching \(/);
  assert.match(config, /\[stacki\] canvas /);
});

// The footer Button of the swash-labs site, as the server renders it for each variant, with the footer's script
// having written the year into its own span and bound a click handler to the link.
const footer = (button) => `<footer data-avb-p="Footer|0"><p>(c) <span id="year">2025</span></p>\n${button}\n</footer>`;
const LINK =
  '<a class="button_wrap link" href="#" data-top data-avb-p="Button|0"><span class="button_text text-style-trim" data-avb-p="Button|0.0">Back to top &#8593;</span></a>';
const PILL = (arrow) =>
  '<a class="button_wrap pill" href="#" data-top data-avb-p="Button|0"><span class="button_roll" data-avb-p="Button|0.0"><span>Back to top &#8593;</span>' +
  `<span aria-hidden="true">Back to top &#8593;</span></span>${arrow ? '<i class="button_arrow" aria-hidden="true" style="--_arrow: url(/arrow.svg)"></i>' : ''}</a>`;

test('the footer Button switches variant and toggles its arrow in place, keeping what the footer script did', () => {
  const live = liveBody(footer(LINK));
  live.querySelector('#year').textContent = '2026';
  const anchor = live.querySelector('[data-top]');
  let clicks = 0;
  anchor.addEventListener('click', () => (clicks += 1));
  morph.patchChildren(live, body(footer(LINK)), body(footer(PILL(false))));
  morph.patchChildren(live, body(footer(PILL(false))), body(footer(PILL(true))));
  assert.equal(live.querySelector('[data-top]'), anchor, 'the link is the same element, so its handler is still bound');
  assert.equal(live.querySelector('#year').textContent, '2026', 'the script own text is kept');
  assert.ok(live.querySelector('.button_arrow'), 'the arrow arrived');
  morph.patchChildren(live, body(footer(PILL(true))), body(footer(PILL(false))));
  assert.equal(live.querySelector('.button_arrow') ?? undefined, undefined, 'and went');
  anchor.click();
  assert.equal(clicks, 1);
});

test('the dev server error overlay goes with a patch that brought the page up to date', () => {
  const live = liveBody('<main>page</main><vite-error-overlay></vite-error-overlay>');
  assert.equal(morph.dismissErrorOverlay(live), true);
  assert.equal(live.querySelector('vite-error-overlay') ?? undefined, undefined);
  assert.ok(live.querySelector('main'));
  assert.equal(morph.dismissErrorOverlay(live), false, 'nothing to remove the second time');
  const nested = liveBody('<main><vite-error-overlay></vite-error-overlay></main>');
  assert.equal(morph.dismissErrorOverlay(nested), false, 'only the overlay the dev client puts on the body');
});

test('a failed rendering keeps the page instead of reloading it', () => {
  const client = fs.readFileSync(repoPath('electron/previewClient/morphClient.ts'), 'utf8');
  assert.match(client, /class HeldRendering/);
  assert.match(client, /error instanceof HeldRendering && error\.status >= 500/);
});

test('the dev log names the file behind a reload and the script behind a scripts reload', () => {
  const config = fs.readFileSync(repoPath('electron/preview/markerConfig.ts'), 'utf8');
  assert.match(config, /file changed outside the app/);
  assert.match(config, /the dev server asked for a full reload/);
  const head = (scripts) => new JSDOM(`<!doctype html><html><head>${scripts}</head><body></body></html>`).window.document;
  const text = morph.describeScriptChange(head('<script type="module" src="/a.js"></script>'), head('<script type="module">1</script>'));
  assert.match(text, /a\.js/);
});
