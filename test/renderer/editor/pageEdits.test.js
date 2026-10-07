// Goal: the renderer's edit queue (src/editor/pageEdits.ts) and gestures
// (src/editor/editGestures.ts) keep plan §7's rules as step 9 left them: gestures
// coalesce within one stream of one undo step while unsent; typing drops the
// gestures its text does not hold; the queue is bounded, and a gesture past it
// is refused, never queued; a gesture is stated when it is sent, and one that
// cannot be stated is refused — nothing is ever saved as a whole model; a
// transient failure sends it again, a write that may have landed never blind;
// and every applied write leaves its undo step the inverse that restores the
// file (several steps in one write: the newest, the rest folded; several
// writes of one gesture: the step waits for every one of them).
// Method: the real modules, bundled with esbuild, driven directly; the send
// function is a fake for the outcome table, then main's real handlers in the
// windowless harness for the end-to-end run, undo included, on a temporary
// project.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const { parsePageDiskRead, parsePageEditResult } = require('#dist/shared/ipc/pageSave.js');
const { repoPath } = require('../../helpers/sources.js');

const buildDirectory = repoPath('node_modules/.stacki-test/page-edits');
fs.mkdirSync(buildDirectory, { recursive: true });
esbuild.buildSync({
  // Named entries: each output is <name>.js wherever its source lives.
  entryPoints: {
    pageEdits: repoPath('src/editor/pageEdits.ts'),
    editGestures: repoPath('src/editor/editGestures.ts'),
    insertGestures: repoPath('src/editor/insertGestures.ts'),
  },
  outdir: buildDirectory,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  logLevel: 'silent',
});
const edits = require(path.join(buildDirectory, 'pageEdits.js'));
const gestures = require(path.join(buildDirectory, 'editGestures.js'));
const insertGestures = require(path.join(buildDirectory, 'insertGestures.js'));

const sum = (digit) => String(digit).repeat(64);
const REF = { path: [0], kind: 'element', span: { start: 0, end: 4 } };
const record = () => ({ outcome: { tag: 'applied', applied: [] } });
// A gesture of one stream: its request removes the node REF names.
const gesture = (stream, refOk = true) => ({
  coalesceKey: undefined,
  urgency: false,
  stream,
  request: () => (refOk ? [{ tag: 'remove-node', target: REF }] : undefined),
  apply: (model) => model,
});

test('the queue coalesces one stream of one undo step, and nothing else', () => {
  const store = new edits.EditDrafts();
  const step = record();
  assert.equal(store.addGesture('/p', gesture('title'), step), 'queued');
  assert.equal(store.addGesture('/p', gesture('title'), step), 'queued');
  assert.equal(store.entries('/p').length, 1, 'the newer value replaced the older');
  assert.deepEqual(step.outcome, { tag: 'pending', waiting: 1, applied: [] });
  store.addGesture('/p', gesture('title'), record());
  store.addGesture('/p', gesture(undefined), step);
  store.addGesture('/p', gesture(undefined), step);
  assert.equal(store.entries('/p').length, 4, 'another step, and structural gestures, stay apart');
  assert.deepEqual(step.outcome, { tag: 'pending', waiting: 3, applied: [] });
  assert.equal(store.entries('/elsewhere').length, 0, 'another page owes nothing here');
  const first = store.shift('/p');
  assert.equal(first.tag, 'gesture');
  assert.equal(store.entries('/p').length, 3, 'a sent entry is gone from the queue');
  store.unshift('/p', first);
  assert.equal(store.entries('/p')[0], first, 'one that failed goes back in front');
});

test('typing drops the unsent gestures: the text typed into does not hold them', () => {
  const store = new edits.EditDrafts();
  const early = record();
  store.addGesture('/p', gesture('a'), early);
  const typing = record();
  const shown = { save: { tag: 'clean', checksum: sum(1) }, source: 'x', origin: undefined };
  store.typeCode('/p', shown, typing);
  assert.deepEqual(early.outcome, { tag: 'dropped' });
  assert.equal(store.entries('/p').length, 1);
  assert.equal(store.entries('/p')[0].tag, 'code');
  // A gesture after typing waits behind the code, stated when it is sent.
  assert.equal(store.addGesture('/p', gesture('b'), record()), 'queued');
  assert.deepEqual(
    store.entries('/p').map((entry) => entry.tag),
    ['code', 'gesture'],
  );
});

test('the queue is bounded: past it, a gesture is refused, never queued', () => {
  const store = new edits.EditDrafts();
  for (let index = 0; index < 64; index++) {
    assert.equal(store.addGesture('/p', gesture(undefined), record()), 'queued');
  }
  const over = record();
  assert.equal(store.addGesture('/p', gesture(undefined), over), 'full');
  assert.equal(store.entries('/p').length, 64);
  assert.deepEqual(over.outcome, { tag: 'applied', applied: [] }, 'nothing is owed for it');
});

test('answers fill the undo step in order; a step is applied when nothing is owed', () => {
  const step = record();
  const store = new edits.EditDrafts();
  store.addGesture('/p', gesture(undefined), step);
  store.addGesture('/p', gesture(undefined), step);
  edits.recordApplied(step, { checksum: sum(2), inverse: [] });
  assert.equal(step.outcome.tag, 'pending');
  edits.recordApplied(step, { checksum: sum(3), inverse: [] });
  assert.deepEqual(step.outcome, {
    tag: 'applied',
    applied: [
      { checksum: sum(2), inverse: [] },
      { checksum: sum(3), inverse: [] },
    ],
  });
  // One write for several steps (typing): the newest learns the inverse, the
  // older ones are folded into it.
  const older = record();
  const newer = record();
  const typed = { save: { tag: 'dirty', baseChecksum: sum(1) }, source: 'one', origin: undefined };
  store.typeCode('/typed', typed, older);
  store.typeCode('/typed', typed, newer);
  edits.recordWrite([older, newer], { checksum: sum(4), inverse: [] });
  assert.deepEqual(older.outcome, { tag: 'folded' });
  assert.equal(newer.outcome.tag, 'applied');
});

const PAGE_OK = (checksum) => ({
  ok: true,
  value: { source: '', editable: false, reason: '', bail: undefined, checksum, inverse: [] },
});
const refusal = (reason, diskChecksum) => ({
  ok: false,
  error: { code: 'rejected', reason, message: reason, diskChecksum },
});

// One gesture of `count` requests, stated against an origin and sent.
async function sent(answers, count = answers.length, refOk = true) {
  const step = record();
  step.outcome = { tag: 'pending', waiting: 1, applied: [] };
  let index = 0;
  const many = {
    ...gesture(undefined, refOk),
    request: () =>
      refOk
        ? Array.from({ length: count }, () => ({ tag: 'remove-node', target: REF }))
        : undefined,
  };
  const origin = { checksum: sum(1), source: '', model: { imports: [], nodes: [] } };
  const outcome = await edits.sendGesture({
    path: '/p',
    origin,
    gesture: many,
    record: step,
    send: async () => answers[index++],
  });
  return { outcome, step, sent: index };
}

test('sending a gesture: every outcome, and what the answers mean', async () => {
  const applied = await sent([PAGE_OK(sum(2)), PAGE_OK(sum(3))]);
  assert.equal(applied.outcome.tag, 'applied');
  assert.deepEqual(
    applied.outcome.replies.map((reply) => reply.checksum),
    [sum(2), sum(3)],
  );
  // A gesture of two requests writes twice, and its step undoes both: the
  // first reply settled a step owed one write, and the second was lost.
  assert.deepEqual(
    applied.step.outcome,
    {
      tag: 'applied',
      applied: [
        { checksum: sum(2), inverse: [] },
        { checksum: sum(3), inverse: [] },
      ],
    },
    'the undo step holds every write of the gesture',
  );

  const unstated = await sent([], 1, false);
  assert.deepEqual(
    unstated.outcome,
    { tag: 'refused', reason: 'unsupported-operation', diskChecksum: sum(1), replies: [] },
    'a gesture with no request is refused, never saved another way',
  );
  assert.equal(unstated.sent, 0);

  const refused = await sent([PAGE_OK(sum(2)), refusal('region-externally-modified', sum(9))]);
  assert.equal(refused.outcome.tag, 'refused');
  assert.equal(refused.outcome.reason, 'region-externally-modified');
  assert.equal(refused.outcome.diskChecksum, sum(9));
  assert.equal(refused.outcome.replies.length, 1, 'the one that applied is reported');

  const busy = await sent([{ ok: false, error: { code: 'backpressured', message: 'busy' } }], 2);
  assert.deepEqual(busy.outcome, { tag: 'retry', message: 'busy' }, 'never accepted: sent again');
  assert.deepEqual(
    busy.step.outcome,
    { tag: 'pending', waiting: 1, applied: [] },
    'a second request that never went out is not waited for: the retry owes it',
  );

  const maybe = await sent([
    PAGE_OK(sum(2)),
    { ok: false, error: { code: 'uncertain', message: '?' } },
  ]);
  assert.equal(maybe.outcome.tag, 'uncertain', 'may have landed: never sent twice blind');
  assert.equal(maybe.outcome.replies.length, 1);
});

test('nodeRefIn names nodes of the origin by path, kind and range, and nothing else', () => {
  const model = {
    imports: [],
    nodes: [
      {
        id: 'a',
        kind: 'element',
        name: 'div',
        start: 0,
        end: 20,
        children: [{ id: 'b', kind: 'text', value: 'x', start: 5, end: 6 }],
      },
      {
        id: 'c',
        kind: 'chunk-group',
        name: 'x',
        chunkFile: '/x.html',
        start: 21,
        end: 30,
        children: [{ id: 'd', kind: 'text', value: 'y', start: 0, end: 1 }],
      },
      { id: 'e', kind: 'element', name: 'p', children: [] },
    ],
  };
  const origin = { checksum: sum(1), source: '', model };
  assert.deepEqual(edits.nodeRefIn(origin, 'b'), {
    path: [0, 0],
    kind: 'text',
    span: { start: 5, end: 6 },
  });
  assert.equal(edits.nodeRefIn(origin, 'd'), undefined, 'inside a chunk file');
  assert.equal(edits.nodeRefIn(origin, 'e'), undefined, 'no source range: created since');
  assert.equal(edits.nodeRefIn(origin, 'zz'), undefined);
});

test('propsGesture: values of every type but a spread are requests; the effect copies', () => {
  const refOf = (id) => (id === 'a' ? REF : undefined);
  const set = gestures.propsGesture(
    'a',
    { title: { type: 'string', value: 'T' }, alt: undefined },
    { coalesceKey: 'k', urgency: false },
  );
  assert.deepEqual(set.request(refOf), [
    { tag: 'set-attribute', target: REF, name: 'title', value: { type: 'string', value: 'T' } },
    { tag: 'remove-attribute', target: REF, name: 'alt' },
  ]);
  assert.equal(set.stream, undefined, 'two fields are no one stream');
  const one = { coalesceKey: undefined, urgency: true };
  assert.equal(
    gestures.propsGesture('a', { title: undefined }, one).stream,
    'attribute:a:title',
    'one field of one node, by its handle',
  );
  assert.equal(
    gestures
      .propsGesture('b', { title: undefined }, { coalesceKey: undefined, urgency: true })
      .request(refOf),
    undefined,
  );
  const options = { coalesceKey: undefined, urgency: true };
  const expr = gestures
    .propsGesture('a', { n: { type: 'expr', value: 'x' } }, options)
    .request(refOf);
  assert.deepEqual(expr?.[0]?.value, { type: 'expr', value: 'x' }, 'the prop step');
  const bare = gestures.propsGesture('a', { hidden: { type: 'bare' } }, options).request(refOf);
  assert.deepEqual(bare?.[0]?.value, { type: 'bare' });
  const spread = gestures.propsGesture('a', { rest: { type: 'spread', value: 'rest' } }, options);
  assert.equal(spread.request(refOf), undefined, 'a spread is code: it cannot be stated');
  const node = {
    id: 'a',
    kind: 'element',
    name: 'img',
    props: { alt: { type: 'string', value: 'x' }, src: { type: 'string', value: 's' } },
    children: undefined,
  };
  const model = {
    imports: [],
    nodes: [{ id: 'r', kind: 'element', name: 'div', children: [node] }],
  };
  const next = set.apply(model);
  assert.deepEqual(
    Object.keys(next.nodes[0].children[0].props),
    ['src', 'title'],
    'order kept, new last',
  );
  assert.deepEqual(Object.keys(node.props), ['alt', 'src'], 'the old model is untouched');
  assert.notEqual(next.nodes[0], model.nodes[0], 'every list on the path is new');
});

// --- End to end: main's real handlers ------------------------------------------------

test('requests reach the page as splices; the undo step restores every byte', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-page-edits-'));
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'user'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"astro":"*"}}');
  const { mainHarness } = await import('../../helpers/mainHarness.ts');
  const harness = mainHarness(path.join(root, 'user'));
  context.after(() => {
    harness.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = path.join(root, 'src/pages/index.astro');
  const text = '<main>\n  <img\n    src="/a.png"\n    alt="Old"\n  />\n</main>\n';
  fs.writeFileSync(file, text);
  const read = parsePageDiskRead(await harness.invoke('page:read', file));
  assert.ok(read.editable);
  const origin = { checksum: read.checksum, source: read.source, model: read.model };
  const image = read.model.nodes[0]?.children?.[0];
  assert.ok(image !== undefined);
  const store = new edits.EditDrafts();
  const step = record();
  for (const patch of [
    { alt: { type: 'string', value: 'New' } },
    { alt: { type: 'string', value: 'Newer' } },
    { loading: { type: 'string', value: 'lazy' } },
  ]) {
    const made = gestures.propsGesture(image.id, patch, { coalesceKey: 'k', urgency: false });
    assert.equal(store.addGesture(file, made, step), 'queued');
  }
  assert.equal(store.entries(file).length, 2, 'the two values of one field coalesced');
  const send = async (request) => parsePageEditResult(await harness.invoke('page:edit', request));
  // Each entry is stated against the same origin and sent in order: main
  // rebases the second through the first's commit exactly.
  let outcome;
  for (let entry = store.shift(file); entry !== undefined; entry = store.shift(file)) {
    assert.equal(entry.tag, 'gesture');
    const gesture = entry.gesture;
    outcome = await edits.sendGesture({ path: file, origin, gesture, record: step, send });
    assert.equal(outcome.tag, 'applied');
  }
  assert.equal(outcome.tag, 'applied');
  const written =
    '<main>\n  <img\n    src="/a.png"\n    alt="Newer"\n    loading="lazy"\n  />\n</main>\n';
  assert.equal(
    fs.readFileSync(file, 'utf8'),
    written,
    'two requests: the coalesced value and the new one',
  );
  assert.equal(step.outcome.tag, 'applied');
  for (const applied of [...step.outcome.applied].reverse()) {
    const undone = await send({
      pagePath: file,
      authoredChecksum: applied.checksum,
      edit: { tag: 'revert', hunks: applied.inverse },
    });
    assert.ok(undone.ok);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), text, 'undone on the engine, byte for byte');
});

test('a delete and the prune it leaves undo together: every import comes back', async (context) => {
  // The shape of a real loss: deleting the wrapper that held every component
  // (App.tsx, removeNode) removes the nodes and then, as a second request of the
  // same gesture, the imports nothing reads any more. Undo reverts the step's
  // writes newest first; a step that learnt only the first write's inverse put
  // the components back and left their imports out.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-page-edits-'));
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'user'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"astro":"*"}}');
  const { mainHarness } = await import('../../helpers/mainHarness.ts');
  const harness = mainHarness(path.join(root, 'user'));
  context.after(() => {
    harness.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = path.join(root, 'src/pages/index.astro');
  const text =
    '---\n' +
    'import Hero from "../components/Hero.astro";\n' +
    'import Note from "../components/Note.astro";\n' +
    '---\n' +
    '<main>\n  <Hero />\n</main>\n<Note />\n';
  fs.writeFileSync(file, text);
  const read = parsePageDiskRead(await harness.invoke('page:read', file));
  assert.ok(read.editable);
  const origin = { checksum: read.checksum, source: read.source, model: read.model };
  const wrapper = read.model.nodes.find((node) => node.kind === 'element' && node.name === 'main');
  assert.ok(wrapper !== undefined);
  const removal = insertGestures.removalGesture([wrapper.id], { urgency: true });
  const afterRemoval = removal.apply(read.model);
  // What the delete leaves unused: Hero's import, read by nothing now.
  const prune = (model) => ({
    ...model,
    imports: model.imports.filter((member) => member.name !== 'Hero'),
  });
  const options = { coalesceKey: undefined, urgency: true };
  const pruning = gestures.frontmatterGesture(afterRemoval, options, prune);
  const gesture = gestures.sequence(removal, pruning);
  const store = new edits.EditDrafts();
  const step = record();
  assert.equal(store.addGesture(file, gesture, step), 'queued');
  const entry = store.shift(file);
  assert.equal(entry?.tag, 'gesture');
  const send = async (request) => parsePageEditResult(await harness.invoke('page:edit', request));
  const outcome = await edits.sendGesture({ path: file, origin, gesture, record: step, send });
  assert.equal(outcome.tag, 'applied');
  assert.equal(outcome.replies.length, 2, 'the removal, then the prune');
  const written = fs.readFileSync(file, 'utf8');
  assert.ok(!written.includes('Hero'), 'the wrapper and the import only it needed are gone');
  assert.ok(written.includes('import Note'), 'the import still read stays');
  assert.equal(step.outcome.tag, 'applied');
  assert.equal(step.outcome.applied.length, 2, 'the step waited for both writes');
  for (const applied of [...step.outcome.applied].reverse()) {
    const undone = await send({
      pagePath: file,
      authoredChecksum: applied.checksum,
      edit: { tag: 'revert', hunks: applied.inverse },
    });
    assert.ok(undone.ok);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), text, 'the nodes and their imports, byte for byte');
});

test(
  'insertGesture stands the new node beside the ' + 'one at its place, or inside an empty parent',
  () => {
    const refOf = (id) => ({ path: [id.length], kind: 'element', span: { start: 0, end: 1 } });
    const text = (id, value) => ({ id, kind: 'text', value });
    const node = { id: 'new', kind: 'element', name: 'p', props: {}, children: [] };
    const model = {
      imports: [],
      nodes: [
        { id: 'a', kind: 'element', name: 'div', props: {}, children: [] },
        text('gap', '\n'),
        {
          id: 'bb',
          kind: 'element',
          name: 'ul',
          props: {},
          children: [{ id: 'ccc', kind: 'element', name: 'li', props: {}, children: undefined }],
        },
      ],
    };
    const options = { urgency: true };
    const placed = (place) => {
      const [first] = gestures.insertGesture(model, node, place, options).request(refOf) ?? [];
      return first && [first.placement, first.target.path[0]];
    };
    assert.deepEqual(
      placed({ parentId: undefined, index: 0 }),
      ['before', 1],
      'before the node at the place',
    );
    assert.deepEqual(
      placed({ parentId: undefined, index: 1 }),
      ['before', 2],
      'blank text is not a neighbour',
    );
    assert.deepEqual(
      placed({ parentId: undefined, index: 9 }),
      ['after', 2],
      'past the end: after the last',
    );
    assert.deepEqual(
      placed({ parentId: 'a', index: 0 }),
      ['first-child', 1],
      'inside an empty parent',
    );
    assert.deepEqual(placed({ parentId: 'bb', index: 1 }), ['after', 3]);
    assert.deepEqual(
      gestures.insertGesture({ imports: [], nodes: [] }, node, undefined, options).request(refOf),
      [{ tag: 'append-body', nodes: [node] }],
      'an empty body takes its first node',
    );
    const inserted = gestures
      .insertGesture(model, node, { parentId: 'bb', index: 0 }, options)
      .apply(model);
    assert.deepEqual(
      inserted.nodes[2].children.map((child) => child.id),
      ['new', 'ccc'],
    );
    assert.deepEqual(
      model.nodes[2].children.map((child) => child.id),
      ['ccc'],
      'the old model is untouched',
    );
    const without = gestures.withoutNodes(model, ['ccc', 'gap']);
    assert.deepEqual(
      without.nodes.map((node) => node.id),
      ['a', 'bb'],
    );
    assert.deepEqual(without.nodes[1].children, []);
    assert.equal(model.nodes.length, 3);
  },
);

test(
  'moveGesture: a note travels with its node, a ' +
    'stale slot goes first, nothing moves into itself',
  () => {
    const refOf = (id) => ({
      path: [id.charCodeAt(0)],
      kind: 'element',
      span: { start: 0, end: 1 },
    });
    const model = {
      imports: [],
      nodes: [
        { id: 'n', kind: 'comment', value: ' note ' },
        {
          id: 'x',
          kind: 'element',
          name: 'p',
          source: '\n  <b>kept</b>\n',
          props: { slot: { type: 'string', value: 's' } },
          children: [{ id: 'b', kind: 'element', name: 'b', props: {}, children: [] }],
        },
        { id: 'z', kind: 'element', name: 'div', props: {}, children: [] },
      ],
    };
    const rules = { keepsSlot: () => false };
    const tags = (place) =>
      gestures
        .moveGesture(model, 'x', place, rules, { urgency: true })
        .request(refOf)
        .map((edit) => [edit.tag, edit.target.path[0], edit.placement]);
    const [note, x, z] = ['n', 'x', 'z'].map((id) => id.charCodeAt(0));
    assert.deepEqual(
      tags({ parentId: undefined, index: 3 }),
      [
        ['remove-attribute', x, undefined],
        ['move-node', x, 'after'],
        ['move-node', note, 'after'],
      ],
      'after a node: the node, then its note in front of it',
    );
    assert.deepEqual(tags({ parentId: 'z', index: 0 }).slice(1), [
      ['move-node', x, 'first-child'],
      ['move-node', note, 'first-child'],
    ]);
    const moved = gestures
      .moveGesture(model, 'x', { parentId: 'z', index: 0 }, rules, { urgency: true })
      .apply(model);
    assert.deepEqual(
      moved.nodes.map((node) => node.id),
      ['z'],
    );
    assert.deepEqual(
      moved.nodes[0].children.map((node) => node.id),
      ['n', 'x'],
      'the note lands above',
    );
    assert.equal(moved.nodes[0].children[1].props.slot, undefined, 'the slot meant nothing there');
    assert.equal(
      gestures.moveGesture(model, 'x', { parentId: 'b', index: 0 }, rules, { urgency: true }),
      undefined,
    );
    // Emptied of its only child, an element forgets the inner source the legacy
    // printer would otherwise write back.
    const emptied = gestures.withoutNodes(model, ['b']);
    assert.equal(Object.hasOwn(emptied.nodes[1], 'source'), false);
    assert.equal(model.nodes[1].source, '\n  <b>kept</b>\n', 'the old model keeps its own');
  },
);
