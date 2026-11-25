// Goal: overlay pins and wheel forwarding hold their contracts.
// - Pin parsing: a pin takes a point anchor, a label of 1 to 3 characters
//   (counted as a person reads them), one of four tones (accent by default), an
//   https avatar of bounded length with no credentials, and `active`,
//   `interactive`, `draggable` and `cluster` flags; every other shape fails with
//   a message that says what was wrong.
// - Placement and crowding: a pin's tail sits on its anchor point at any zoom,
//   and pins cluster with each other and with the same app's labels, never
//   across apps, never on a viewport rectangle, never with `cluster: false`.
// - Wheel forwarding: a wheel over the overlay maps to the canvas point the
//   frame scrolls from, with its deltas unchanged by the zoom; the frame turns
//   lines and pages into pixels and Shift into a sideways scroll.
// Method: the pure modules bundled with esbuild, driven by hand-made items and
// measurements; no frames, no DOM. The pointer itself (wheel, clicks, capture)
// is tested in a real window by overlayPointer.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');

const rpc = load('shared/properties/appsRpc.ts');
const { placeOverlays, overlayWheelMessage } = load('src/features/apps/overlayPlacement.ts');
const { clusterOverlays } = load('src/features/apps/overlayClusters.ts');
const { wheelPixels } = load('electron/preload/frameAppScroll.ts');

const pinInput = (extra = {}) => ({ kind: 'pin', id: 'c1', anchor: { nodeId: 'hero', at: { x: 0.5, y: 0.5 } }, ...extra });

test('a pin parses with its defaults and every field', () => {
  assert.deepEqual(rpc.parseOverlayItem(pinInput()), {
    kind: 'pin',
    id: 'c1',
    anchor: { nodeId: 'hero', occurrence: undefined, at: { x: 0.5, y: 0.5 } },
    label: undefined,
    tone: 'accent',
    avatarURL: undefined,
    active: false,
    interactive: false,
    draggable: false,
    cluster: true,
  });
  const full = rpc.parseOverlayItem(
    pinInput({
      label: '12',
      tone: 'danger',
      avatarURL: 'https://images.example.com/a.png?s=48',
      active: true,
      interactive: true,
      draggable: true,
      cluster: false,
    }),
  );
  assert.equal(full.label, '12');
  assert.equal(full.tone, 'danger');
  assert.equal(full.avatarURL, 'https://images.example.com/a.png?s=48');
  assert.equal(full.active, true);
  assert.equal(full.draggable, true);
  assert.equal(full.cluster, false);
  // Three characters as read: two emoji are four UTF-16 units but two characters.
  assert.equal(rpc.parseOverlayItem(pinInput({ label: '😀😀' })).label, '😀😀');
  assert.equal(rpc.parseOverlayItem(pinInput({ label: 'ABC' })).label, 'ABC');
  for (const tone of ['accent', 'success', 'muted', 'danger']) {
    assert.equal(rpc.parseOverlayItem(pinInput({ tone })).tone, tone);
  }
  // An element anchor with no point: the tail goes on the element's corner.
  assert.equal(rpc.parseOverlayItem(pinInput({ anchor: { nodeId: 'hero' } })).kind, 'pin');
});

test('a pin with a bad field fails and says which', () => {
  const longURL = `https://example.com/${'a'.repeat(rpc.APP_RPC_LIMITS.pinAvatarURLCharsMax)}`;
  const cases = [
    [{ label: '' }, /1 to 3 characters/],
    [{ label: 'ABCD' }, /1 to 3 characters/],
    [{ label: ' 1' }, /leading or trailing/],
    [{ label: 7 }, /./],
    [{ tone: 'warning' }, /tone/],
    [{ avatarURL: 'http://example.com/a.png' }, /https/],
    [{ avatarURL: 'javascript:alert(1)' }, /https/],
    [{ avatarURL: 'data:image/png;base64,AAAA' }, /https/],
    [{ avatarURL: 'not a url' }, /https/],
    [{ avatarURL: 'https://user:secret@example.com/a.png' }, /credentials/],
    [{ avatarURL: longURL }, /2048/],
    [{ avatarURL: '' }, /1 to 2048/],
    [{ active: 'yes' }, /active/],
    [{ interactive: 1 }, /interactive/],
    [{ cluster: 'no' }, /cluster/],
  ];
  for (const [extra, message] of cases) {
    assert.throws(() => rpc.parseOverlayItem(pinInput(extra)), message, JSON.stringify(extra));
  }
  // The kinds that cannot take a point or a drag still cannot, and say pins can.
  assert.throws(() => rpc.parseOverlayItem({ kind: 'box', id: 'b', anchor: { nodeId: 'hero', at: { x: 0, y: 0 } } }), /label or a pin anchors to a point/);
  assert.throws(
    () => rpc.parseOverlayItem({ kind: 'heat', id: 'h', anchor: { nodeId: 'hero' }, columns: 1, rows: 1, values: [1], draggable: true }),
    /box, a label or a pin is draggable/,
  );
  assert.throws(() => rpc.parseOverlayItem({ kind: 'marker', id: 'm', anchor: { nodeId: 'hero' } }), /box, label, pin, heat or frame/);
  // A list of pins is bounded like any overlay.
  assert.equal(rpc.parseOverlayItems([pinInput(), pinInput({ id: 'c2' })]).length, 2);
  assert.throws(() => rpc.parseOverlayItems([pinInput(), pinInput()]), /unique/);
});

const pathFor = (nodeId) => ({ hero: '0.1', card: '0.2' })[nodeId];
const pin = (id, at, extra = {}) => rpc.parseOverlayItem({ kind: 'pin', id, anchor: { nodeId: 'hero', at }, interactive: true, ...extra });

test('a pin sits on its point at any zoom and clusters with its own app’s pins and labels', () => {
  const rects = { 0.1: [{ x: 100, y: 200, w: 400, h: 100 }] };
  for (const scale of [0.5, 1, 2]) {
    const [placed] = placeOverlays(new Map([['notes', [pin('a', { x: 0.5, y: 0.5 })]]]), rects, scale, { target: () => undefined }, pathFor);
    assert.deepEqual([placed.left, placed.top, placed.width, placed.height], [300 * scale, 250 * scale, 0, 0], `zoom ${scale}`);
  }
  const near = [
    pin('a', { x: 0.5, y: 0.5 }),
    pin('b', { x: 0.52, y: 0.5 }),
    rpc.parseOverlayItem({ kind: 'label', id: 'l', anchor: { nodeId: 'hero', at: { x: 0.51, y: 0.55 } }, text: 'x', placement: 'center' }),
    pin('far', { x: 0, y: 0 }),
    pin('apart', { x: 0.5, y: 0.5 }, { cluster: false }),
  ];
  const overlays = new Map([
    ['notes', near],
    ['other', [pin('o', { x: 0.5, y: 0.5 })]],
  ]);
  const { singles, clusters } = clusterOverlays(
    placeOverlays(overlays, rects, 1, { target: () => undefined }, pathFor),
    rpc.APP_RPC_LIMITS.clusterRadiusPx,
    undefined,
  );
  assert.equal(clusters.length, 1);
  assert.deepEqual(
    clusters[0].members.map((member) => member.item.id),
    ['a', 'b', 'l'],
  );
  assert.deepEqual(singles.map((placement) => placement.item.id).sort(), ['apart', 'far', 'o']);
  // A held pin never folds into a bubble, so the pointer keeps the element it pressed.
  const held = clusterOverlays(placeOverlays(overlays, rects, 1, { target: () => undefined }, pathFor), rpc.APP_RPC_LIMITS.clusterRadiusPx, {
    appId: 'notes',
    itemId: 'a',
    phase: 'dragging',
  });
  assert.deepEqual(
    held.clusters[0].members.map((member) => member.item.id),
    ['b', 'l'],
  );
  // A pin on a viewport rectangle is where the app put it: it never clusters.
  const fixed = rpc.parseOverlayItem({ kind: 'pin', id: 'r', anchor: { rect: { x: 300, y: 250, width: 0, height: 0 } } });
  const withFixed = clusterOverlays(
    placeOverlays(new Map([['notes', [pin('a', { x: 0.5, y: 0.5 }), fixed]]]), rects, 1, { target: () => undefined }, pathFor),
    24,
    undefined,
  );
  assert.equal(withFixed.clusters.length, 0);
});

test('a wheel over the overlay maps to the canvas point, with its deltas as they came', () => {
  const wheel = { clientX: 260, clientY: 140, deltaX: 3, deltaY: 120, deltaMode: 0, ctrlKey: false, shiftKey: false, altKey: false, metaKey: true };
  assert.deepEqual(overlayWheelMessage({ left: 60, top: 40 }, wheel, 0.5), {
    type: 'avb:app-wheel',
    x: 400,
    y: 200,
    deltaX: 3,
    deltaY: 120,
    deltaMode: 0,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: true,
  });
  assert.throws(() => overlayWheelMessage({ left: 0, top: 0 }, wheel, 0), /scale is positive/);
  assert.throws(() => overlayWheelMessage({ left: 0, top: 0 }, { ...wheel, deltaY: Number.NaN }, 1), /finite way down/);
});

test('the frame turns lines, pages and Shift into pixels as a browser does', () => {
  const viewport = { width: 1000, height: 800 };
  const wheel = (deltaX, deltaY, deltaMode, shiftKey = false) => wheelPixels({ deltaX, deltaY, deltaMode, shiftKey }, viewport);
  assert.deepEqual(wheel(0, 120, 0), { x: 0, y: 120 });
  assert.deepEqual(wheel(1, -3, 1), { x: 40, y: -120 });
  assert.deepEqual(wheel(0, 1, 2), { x: 0, y: 800 });
  assert.deepEqual(wheel(0.5, 0, 2), { x: 500, y: 0 });
  // Shift with a vertical-only wheel scrolls sideways; a wheel that already moves sideways is left alone.
  assert.deepEqual(wheel(0, 100, 0, true), { x: 100, y: 0 });
  assert.deepEqual(wheel(30, 100, 0, true), { x: 30, y: 100 });
});
