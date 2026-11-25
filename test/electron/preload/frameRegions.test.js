// Goal: selected-node lookup must avoid reading every tag while keeping live-DOM semantics.
// Method: count our attribute reads after native selection, then test repeated paths,
// nesting, focused instances, unusual path tokens, limits and synchronous DOM changes.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');
const regions = loadRenderer('electron/preload/frameRegions.ts');

function fixture() {
  const dom = new JSDOM('<!doctype html><body></body>');
  global.document = dom.window.document;
  regions.resetFocusCache();
  regions.setTracking({ paths: [], scope: '', focus: '', occurrence: 0 });
  const add = (value, parent = document.body) => {
    const element = document.createElement('div');
    element.setAttribute('data-avb-p', value);
    parent.append(element);
    return element;
  };
  return { add, close: () => dom.window.close() };
}

test('ordinary lookup reads only matching tags on a 2,000-element page', () => {
  const view = fixture();
  try {
    for (let index = 0; index < 2000; index++) {
      view.add(`0.${index}`);
    }
    let reads = 0;
    let selecting = false;
    const query = document.querySelectorAll.bind(document);
    // JSDOM implements the browser selector engine in JS. Count only our work
    // after that engine returns, not its implementation's own attribute reads.
    document.querySelectorAll = (selector) => {
      selecting = true;
      try {
        return query(selector);
      } finally {
        selecting = false;
      }
    };
    const prototype = document.defaultView.Element.prototype;
    const read = prototype.getAttribute;
    prototype.getAttribute = function (name) {
      if (!selecting) {
        if (name === 'data-avb-p') {
          reads++;
        }
      }
      return read.call(this, name);
    };
    const selected = regions.elementsWithPath('0.123');
    assert.equal(selected.length, 1);
    assert.equal(reads, 1);
    reads = 0;
    assert.deepEqual(regions.allElementsWithPath('0.123', 1), selected);
    assert.equal(reads, 1);
    assert.deepEqual(regions.elementsWithPath('missing'), []);
  } finally {
    view.close();
  }
});

test('token matching, nested copies and clone changes preserve exact results', () => {
  const view = fixture();
  try {
    const first = view.add('0 src/components/Card.astro|0.1');
    view.add('0', first);
    const second = view.add('0');
    view.add('0.1');
    view.add('10');
    view.add('0\tother');
    assert.deepEqual(regions.elementsWithPath('0'), [first, second]);
    assert.deepEqual(regions.elementsWithPath('src/components/Card.astro|0.1'), [first]);
    assert.deepEqual(regions.allElementsWithPath('0'), [first, second], 'every occurrence is returned, never refused for being many');
    first.remove();
    const clone = second.cloneNode(true);
    document.body.append(clone);
    assert.deepEqual(regions.elementsWithPath('0'), [second, clone]);
    second.setAttribute('data-avb-p', '1');
    assert.deepEqual(regions.elementsWithPath('0'), [clone]);
    assert.deepEqual(regions.allElementsWithPath('0'), [clone]);
  } finally {
    view.close();
  }
});

test('unusual tokens cannot inject selectors or change matching semantics', () => {
  const view = fixture();
  try {
    const values = ['x"]', 'x\\y', 'компонент|0', 'é|0', 'x\ny', 'x\ty', '0\n', '#id', '😀|0'];
    for (const value of values) {
      const element = view.add(value);
      assert.deepEqual(regions.elementsWithPath(value), [element]);
      assert.deepEqual(regions.allElementsWithPath(value), [element]);
    }
    view.add('with space');
    assert.deepEqual(regions.elementsWithPath('with space'), []);
    assert.deepEqual(regions.elementsWithPath(''), []);
    assert.deepEqual(regions.elementsWithPath('x"], div, [data-avb-p="'), []);
  } finally {
    view.close();
  }
});

test('focused lookup narrows instances while authored edits still reach every copy', () => {
  const view = fixture();
  try {
    const first = view.add('0');
    const firstChild = view.add('Card.astro|0', first);
    const second = view.add('0');
    const secondChild = view.add('Card.astro|0', second);
    const box = { x: 0, y: 0, width: 100, height: 100, left: 0, top: 0, right: 100, bottom: 100 };
    first.getBoundingClientRect = () => box;
    second.getBoundingClientRect = () => box;
    regions.setTracking({ paths: [], scope: 'Card.astro|', focus: '0', occurrence: 1 });
    assert.deepEqual(regions.elementsWithPath('Card.astro|0'), [secondChild]);
    assert.deepEqual(regions.allElementsWithPath('Card.astro|0', 2), [firstChild, secondChild]);
  } finally {
    view.close();
  }
});
