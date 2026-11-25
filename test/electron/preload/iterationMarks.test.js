// Goal: the frame tells which pass of a loop a clicked node is in, from the
// pass markers the marked page carries, whatever the node's own copy count.
//
// The reported page: `cards.map((card) => …)` renders three cards; each shows a
// FlutedImage when `card.fluted` and an Image otherwise, and only card three is
// not fluted. The Image renders ONCE, so counting its copies says "first of
// one"; the pass it sits after says third.
//
// Method: the page's markup as the marker plugin serves it (generated here:
// node markers, a pass marker at the start of each pass), collected in jsdom by
// the real preload modules, which take the markers out. Then each node's
// iterations are read as a click would. Checked: the lone Image is in pass 2;
// a node in card two is in pass 1; nested loops name each loop's own pass; a
// loop that renders its passes in another order (a filtered list) names the
// list place the marker says, not the rendered one; a loop in a component
// rendered twice reads its own instance; and what is not known stays out
// (no marks, an unmarked ancestor, a pass that rendered nothing, a page patched
// so the pass left the document).
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const loadFrameModules = require('../../helpers/frameModules.js');

function inPage(html, read) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  global.window = dom.window;
  global.document = dom.window.document;
  try {
    const frame = loadFrameModules();
    frame.collectRegions();
    return read(frame, dom.window.document);
  } finally {
    dom.window.close();
    delete global.window;
    delete global.document;
  }
}
const imageIn = (frame, nodePath) => frame.iterationsForRun(nodePath, frame.runsOf(nodePath)?.[0]);

// Card k: a pass marker, the card div (path 0.0.0), the condition (0.0.0.0) and the branch's node.
const card = (index, fluted) => `
  <!--avb-i:${index}:0.0--><!--avb-s:0.0.0--><div data-avb-p="0.0.0" class="card">
    <!--avb-s:0.0.0.0-->${
      fluted
        ? '<!--avb-s:0.0.0.0.0--><!--avb-s:0.0.0.0.0.0--><section data-avb-p="0.0.0.0.0.0">fluted</section><!--avb-e:0.0.0.0.0.0--><!--avb-e:0.0.0.0.0-->'
        : '<!--avb-s:0.0.0.0.1--><!--avb-s:0.0.0.0.1.0--><img data-avb-p="0.0.0.0.1.0" alt="plain"><!--avb-e:0.0.0.0.1.0--><!--avb-e:0.0.0.0.1-->'
    }<!--avb-e:0.0.0.0-->
  </div><!--avb-e:0.0.0-->`;
const PAGE = `<!--avb-s:0--><main data-avb-p="0"><!--avb-s:0.0-->${card(0, true)}${card(1, true)}${card(2, false)}<!--avb-e:0.0--></main><!--avb-e:0-->`;

test('the Image that renders only in the third card is in pass 2, though it has one copy', () => {
  inPage(PAGE, (frame) => {
    assert.equal(frame.runsOf('0.0.0.0.1.0').length, 1, 'one copy of the Image');
    assert.deepEqual(imageIn(frame, '0.0.0.0.1.0'), [{ path: '0.0', index: 2 }]);
  });
});

test('a node in card two is in pass 1, and each card’s div is its own pass', () => {
  inPage(PAGE, (frame) => {
    assert.deepEqual(imageIn(frame, '0.0.0.0.0.0').length, 1);
    const fluted = frame.runsOf('0.0.0.0.0.0');
    assert.equal(fluted.length, 2, 'two fluted copies');
    assert.deepEqual(frame.iterationsForRun('0.0.0.0.0.0', fluted[0]), [{ path: '0.0', index: 0 }]);
    assert.deepEqual(frame.iterationsForRun('0.0.0.0.0.0', fluted[1]), [{ path: '0.0', index: 1 }]);
    const cards = frame.runsOf('0.0.0');
    assert.deepEqual(
      cards.map((run, at) => frame.iterationsForRun('0.0.0', run)[0]?.index ?? 'none'),
      [0, 1, 2],
    );
  });
});

test('the loop itself and nodes outside it name no pass of it', () => {
  inPage(PAGE, (frame) => {
    assert.deepEqual(frame.iterationsForRun('0.0', frame.runsOf('0.0')?.[0]), [], 'a loop is not inside its own passes');
    assert.deepEqual(frame.iterationsForRun('0', frame.runsOf('0')?.[0]), []);
  });
});

test('nested loops name each loop’s own pass, outermost and innermost', () => {
  const inner = (outer, index) => `<!--avb-i:${index}:0.0.0.1--><!--avb-s:0.0.0.1.0--><li data-avb-p="0.0.0.1.0">${outer}-${index}</li><!--avb-e:0.0.0.1.0-->`;
  const group = (index) =>
    `<!--avb-i:${index}:0.0--><!--avb-s:0.0.0--><ul data-avb-p="0.0.0"><!--avb-s:0.0.0.1-->${inner(index, 0)}${inner(index, 1)}<!--avb-e:0.0.0.1--></ul><!--avb-e:0.0.0-->`;
  const html = `<!--avb-s:0--><main data-avb-p="0"><!--avb-s:0.0-->${group(0)}${group(1)}<!--avb-e:0.0--></main><!--avb-e:0-->`;
  inPage(html, (frame) => {
    const rows = frame.runsOf('0.0.0.1.0');
    assert.equal(rows.length, 4);
    const named = rows.map((run) =>
      frame
        .iterationsForRun('0.0.0.1.0', run)
        .map((pass) => `${pass.path}=${pass.index}`)
        .join(' '),
    );
    assert.deepEqual(named, ['0.0.0.1=0 0.0=0', '0.0.0.1=1 0.0=0', '0.0.0.1=0 0.0=1', '0.0.0.1=1 0.0=1']);
  });
});

test('a filtered loop names the list place the marker says, not the rendered order', () => {
  // Rendered order is c, a (items 2 and 0 of the list the picker shows).
  const pass = (index, text) => `<!--avb-i:${index}:0.0--><!--avb-s:0.0.0--><p data-avb-p="0.0.0">${text}</p><!--avb-e:0.0.0-->`;
  const html = `<!--avb-s:0--><main data-avb-p="0"><!--avb-s:0.0-->${pass(2, 'c')}${pass(0, 'a')}<!--avb-e:0.0--></main><!--avb-e:0-->`;
  inPage(html, (frame) => {
    const runs = frame.runsOf('0.0.0');
    assert.deepEqual(
      runs.map((run) => frame.iterationsForRun('0.0.0', run)[0]?.index),
      [2, 0],
    );
  });
});

test('an item the render could not place says -1, which the editor reads as unknown', () => {
  const html = `<!--avb-s:0--><main data-avb-p="0"><!--avb-s:0.0--><!--avb-i:-1:0.0--><!--avb-s:0.0.0--><p data-avb-p="0.0.0">x</p><!--avb-e:0.0.0--><!--avb-e:0.0--></main><!--avb-e:0-->`;
  inPage(html, (frame) => {
    assert.deepEqual(frame.iterationsForRun('0.0.0', frame.runsOf('0.0.0')?.[0]), [{ path: '0.0', index: -1 }]);
  });
});

test('a loop in a component rendered twice reads its own instance', () => {
  const loop = (instance) =>
    `<!--avb-s:Card.astro|0--><section data-avb-p="Card.astro|0"><!--avb-s:Card.astro|0.0-->` +
    [0, 1, 2]
      .map(
        (index) =>
          `<!--avb-i:${index}:Card.astro|0.0--><!--avb-s:Card.astro|0.0.0--><i data-avb-p="Card.astro|0.0.0">${instance}${index}</i><!--avb-e:Card.astro|0.0.0-->`,
      )
      .join('') +
    `<!--avb-e:Card.astro|0.0--></section><!--avb-e:Card.astro|0-->`;
  inPage(`<main>${loop('a')}${loop('b')}</main>`, (frame) => {
    const items = frame.runsOf('Card.astro|0.0.0');
    assert.equal(items.length, 6);
    assert.deepEqual(
      items.map((run) => frame.iterationsForRun('Card.astro|0.0.0', run)[0]?.index),
      [0, 1, 2, 0, 1, 2],
    );
  });
});

test('no marks name nothing (the editor falls back)', () => {
  const plain = `<!--avb-s:0--><main data-avb-p="0"><!--avb-s:0.0--><!--avb-s:0.0.0--><p data-avb-p="0.0.0">a</p><!--avb-e:0.0.0--><!--avb-e:0.0--></main><!--avb-e:0-->`;
  inPage(plain, (frame) => assert.deepEqual(frame.iterationsForRun('0.0.0', frame.runsOf('0.0.0')?.[0]), [], 'an older page marks none'));
  assert.throws(() => inPage(PAGE, (frame) => frame.iterationsOf(document.body, new Array(100).fill('0.0'))), /bounded number of ancestors/);
});

test('the markers leave the document, so the page is as it was without them', () => {
  inPage(PAGE, (_frame, frameDocument) => {
    const comments = [];
    const walker = frameDocument.createTreeWalker(frameDocument.body, 128);
    while (walker.nextNode()) {
      comments.push(walker.currentNode.data);
    }
    assert.deepEqual(comments, []);
  });
});
