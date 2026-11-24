// Goal: switching a Button's `variant` prop in the canvas (main <-> pill) leaves the page
// exactly as a fresh load of the same rendering shows it, and, when it cannot, reloads
// instead of showing a wrong size. The report: on swash-labs the CTA pill showed "LET'S"
// clipped in a narrow pill after a switch, and a refresh fixed it. The hero script had
// sized the adopted button once, from the variant it mounted with; the patch kept that
// inline size under the new variant.
// Method: jsdom pages shaped like Astro's dev output (scoped `data-astro-cid-*` classes,
// a `<style data-vite-dev-id>` in the head) go through the morph modules the way
// morphClient applies a rendering. After each patch the live head and body are compared
// with a fresh parse of the same rendering, in both directions, with the negative space
// covered: a class the server removed, a style attribute it removed, a scoped stylesheet
// whose text changed. Then a "script" sizes the button inline, and the switch must refuse
// to patch (the reload) while a transform, a pointer custom property, a server-written
// size or a plain text edit must not.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const loadMorphModules = require('../../helpers/morphModules.js');

const CID = 'data-astro-cid-x7k2';
const STYLE_ID = '/src/components/Button.astro?astro&type=style&index=0&lang.css';
const SCOPED_CSS = `.button_wrap[${CID}]{display:inline-flex;padding:.75em 1.5em}.button_wrap.pill[${CID}]{width:var(--pill-width,auto);white-space:nowrap}`;

const BUTTONS = {
  main: (label) => `<a href="#contact" class="button_wrap" ${CID}>\n  <span class="button_text text-style-trim" ${CID}>${label}</span>\n</a>`,
  pill: (label) =>
    `<a href="#contact" class="button_wrap pill" style="width: 15rem" ${CID}>\n  <span class="button_roll" ${CID}><span ${CID}>${label}</span>` +
    `<span aria-hidden="true" ${CID}>${label}</span></span><i class="button_arrow" style="--_arrow: url(/arrow.svg)" aria-hidden="true" ${CID}></i>\n</a>`,
};

const PAGE = (variant, { css = SCOPED_CSS, label = 'Let’s talk' } = {}) =>
  `<!doctype html><html><head><title>Page</title><style type="text/css" data-vite-dev-id="${STYLE_ID}">${css}</style></head>` +
  `<body><main><div class="cta">${BUTTONS[variant](label)}</div><p>After</p></main></body></html>`;

function setup(html) {
  const dom = new JSDOM(html);
  global.document = dom.window.document;
  const morph = loadMorphModules();
  const parse = (source) => new dom.window.DOMParser().parseFromString(source, 'text/html');
  let previous = parse(html);
  morph.noteStyles(previous);
  // What morphClient.applyRendering does with a new rendering, minus the markers.
  const apply = (source) => {
    const next = parse(source);
    morph.patchChildren(dom.window.document.head, previous.head, next.head);
    morph.patchChildren(dom.window.document.body, previous.body, next.body);
    morph.refreshDevStyles(previous, next);
    previous = next;
  };
  return { dom, document: dom.window.document, apply };
}

// Compared with a fresh load of `html` by isEqualNode: same nodes, attributes and text,
// with attribute order left out (a patched attribute is appended; the cascade does not care).
function assertLikeFresh(document, html, message) {
  const expected = new JSDOM(html).window.document;
  assert.equal(document.querySelector('style').textContent, expected.querySelector('style').textContent, `${message}: the scoped stylesheet`);
  assert.ok(document.body.isEqualNode(expected.body), `${message}: the markup\n${document.body.innerHTML}\n!=\n${expected.body.innerHTML}`);
}

test('main -> pill -> main patches to what a fresh load shows', () => {
  const { document, apply } = setup(PAGE('main'));
  const button = document.querySelector('a');
  apply(PAGE('pill'));
  assertLikeFresh(document, PAGE('pill'), 'pill');
  assert.equal(document.querySelector('a'), button, 'The button is patched in place, not rebuilt');
  apply(PAGE('main'));
  assertLikeFresh(document, PAGE('main'), 'back to main');
  assert.equal(button.getAttribute('class'), 'button_wrap', 'The server’s `pill` class is removed');
  assert.equal(button.hasAttribute('style'), false, 'The server’s style attribute is removed');
  assert.equal(document.querySelector('.button_arrow') === null, true, 'The arrow and its inline style are gone');
});

test('pill -> main -> pill patches to what a fresh load shows', () => {
  const { document, apply } = setup(PAGE('pill'));
  apply(PAGE('main'));
  assertLikeFresh(document, PAGE('main'), 'main');
  apply(PAGE('pill'));
  assertLikeFresh(document, PAGE('pill'), 'back to pill');
});

test('a variant switch that also changes the scoped stylesheet carries the new text', () => {
  const css = SCOPED_CSS.replace('white-space:nowrap', 'white-space:nowrap;max-width:20rem');
  const { document, apply } = setup(PAGE('main'));
  apply(PAGE('pill', { css }));
  assertLikeFresh(document, PAGE('pill', { css }), 'pill with new CSS');
  apply(PAGE('main'));
  assertLikeFresh(document, PAGE('main'), 'main with the old CSS back');
});

test('a button a page script sized from its old variant refuses the patch, in both directions', () => {
  for (const [from, to] of [
    ['main', 'pill'],
    ['pill', 'main'],
  ]) {
    const { document, apply } = setup(PAGE(from));
    // What swash-hero.js does as it adopts the CTA: measures it and writes the size inline.
    document.querySelector('a').setAttribute('style', '--pill-w: 105.17px; font-size: 45.99px; transform: translate(10px, 20px)');
    assert.throws(() => apply(PAGE(to)), /^Error: the page sized <a\.button_wrap.*\(font-size\) from markup this edit replaces$/, `${from} -> ${to}`);
  }
});

test('negative space: what a measurement is not still patches', () => {
  const cases = [
    ['an animation’s transform and opacity', 'transform: translate(10px, 20px); opacity: 1'],
    ['a pointer handler’s custom properties', '--_mx: 12px; --_my: 30px'],
  ];
  for (const [what, style] of cases) {
    const { document, apply } = setup(PAGE('main'));
    document.querySelector('a').setAttribute('style', style);
    assert.doesNotThrow(() => apply(PAGE('pill')), what);
    assert.equal(document.querySelector('a').getAttribute('class'), 'button_wrap pill', `${what}: the variant lands`);
    assert.equal(document.querySelector('a').getAttribute('style'), 'width: 15rem', `${what}: the server’s style is written`);
  }

  // The server wrote the size itself: it is the server's to change, not a measurement.
  const served = setup(PAGE('pill'));
  assert.doesNotThrow(() => served.apply(PAGE('main')), 'a server-written width');
  assertLikeFresh(served.document, PAGE('main'), 'server-written width removed');

  // A text edit keeps the class: the measured element is still the measured thing.
  const text = setup(PAGE('pill'));
  text.document.querySelector('a').setAttribute('style', 'width: 15rem; font-size: 45.99px');
  assert.doesNotThrow(() => text.apply(PAGE('pill', { label: 'Let’s chat' })), 'a text edit');
  assert.match(text.document.querySelector('a').textContent, /Let’s chat/);
});

test('pageMeasured names only sizing the server did not write', () => {
  const { document } = setup(PAGE('main'));
  const element = (style) => {
    const node = document.createElement('a');
    if (style !== undefined) {
      node.setAttribute('style', style);
    }
    return node;
  };
  const { pageMeasured } = loadMorphModules();
  assert.equal(pageMeasured(element('width: 10px'), element(undefined)), 'width');
  assert.equal(pageMeasured(element('WIDTH:10px'), element('width: 10px')), undefined, 'Case and spacing are not a change');
  assert.equal(pageMeasured(element('max-width: 30ch'), element('max-width: 20ch')), 'max-width', 'A changed value is the client’s');
  assert.equal(pageMeasured(element('--pill-w: 1px; opacity: 0'), element(undefined)), undefined);
  assert.equal(pageMeasured(element(undefined), element('width: 10px')), undefined, 'A size the client removed is not a measurement');
});
