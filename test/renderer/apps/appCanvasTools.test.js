// Goal: the app canvas tools from the feedback round hold their contracts.
// - Point anchors: a label at `at` sits at that fraction of its element's box,
//   scaled by the canvas zoom, and follows the box when a scroll re-measures it.
// - Crowding: an app's anchored labels within clusterRadiusPx collapse into one
//   bubble; labels further apart, of another app, opted out, or on a viewport
//   rectangle stay single.
// - Canvas capture: one owner at a time, the latest wins and the displaced app
//   hears it with `reason: 'replaced'`, Escape cancels (`'escape'`), an app's own
//   start and end reach it (`'app'`), a stopped app releases it, and a click's payload
//   carries the element and the point within it, clamped to the box.
// - Durable keys: `node.key` writes one key, keeps it when asked again, follows
//   the element when an edit moves it (new id, same key), and tells identical
//   twins apart; a duplicated key resolves to the first copy and the later copy
//   gets a fresh one.
// - Reading other pages: `page.getTree` serves the open page live and others
//   from disk; `page.findByAttribute` caches by stamp, re-reads only what
//   changed, stops at its limit and its byte budget, and says when it did.
// - The RPC table parses the new params, and the dispatcher gates page reading
//   by `panel:pages`.
// Method: the pure modules bundled with esbuild, driven by fake hosts and hand-made
// measurements; no frames, no DOM.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');

const { placeOverlays, anchorPoint } = load('src/features/apps/overlayPlacement.ts');
const { clusterOverlays } = load('src/features/apps/overlayClusters.ts');
const { createCanvasCapture, canvasClickPayload } = load('src/features/apps/canvasCapture.ts');
const { nodeKey, findNodeByKey, keyHolders } = load('src/features/apps/nodeKeys.ts');
const { createAppPageIndex, attributeMatches } = load('src/features/apps/appPageIndex.ts');
const { createOverlayMeasure } = load('src/features/apps/overlayMeasure.ts');
const rpc = load('shared/properties/appsRpc.ts');
const payloads = load('shared/ipc/ipcPayloads.ts');

const label = (id, anchor, extra = {}) => ({
  kind: 'label',
  id,
  anchor,
  text: id,
  placement: 'center',
  color: undefined,
  background: undefined,
  interactive: true,
  cluster: true,
  ...extra,
});
const pathFor = (nodeId) => ({ hero: '0.1', card: '0.2', far: '0.3' })[nodeId];

test('a point anchor sits at its fraction of the box, at any zoom and after a scroll', () => {
  const overlays = new Map([['pins', [label('p', { nodeId: 'hero', occurrence: undefined, at: { x: 0.25, y: 0.5 } })]]]);
  const rects = { 0.1: [{ x: 100, y: 200, w: 400, h: 100 }] };
  for (const scale of [0.5, 1, 2]) {
    const [placed] = placeOverlays(overlays, rects, scale, { target: () => undefined }, pathFor);
    assert.deepEqual([placed.left, placed.top, placed.width, placed.height], [200 * scale, 250 * scale, 0, 0], `zoom ${scale}`);
  }
  // Scrolled 180px down: the same measurement pass moves the point with the box.
  const [scrolled] = placeOverlays(overlays, { 0.1: [{ x: 100, y: 20, w: 400, h: 100 }] }, 0.5, { target: () => undefined }, pathFor);
  assert.deepEqual([scrolled.left, scrolled.top], [100, 35]);
  // Corners, and a box with no size.
  assert.deepEqual(anchorPoint({ x: 10, y: 10, w: 50, h: 20 }, { x: 1, y: 1 }), { x: 60, y: 30 });
  assert.deepEqual(anchorPoint({ x: 10, y: 10, w: 0, h: 0 }, { x: 0.5, y: 0.5 }), { x: 10, y: 10 });
});

test('the overlay parser takes points on labels only, bounds them, and clusters by default', () => {
  const [item] = rpc.parseOverlayItems([{ kind: 'label', id: 'a', text: 'Hi', anchor: { nodeId: 'n0', at: { x: 0.3, y: 1 } } }]);
  assert.deepEqual(item.anchor.at, { x: 0.3, y: 1 });
  assert.equal(item.cluster, true);
  assert.equal(rpc.parseOverlayItems([{ kind: 'label', id: 'a', text: 'Hi', anchor: { nodeId: 'n0' }, cluster: false }])[0].cluster, false);
  assert.throws(() => rpc.parseOverlayItems([{ kind: 'box', id: 'b', anchor: { nodeId: 'n0', at: { x: 0.5, y: 0.5 } } }]), /Only a label/);
  assert.throws(() => rpc.parseOverlayItems([{ kind: 'label', id: 'a', text: 'Hi', anchor: { nodeId: 'n0', at: { x: 1.2, y: 0 } } }]), /0 to 1/);
  assert.throws(() => rpc.parseOverlayItems([{ kind: 'label', id: 'a', text: 'Hi', anchor: { nodeId: 'n0', at: { x: 'left', y: 0 } } }]), /number/);
  const many = Array.from({ length: 64 }, (_, index) => ({ kind: 'label', id: `p${index}`, text: 'x', anchor: { nodeId: `n${index}` } }));
  assert.equal(rpc.parseOverlayItems(many).length, 64, 'an overlay anchors to as many elements as it has items');
});

test('crowded labels of one app collapse into a bubble at the radius, and only those', () => {
  const radius = rpc.APP_RPC_LIMITS.clusterRadiusPx;
  const at = (x, y) => ({ nodeId: 'hero', occurrence: undefined, at: { x, y } });
  const rects = { 0.1: [{ x: 0, y: 0, w: 1000, h: 1000 }] };
  const inside = radius / 1000; // `radius` pixels apart: still one bubble.
  const outside = (radius + 1) / 1000;
  const overlays = new Map([
    [
      'pins',
      [
        label('a', at(0.1, 0.1)),
        label('b', at(0.1 + inside, 0.1)),
        label('c', at(0.5, 0.5)),
        label('d', at(0.5 + outside, 0.5)),
        label('e', at(0.1, 0.1), { cluster: false }),
        label('f', { rect: { x: 100, y: 100, width: 0, height: 0 } }),
      ],
    ],
    ['other', [label('g', at(0.1, 0.1))]],
  ]);
  const { singles, clusters } = clusterOverlays(placeOverlays(overlays, rects, 1, { target: () => undefined }, pathFor), radius, undefined);
  assert.deepEqual(
    clusters.map((cluster) => [cluster.appId, cluster.members.map((member) => member.item.id)]),
    [['pins', ['a', 'b']]],
  );
  assert.deepEqual(singles.map((placement) => placement.item.id).sort(), ['c', 'd', 'e', 'f', 'g']);
  assert.deepEqual([clusters[0].left, clusters[0].top], [100, 100], 'the bubble sits on its first label');
  // Zoomed out, the same pins are closer on screen: c and d now share a bubble.
  const zoomed = clusterOverlays(placeOverlays(overlays, rects, 0.5, { target: () => undefined }, pathFor), radius, undefined);
  assert.deepEqual(zoomed.clusters.map((cluster) => cluster.members.map((member) => member.item.id)).sort(), [
    ['a', 'b'],
    ['c', 'd'],
  ]);
});

function captureWorld() {
  const sent = [];
  const running = new Set(['pins', 'notes']);
  const capture = createCanvasCapture({
    emit: (appId, event, data) => {
      sent.push([appId, event, data]);
      return 1;
    },
    running: (appId) => running.has(appId),
  });
  return { capture, sent, running };
}

test('one app captures at a time: the latest wins, Escape cancels, stopping releases', () => {
  const { capture, sent, running } = captureWorld();
  assert.deepEqual(capture.set({ id: 'pins', name: 'Pins' }, true, { cursor: 'crosshair', mode: 'capture', reason: undefined }), { applied: true });
  assert.equal(capture.owner().appId, 'pins');
  assert.deepEqual(sent, [['pins', 'canvas.capture', { on: true, reason: 'app' }]], 'the app hears its own start');
  capture.set({ id: 'notes', name: 'Notes' }, true, { cursor: 'default', mode: 'capture', reason: undefined });
  assert.equal(capture.owner().appId, 'notes', 'the most recent capture wins');
  assert.deepEqual(
    sent.slice(1),
    [
      ['pins', 'canvas.capture', { on: false, reason: 'replaced' }],
      ['notes', 'canvas.capture', { on: true, reason: 'app' }],
    ],
    'the displaced app hears why',
  );
  // Ending another app's capture changes nothing, and tells no one.
  const heard = sent.length;
  capture.set({ id: 'pins', name: 'Pins' }, false, { cursor: 'crosshair', mode: 'capture', reason: undefined });
  assert.equal(capture.owner().appId, 'notes');
  assert.equal(sent.length, heard);
  assert.equal(capture.cancel(), true, 'Escape ends the capture');
  assert.equal(capture.owner(), undefined);
  assert.deepEqual(sent.at(-1), ['notes', 'canvas.capture', { on: false, reason: 'escape' }]);
  assert.equal(capture.cancel(), false, 'Escape with nothing captured is the editor’s');
  // A stopped app releases the canvas.
  capture.set({ id: 'pins', name: 'Pins' }, true, { cursor: 'crosshair', mode: 'capture', reason: undefined });
  running.delete('pins');
  capture.changed();
  assert.equal(capture.owner(), undefined);
  assert.equal(
    capture.set({ id: 'pins', name: 'Pins' }, true, { cursor: 'crosshair', mode: 'capture', reason: undefined }).applied,
    false,
    'only a running app captures',
  );
});

test('an app that ends its own capture hears it, told apart from Escape', () => {
  const { capture, sent } = captureWorld();
  capture.set({ id: 'pins', name: 'Pins' }, true, { cursor: 'crosshair', mode: 'capture', reason: undefined });
  assert.deepEqual(capture.set({ id: 'pins', name: 'Pins' }, false, { cursor: 'crosshair', mode: 'capture', reason: undefined }), { applied: true });
  assert.equal(capture.owner(), undefined);
  assert.deepEqual(sent.at(-1), ['pins', 'canvas.capture', { on: false, reason: 'app' }]);
  // Ending a capture it does not hold says nothing.
  const heard = sent.length;
  capture.set({ id: 'pins', name: 'Pins' }, false, { cursor: 'crosshair', mode: 'capture', reason: undefined });
  assert.equal(sent.length, heard);
});

test('a captured click goes to the owner with the element and the point within it', () => {
  const { capture, sent } = captureWorld();
  const click = canvasClickPayload({ nodeId: 'n0.2', x: 150, y: 260, box: { x: 100, y: 200, w: 200, h: 120 }, layers: [] });
  assert.deepEqual(click, { nodeId: 'n0.2', at: { x: 0.25, y: 0.5 }, x: 150, y: 260, layers: [] });
  assert.equal(capture.click(click), false, 'nothing captures: the canvas selects');
  capture.set({ id: 'pins', name: 'Pins' }, true, { cursor: 'crosshair', mode: 'capture', reason: undefined });
  assert.equal(capture.click(click), true);
  assert.deepEqual(sent.at(-1), ['pins', 'canvas.click', click]);
  // On the border, a pixel outside, no box, no element, no area.
  assert.deepEqual(canvasClickPayload({ nodeId: 'n1', x: 99, y: 330, box: { x: 100, y: 200, w: 200, h: 120 }, layers: [] }).at, { x: 0, y: 1 });
  assert.equal(canvasClickPayload({ nodeId: 'n1', x: 5, y: 5, box: undefined, layers: [] }).at, undefined);
  assert.equal(canvasClickPayload({ nodeId: undefined, x: 5, y: 5, box: { x: 0, y: 0, w: 10, h: 10 }, layers: [] }).at, undefined);
  assert.equal(canvasClickPayload({ nodeId: 'n1', x: 5, y: 5, box: { x: 0, y: 0, w: 0, h: 10 }, layers: [] }).at, undefined);
  assert.deepEqual(rpc.APP_METHODS['canvas.capture'].params({ on: true }), { on: true, cursor: 'crosshair', mode: 'capture', reason: undefined });
  assert.throws(() => rpc.APP_METHODS['canvas.capture'].params({ on: true, cursor: 'pointer' }), /cursor/);
});

// A page as the host's tree, and its one edit: setAttribute writes into the tree.
function keyedPage(nodes) {
  const page = { nodes };
  // Iterative, bounded by the hand-made trees here.
  const find = (list, id) => {
    const stack = [...list];
    for (let visited = 0; stack.length > 0 && visited < 1000; visited += 1) {
      const node = stack.pop();
      if (node.id === id) {
        return node;
      }
      stack.push(...node.children);
    }
    return undefined;
  };
  const writes = [];
  return {
    page,
    writes,
    host: {
      node: (id) => find(page.nodes, id),
      tree: () => page.nodes,
      setAttribute: async (id, name, value) => {
        writes.push([id, name, value]);
        const node = find(page.nodes, id);
        node.attributes = { ...node.attributes, [name]: value };
        return { applied: true };
      },
    },
  };
}
const element = (id, attributes = {}, children = []) => ({ id, kind: 'element', name: 'div', classes: [], attributes, text: undefined, children });

test('a key is written once, kept, and finds its element after an edit moves it', async () => {
  const world = keyedPage([element('s1.0', {}, [element('s1.0.0'), element('s1.0.1')])]);
  const first = await nodeKey(world.host, 's1.0.1');
  assert.equal(first.applied, true);
  assert.match(first.key, /^k[0-9a-z]{12}$/);
  assert.equal(world.writes.length, 1, 'one attribute edit: one undo step');
  assert.deepEqual(await nodeKey(world.host, 's1.0.1'), first, 'asked again, the key is kept and nothing is written');
  assert.equal(world.writes.length, 1);
  // An edit moves the element out of its parent; the page reparses and the element has a new id. The key travels with it.
  const moved = { ...world.host.node('s1.0.1'), id: 's2.1' };
  world.page.nodes = [element('s2.0', {}, [element('s2.0.0')]), moved];
  assert.equal(findNodeByKey(world.page.nodes, first.key), 's2.1');
  assert.equal(findNodeByKey(world.page.nodes, 'kmissing0000'), undefined);
  assert.throws(() => rpc.APP_METHODS['node.find'].params({ key: 'not a key' }), /key/);
});

test('identical twins get distinct keys; a duplicated key resolves to the first copy and the copy is re-keyed', async () => {
  const world = keyedPage([element('a', { class: 'card' }), element('b', { class: 'card' })]);
  const left = await nodeKey(world.host, 'a');
  const right = await nodeKey(world.host, 'b');
  assert.notEqual(left.key, right.key);
  assert.equal(findNodeByKey(world.page.nodes, left.key), 'a');
  assert.equal(findNodeByKey(world.page.nodes, right.key), 'b');
  // ⌘D on `a` copies its attribute: two elements carry one key.
  world.page.nodes = [element('a', { 'data-stacki-key': left.key }), element('a2', { 'data-stacki-key': left.key }), world.page.nodes[1]];
  assert.deepEqual(keyHolders(world.page.nodes, left.key), ['a', 'a2']);
  assert.equal(findNodeByKey(world.page.nodes, left.key), 'a', 'the first in document order');
  const copy = await nodeKey(world.host, 'a2');
  assert.notEqual(copy.key, left.key, 'the later copy is given its own key');
  assert.deepEqual(keyHolders(world.page.nodes, left.key), ['a']);
  // Text holds no attributes.
  world.page.nodes.push({ id: 't', kind: 'text', name: '', classes: [], attributes: {}, text: 'hi', children: [] });
  assert.equal((await nodeKey(world.host, 't')).applied, false);
  assert.equal((await nodeKey(world.host, 'nope')).applied, false);
});

function diskWorld(fileCount, sizeBytes = 100) {
  const files = Array.from({ length: fileCount }, (_, index) => `src/pages/p${index}.astro`);
  const stamps = new Map(files.map((file) => [file, { mtimeMs: 1, sizeBytes }]));
  const reads = [];
  const trees = new Map(
    files.map((file, index) => [file, [element(`n${index}`, { 'data-note': `note ${index}` }, [element(`n${index}.0`, { 'data-note': 'inner' })])]]),
  );
  const index = createAppPageIndex({
    list: () => files,
    stamps: async (paths) => paths.map((path) => stamps.get(path)),
    readTree: async (path) => {
      reads.push(path);
      return { editable: true, nodes: trees.get(path), truncated: false };
    },
  });
  return { files, stamps, reads, trees, index };
}

test('getTree serves the open page live and others from disk, cached by stamp', async () => {
  const world = diskWorld(3);
  const open = { path: 'src/pages/p0.astro', editable: true, nodes: [element('live')], truncated: false };
  assert.equal(await world.index.getTree('src/pages/p0.astro', open), open, 'the open page is its live tree');
  const other = await world.index.getTree('src/pages/p1.astro', open);
  assert.equal(other.nodes[0].id, 'n1');
  await world.index.getTree('src/pages/p1.astro', open);
  assert.deepEqual(world.reads, ['src/pages/p1.astro'], 'an unchanged file is read once');
  world.stamps.set('src/pages/p1.astro', { mtimeMs: 2, sizeBytes: 100 });
  await world.index.getTree('src/pages/p1.astro', open);
  assert.equal(world.reads.length, 2, 'a changed mtime reads it again');
  assert.equal(await world.index.getTree('src/pages/elsewhere.astro', open), undefined, 'only the project’s pages and components');
  world.stamps.delete('src/pages/p2.astro');
  assert.equal(await world.index.getTree('src/pages/p2.astro', open), undefined, 'a file that is gone');
  assert.throws(() => rpc.APP_METHODS['page.getTree'].params({ path: '../secrets.astro' }), /segments/);
  assert.throws(() => rpc.APP_METHODS['page.getTree'].params({ path: 'src/pages/a.ts' }), /astro/);
});

test('findByAttribute finds across files, stops at its limit and byte budget, and re-reads only what changed', async () => {
  const world = diskWorld(5);
  const all = await world.index.findByAttribute('data-note', 500, undefined);
  assert.equal(all.matches.length, 10);
  assert.equal(all.truncated, false);
  assert.deepEqual(all.matches[0], { path: 'src/pages/p0.astro', nodeId: 'n0', value: 'note 0' });
  assert.equal(world.reads.length, 5);
  await world.index.findByAttribute('data-note', 500, undefined);
  assert.equal(world.reads.length, 5, 'the second scan reads nothing that did not change');
  world.stamps.set('src/pages/p3.astro', { mtimeMs: 9, sizeBytes: 100 });
  await world.index.findByAttribute('data-note', 500, undefined);
  assert.deepEqual(world.reads.slice(5), ['src/pages/p3.astro']);
  const limited = await world.index.findByAttribute('data-note', 3, undefined);
  assert.equal(limited.matches.length, 3);
  assert.equal(limited.truncated, true);
  assert.equal(attributeMatches('x', world.trees.get('src/pages/p0.astro'), 'data-none', 5).matches.length, 0);
  // Files larger than one call's byte budget are left for later, and the answer says so.
  const budget = rpc.APP_RPC_LIMITS.indexBytesReadMax;
  const heavy = diskWorld(3, Math.floor(budget / 2) + 1);
  const first = await heavy.index.findByAttribute('data-note', 500, undefined);
  assert.equal(heavy.reads.length, 1);
  assert.equal(first.truncated, true);
  const second = await heavy.index.findByAttribute('data-note', 500, undefined);
  assert.equal(heavy.reads.length, 2, 'the next call carries on where the cache leaves off');
  assert.equal(second.truncated, true);
  await heavy.index.findByAttribute('data-note', 500, undefined);
  const done = await heavy.index.findByAttribute('data-note', 500, undefined);
  assert.equal(done.truncated, false);
  assert.equal(done.matches.length, 6);
  // The bounds the parser and the IPC hold.
  assert.equal(rpc.APP_METHODS['page.findByAttribute'].params({ name: 'data-note' }).limit, rpc.APP_RPC_LIMITS.attributeMatchesMax);
  assert.throws(() => rpc.APP_METHODS['page.findByAttribute'].params({ name: 'data-note', limit: 501 }), /limit/);
  assert.equal(payloads.APP_FILE_STAMPS_MAX, rpc.APP_RPC_LIMITS.indexFilesMax, 'one stamp batch covers every file an app may read');
  const rels = (count) => Array.from({ length: count }, (_, index) => `src/pages/p${index}.astro`);
  assert.equal(payloads.parseIpcPayload('apps:fileStamps', { projectPath: '/site', rels: rels(2000) }).rels.length, 2000);
  assert.throws(() => payloads.parseIpcPayload('apps:fileStamps', { projectPath: '/site', rels: rels(2001) }), /at most 2000/);
});

test('node.measure answers known boxes at once and waits, bounded, for one the canvas was not measuring', async () => {
  const store = createOverlayMeasure({ timeoutMs: 50 });
  assert.deepEqual(await store.measure('hero', undefined), [], 'nothing measured yet');
  store.note({ rects: { 0.1: [{ x: 1, y: 2, w: 3, h: 4 }] }, pathFor });
  assert.deepEqual(await store.measure('hero', undefined), [{ x: 1, y: 2, width: 3, height: 4 }]);
  const waiting = store.measure('card', 0);
  assert.deepEqual(store.requested(), ['card'], 'the canvas is asked to measure it');
  store.note({ rects: { 0.2: [{ x: 5, y: 6, w: 7, h: 8 }] }, pathFor });
  assert.deepEqual(await waiting, [{ x: 5, y: 6, width: 7, height: 8 }]);
  assert.deepEqual(store.requested(), []);
  assert.deepEqual(await store.measure('far', undefined), [], 'not rendered: empty after the timeout');
  assert.deepEqual(await store.measure('unknown', undefined), [], 'not on the canvas at all');
});

test('the dispatcher gates reading other pages by panel:pages and wires the new methods', async () => {
  const host = load('src/features/apps/appRpcHost.ts');
  const roles = load('shared/properties/projectRoles.ts');
  const world = diskWorld(2);
  const fakeHost = {
    page: () => undefined,
    node: () => undefined,
    pageFiles: {
      list: () => world.files,
      stamps: async (paths) => paths.map(() => ({ mtimeMs: 1, sizeBytes: 1 })),
      readTree: async (path) => ({ editable: true, nodes: world.trees.get(path), truncated: false }),
    },
  };
  const session = {
    app: { manifest: { id: 'pins', name: 'Pins', version: '1.0.0', shortcutClaims: [] } },
    subscriptions: new Set(),
    ...host.inFlightCounter(),
  };
  const { capture } = captureWorld();
  const context = (role) => ({ host: fakeHost, role: () => role, setOverlay: () => undefined, capture });
  const request = (id, method, params) => ({ stacki: 'app', v: 1, id, method, params });
  const noPages = { id: 'c', name: 'Client', isAdmin: false, features: new Set(['panel:apps', 'app:pins']) };
  const denied = await host.answerAppMessage(session, request(1, 'page.findByAttribute', { name: 'data-note' }), context(noPages));
  assert.equal(denied.error.code, 'role-denied');
  const found = await host.answerAppMessage(session, request(2, 'page.findByAttribute', { name: 'data-note', limit: 2 }), context(roles.ADMIN_VIEW));
  assert.equal(found.value.matches.length, 2);
  const tree = await host.answerAppMessage(session, request(3, 'page.getTree', { path: 'src/pages/p1.astro' }), context(roles.ADMIN_VIEW));
  assert.equal(tree.value.nodes[0].id, 'n1');
  const captured = await host.answerAppMessage(session, request(4, 'canvas.capture', { on: true }), context(noPages));
  assert.equal(captured.ok, true, 'capturing needs no panel');
  assert.equal(capture.owner().appId, 'pins');
  const missing = await host.answerAppMessage(session, request(5, 'node.find', { key: 'kabcdef123456' }), context(roles.ADMIN_VIEW));
  assert.deepEqual(missing.value, { nodeId: undefined });
});
