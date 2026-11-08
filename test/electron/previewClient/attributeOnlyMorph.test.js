// Goal: a prop edit that changes only an element's own attributes (a maxWidth that
// writes a `style`, a variant that writes a class) patches those attributes in place,
// even when a page script has rebuilt the element's children. On stacki.build the hero
// heading's text is split into lines by an entrance script; the patch used to descend
// into those children, fail to line them up with the server's, and reload the page on
// every keystroke, restarting every entrance animation: the reported flicker.
// Method: a jsdom page where a "script" has replaced a heading's text with line
// wrappers; renderings from that window's DOMParser that differ only in the heading's
// style, then only in its class, go through the morph modules. A MutationObserver
// records every node added or removed; the checks require node identity to hold and
// the scripted children to survive, and that a real change to the children still lands.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const loadMorphModules = require('../../helpers/morphModules.js');
const { LIMITS } = require('#dist/shared/core/limits.js');

const HEADING = (style, className, text) =>
  `<!--avb-s:0.1--><h1 style="${style}" class="${className}" data-avb-p="Heading.astro|0.0.0 0.1">\n  ${text}\n</h1><!--avb-e:0.1-->`;

const PAGE = (body) => `<!doctype html><html><head><title>Page</title></head><body><main>${body}<p data-avb-p="0.2">After</p></main></body></html>`;

function rendering(dom, morph, html) {
  const withAnchors = new dom.window.DOMParser().parseFromString(html, 'text/html');
  const clean = withAnchors.cloneNode(true);
  morph.stripAnchors(clean);
  return { withAnchors, clean };
}

function patch(document, morph, previous, next) {
  morph.patchChildren(document.body, previous.clean.body, next.clean.body);
  morph.syncAnchors(document.body, next.withAnchors.body);
}

function setup() {
  const first = PAGE(HEADING('--_mw: 17ch;', 'heading text-style-display', 'Edit Astro sites visually'));
  const dom = new JSDOM(first);
  global.document = dom.window.document;
  const morph = loadMorphModules(LIMITS);
  const document = dom.window.document;
  // What the page's entrance script does: the text becomes one wrapper per line.
  const heading = document.querySelector('h1');
  heading.replaceChildren(
    ...['Edit Astro', 'sites visually'].map((line) => Object.assign(document.createElement('div'), { className: 'line', textContent: line })),
  );
  const changes = [];
  new dom.window.MutationObserver((records) => {
    for (const record of records) {
      for (const node of [...record.addedNodes, ...record.removedNodes]) {
        if (node.nodeType === 1) {
          changes.push(`${record.addedNodes.length > 0 ? '+' : '-'}${node.tagName}`);
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
  return { dom, morph, document, heading, changes, first: rendering(dom, morph, first) };
}

test('a run of attribute-only prop changes patches the attribute in place and keeps scripted children', () => {
  const { dom, morph, document, heading, changes, first } = setup();
  let previous = first;
  for (const width of ['20ch', '25ch', '30ch']) {
    const next = rendering(dom, morph, PAGE(HEADING(`--_mw: ${width};`, 'heading text-style-display', 'Edit Astro sites visually')));
    assert.doesNotThrow(() => patch(document, morph, previous, next), `The ${width} patch lines up without a reload`);
    previous = next;
  }
  const variant = rendering(dom, morph, PAGE(HEADING('--_mw: 30ch;', 'heading text-style-h1', 'Edit Astro sites visually')));
  patch(document, morph, previous, variant);
  assert.equal(document.querySelector('h1'), heading, 'The heading is the same node');
  assert.equal(heading.getAttribute('style'), '--_mw: 30ch;');
  assert.equal(heading.className, 'heading text-style-h1');
  assert.deepEqual(
    [...heading.querySelectorAll('.line')].map((line) => line.textContent),
    ['Edit Astro', 'sites visually'],
    'The entrance script’s line wrappers stay',
  );
  assert.deepEqual(changes, [], 'Nothing was removed or inserted');
});

test('negative space: when the children did change, they are still patched', () => {
  const dom = new JSDOM(PAGE(HEADING('--_mw: 17ch;', 'heading', 'Old words')));
  global.document = dom.window.document;
  const morph = loadMorphModules(LIMITS);
  const previous = rendering(dom, morph, PAGE(HEADING('--_mw: 17ch;', 'heading', 'Old words')));
  const next = rendering(dom, morph, PAGE(HEADING('--_mw: 20ch;', 'heading', 'New words')));
  patch(dom.window.document, morph, previous, next);
  const heading = dom.window.document.querySelector('h1');
  assert.equal(heading.getAttribute('style'), '--_mw: 20ch;');
  assert.match(heading.textContent, /New words/, 'A changed text still reaches the page');
});
