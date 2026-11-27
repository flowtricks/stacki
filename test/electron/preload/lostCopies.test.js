// Goal: a component node drawn several times, where only one copy kept its marker comments (the
// others were written into slots their component renders to a string, which strips comments),
// is still one place per copy. The bug: the marked copy's single run unioned every tagged
// element, so selecting a Button's root with Button open outlined one box from the skip link to
// the footer. Also: a go-to shows what hides its element (frameUnhide.ts) and puts it back.
// Method: jsdom pages tagged as the canvas receives them; collectRegions runs and the runs are
// read from `regions`. Cases: separate instances split into copies in document order, clones of
// one element (a text animation) stay one copy, a second pass derives the same copies, and a
// closed block and a hidden tab panel are shown for a go-to, then restored exactly.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');

const preload = loadRenderer('test/fixtures/frameUnhideEntry.ts');
const KEY = 'Button.astro|0.0';

function pageOf(body) {
  const dom = new JSDOM(`<!doctype html><body>${body}</body>`);
  for (const name of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'SVGElement']) {
    global[name] = name === 'window' ? dom.window : dom.window[name];
  }
  preload.regions.clear();
  preload.resetFocusCache();
  preload.setTracking({ paths: [], scope: '', focus: '', occurrence: 0 });
  preload.collectRegions();
  return dom;
}

const marked = (id, html) => `<!--avb-s:${id}-->${html}<!--avb-e:${id}-->`;
const ids = (runs) =>
  (runs ?? []).map((run) =>
    run
      .filter((node) => node.nodeType === 1)
      .map((node) => node.id)
      .join('+'),
  );

test('copies that lost their markers are copies of their own, in document order', () => {
  const dom = pageOf(
    `<header data-avb-p="Skip.astro|0">${marked(KEY, `<a id="skip" data-avb-p="${KEY} Skip.astro|0.0">Skip</a>`)}</header>` +
      `<div data-avb-p="0.1"><a id="one" data-avb-p="${KEY} 0.1.0">One</a></div>` +
      `<footer data-avb-p="Footer.astro|0"><a id="two" data-avb-p="${KEY} Footer.astro|0.1">Two</a></footer>`,
  );
  try {
    assert.deepEqual(ids(preload.regions.get(KEY)), ['skip', 'one', 'two']);
    preload.collectRegions();
    assert.deepEqual(ids(preload.regions.get(KEY)), ['skip', 'one', 'two'], 'a second pass derives the same copies, not more');
  } finally {
    dom.window.close();
  }
});

test('clones of one marked element stay one copy', () => {
  const clone = (id) => `<p id="${id}" data-avb-p="0.2 Text.astro|0">line</p>`;
  const dom = pageOf(`<section data-avb-p="0">${marked('0.2', clone('first'))}${clone('second')}${clone('third')}</section>`);
  try {
    assert.deepEqual(ids(preload.regions.get('0.2')), ['first']);
  } finally {
    dom.window.close();
  }
});

test('a go-to shows a closed block and a hidden panel, and puts the page back', () => {
  const dom = pageOf(
    '<style>.modal { display: none } .modal.stacki-opened { display: block } .panel { visibility: hidden } .panel.on { visibility: visible }</style>' +
      '<div class="modal" id="modal"><a data-avb-p="0.1">In modal</a></div>' +
      '<div id="panels"><div class="panel on" id="first">A</div><div class="panel" id="second" style="color: red"><a data-avb-p="0.2">B</a></div></div>' +
      '<details id="more"><summary>More</summary><a data-avb-p="0.3">C</a></details>',
  );
  const byId = (id) => dom.window.document.getElementById(id);
  try {
    preload.showTarget('0.1', 0, { unhide: false });
    assert.equal(byId('modal').classList.contains('stacki-opened'), false, 'only a go-to shows hidden content');
    preload.showTarget('0.1', 0, { unhide: true });
    assert.equal(byId('modal').classList.contains('stacki-opened'), true);
    preload.showTarget('0.2', 0, { unhide: true });
    assert.equal(byId('modal').classList.contains('stacki-opened'), false, 'the next go-to closes what the last opened');
    assert.equal(byId('second').style.visibility, 'visible');
    preload.showTarget('0.3', 0, { unhide: true });
    assert.equal(byId('second').getAttribute('style'), 'color: red', 'the panel’s own style is back as it was');
    assert.equal(byId('more').hasAttribute('open'), true);
    preload.restoreUntracked(['0.3']);
    assert.equal(byId('more').hasAttribute('open'), true, 'kept while the selection is inside it');
    preload.restoreUntracked(['0.1']);
    assert.equal(byId('more').hasAttribute('open'), false);
  } finally {
    dom.window.close();
  }
});
