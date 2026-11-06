// Goal: the space inside a loop's outline belongs to the loop. A loop has no
// element, so its outline is the union of its items, and the browser answers for
// the gap between two cards with the element holding them: clicking inside the
// purple outline selected the parent, and the up arrow had nothing to step from.
// Method: two halves. The decision is a pure function of a point and measured
// boxes (electron/preload/unionHit.ts), pinned with literal boxes. The wiring runs
// the built preload over a jsdom page marked as the serializer marks it, with the
// layout stated box by box and elementFromPoint answering from those boxes, then
// reads what hover, click, right-click and double-click report for each spot.
// Negative space: a card keeps its own click, the parent keeps everything outside
// the union, a loop with nothing rendered cannot be hit, a one-element child with
// `pointer-events: none` does not take clicks from its parent, and space a loop
// does not sit directly in is left alone.
const assert = require('node:assert/strict');
const Module = require('node:module');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');
const { repoPath } = require('../../helpers/sources.js');
const { unionAt, UNION_RUNS_MAX } = loadRenderer('electron/preload/unionHit.ts');

const box = (left, top, right, bottom) => ({ left, top, right, bottom });
const union = (path, occurrence, area) => ({ path, occurrence, box: area });

test('a point inside a union picks it, a point outside picks nothing', () => {
  const loop = union('0.0.0', 0, box(0, 0, 100, 100));
  assert.equal(unionAt(50, 50, [loop]), loop);
  assert.equal(unionAt(100, 100, [loop]), loop, 'the outline is drawn on the edge, so the edge counts');
  assert.equal(unionAt(101, 50, [loop]), undefined);
  assert.equal(unionAt(50, 50, []), undefined);
  assert.equal(unionAt(0, 0, [union('0.0.0', 0, box(0, 0, 0, 100))]), undefined, 'a box with no area holds no point');
});

test('the innermost union holding the point wins, in either order', () => {
  const outer = union('0.0', 0, box(0, 0, 100, 100));
  const inner = union('0.0.0', 1, box(10, 10, 40, 40));
  assert.equal(unionAt(20, 20, [outer, inner]), inner);
  assert.equal(unionAt(20, 20, [inner, outer]), inner);
  assert.equal(unionAt(60, 60, [outer, inner]), outer);
});

test('equal boxes go to the outermost node, so a then branch is never picked', () => {
  const condition = union('0.1', 0, box(0, 0, 100, 100));
  const then = union('0.1.0', 0, box(0, 0, 100, 100));
  assert.equal(unionAt(50, 50, [condition, then]), condition);
  assert.equal(unionAt(50, 50, [then, condition]), condition);
});

test('the point must be finite and the candidates capped', () => {
  assert.throws(() => unionAt(Number.NaN, 0, []), /Assertion failed: unionAt: x is a finite number/);
  assert.throws(() => unionAt(0, Number.POSITIVE_INFINITY, []), /Assertion failed: unionAt: y is a finite number/);
  const many = Array.from({ length: UNION_RUNS_MAX + 1 }, () => union('0', 0, box(0, 0, 1, 1)));
  assert.throws(() => unionAt(5, 5, many), /Assertion failed: unionAt: candidates are capped/);
  assert.equal(unionAt(5, 5, many.slice(0, UNION_RUNS_MAX)), undefined);
});

const marked = (nodePath, html) => `<!--avb-s:${nodePath}-->${html}<!--avb-e:${nodePath}-->`;
const tile = (nodePath, name) => marked(nodePath, `<div data-box="${name}"></div>`);

const PAGE = `<!doctype html><body>
  ${marked(
    '0',
    `<section data-box="section">
      ${marked(
        '0.0',
        `<div data-box="layout">
          ${marked('0.0.0', [tile('0.0.0.0', 'card1'), tile('0.0.0.0', 'card2'), tile('0.0.0.0', 'card3')].join('\n'))}
          ${tile('0.0.1', 'static')}
        </div>`,
      )}
      ${marked(
        '0.1',
        `<div data-box="nested">
          ${marked(
            '0.1.0',
            [
              marked('0.1.0.0', tile('0.1.0.0.0', 'tileA1') + tile('0.1.0.0.0', 'tileA2')),
              marked('0.1.0.0', tile('0.1.0.0.0', 'tileB1') + tile('0.1.0.0.0', 'tileB2')),
            ].join('\n'),
          )}
        </div>`,
      )}
      ${marked('0.2', `<div data-box="branching">${marked('0.2.0', marked('0.2.0.0', tile('0.2.0.0.0', 'then1') + tile('0.2.0.0.1', 'then2')))}</div>`)}
      ${marked('0.3', `<div data-box="empty">${marked('0.3.0', '')}</div>`)}
      ${marked('0.4', `<div data-box="overlaid">${tile('0.4.0', 'overlay')}</div>`)}
      ${marked('0.5', `<div data-box="wrapper"><div data-box="inner">${marked('0.5.0', tile('0.5.0.0', 'far1') + tile('0.5.0.0', 'far2'))}</div></div>`)}
    </section>`,
  )}
</body>`;

// [left, top, width, height]. The cards sit in a row with 20px gaps, in a layout
// with space around them; the static card is past the loop's last.
const BOXES = {
  section: [0, 0, 1000, 1600],
  layout: [0, 0, 1000, 200],
  card1: [20, 20, 100, 100],
  card2: [140, 20, 100, 100],
  card3: [260, 20, 100, 100],
  static: [500, 20, 100, 100],
  // Two groups of two tiles, the gap between groups wider than within one.
  nested: [0, 200, 1000, 200],
  tileA1: [20, 220, 50, 50],
  tileA2: [80, 220, 50, 50],
  tileB1: [220, 220, 50, 50],
  tileB2: [280, 220, 50, 50],
  branching: [0, 400, 1000, 200],
  then1: [20, 420, 50, 50],
  then2: [100, 420, 50, 50],
  empty: [0, 600, 1000, 200],
  overlaid: [0, 800, 1000, 200],
  overlay: [0, 800, 1000, 200],
  wrapper: [0, 1000, 1000, 200],
  inner: [0, 1000, 500, 100],
  far1: [20, 1020, 50, 50],
  far2: [100, 1020, 50, 50],
};

// With `pointer-events: none` the browser never answers with it.
const UNHITTABLE = new Set(['overlay']);

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
  // No hit testing in jsdom: the deepest element whose stated box holds the point.
  // Read from the table, so a count of the frame's own measuring stays honest.
  window.document.elementFromPoint = (x, y) => {
    let found;
    for (const element of window.document.querySelectorAll('[data-box]')) {
      const area = measured(element.getAttribute('data-box'));
      const holds = x >= area.left && x <= area.right && y >= area.top && y <= area.bottom;
      if (holds && !UNHITTABLE.has(element.getAttribute('data-box'))) {
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
  require(repoPath('dist/electron/preload/preload.js'));
  Module.prototype.require = realRequire;
  await new Promise((resolve) => setTimeout(resolve, 60));
  const post = (data) => {
    const event = new window.MessageEvent('message', { data });
    Object.defineProperty(event, 'source', { value: window.parent });
    window.dispatchEvent(event);
  };
  post({ type: 'avb:design', on: true });
  post({ type: 'avb:track', paths: ['0'], scope: '', focus: '', focusOcc: 0 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  // One event at a point, and the message the frame answered it with.
  const fire = (type, reply, x, y) => {
    sent.length = 0;
    const target = window.document.elementFromPoint(x, y);
    target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    return sent.find((message) => message.type === reply);
  };
  return {
    window,
    sent,
    click: (x, y) => fire('click', 'avb:click-node', x, y),
    context: (x, y) => fire('contextmenu', 'avb:context-node', x, y),
    open: (x, y) => fire('dblclick', 'avb:open-node', x, y),
    // Leaving first: hover only speaks when the answer changes, and keeps its boxes.
    hover: (x, y) => {
      window.document.documentElement.dispatchEvent(new window.MouseEvent('mouseleave'));
      return fire('mousemove', 'avb:hover-node', x, y);
    },
  };
}

test('the canvas resolves every pointer route by the same rule', async (route) => {
  const page = await openPage();
  const clicked = (x, y) => {
    const { path, occurrence, outside } = page.click(x, y);
    return { path, occurrence, outside };
  };

  await route.test('a click in the gap between cards selects the loop', () => {
    assert.deepEqual(clicked(130, 70), { path: '0.0.0', occurrence: 0, outside: false });
    assert.deepEqual(clicked(250, 70), { path: '0.0.0', occurrence: 0, outside: false });
  });

  await route.test('a click on a card selects that card', () => {
    assert.deepEqual(clicked(70, 70), { path: '0.0.0.0', occurrence: 0, outside: false });
    assert.deepEqual(clicked(190, 70), { path: '0.0.0.0', occurrence: 1, outside: false });
    assert.deepEqual(clicked(310, 70), { path: '0.0.0.0', occurrence: 2, outside: false });
  });

  await route.test('a click outside the union selects the parent', () => {
    assert.equal(clicked(10, 70).path, '0.0', 'left of the first card');
    assert.equal(clicked(70, 10).path, '0.0', 'above the row');
    assert.equal(clicked(70, 150).path, '0.0', 'below the row');
    assert.equal(clicked(430, 70).path, '0.0', 'between the last card and the static one');
    assert.equal(clicked(550, 70).path, '0.0.1', 'a static sibling is itself');
  });

  await route.test('nested loops: the innermost union holding the point wins', () => {
    assert.deepEqual(clicked(75, 245), { path: '0.1.0.0', occurrence: 0, outside: false }, 'inside the first group');
    assert.deepEqual(clicked(275, 245), { path: '0.1.0.0', occurrence: 1, outside: false }, 'inside the second group');
    assert.deepEqual(clicked(175, 245), { path: '0.1.0', occurrence: 0, outside: false }, 'between the groups is the outer loop');
    assert.equal(clicked(45, 245).path, '0.1.0.0.0', 'a tile is still a tile');
    assert.equal(clicked(500, 245).path, '0.1', 'past both is the parent');
  });

  await route.test('a condition takes the gap in its branch, and never the then branch', () => {
    assert.equal(clicked(85, 445).path, '0.2.0');
    assert.equal(clicked(45, 445).path, '0.2.0.0.0');
    assert.equal(clicked(500, 445).path, '0.2');
  });

  await route.test('what has no union to point at is left alone', () => {
    assert.equal(clicked(100, 700).path, '0.3', 'a loop with nothing rendered has no box');
    assert.equal(clicked(100, 900).path, '0.4', 'a lone element the browser skips is not a union');
    assert.equal(clicked(600, 1050).path, '0.5', 'outside the element the run sits in');
  });

  await route.test('hover lights what a click would select', () => {
    assert.equal(page.hover(130, 70).path, '0.0.0');
    assert.equal(page.hover(70, 70).path, '0.0.0.0');
    assert.equal(page.hover(190, 70).occurrence, 1);
    assert.equal(page.hover(10, 70).path, '0.0');
    assert.equal(page.hover(175, 245).path, '0.1.0');
    assert.equal(page.hover(275, 245).path, '0.1.0.0');
    assert.equal(page.hover(275, 245).occurrence, 1);
  });

  await route.test('a right-click and a double-click resolve the same way', () => {
    assert.equal(page.context(130, 70).path, '0.0.0');
    assert.equal(page.context(70, 70).path, '0.0.0.0');
    assert.equal(page.context(10, 70).path, '0.0');
    assert.equal(page.open(130, 70).path, '0.0.0');
    assert.equal(page.open(190, 70).occurrence, 1);
    assert.equal(page.open(10, 70).path, '0.0');
  });

  await route.test('hover measures the union once while the pointer stays over one element', () => {
    const card = page.window.document.querySelector('[data-box="card3"]');
    let reads = 0;
    const measure = card.getBoundingClientRect.bind(card);
    card.getBoundingClientRect = () => {
      reads += 1;
      return measure();
    };
    page.hover(130, 70);
    const first = reads;
    assert.ok(first > 0, 'the first move over the gap measures');
    for (let move = 0; move < 20; move += 1) {
      page.window.document
        .elementFromPoint(130, 70)
        .dispatchEvent(new page.window.MouseEvent('mousemove', { bubbles: true, clientX: 130 + (move % 2), clientY: 70 }));
    }
    assert.equal(reads, first, 'the moves after it reuse those boxes');
    page.click(130, 70);
    assert.ok(reads > first, 'a click measures afresh');
    delete card.getBoundingClientRect;
  });

  await route.test('the up arrow pressed on the canvas reaches the app', () => {
    page.sent.length = 0;
    const key = new page.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
    page.window.document.body.dispatchEvent(key);
    assert.deepEqual(
      page.sent.find((message) => message.type === 'avb:shortcut'),
      { type: 'avb:shortcut', name: 'arrow', key: 'ArrowUp' },
    );
    assert.equal(key.defaultPrevented, true, 'the page does not scroll instead');
  });
  page.window.close();
});
