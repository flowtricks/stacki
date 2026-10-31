// Goal: a text run inside an inline run has no markers and no tag, yet must still be found,
// so a selected run of words draws an outline on the canvas.
// Method: build the markup the serializer writes for `text <strong>…</strong> text` in JSDOM,
// then ask for each child path. Known-good placements are claimed; every placement that is not
// certain (a missing neighbour, a gap of two, siblings out of order, an index past the end, a
// root path) claims nothing rather than a wrong box.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');
const regions = loadRenderer('electron/preload/frameRegions.ts');
const inline = loadRenderer('electron/preload/inlineText.ts');

function page(html) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  global.document = dom.window.document;
  // Each bundle carries its own frameRegions; inlineText's copy starts untracked and unfocused.
  regions.resetFocusCache();
  return dom;
}
const words = (path) =>
  inline.inlineTextRuns(path).map((run) => run.map((text) => text.data.trim()));

const HEADING =
  '<h2 data-avb-p="src/components/Heading.astro|0.0.0 0.1">' +
  '\n  The way we change the world: <strong data-avb-p="0.1.1">Follow Jesus.</strong>' +
  " Let's change the world together!\n</h2>";

test('the text before and after a tagged sibling is found', () => {
  const dom = page(HEADING);
  try {
    assert.deepEqual(words('0.1.0'), [['The way we change the world:']]);
    assert.deepEqual(words('0.1.2'), [["Let's change the world together!"]]);
  } finally {
    dom.window.close();
  }
});

test('an index that is not certain claims nothing', () => {
  const dom = page(HEADING);
  try {
    assert.deepEqual(words('0.1.3'), [], 'two past the last tagged sibling');
    assert.deepEqual(words('0.1.1'), [], 'the element itself is not text');
    assert.deepEqual(words('0'), [], 'a root has no parent to look in');
    assert.deepEqual(words('0.9.0'), [], 'a parent that is not on the page');
    assert.deepEqual(words('0.1.x'), [], 'a malformed index');
  } finally {
    dom.window.close();
  }
});

test('a gap of more than one child is not claimed', () => {
  const dom = page(
    '<p data-avb-p="0">one <b data-avb-p="0.1">two</b> three <i data-avb-p="0.4">four</i></p>',
  );
  try {
    assert.deepEqual(words('0.2'), [], 'the next tagged sibling is 0.4, not 0.3');
    assert.deepEqual(words('0.0'), [['one']]);
  } finally {
    dom.window.close();
  }
});

test('siblings out of order claim nothing rather than crash', () => {
  const dom = page(
    '<p data-avb-p="0"><b data-avb-p="0.3">a</b> mid <i data-avb-p="0.1">b</i> end</p>',
  );
  try {
    assert.deepEqual(words('0.2'), []);
  } finally {
    dom.window.close();
  }
});

test('a component that wraps its slot is searched where the siblings are', () => {
  const dom = page(
    '<div data-avb-p="0.2"><span class="inner">' +
      'Hello <em data-avb-p="0.2.1">there</em> friend</span></div>',
  );
  try {
    assert.deepEqual(words('0.2.0'), [['Hello']]);
    assert.deepEqual(words('0.2.2'), [['friend']]);
  } finally {
    dom.window.close();
  }
});

test('plain text with no tagged siblings is the whole run, at index 0 only', () => {
  const dom = page('<p data-avb-p="0.5">Just words</p>');
  try {
    assert.deepEqual(words('0.5.0'), [['Just words']]);
    assert.deepEqual(words('0.5.1'), []);
  } finally {
    dom.window.close();
  }
});

test('each place the parent renders gives its own run', () => {
  const dom = page('<p data-avb-p="0.3">first</p><p data-avb-p="0.3">second</p>');
  try {
    assert.deepEqual(words('0.3.0'), [['first'], ['second']]);
  } finally {
    dom.window.close();
  }
});

test('inlinePlace splits a path and rejects roots and bad indexes', () => {
  assert.deepEqual(inline.inlinePlace('src/A.astro|0.1.2'), {
    parent: 'src/A.astro|0.1',
    index: 2,
  });
  assert.equal(inline.inlinePlace('0'), undefined);
  assert.equal(inline.inlinePlace('.1'), undefined);
  assert.equal(inline.inlinePlace('0.-1'), undefined);
  assert.equal(inline.inlinePlace('0.99999999999999999999'), undefined);
});

// Hover: the pointer over the words beside a tagged sibling names the text run; JSDOM has no
// layout, so the caret lookup and the text's boxes are stubbed to put the pointer on the words.
function pointAt(dom, text, onWords) {
  dom.window.document.caretRangeFromPoint = () => ({ startContainer: text });
  dom.window.Range.prototype.getClientRects = () =>
    onWords ? [{ left: 0, right: 100, top: 0, bottom: 20 }] : [];
}

test('the pointer on words beside a tagged sibling names that text run', () => {
  const dom = page(HEADING);
  try {
    const heading = document.querySelector('h2');
    pointAt(dom, heading.lastChild, true);
    assert.equal(inline.inlineTextPathAt('0.1', 10, 10), '0.1.2');
    pointAt(dom, heading.firstChild, true);
    assert.equal(inline.inlineTextPathAt('0.1', 10, 10), '0.1.0');
    pointAt(dom, heading.lastChild, false);
    assert.equal(inline.inlineTextPathAt('0.1', 10, 10), undefined, 'blank space beside them');
    pointAt(dom, heading.lastChild, true);
    assert.equal(inline.inlineTextPathAt('0.9', 10, 10), undefined, 'another parent');
  } finally {
    dom.window.close();
  }
});

test('words that are their element’s only content leave the element as the target', () => {
  const dom = page('<p data-avb-p="0.5">Just words</p>');
  try {
    pointAt(dom, document.querySelector('p').firstChild, true);
    assert.equal(inline.inlineTextPathAt('0.5', 10, 10), undefined);
  } finally {
    dom.window.close();
  }
});

test('without a caret lookup nothing is reported', () => {
  const dom = page(HEADING);
  try {
    assert.equal(inline.inlineTextPathAt('0.1', 10, 10), undefined);
  } finally {
    dom.window.close();
  }
});
