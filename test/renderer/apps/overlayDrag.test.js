// Goal: dragging an app's overlay item (`overlay.drag`, docs/apps.md "Dragging")
// holds its contracts.
// - Threshold: a press that moves less than dragThresholdPx (in overlay-layer
//   pixels, whatever the zoom) is a click, sending `overlay.click` only for an
//   interactive item; at the threshold it is a drag.
// - Sequencing: one `start`, then `move`s, then one `end`; `move` goes at most once
//   per animation frame with one canvas question in flight, the latest point
//   wins, and a drop while a question is in flight still lands after it.
// - Cancelling: Escape, the app stopping and the item leaving the overlay (or no
//   longer being draggable) end the drag with `cancelled: true` and the last
//   geometry; a drag the app never heard start ends silently; a drop stands.
// - Ownership: only the app that drew the item hears it, and one press or drag
//   runs at a time.
// - Clustering: the held item never folds into a count bubble.
// - Parser: `draggable` defaults to false, takes booleans only, and only on boxes
//   and labels; the pointer maps from client to canvas pixels by the zoom.
// - The canvas point query: replies are matched by id, bounded, and time out.
// Method: the pure controller driven by a fake frame clock and a fake canvas
// whose answers the test releases by hand, so every interleaving is explicit;
// the point query runs against a fake canvas window. No DOM.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');

const { createOverlayDrag } = load('src/features/apps/overlayDrag.ts');
const { overlayPointerPoint, placeOverlays } = load('src/features/apps/overlayPlacement.ts');
const { clusterOverlays } = load('src/features/apps/overlayClusters.ts');
const rpc = load('shared/properties/appsRpc.ts');

const THRESHOLD = rpc.APP_RPC_LIMITS.dragThresholdPx;
const point = (layerX, layerY, scale = 1) => ({ layerX, layerY, x: layerX / scale, y: layerY / scale });

// A world with apps, their draggable items, a frame clock and a canvas that answers when told.
function dragWorld() {
  const sent = [];
  const running = new Set(['pins', 'notes']);
  const items = new Map([
    ['pins', new Set(['p1'])],
    ['notes', new Set(['n1'])],
  ]);
  const frames = [];
  const questions = [];
  const drag = createOverlayDrag({
    emit: (appId, event, data) => {
      sent.push([appId, event, data]);
      return 1;
    },
    running: (appId) => running.has(appId),
    holds: (appId, itemId) => items.get(appId)?.has(itemId) === true,
    locate: (x, y) =>
      new Promise((resolve) => {
        questions.push({ x, y, answer: () => resolve({ nodeId: 'hero', at: { x: 0.5, y: 0.5 }, x, y, layers: [] }) });
      }),
    frame: (step) => {
      const entry = { step, cancelled: false };
      frames.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  });
  const tick = () => {
    for (const entry of frames.splice(0)) {
      if (!entry.cancelled) {
        entry.step();
      }
    }
  };
  // Answers the oldest question and lets its continuation run.
  const answer = async () => {
    const question = questions.shift();
    assert.ok(question, 'a question is waiting');
    question.answer();
    await new Promise((resolve) => setImmediate(resolve));
  };
  const phases = () => sent.filter(([, event]) => event === 'overlay.drag').map(([, , data]) => data.phase + (data.cancelled ? '!' : ''));
  const press = (extra = {}) => drag.press({ appId: 'pins', itemId: 'p1', nodeId: 'hero', interactive: true, point: point(100, 100), ...extra });
  return { drag, sent, running, items, frames, questions, tick, answer, phases, press };
}

test('a press under the threshold is a click; at the threshold it is a drag', async () => {
  const world = dragWorld();
  assert.equal(world.press(), true);
  world.drag.move(point(100 + THRESHOLD - 1, 100));
  world.drag.move(point(100, 100 + THRESHOLD - 1));
  world.drag.release(point(100 + THRESHOLD - 1, 100));
  assert.deepEqual(world.sent, [['pins', 'overlay.click', { itemId: 'p1', nodeId: 'hero' }]]);
  assert.equal(world.drag.held(), undefined);
  // A draggable item that is not interactive clicks silently.
  world.sent.length = 0;
  world.press({ interactive: false });
  world.drag.release(point(100, 100));
  assert.deepEqual(world.sent, []);
  // The threshold is in layer pixels: zoomed out to a quarter, a 4px hand move is 16 canvas pixels and still a drag.
  world.drag.press({ appId: 'pins', itemId: 'p1', nodeId: 'hero', interactive: true, point: point(100, 100, 0.25) });
  world.drag.move(point(100 + THRESHOLD, 100, 0.25));
  assert.equal(world.drag.held().phase, 'dragging');
  world.tick();
  await world.answer();
  assert.deepEqual(world.sent[0][2], { itemId: 'p1', phase: 'start', nodeId: 'hero', at: { x: 0.5, y: 0.5 }, x: 416, y: 400, layers: [], cancelled: false });
});

test('start, moves and end arrive in order, one move per frame, the latest point winning', async () => {
  const world = dragWorld();
  world.press();
  world.drag.move(point(110, 100));
  assert.equal(world.questions.length, 0, 'nothing is asked before the frame');
  world.tick();
  assert.equal(world.questions.length, 1);
  // Moves while a question is in flight schedule nothing; the latest is asked next.
  world.drag.move(point(120, 100));
  world.drag.move(point(130, 100));
  assert.equal(world.frames.length, 0, 'one question in flight at a time');
  await world.answer();
  assert.deepEqual(world.phases(), ['start']);
  assert.equal(world.frames.length, 1, 'the newer point waits for the next frame');
  world.drag.move(point(140, 100));
  world.drag.move(point(150, 100));
  assert.equal(world.frames.length, 1, 'many moves in one frame ask once');
  world.tick();
  assert.deepEqual([world.questions[0].x, world.questions.length], [150, 1], 'the latest point is the one asked');
  await world.answer();
  assert.deepEqual(world.phases(), ['start', 'move']);
  assert.equal(world.frames.length, 0, 'no frame when the pointer has not moved since');
  // A drop while a question is in flight: the move lands, then the end at the drop point.
  world.drag.move(point(160, 100));
  world.tick();
  world.drag.release(point(170, 100));
  await world.answer();
  assert.deepEqual(world.phases(), ['start', 'move', 'move']);
  assert.equal(world.questions[0].x, 170);
  await world.answer();
  assert.deepEqual(world.phases(), ['start', 'move', 'move', 'end']);
  assert.equal(world.sent.at(-1)[2].x, 170);
  assert.equal(world.drag.held(), undefined);
  assert.ok(
    world.sent.every(([appId]) => appId === 'pins'),
    'only the owner hears its drag',
  );
});

test('a drop before the start was answered still starts, then ends', async () => {
  const world = dragWorld();
  world.press();
  world.drag.move(point(120, 100));
  world.drag.release(point(125, 100));
  assert.equal(world.frames[0].cancelled, true, 'the waiting frame is dropped');
  await world.answer();
  assert.deepEqual(world.phases(), ['start', 'end']);
  assert.ok(
    world.sent.every(([, event]) => event !== 'overlay.click'),
    'a drag is never also a click',
  );
});

test('Escape, the app stopping and the item leaving cancel; a drop stands', async () => {
  for (const cut of ['escape', 'stop', 'replace', 'undraggable']) {
    const world = dragWorld();
    world.press();
    world.drag.move(point(120, 100));
    world.tick();
    await world.answer();
    if (cut === 'escape') {
      assert.equal(world.drag.cancel(), true);
    } else if (cut === 'stop') {
      world.running.delete('pins');
      world.drag.changed();
    } else {
      world.items.get('pins').delete('p1'); // Replaced by an overlay without it, or with it no longer draggable.
      world.drag.changed();
    }
    assert.deepEqual(world.phases(), ['start', 'end!'], cut);
    assert.deepEqual(world.sent.at(-1)[2], { itemId: 'p1', phase: 'end', nodeId: 'hero', at: { x: 0.5, y: 0.5 }, x: 120, y: 100, layers: [], cancelled: true });
    assert.equal(world.drag.held(), undefined);
    assert.equal(world.drag.cancel(), false, 'nothing left to cancel');
  }
  // An overlay redrawn with the item still draggable keeps the drag.
  const kept = dragWorld();
  kept.press();
  kept.drag.move(point(120, 100));
  kept.drag.changed();
  assert.equal(kept.drag.held().phase, 'dragging');
  // A drag the app never heard start ends silently; the late answer is dropped.
  const early = dragWorld();
  early.press();
  early.drag.move(point(120, 100));
  early.tick();
  early.drag.cancel();
  await early.answer();
  assert.deepEqual(early.sent, []);
  // Escape during a press: no click when it comes up.
  const pressed = dragWorld();
  pressed.press();
  assert.equal(pressed.drag.cancel(), true);
  pressed.drag.release(point(100, 100));
  assert.deepEqual(pressed.sent, []);
  // Escape after the drop: the drop stands.
  const dropped = dragWorld();
  dropped.press();
  dropped.drag.move(point(120, 100));
  dropped.drag.release(point(120, 100));
  assert.equal(dropped.drag.cancel(), false);
  await dropped.answer();
  assert.deepEqual(dropped.phases(), ['start', 'end']);
});

test('one press at a time, only for a running app’s draggable item, heard by its owner', async () => {
  const world = dragWorld();
  assert.equal(world.press({ itemId: 'missing' }), false, 'an item the overlay lacks');
  world.running.delete('notes');
  assert.equal(world.drag.press({ appId: 'notes', itemId: 'n1', nodeId: undefined, interactive: true, point: point(0, 0) }), false, 'a stopped app');
  world.running.add('notes');
  assert.equal(world.press(), true);
  assert.equal(world.drag.press({ appId: 'notes', itemId: 'n1', nodeId: undefined, interactive: true, point: point(0, 0) }), false, 'one at a time');
  world.drag.move(point(120, 100));
  world.tick();
  await world.answer();
  world.drag.release(point(120, 100));
  await world.answer();
  assert.deepEqual([...new Set(world.sent.map(([appId]) => appId))], ['pins']);
  // The held view is stable between changes, as a store must be.
  world.press();
  assert.equal(world.drag.held(), world.drag.held());
  assert.deepEqual(world.drag.held(), { appId: 'pins', itemId: 'p1', phase: 'pressed' });
});

test('the held label stays out of count bubbles', () => {
  const label = (id, x) => ({
    kind: 'label',
    id,
    anchor: { nodeId: 'hero', occurrence: undefined, at: { x, y: 0.5 } },
    text: id,
    placement: 'center',
    color: undefined,
    background: undefined,
    interactive: true,
    draggable: true,
    cluster: true,
  });
  const overlays = new Map([['pins', [label('a', 0.1), label('b', 0.101), label('c', 0.102)]]]);
  const placed = placeOverlays(overlays, { 0.1: [{ x: 0, y: 0, w: 1000, h: 100 }] }, 1, { target: () => undefined }, () => '0.1');
  const free = clusterOverlays(placed, rpc.APP_RPC_LIMITS.clusterRadiusPx, undefined);
  assert.deepEqual([free.singles.length, free.clusters.length], [0, 1]);
  const held = clusterOverlays(placed, rpc.APP_RPC_LIMITS.clusterRadiusPx, { appId: 'pins', itemId: 'b' });
  assert.deepEqual(
    held.singles.map((single) => single.item.id),
    ['b'],
  );
  assert.deepEqual(
    held.clusters[0].members.map((member) => member.item.id),
    ['a', 'c'],
  );
  // Another app's item of the same id is not held.
  assert.equal(clusterOverlays(placed, rpc.APP_RPC_LIMITS.clusterRadiusPx, { appId: 'notes', itemId: 'b' }).singles.length, 0);
});

test('the parser takes draggable on boxes and labels, as a boolean, off by default', () => {
  const [box, labelled] = rpc.parseOverlayItems([
    { kind: 'box', id: 'b', anchor: { nodeId: 'n0' }, draggable: true },
    { kind: 'label', id: 'l', text: 'Hi', anchor: { nodeId: 'n0', at: { x: 0, y: 1 } } },
  ]);
  assert.equal(box.draggable, true);
  assert.equal(labelled.draggable, false);
  for (const bad of ['yes', 1, {}]) {
    assert.throws(
      () => rpc.parseOverlayItems([{ kind: 'label', id: 'l', text: 'Hi', anchor: { nodeId: 'n0' }, draggable: bad }]),
      /draggable must be true or false/,
    );
  }
  assert.throws(
    () => rpc.parseOverlayItems([{ kind: 'heat', id: 'h', anchor: { nodeId: 'n0' }, columns: 1, rows: 1, values: [0.5], draggable: true }]),
    /Only a box, a label or a pin is draggable/,
  );
  assert.throws(
    () => rpc.parseOverlayItems([{ kind: 'frame', id: 'f', anchor: { nodeId: 'n0' }, path: 'x.html', draggable: false }]),
    /Only a box, a label or a pin/,
  );
  assert.ok(rpc.APP_EVENT_NAMES.includes('overlay.drag'));
  assert.deepEqual(rpc.APP_DRAG_PHASES, ['start', 'move', 'end']);
  assert.ok(Number.isSafeInteger(THRESHOLD) && THRESHOLD > 0);
});

test('a pointer maps from client pixels to the layer and the canvas by the zoom', () => {
  assert.deepEqual(overlayPointerPoint({ left: 40, top: 16 }, { x: 140, y: 66 }, 0.5), { layerX: 100, layerY: 50, x: 200, y: 100 });
  assert.throws(() => overlayPointerPoint({ left: 0, top: 0 }, { x: 1, y: 1 }, 0), /scale is positive/);
});

test('the canvas point query matches replies by id, checks them, and times out', async () => {
  const told = [];
  // The point query and canvasQuery must share one module instance, so one bundle exports both.
  const both = load('test/fixtures/apps/canvasPointEntry.ts');
  both.setCanvasFrame({ postMessage: (message) => told.push(message) });
  const asked = both.queryCanvasPoint(12, 34);
  assert.deepEqual(told[0], { type: 'avb:point-query', id: told[0].id, x: 12, y: 34 });
  both.receiveCanvasPoint({ id: told[0].id + 1, path: 'x' }); // Not ours: ignored.
  both.receiveCanvasPoint({ id: told[0].id, path: 'src/pages/index.astro|0.1', occurrence: 2, box: { x: 1, y: 2, w: 3, h: 4 } });
  assert.deepEqual(await asked, { path: 'src/pages/index.astro|0.1', occurrence: 2, x: 12, y: 34, box: { x: 1, y: 2, w: 3, h: 4 }, layers: [] });
  // A reply out of bounds names no element, and drops its box.
  const bad = both.queryCanvasPoint(1, 1);
  both.receiveCanvasPoint({ id: told[1].id, path: 'p'.repeat(5000), occurrence: -1, box: { x: 0, y: 0, w: 1, h: 1 } });
  assert.deepEqual(await bad, { path: undefined, occurrence: 0, x: 1, y: 1, box: undefined, layers: [] });
  // No answer: undefined after the timeout.
  const silent = await both.queryCanvasPoint(5, 5);
  assert.equal(silent, undefined);
  // No canvas: undefined at once.
  both.setCanvasFrame(undefined);
  assert.equal(await both.queryCanvasPoint(5, 5), undefined);
});

test('the frame answers a point query by its own hit test, and ignores what is not one', () => {
  const { receivePointQuery } = load('electron/preload/framePointQuery.ts');
  const posted = [];
  const locate = (x, y) => (x < 50 ? { path: '0.1', occurrence: 1, box: { x: 0, y: 0, w: 50, h: y } } : undefined);
  assert.equal(
    receivePointQuery({ type: 'avb:query', id: 1 }, locate, (message) => posted.push(message)),
    false,
  );
  assert.equal(
    receivePointQuery({ type: 'avb:point-query', id: 3, x: 10, y: 20 }, locate, (message) => posted.push(message)),
    true,
  );
  assert.equal(
    receivePointQuery({ type: 'avb:point-query', id: 4, x: 90, y: 20 }, locate, (message) => posted.push(message)),
    true,
  );
  // Out of range: an answer with no element, so the editor does not wait out its timeout.
  assert.equal(
    receivePointQuery({ type: 'avb:point-query', id: 5, x: 2e6, y: 0 }, locate, (message) => posted.push(message)),
    true,
  );
  // A malformed id: no answer, since no one asked it.
  assert.equal(
    receivePointQuery({ type: 'avb:point-query', id: 0, x: 1, y: 1 }, locate, (message) => posted.push(message)),
    true,
  );
  assert.deepEqual(posted, [
    { type: 'avb:point-result', id: 3, path: '0.1', occurrence: 1, box: { x: 0, y: 0, w: 50, h: 20 }, layers: [] },
    { type: 'avb:point-result', id: 4, path: undefined, occurrence: 0, box: undefined, layers: [] },
    { type: 'avb:point-result', id: 5, path: undefined, occurrence: 0, box: undefined, layers: [] },
  ]);
});
