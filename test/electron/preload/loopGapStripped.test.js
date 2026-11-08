// Goal: a loop whose markers a component stripped out (a <Section> that renders its
// slot to a string and removes the comments, as stacki.build's does) is still a node
// on the canvas. Its items keep their `data-avb-p`, the loop's path plus their own
// index, so the canvas works out the loop's area from them: the gap between items
// selects the loop, an item selects the item, the space outside the items selects
// the holder, and the loop's outline wraps every item. A loop with one item is still
// outlined around it. Markers, where they survive, stay the answer.
// Method: run the built preload over a jsdom page marked as the serializer marks it
// after the comments are gone, with the layout stated box by box and
// elementFromPoint answering from those boxes (as test/electron/preload/loopGapHit.test.js
// does), then read what click, hover and tracking report.
const assert = require('node:assert/strict');
const Module = require('node:module');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

// <section> is 0, the <ul> 0.0, `items.map` 0.0.0 (no element, markers gone) and each <li> 0.0.0.0.
// The one-item loop 0.1.0 sits in its own <ul> 0.1. The marked loop 0.2.0 keeps its comments.
const PAGE = `<!doctype html><body><!--avb-s:0--><section data-avb-p="0" data-box="section">
  <ul data-avb-p="0.0" data-box="list">
    <li data-avb-p="0.0.0.0" data-box="item1">One</li>
    <li data-avb-p="0.0.0.0" data-box="item2">Two</li>
    <li data-avb-p="0.0.0.0" data-box="item3">Three</li>
  </ul>
  <ul data-avb-p="0.1" data-box="single"><li data-avb-p="0.1.0.0" data-box="only">Only</li></ul>
  <ul data-avb-p="0.2" data-box="marked"><!--avb-s:0.2.0--><li data-avb-p="0.2.0.0" data-box="m1">A</li><li data-avb-p="0.2.0.0" data-box="m2">B</li><!--avb-e:0.2.0--></ul>
</section><!--avb-e:0--></body>`;

// [left, top, width, height]: three items in a row with 40px gaps, padding around them.
const BOXES = {
  section: [0, 0, 1000, 600],
  list: [0, 0, 1000, 100],
  item1: [20, 20, 100, 40],
  item2: [160, 20, 100, 40],
  item3: [300, 20, 100, 40],
  single: [0, 200, 1000, 100],
  only: [20, 220, 100, 40],
  marked: [0, 400, 1000, 100],
  m1: [20, 420, 100, 40],
  m2: [160, 420, 100, 40],
};

async function openPage() {
  const dom = new JSDOM(PAGE, { url: 'http://localhost:4321/#avb-design', pretendToBeVisual: true });
  const { window } = dom;
  const measured = (name) => {
    const [x, y, width, height] = BOXES[name] ?? [0, 0, 0, 0];
    return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height };
  };
  window.Element.prototype.getBoundingClientRect = function () {
    return measured(this.getAttribute('data-box'));
  };
  window.Range.prototype.getBoundingClientRect = () => measured('');
  window.focus = () => {};
  window.document.elementFromPoint = (x, y) => {
    let found;
    for (const element of window.document.querySelectorAll('[data-box]')) {
      const area = measured(element.getAttribute('data-box'));
      if (x >= area.left && x <= area.right && y >= area.top && y <= area.bottom) {
        found = found === undefined || found.contains(element) ? element : found;
      }
    }
    return found;
  };
  for (const name of ['window', 'document', 'location', 'navigator', 'MutationObserver', 'Element', 'Node', 'MouseEvent']) {
    global[name] = name === 'window' ? window : window[name];
  }
  global.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  const sent = [];
  window.parent = { postMessage: (message) => sent.push(message) };
  const electron = {
    contextBridge: { exposeInMainWorld: () => {} },
    ipcRenderer: { on: () => {}, send: () => {}, invoke: async () => {} },
    webUtils: {},
  };
  const realRequire = Module.prototype.require;
  Module.prototype.require = function (id) {
    return id === 'electron' ? electron : realRequire.apply(this, arguments);
  };
  process.isMainFrame = false;
  const entry = repoPath('dist/electron/preload/preload.js');
  delete require.cache[entry];
  try {
    require(entry);
  } finally {
    Module.prototype.require = realRequire;
  }
  await new Promise((resolve) => setTimeout(resolve, 60));
  const post = async (data) => {
    const event = new window.MessageEvent('message', { data });
    Object.defineProperty(event, 'source', { value: window.parent });
    window.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 40));
  };
  await post({ type: 'avb:track', paths: ['0'], scope: '', focus: '', focusOcc: 0 });
  const fire = (type, reply, x, y) => {
    sent.length = 0;
    const target = window.document.elementFromPoint(x, y);
    target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    const message = sent.find((item) => item.type === reply);
    return message === undefined ? undefined : { path: message.path, occurrence: message.occurrence };
  };
  return {
    window,
    click: (x, y) => fire('click', 'avb:click-node', x, y),
    hover: (x, y) => {
      window.document.documentElement.dispatchEvent(new window.MouseEvent('mouseleave'));
      return fire('mousemove', 'avb:hover-node', x, y);
    },
    // The boxes the app is sent for a tracked path: what its outline is drawn from.
    outline: async (nodePath) => {
      sent.length = 0;
      await post({ type: 'avb:track', paths: [nodePath], scope: '', focus: '', focusOcc: 0 });
      const rects = sent.filter((item) => item.type === 'avb:rects').at(-1)?.rects ?? {};
      return (rects[nodePath] ?? []).map((rect) => [rect.x, rect.y, rect.w, rect.h]);
    },
  };
}

test('a loop whose markers were stripped is worked out from its items', async (route) => {
  const page = await openPage();
  try {
    await route.test('the gap between items selects the loop', () => {
      assert.deepEqual(page.click(140, 40), { path: '0.0.0', occurrence: 0 });
      assert.deepEqual(page.click(280, 40), { path: '0.0.0', occurrence: 0 });
    });
    await route.test('an item still selects that item', () => {
      assert.deepEqual(page.click(70, 40), { path: '0.0.0.0', occurrence: 0 });
      assert.deepEqual(page.click(210, 40), { path: '0.0.0.0', occurrence: 1 });
      assert.deepEqual(page.click(350, 40), { path: '0.0.0.0', occurrence: 2 });
    });
    await route.test('outside the items is the holder', () => {
      assert.equal(page.click(10, 40)?.path, '0.0', 'left of the first item');
      assert.equal(page.click(140, 80)?.path, '0.0', 'below the row');
      assert.equal(page.click(600, 40)?.path, '0.0', 'past the last item');
    });
    await route.test('hover lights what a click would select', () => {
      assert.equal(page.hover(140, 40)?.path, '0.0.0');
      assert.equal(page.hover(70, 40)?.path, '0.0.0.0');
    });
    await route.test("the loop's outline wraps every item", async () => {
      assert.deepEqual(await page.outline('0.0.0'), [[20, 20, 380, 40]]);
    });
    await route.test('a loop with one item is outlined around it', async () => {
      assert.deepEqual(await page.outline('0.1.0'), [[20, 220, 100, 40]]);
    });
    await route.test('a loop whose markers survived is read from them', async () => {
      assert.deepEqual(page.click(140, 440), { path: '0.2.0', occurrence: 0 });
      assert.deepEqual(await page.outline('0.2.0'), [[20, 420, 240, 40]]);
    });
  } finally {
    page.window.close();
  }
});
