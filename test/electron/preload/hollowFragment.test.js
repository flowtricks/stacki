// Goal: a fragment, loop or condition whose markers a slot-scrubbing component stripped is still ONE place per
// rendering, worked out from its children's tags (frameRegions.ts collectHollowRegions), so its outline is the union
// of every child. The bug: each child of a `<Fragment slot>` also carries its own component's root path
// (`Paragraph.astro|0`, `ButtonWrapper.astro|0`), and those split the fragment into one copy per child; the navigator
// selects copy zero and the outline wrapped the paragraph alone.
// Method: jsdom pages tagged as the canvas receives them once the comments are gone; collectRegions runs and the
// derived runs are read from `regions`. Cases: the bug's two children, bare text between children, a loop child, a
// nested fragment, separate component instances (which must stay separate copies), and 8,000 loop items. The large
// loop counts sibling steps and the size of array membership scans to catch repeated walks of a growing run.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');
const frame = loadRenderer('electron/preload/frameRegions.ts');

const FRAGMENT = '0.0.1';
const child = (index) => `${FRAGMENT}.${index}`;

function collect(columnHtml) {
  const dom = new JSDOM(
    `<!doctype html><body><!--avb-s:0--><section data-avb-p="0"><div data-avb-p="0.0 ContentWrapper.astro|0"><div id="column">${columnHtml}</div></div></section><!--avb-e:0--></body>`,
  );
  global.document = dom.window.document;
  frame.regions.clear();
  frame.resetFocusCache();
  frame.setTracking({ paths: [], scope: '', focus: '', occurrence: 0 });
  frame.collectRegions();
  const column = dom.window.document.getElementById('column');
  assert.ok(column, 'the page holds the column');
  return { column, runs: (nodePath) => frame.regions.get(nodePath), close: () => dom.window.close() };
}

const elementsOf = (run) => run.filter((node) => node.nodeType === 1);

test('a scrubbed fragment holding two components is one copy of both', () => {
  const page = collect(
    `<p data-avb-p="Paragraph.astro|0 ${child(0)}">Body</p><div data-avb-p="ButtonWrapper.astro|0 ${child(1)}"><a data-avb-p="Button.astro|0 ${child(1)}.0">Go</a></div>`,
  );
  try {
    const runs = page.runs(FRAGMENT);
    assert.equal(runs?.length, 1, 'one rendering, one run');
    assert.deepEqual(elementsOf(runs[0]), Array.from(page.column.children));
  } finally {
    page.close();
  }
});

test("the bare text between a fragment's children is in its run", () => {
  const page = collect(`<span data-avb-p="${child(0)}">Lead</span> between <span data-avb-p="${child(2)}">Tail</span>`);
  try {
    const runs = page.runs(FRAGMENT);
    assert.equal(runs?.length, 1);
    assert.equal(runs[0].length, 3, 'element, text, element');
    assert.equal(runs[0][1].textContent, ' between ');
  } finally {
    page.close();
  }
});

test('a fragment holding a loop and a button wraps the items too, and the loop stays one copy', () => {
  const items = [0, 1, 2].map((item) => `<div data-avb-p="Card.astro|0 ${child(0)}.0">${item}</div>`).join('');
  const page = collect(`${items}<div data-avb-p="ButtonWrapper.astro|0 ${child(1)}">Go</div>`);
  try {
    const fragmentRuns = page.runs(FRAGMENT);
    assert.equal(fragmentRuns?.length, 1);
    assert.equal(elementsOf(fragmentRuns[0]).length, 4, 'three items and the button');
    const loopRuns = page.runs(child(0));
    assert.equal(loopRuns?.length, 1, 'a loop is one place, its items its contents');
    assert.equal(elementsOf(loopRuns[0]).length, 3);
  } finally {
    page.close();
  }
});

test('a fragment inside a fragment: each is one copy, the outer one wraps the inner one', () => {
  const page = collect(
    `<p data-avb-p="Paragraph.astro|0 ${child(0)}">A</p><p data-avb-p="Paragraph.astro|0 ${child(1)}.0">B</p><div data-avb-p="ButtonWrapper.astro|0 ${child(1)}.1">C</div>`,
  );
  try {
    assert.equal(page.runs(FRAGMENT)?.length, 1);
    assert.equal(elementsOf(page.runs(FRAGMENT)[0]).length, 3);
    assert.equal(page.runs(child(1))?.length, 1);
    assert.equal(elementsOf(page.runs(child(1))[0]).length, 2);
  } finally {
    page.close();
  }
});

test('separate instances of a component stay separate copies of its hollow node', () => {
  // Five Buttons whose root fragment is hollow: each instance is told apart by the page path it was given.
  const buttons = [1, 2, 3, 4, 5].map((index) => `<a data-avb-p="Button.astro|0.0 0.0.${index}">B${index}</a>`).join('');
  const page = collect(buttons);
  try {
    const runs = page.runs('Button.astro|0');
    assert.equal(runs?.length, 5, 'one copy per instance');
    for (const run of runs) {
      assert.equal(elementsOf(run).length, 1);
    }
  } finally {
    page.close();
  }
});

test('collecting a hollow fragment walks the 8,000-item loop a bounded number of times', () => {
  const measure = (count) => {
    const items = Array.from({ length: count }, (_, item) => `<div data-avb-p="Card.astro|0 ${child(0)}.0">${item}</div>`).join('');
    const page = collect(`${items}<div data-avb-p="${child(1)}">Go</div>`);
    try {
      const work = countCollectionWork(page.column.ownerDocument.defaultView);
      assert.equal(page.runs(FRAGMENT)?.length, 1);
      assert.equal(elementsOf(page.runs(FRAGMENT)[0]).length, count + 1);
      assert.equal(page.runs(child(0))?.length, 1);
      assert.equal(elementsOf(page.runs(child(0))[0]).length, count);
      return work;
    } finally {
      page.close();
    }
  };
  const smallWork = measure(1000);
  const largeWork = measure(8000);
  assert.ok(smallWork >= 1000, 'the collection walks the loop');
  assert.ok(largeWork < smallWork * 24, `8 times the items took ${largeWork} steps against ${smallWork}`);
});

function countCollectionWork(window) {
  const nodePrototype = window.Node.prototype;
  const sibling = Object.getOwnPropertyDescriptor(nodePrototype, 'nextSibling');
  assert.equal(typeof sibling?.get, 'function', 'jsdom exposes the sibling getter');
  const includes = Array.prototype.includes;
  let steps = 0;
  Object.defineProperty(nodePrototype, 'nextSibling', {
    ...sibling,
    get() {
      steps += 1;
      return sibling.get.call(this);
    },
  });
  Array.prototype.includes = function (item, fromIndex) {
    if (item instanceof window.Node) {
      // Checking each new node against the run already collected scans the full array on a miss.
      steps += this.length;
    }
    return includes.call(this, item, fromIndex);
  };
  try {
    frame.collectRegions();
    return steps;
  } finally {
    Array.prototype.includes = includes;
    Object.defineProperty(nodePrototype, 'nextSibling', sibling);
  }
}
