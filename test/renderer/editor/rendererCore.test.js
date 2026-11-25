// Goal: the renderer's pure core — tree index, loop bindings, and page and file
// persistence — behaves as its callers rely on.
// Method: bundle the real modules with esbuild and drive them directly; saves
// resolve on test-held gates so every interleaving is chosen, not timed.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const buildDirectory = repoPath('node_modules/.stacki-test/renderer-core');
fs.mkdirSync(buildDirectory, { recursive: true });
esbuild.buildSync({
  // Named entries: each output is <name>.js wherever its source lives.
  entryPoints: {
    editorTree: repoPath('src/editor/editorTree.ts'),
    loopBindings: repoPath('src/editor/loopBindings.ts'),
    pagePersistence: repoPath('src/editor/pagePersistence.ts'),
    pageEdits: repoPath('src/editor/pageEdits.ts'),
  },
  outdir: buildDirectory,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  logLevel: 'silent',
});
const tree = require(path.join(buildDirectory, 'editorTree.js'));
const loops = require(path.join(buildDirectory, 'loopBindings.js'));
const { createPageSaver, scanContainsFile } = require(path.join(buildDirectory, 'pagePersistence.js'));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise(setImmediate);

test('tree index preserves locations, ancestry and anchors after moves', () => {
  const leaf = {
    id: 'leaf',
    props: { id: { type: 'string', value: 'anchor' } },
    children: undefined,
  };
  const nodes = [
    { id: 'first', children: [leaf] },
    { id: 'second', children: [] },
  ];
  const index = tree.createTreeIndex(nodes);
  assert.equal(index.node('leaf'), leaf);
  assert.equal(index.parent('leaf'), nodes[0]);
  assert.equal(index.path('leaf'), '0.0');
  assert.deepEqual(index.ancestors('leaf'), [nodes[0], leaf]);
  assert.deepEqual(index.sectionIds, ['anchor']);
  assert.equal(index.byPath.get('0.0'), leaf);
  assert.equal(index.path('missing'), undefined);
  assert.equal(index.parent('first'), undefined);
  assert.equal(tree.isDescendantOf(leaf, 'leaf'), true);
  nodes[1].children.push(nodes[0].children.pop());
  assert.equal(tree.findParentNode(nodes, 'leaf'), nodes[1]);
  assert.deepEqual(tree.pathOfNode(nodes, 'leaf'), [1, 0]);
  assert.deepEqual(tree.ancestorChain(nodes, 'leaf'), [nodes[1], leaf]);
  assert.equal(tree.nodeAtPath(nodes, [1, 0]), leaf);
  assert.equal(tree.createTreeIndex(nodes).path('leaf'), '1.0');
  assert.deepEqual(tree.findParentList({ nodes }, 'leaf'), { list: nodes[1].children, index: 0 });
});

test('deep tree lookup does not exhaust the JavaScript call stack', () => {
  let node = { id: 'leaf' };
  for (let i = 0; i < 15000; i++) {
    node = { id: `parent${i}`, children: [node] };
  }
  assert.equal(tree.findNodeById([node], 'leaf').id, 'leaf');
  assert.equal(tree.pathOfNode([node], 'leaf').length, 15001);
});

test('loop renames preserve dollar identifiers, property names and nested shadows', () => {
  const nodes = [
    { kind: 'expr', value: '{$item.label + $items.label + other.$item}' },
    { kind: 'text', value: '$item prose {$item.label}' },
    {
      kind: 'map',
      head: '$item.children.map(($item) => (',
      body: ['const title = $item.title;'],
      children: [{ kind: 'expr', value: '{$item.title}' }],
    },
    {
      kind: 'map',
      head: '$item.children.map((child) => (',
      body: ['const title = $item.title;'],
      children: [{ kind: 'expr', value: '{$item.title}' }],
    },
  ];
  const before = structuredClone(nodes);
  const renamed = loops.renamedLoopVar(nodes, '$item', 'next$');
  assert.deepEqual(nodes, before, 'the nodes passed in are left as they were');
  assert.equal(renamed[0].value, '{next$.label + $items.label + other.$item}');
  assert.equal(renamed[1].value, '$item prose {next$.label}');
  assert.equal(renamed[2].head, 'next$.children.map(($item) => (');
  assert.equal(renamed[2].body[0], 'const title = $item.title;');
  assert.equal(renamed[2].children[0].value, '{$item.title}');
  assert.equal(renamed[3].body[0], 'const title = next$.title;');
  assert.equal(renamed[3].children[0].value, '{next$.title}');
  assert.throws(() => loops.renamedLoopVar(nodes, 'x', 'x'), /A rename changes the name/);
});

test("switching a loop's data points the loops reading its item at an empty array", () => {
  const nodes = [
    {
      kind: 'map',
      head: 'item.tags.map((tag) => (',
      children: [
        {
          kind: 'cond',
          test: 'item.show',
          children: [{ kind: 'branch', name: 'then', children: [] }],
        },
      ],
    },
    {
      kind: 'map',
      head: 'other.map((item) => (',
      children: [{ kind: 'map', head: 'item.more.map((x) => (', children: [] }],
    },
  ];
  const before = structuredClone(nodes);
  const disconnected = loops.disconnectedLoops(nodes, ['item']);
  assert.deepEqual(nodes, before, 'the nodes passed in are left as they were');
  assert.equal(disconnected[0].head, '[].map((tag) => (');
  assert.equal(disconnected[0].children[0].test, 'false');
  assert.equal(disconnected[1].children[0].head, 'item.more.map((x) => (', 'shadowed below');
});

test('moving from a loop drops lost bindings without rewriting nested local variables', () => {
  const node = {
    kind: 'element',
    props: {
      href: { type: 'expr', value: 'item$.url' },
      title: { type: 'expr', value: 'other.item$' },
    },
    children: [
      { kind: 'expr', value: '{item$.label}' },
      {
        kind: 'map',
        head: 'item$.children.map((item$) => (',
        body: ['const title = item$.title;'],
        children: [{ kind: 'expr', value: '{item$.label}' }],
      },
    ],
  };
  const before = structuredClone(node);
  const stripped = loops.strippedBindings(node, ['item$']);
  assert.deepEqual(node, before, 'the node passed in is left as it was');
  assert.equal(stripped.removed, 3);
  assert.equal(stripped.node.props.href, undefined);
  assert.equal(stripped.node.props.title.value, 'other.item$');
  assert.equal(stripped.node.children[0].kind, 'text');
  assert.equal(stripped.node.children[0].value, 'content');
  assert.equal(stripped.node.children[1].head, '[].map((item$) => (');
  assert.equal(stripped.node.children[1].body[0], 'const title = item$.title;');
  assert.equal(stripped.node.children[1].children[0].value, '{item$.label}');
  assert.deepEqual(loops.strippedBindings(node, []), { node, removed: 0 });
});

test('a loop still running keeps its declarations, reading a placeholder instead', () => {
  const node = {
    kind: 'map',
    head: 'list.map((row) => (',
    body: ['const a = item.title;', 'const b = row.title;'],
    children: [{ kind: 'text', value: 'x {item.y} {row.z}' }],
  };
  const stripped = loops.strippedBindings(node, ['item']);
  assert.equal(stripped.removed, 2);
  assert.deepEqual(stripped.node.body, ["const a = 'content';", 'const b = row.title;']);
  assert.equal(stripped.node.children[0].value, 'x content {row.z}');
});

// Page saver harness: a real queue (src/editor/pageEdits.ts) and a send held on a
// gate per entry, so each test decides exactly when disk answers.
const edits = require(path.join(buildDirectory, 'pageEdits.js'));
const step = () => ({ outcome: { tag: 'applied', applied: [] } });
const gesture = (name) => ({
  coalesceKey: undefined,
  urgency: true,
  stream: undefined,
  request: () => [],
  apply: (model) => model,
  name,
});
function saverHarness(path = '/page.astro') {
  const harness = { path, queue: new edits.EditDrafts(), sent: [], gates: [], conflicted: false };
  harness.save = createPageSaver({
    queue: harness.queue,
    currentPath: () => harness.path,
    conflicted: () => harness.conflicted,
    send: (sentPath, entry) => {
      harness.sent.push({ path: sentPath, name: entry.gesture.name });
      const gate = deferred();
      harness.gates.push(gate);
      return gate.promise;
    },
  });
  harness.add = (name) => harness.queue.addGesture(harness.path, gesture(name), step());
  harness.answer = (index, outcome) => harness.gates[index].resolve(outcome);
  return harness;
}

test('the saver sends the queued entries in order, one at a time; later ones wait', async () => {
  const page = saverHarness();
  page.add('a');
  page.add('b');
  const one = page.save.flush();
  await tick();
  assert.deepEqual(
    page.sent.map((entry) => entry.name),
    ['a'],
  );
  assert.equal(page.save.writing(), true);
  page.add('c'); // Made while the flush runs: the next flush sends it.
  const two = page.save.flush();
  page.answer(0, { tag: 'sent' });
  await tick();
  assert.deepEqual(
    page.sent.map((entry) => entry.name),
    ['a', 'b'],
    'one at a time, in order',
  );
  page.answer(1, { tag: 'sent' });
  assert.equal(await one, 'settled', 'a flush sends what it found, and no more');
  await tick();
  assert.deepEqual(
    page.sent.map((entry) => entry.name),
    ['a', 'b', 'c'],
    'the flush asked later',
  );
  page.answer(2, { tag: 'sent' });
  assert.equal(await two, 'settled');
  assert.equal(page.save.writing(), false);
  assert.equal(page.queue.empty(page.path), true);
});

test('a failed send puts its entry back in front and rejects; a retry sends it again', async () => {
  const page = saverHarness();
  page.add('a');
  page.add('b');
  const failed = page.save.flush();
  await tick();
  page.answer(0, { tag: 'failed', error: new Error('disk full') });
  await assert.rejects(failed, /disk full/);
  assert.equal(page.queue.entries(page.path).length, 2, 'nothing was lost');
  const retry = page.save.flush();
  await tick();
  assert.equal(page.sent[1].name, 'a', 'the failed entry goes first');
  page.answer(1, { tag: 'sent' });
  await tick();
  page.answer(2, { tag: 'sent' });
  assert.equal(await retry, 'settled');
});

test('a refused send stops autosave until the user decides', async () => {
  const page = saverHarness();
  page.add('a');
  page.add('b');
  const refused = page.save.flush();
  await tick();
  page.conflicted = true; // The sender marks the page conflicted with its reason.
  page.answer(0, { tag: 'conflicted' });
  assert.equal(await refused, 'conflicted');
  assert.equal(page.queue.entries(page.path).length, 2, 'the refused entry is kept');
  assert.equal(await page.save.flush(), 'conflicted', 'nothing reaches disk');
  assert.equal(page.sent.length, 1);
  page.conflicted = false; // "Review in code" and "Keep", or "Reload".
  const kept = page.save.flush();
  await tick();
  page.answer(1, { tag: 'sent' });
  await tick();
  page.answer(2, { tag: 'sent' });
  assert.equal(await kept, 'settled');
});

test('no open file: nothing to send', async () => {
  const page = saverHarness();
  page.add('a');
  page.path = undefined;
  assert.equal(await page.save.flush(), 'settled');
  assert.equal(page.sent.length, 0);
});

test('external edits recognize pages, components and layouts as editable files', () => {
  const scan = {
    pages: [{ path: 'a.astro' }],
    components: [{ path: 'b.astro' }],
    layouts: [{ path: 'c.astro' }],
  };
  for (const file of ['a.astro', 'b.astro', 'c.astro']) {
    assert.equal(scanContainsFile(scan, file), true);
  }
  assert.equal(scanContainsFile(scan, 'deleted.astro'), false);
});

test('code window saves keep each file and flush the latest version in order', async () => {
  const { createFileSaver } = require(path.join(buildDirectory, 'pagePersistence.js'));
  const writes = [];
  const saver = createFileSaver({ delay: 10000 });
  saver.schedule('a.css', async () => writes.push('a:old'));
  saver.schedule('b.css', async () => writes.push('b:current'));
  saver.schedule('a.css', async () => writes.push('a:current'));
  await saver.flush();
  assert.deepEqual(writes.sort(), ['a:current', 'b:current']);
  const gate = deferred();
  saver.schedule('a.css', async () => {
    writes.push('a:pending');
    await gate.promise;
  });
  const first = saver.flush();
  await tick();
  saver.schedule('a.css', async () => writes.push('a:newest'));
  const second = saver.flush();
  await tick();
  assert.equal(writes.includes('a:newest'), false);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(writes.slice(-2), ['a:pending', 'a:newest']);
});

test('failed code window writes are retained for an explicit retry', async () => {
  const { createFileSaver } = require(path.join(buildDirectory, 'pagePersistence.js'));
  let fail = true;
  let attempts = 0;
  const errors = [];
  const saver = createFileSaver({ delay: 10000, onError: (error) => errors.push(error.message) });
  saver.schedule('a.css', async () => {
    attempts++;
    if (fail) {
      throw new Error('disk full');
    }
  });
  await assert.rejects(saver.flush(), /disk full/);
  assert.deepEqual(errors, ['disk full']);
  fail = false;
  await saver.flush();
  assert.equal(attempts, 2);
});
