// Goal: selecting a node in the Navigator glides the canvas to it (frameReveal.ts),
// with the arithmetic and the animation each pinned on their own.
// Methodology: the pure part (where a box lands, whether it needs to move, how long and
// how far a glide has gone) is checked with plain numbers, valid and invalid. The glide is
// run in jsdom with a stubbed animation-frame clock the test steps by hand and a stubbed
// scroll that records what it was asked, so the steps, the cancellation and the stall
// fallback are asserted without a real layout. The page there forces `scroll-behavior:
// auto`: every step must still be an instant scroll of its own, so the site's setting
// cannot turn the glide into a jump or a second animation.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');
const { landingTop, boxComfortable, glideDurationMs, glidePosition, SCROLL_MARGIN } = loadRenderer('electron/preload/frameRevealMath.ts');
const { startGlide } = loadRenderer('electron/preload/frameRevealGlide.ts');

const box = (y, height, width = 100) => ({ x: 0, y, w: width, h: height });

test('landing: a small box is centred, a tall one sits a margin below the top', () => {
  assert.equal(landingTop(box(900, 100), 600, 1000, 0), 1000 + 900 - 250);
  assert.equal(landingTop(box(-500, 100), 600, 1000, 0), 1000 - 500 - 250);
  assert.equal(landingTop(box(900, 1500), 600, 1000, 0), 1000 + 900 - SCROLL_MARGIN);
  assert.equal(landingTop(box(-9999, 100), 600, 100, 0), 0, 'never above the top of the page');
});

test('landing: a sticky header pushes the landing down', () => {
  assert.equal(landingTop(box(900, 100), 600, 0, 80), 900 - (80 + Math.floor((520 - 100) / 2)));
  assert.equal(landingTop(box(900, 1500), 600, 0, 80), 900 - (80 + SCROLL_MARGIN));
  assert.throws(() => landingTop(box(0, 10), 600, 0, -1), /negative height/);
  assert.throws(() => landingTop(box(0, 10), 600, 0, 700), /no taller than the view/);
  assert.throws(() => landingTop(box(0, 10), 600, Number.NaN, 0), /has a position/);
});

test('comfortable: whole in view stays, cut by an edge or under a bar moves', () => {
  assert.equal(boxComfortable(box(100, 100), 600, 0), true);
  assert.equal(boxComfortable(box(0, 100), 600, 0), true);
  assert.equal(boxComfortable(box(500, 100), 600, 0), true);
  assert.equal(boxComfortable(box(-40, 100), 600, 0), false, 'cut by the top');
  assert.equal(boxComfortable(box(550, 100), 600, 0), false, 'cut by the bottom');
  assert.equal(boxComfortable(box(-100, 100), 600, 0), false, 'only touching the top edge');
  assert.equal(boxComfortable(box(900, 100), 600, 0), false, 'below the frame');
  assert.equal(boxComfortable(box(20, 100), 600, 80), false, 'hiding behind a sticky header');
  assert.equal(boxComfortable(box(80, 100), 600, 80), true, 'just below the header');
});

test('comfortable: a box taller than the view is left alone while it fills half of it', () => {
  assert.equal(boxComfortable(box(-200, 1500), 600, 0), true);
  assert.equal(boxComfortable(box(-1000, 1500), 600, 0), true, 'bottom half showing');
  assert.equal(boxComfortable(box(-1250, 1500), 600, 0), false, 'a sliver at the top');
  assert.equal(boxComfortable(box(500, 1500), 600, 0), false, 'a sliver at the bottom');
  assert.equal(boxComfortable(box(0, 1500), 600, 100), true);
});

test('comfortable: a box with no area is judged whole; negative sizes are programmer errors', () => {
  assert.equal(boxComfortable(box(100, 0), 600, 0), true);
  assert.equal(boxComfortable(box(900, 0), 600, 0), false);
  assert.equal(boxComfortable(box(100, 100, 0), 600, 0), true);
  assert.throws(() => boxComfortable(box(0, -1), 600, 0), /negative height/);
  assert.throws(() => boxComfortable(box(0, 1, -1), 600, 0), /negative width/);
});

test('glide arithmetic: duration scales with distance and is capped; position eases out', () => {
  assert.equal(glideDurationMs(0), 300);
  assert.equal(glideDurationMs(-1200), 375);
  assert.equal(glideDurationMs(2400), 450);
  assert.equal(glideDurationMs(1_000_000), 450);
  assert.throws(() => glideDurationMs(Number.POSITIVE_INFINITY), /is a number/);
  assert.equal(glidePosition(0, 1000, 0, 300), 0);
  assert.equal(glidePosition(0, 1000, 300, 300), 1000);
  assert.equal(glidePosition(0, 1000, 999, 300), 1000);
  assert.equal(glidePosition(1000, 0, 300, 300), 0);
  const half = glidePosition(0, 1000, 150, 300);
  assert.ok(half > 500, 'ease-out is past halfway at half the time');
  let previous = -1;
  for (let elapsed = 0; elapsed <= 300; elapsed += 10) {
    const position = glidePosition(0, 1000, elapsed, 300);
    assert.ok(position >= previous, 'never moves backwards');
    previous = position;
  }
  assert.throws(() => glidePosition(0, 1, 0, 0), /takes time/);
});

// A frame with a scroll that records, a hand-stepped animation clock, and a page that
// forces `scroll-behavior: auto`.
function stage() {
  const dom = new JSDOM('<!doctype html><style>html { scroll-behavior: auto !important; }</style><body></body>');
  const { window } = dom;
  const queue = [];
  let nextHandle = 1;
  const saved = {};
  const install = {
    requestAnimationFrame: (callback) => {
      const handle = nextHandle++;
      queue.push({ handle, callback });
      return handle;
    },
    cancelAnimationFrame: (handle) => {
      const index = queue.findIndex((entry) => entry.handle === handle);
      if (index >= 0) {
        queue.splice(index, 1);
      }
    },
  };
  for (const [name, value] of Object.entries(install)) {
    saved[name] = Object.getOwnPropertyDescriptor(global, name);
    Object.defineProperty(global, name, { value, configurable: true, writable: true });
  }
  const scrolls = [];
  const move = (label) => ({ from: 0, to: 1000, scrollTo: (top) => scrolls.push({ label, top, behavior: 'instant' }), events: window });
  const tick = (nowMs) => {
    const frames = queue.splice(0);
    for (const entry of frames) {
      entry.callback(nowMs);
    }
    return frames.length;
  };
  const restore = () => {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor === undefined) {
        delete global[name];
      } else {
        Object.defineProperty(global, name, descriptor);
      }
    }
    window.close();
  };
  return { window, scrolls, move, tick, queue, restore };
}

test('glide: steps once per frame to the exact target, on a page forcing scroll-behavior auto', () => {
  const stub = stage();
  try {
    const ends = [];
    startGlide([stub.move('page')], (outcome) => ends.push(outcome));
    let nowMs = 1000;
    let guard = 0;
    while (ends.length === 0 && guard < 100) {
      stub.tick(nowMs);
      nowMs += 16;
      guard += 1;
    }
    assert.deepEqual(ends, ['arrived']);
    assert.ok(stub.scrolls.length >= 5, `several steps, not one jump (${stub.scrolls.length})`);
    assert.ok(stub.scrolls.length <= 40, 'bounded: about one step per frame of the glide');
    assert.ok(stub.scrolls.every((scroll) => scroll.behavior === 'instant'));
    assert.equal(stub.scrolls.at(-1).top, 1000);
    const tops = stub.scrolls.map((scroll) => scroll.top);
    assert.deepEqual(
      tops,
      [...tops].sort((first, second) => first - second),
      'monotonic',
    );
    assert.equal(stub.queue.length, 0, 'no frame left pending');
  } finally {
    stub.restore();
  }
});

test('glide: a wheel, touch, key or press ends it where the person put the page', () => {
  for (const type of ['wheel', 'touchstart', 'keydown', 'pointerdown']) {
    const stub = stage();
    try {
      const ends = [];
      startGlide([stub.move('page')], (outcome) => ends.push(outcome));
      stub.tick(0);
      stub.tick(16);
      const before = stub.scrolls.length;
      stub.window.dispatchEvent(new stub.window.Event(type));
      assert.deepEqual(ends, ['taken-over'], type);
      assert.equal(stub.queue.length, 0, `${type}: the pending frame is cancelled`);
      stub.tick(32);
      assert.equal(stub.scrolls.length, before, `${type}: nothing scrolls afterwards`);
    } finally {
      stub.restore();
    }
  }
});

test('glide: stopping it from outside is silent and final (a newer selection retargets)', () => {
  const stub = stage();
  try {
    const ends = [];
    const stop = startGlide([stub.move('first')], (outcome) => ends.push(outcome));
    stub.tick(0);
    stub.tick(16);
    stop();
    const before = stub.scrolls.length;
    stub.tick(32);
    assert.deepEqual(ends, []);
    assert.equal(stub.scrolls.length, before);
    const second = [];
    startGlide([{ ...stub.move('second'), from: 400, to: 0 }], (outcome) => second.push(outcome));
    for (let nowMs = 100; second.length === 0 && nowMs < 2000; nowMs += 16) {
      stub.tick(nowMs);
    }
    assert.deepEqual(second, ['arrived']);
    assert.equal(stub.scrolls.at(-1).label, 'second');
    assert.equal(stub.scrolls.at(-1).top, 0);
  } finally {
    stub.restore();
  }
});

test('glide: two scrollers move together and land together', () => {
  const stub = stage();
  try {
    const ends = [];
    startGlide([stub.move('panel'), { ...stub.move('page'), to: 600 }], (outcome) => ends.push(outcome));
    for (let nowMs = 0; ends.length === 0 && nowMs < 2000; nowMs += 16) {
      stub.tick(nowMs);
    }
    const lastPanel = stub.scrolls.filter((scroll) => scroll.label === 'panel').at(-1);
    const lastPage = stub.scrolls.filter((scroll) => scroll.label === 'page').at(-1);
    assert.equal(lastPanel.top, 1000);
    assert.equal(lastPage.top, 600);
  } finally {
    stub.restore();
  }
});

test('glide: a window that runs no animation frames still lands, after the stall bound', async () => {
  const stub = stage();
  try {
    const ends = [];
    startGlide([stub.move('page')], (outcome) => ends.push(outcome));
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual(ends, ['arrived']);
    assert.deepEqual(stub.scrolls, [{ label: 'page', top: 1000, behavior: 'instant' }]);
    assert.equal(stub.queue.length, 0);
  } finally {
    stub.restore();
  }
});

test('glide: nothing to move is a programmer error', () => {
  const stub = stage();
  try {
    assert.throws(() => startGlide([], () => {}), /something to move/);
  } finally {
    stub.restore();
  }
});
