// Goal: a double click inside rich text but on no words (between its paragraphs, in the box's padding) opens its
// words for typing instead of falling through to opening the component; a click outside the box does not.
// Method: JSDOM markup stamped as the preview stamps a rich text instance, a catalog target per paragraph, and a
// stubbed line geometry (JSDOM lays nothing out), against findRichBoxHit (electron/preload/frameText.ts).
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');

test('a click on the box itself takes the nearest words; outside it takes none', () => {
  const dom = new JSDOM(
    '<!doctype html><body><section id="outside"><div id="box" data-avb-p="x|0.0"><p data-avb-p="0.0.0">First</p><p data-avb-p="0.0.1">Second</p></div></section></body>',
    { pretendToBeVisual: true },
  );
  const { window } = dom;
  for (const name of ['HTMLElement', 'Node', 'Element', 'Text', 'Comment', 'NodeFilter', 'getComputedStyle']) {
    global[name] = window[name];
  }
  global.window = window;
  global.document = window.document;
  global.location = window.location;
  const tops = { First: 0, Second: 60 };
  window.Range.prototype.getClientRects = function () {
    const top = tops[this.startContainer.data];
    return [{ left: 0, right: 100, top, bottom: top + 20, width: 100, height: 20 }];
  };
  const { findRichBoxHit } = loadRenderer('electron/preload/frameText.ts');
  const target = (key, index, value) => ({
    kind: 'element',
    key,
    path: `0.0.${index}.0`,
    parent: `0.0.${index}`,
    value,
    label: 'p',
    nested: false,
    tag: 'p',
    siblings: [],
    breaks: 'rich',
    richRoot: '0.0',
  });
  const catalog = { targets: [target('first', 0, 'First'), target('second', 1, 'Second')] };
  const box = window.document.getElementById('box');
  const at = (element, y) => findRichBoxHit(catalog, { target: element, clientX: 500, clientY: y });
  try {
    assert.equal(at(box, 28)?.target.key, 'first');
    assert.equal(at(box, 52)?.target.key, 'second');
    assert.equal(at(window.document.getElementById('outside'), 28), undefined);
    assert.equal(findRichBoxHit({ targets: [{ ...catalog.targets[0], breaks: 'line' }] }, { target: box, clientX: 0, clientY: 0 }), undefined);
  } finally {
    window.close();
  }
});

test('rich text with no words is found by its box, and the space level with a narrow box types in it', () => {
  const dom = new JSDOM(
    '<!doctype html><body><section id="wrap" data-avb-p="9"><div id="box" data-avb-p="x|0.0"><img data-avb-p="0.0.0"></div></section></body>',
    { pretendToBeVisual: true },
  );
  const { window } = dom;
  for (const name of ['HTMLElement', 'Node', 'Element', 'Text', 'Comment', 'NodeFilter', 'getComputedStyle']) {
    global[name] = window[name];
  }
  global.window = window;
  global.document = window.document;
  global.location = window.location;
  const { findWordlessHit, findBesideHit } = loadRenderer('electron/preload/frameText.ts');
  const { collectRegions } = loadRenderer('electron/preload/frameRegions.ts');
  const catalog = { targets: [], boxes: ['0.0'] };
  const box = window.document.getElementById('box');
  const wrap = window.document.getElementById('wrap');
  box.getBoundingClientRect = () => ({ left: 0, right: 100, top: 0, bottom: 50 });
  try {
    collectRegions();
    assert.equal(findWordlessHit(catalog, { target: box })?.target.richRoot, '0.0');
    assert.equal(findWordlessHit(catalog, { target: wrap }), undefined);
    const beside = findBesideHit(catalog, { target: wrap, clientX: 400, clientY: 20 });
    assert.ok(beside === undefined || beside.target.richRoot === '0.0');
    assert.equal(findBesideHit(catalog, { target: wrap, clientX: 400, clientY: 200 }), undefined, 'below stays the wrapper’s');
  } finally {
    window.close();
  }
});
