// Goal: src/editor/pageSender.ts shows each queue entry's outcome on the page as plan
// §7 and §11.9 require: an applied gesture moves the origin on — and, when
// nothing more is owed, the page is the reply itself, clean, every handle
// carried; a gesture refused over unchanged bytes (no form the engine can plan)
// is taken back and said out loud, never saved some other way; one refused
// over changed bytes is the conflict notice with its reason; a write that
// may have landed is never sent again blind — the disk decides; and a preview
// of the queue (the reviewed version of a conflicted page) is those gestures
// planned as splices of the bytes they were stated on, nothing written.
// Method: a real page parsed by the real parser, replies made by main's real
// translation and planner (so their inverse hunks are main's), and the page
// state held in a plain object the sender updates.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const load = require('../../helpers/rendererModule');
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const { parsePageResult } = require('#dist/shared/page/pageNode.js');
const { NODE_PROJECTOR } = require('#dist/electron/documents/documentDisk.js');
const { buildEditIntent } = require('#dist/electron/documents/editRequests.js');
const { toIntent } = require('#dist/shared/engine/intent.js');
const { planIntent } = require('#dist/shared/engine/planner.js');
const { applySplices, inverseEdits } = require('#dist/shared/engine/splice.js');
const { pageEditError } = require('#dist/electron/documents/pageRequests.js');
const { createEntrySender, previewGestures } = load('src/editor/pageSender.ts');
const { createPageSaver } = load('src/editor/pagePersistence.ts');
const edits = load('src/editor/pageEdits.ts');
const editGestures = load('src/editor/editGestures.ts');

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const PATH = '/project/src/pages/index.astro';
const PAGE = '<main>\n  <h1 class="t">Title</h1>\n  <p>One</p>\n</main>\n';
const HEADING_TITLED = PAGE.replace('class="t"', 'class="t" title="a"');
const BOTH_TITLED = HEADING_TITLED.replace('<p>', '<p title="b">');
const titled = (value) => ({ title: { type: 'string', value } });

function read(source) {
  const parsed = parsePageResult(parsePage(source, { locs: true }));
  return { ...parsed, source, checksum: sha256(source) };
}

// The page as the app shows it after reading `source`.
function pageState(source) {
  const page = read(source);
  assert.ok(page.editable);
  const origin = { checksum: page.checksum, source, model: page.model };
  return {
    editable: true,
    model: page.model,
    source,
    parsedFrom: source,
    save: { tag: 'dirty', baseChecksum: page.checksum },
    origin,
  };
}

// Main's page:edit, on a disk the test holds.
function engine(disk) {
  return async ({ authoredChecksum, edit }) => {
    const snapshot = NODE_PROJECTOR.snapshot(PATH, Buffer.from(disk.text));
    if (snapshot.checksum !== authoredChecksum) {
      const reason = 'region-externally-modified';
      const error = { code: 'rejected', reason, message: 'x', diskChecksum: snapshot.checksum };
      return { ok: false, error };
    }
    const draft = buildEditIntent(edit, snapshot);
    if (!draft.ok) {
      const reason = draft.error;
      const error = { code: 'rejected', reason, message: reason, diskChecksum: snapshot.checksum };
      return { ok: false, error };
    }
    const intent = toIntent({ id: 't', file: PATH, authoredChecksum, ...draft.value });
    const planned = planIntent({ authored: snapshot, current: snapshot }, intent);
    assert.ok(planned.ok, `planned (${planned.ok ? '' : planned.error})`);
    disk.text = Buffer.from(applySplices(snapshot.bytes, planned.value.splices)).toString('utf8');
    const inverse = inverseEdits(planned.value.splices);
    return { ok: true, value: { ...read(disk.text), inverse } };
  };
}

function harness(source, overrides = {}) {
  const disk = { text: source };
  const box = { state: pageState(source), notices: [], conflicts: [] };
  const queue = new edits.EditDrafts();
  const send = createEntrySender({
    queue,
    state: () => box.state,
    update: (_path, change) => {
      box.state = change(box.state);
    },
    conflict: (reason) => box.conflicts.push(reason),
    notice: (message) => box.notices.push(message),
    edit: engine(disk),
    writeWhole: async () => {
      throw new Error('an .astro page is never saved whole');
    },
    read: async () => read(disk.text),
    ...overrides,
  });
  return { disk, box, queue, send };
}

const step = () => ({ outcome: { tag: 'applied', applied: [] } });

test('a failed text write keeps the visible edit queued until a later save succeeds', async () => {
  let unavailable = true;
  const fixture = harness(PAGE, {
    edit: async (request) => {
      if (unavailable) {
        const error = pageEditError(PATH, {
          tag: 'rejected',
          reason: 'write-failed',
          message: 'EPERM: file temporarily held open',
          diskChecksum: sha256(PAGE),
        });
        return { ok: false, error };
      }
      return engine(fixture.disk)(request);
    },
  });
  const { box, disk, queue, send } = fixture;
  const text = box.state.model.nodes[0].children[0].children[0];
  const gesture = editGestures.nodeGesture(
    text.id,
    { ...text, value: 'Updated' },
    {
      coalesceKey: undefined,
      urgency: false,
    },
  );
  const record = step();
  queue.addGesture(PATH, gesture, record);
  box.state = { ...box.state, model: gesture.apply(box.state.model) };
  const predicted = box.state.model;
  const saver = createPageSaver({
    queue,
    currentPath: () => PATH,
    conflicted: () => box.state.save.tag === 'conflicted',
    send,
  });
  await assert.rejects(saver.flush(), /EPERM/);
  assert.equal(disk.text, PAGE);
  assert.deepEqual(box.state.model, predicted, 'the typed text remains visible');
  assert.equal(box.state.save.tag, 'failed');
  assert.match(box.state.save.message, /EPERM/);
  assert.equal(queue.entries(PATH).length, 1);
  assert.equal(record.outcome.tag, 'pending', 'the undo record is retained');
  assert.deepEqual(box.notices, [], 'a write failure is not an unsupported visual edit');
  unavailable = false;
  assert.equal(await saver.flush(), 'settled');
  assert.equal(disk.text, PAGE.replace('Title', 'Updated'));
  assert.equal(queue.entries(PATH).length, 0);
  assert.equal(box.state.save.tag, 'clean');
  assert.equal(record.outcome.applied.length, 1, 'the edit is committed once');
});

test('an applied gesture: the page is the reply, clean, with every handle carried', async () => {
  const { disk, box, queue, send } = harness(PAGE);
  const heading = box.state.model.nodes[0].children[0];
  const record = step();
  const big = { class: { type: 'string', value: 'big' } };
  const retitle = editGestures.propsGesture(heading.id, big, {
    coalesceKey: undefined,
    urgency: true,
  });
  queue.addGesture(PATH, retitle, record);
  box.state = { ...box.state, model: retitle.apply(box.state.model) };
  const outcome = await send(PATH, queue.shift(PATH));
  assert.deepEqual(outcome, { tag: 'sent' });
  assert.equal(disk.text, PAGE.replace('class="t"', 'class="big"'));
  assert.deepEqual(box.state.save, { tag: 'clean', checksum: sha256(disk.text) });
  assert.equal(box.state.origin.checksum, sha256(disk.text), 'the origin moved on');
  assert.equal(box.state.model.nodes[0].children[0].id, heading.id, 'the handle was carried');
  assert.equal(record.outcome.tag, 'applied');
});

test('a confirmed discrete edit cues the canvas after disk changes', async () => {
  const seen = [];
  const { disk, box, queue, send } = harness(PAGE, {
    onAppliedUrgentEdit: () => seen.push(disk.text),
  });
  const heading = box.state.model.nodes[0].children[0];
  const clone = { ...heading, id: `g${'a'.repeat(32)}` };
  const duplicate = editGestures.duplicateGesture(heading.id, clone, { urgency: true });
  queue.addGesture(PATH, duplicate, step());
  box.state = { ...box.state, model: duplicate.apply(box.state.model) };
  assert.deepEqual(await send(PATH, queue.shift(PATH)), { tag: 'sent' });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /<h1 class="t">Title<\/h1>[\s\S]*<h1 class="t">Title<\/h1>/);

  const remove = editGestures.removalGesture([clone.id], { urgency: true });
  queue.addGesture(PATH, remove, step());
  box.state = { ...box.state, model: remove.apply(box.state.model) };
  assert.deepEqual(await send(PATH, queue.shift(PATH)), { tag: 'sent' });
  assert.equal(seen.length, 2);
  assert.equal(disk.text, PAGE);

  const retitle = editGestures.propsGesture(heading.id, titled('later'), {
    coalesceKey: undefined,
    urgency: false,
  });
  queue.addGesture(PATH, retitle, step());
  box.state = { ...box.state, model: retitle.apply(box.state.model) };
  assert.deepEqual(await send(PATH, queue.shift(PATH)), { tag: 'sent' });
  assert.equal(seen.length, 2, 'batched typing still relies on HMR');
});

test('with more queued, only the origin moves on; the model shows the newer edit', async () => {
  const { disk, box, queue, send } = harness(PAGE);
  const [heading, paragraph] = box.state.model.nodes[0].children;
  const options = { coalesceKey: undefined, urgency: true };
  const first = editGestures.propsGesture(heading.id, titled('a'), options);
  const second = editGestures.propsGesture(paragraph.id, titled('b'), options);
  queue.addGesture(PATH, first, step());
  queue.addGesture(PATH, second, step());
  box.state = { ...box.state, model: second.apply(first.apply(box.state.model)) };
  await send(PATH, queue.shift(PATH));
  assert.equal(box.state.save.tag, 'dirty');
  assert.equal(box.state.save.baseChecksum, sha256(disk.text), 'the next request names these');
  assert.equal(box.state.model.nodes[0].children[1].props.title.value, 'b', 'the newer edit shows');
  await send(PATH, queue.shift(PATH));
  assert.equal(disk.text, BOTH_TITLED);
  assert.equal(box.state.save.tag, 'clean');
});

test('edits queued during a move keep the moved element and child selected', async () => {
  const card = '<article><p>Same</p></article>';
  const { disk, box, queue, send } = harness(`<main>${card}${card}</main><aside></aside>`);
  const [main, aside] = box.state.model.nodes;
  const target = main.children[0];
  const child = target.children[0];
  const move = editGestures.moveGesture(box.state.model, target.id, { parentId: aside.id, index: 0 }, { keepsSlot: () => true }, { urgency: true });
  assert.ok(move);
  const options = { coalesceKey: undefined, urgency: true };
  const gestures = [move, editGestures.propsGesture(target.id, titled('Moved'), options), editGestures.propsGesture(child.id, titled('Child'), options)];
  for (const gesture of gestures) {
    queue.addGesture(PATH, gesture, step());
    box.state = { ...box.state, model: gesture.apply(box.state.model) };
  }
  for (const _gesture of gestures) {
    assert.deepEqual(await send(PATH, queue.shift(PATH)), { tag: 'sent' });
  }
  assert.equal(disk.text, `<main>${card}</main><aside>\n\t<article title="Moved">` + '<p title="Child">Same</p></article>\n</aside>');
  const moved = box.state.model.nodes[1].children[0];
  assert.equal(moved.id, target.id, 'selection follows the moved element');
  assert.equal(moved.children[0].id, child.id, 'selection also follows its child');
  assert.deepEqual(box.notices, []);
  assert.deepEqual(box.conflicts, []);
});

test('a gesture with no remaining change completes without a write or error', async () => {
  const { disk, box, queue, send } = harness(PAGE);
  const record = step();
  const unchanged = {
    coalesceKey: undefined,
    urgency: true,
    stream: undefined,
    request: () => undefined, // No request and no model change: nothing to state.
    apply: (model) => model,
  };
  queue.addGesture(PATH, unchanged, record);
  box.state = { ...box.state, model: unchanged.apply(box.state.model) };
  assert.deepEqual(await send(PATH, queue.shift(PATH)), { tag: 'sent' });
  assert.equal(disk.text, PAGE, 'nothing written');
  assert.deepEqual(record.outcome, { tag: 'applied', applied: [] });
  assert.deepEqual(box.notices, []);
  assert.equal(box.state.model.nodes.length, 1, 'the shown model is the origin again');
  assert.deepEqual(box.state.save, { tag: 'clean', checksum: sha256(PAGE) });
});

test('a failed request preserves undo for earlier writes in the same gesture', async () => {
  let requests = 0;
  const fixture = harness(PAGE, {
    edit: async (request) => {
      requests += 1;
      if (requests === 1) {
        return engine(fixture.disk)(request);
      }
      return {
        ok: false,
        error: {
          code: 'rejected',
          reason: 'unsupported-operation',
          message: 'planner failure',
          diskChecksum: sha256(fixture.disk.text),
        },
      };
    },
  });
  const { disk, box, queue, send } = fixture;
  const [heading, paragraph] = box.state.model.nodes[0].children;
  const options = { coalesceKey: undefined, urgency: true };
  const first = editGestures.propsGesture(heading.id, titled('a'), options);
  const second = editGestures.propsGesture(paragraph.id, titled('b'), options);
  const gesture = {
    ...options,
    stream: undefined,
    request: (refOf) => [...first.request(refOf), ...second.request(refOf)],
    apply: (model) => second.apply(first.apply(model)),
  };
  const record = step();
  queue.addGesture(PATH, gesture, record);
  box.state = { ...box.state, model: gesture.apply(box.state.model) };
  assert.deepEqual(await send(PATH, queue.shift(PATH)), { tag: 'sent' });
  assert.equal(disk.text, HEADING_TITLED);
  assert.equal(record.outcome.tag, 'applied');
  assert.equal(record.outcome.applied.length, 1, 'the saved part still has an undo');
  const [{ inverse }] = record.outcome.applied;
  const undone = await engine(disk)({
    authoredChecksum: sha256(disk.text),
    edit: { tag: 'revert', hunks: inverse },
  });
  assert.ok(undone.ok);
  assert.equal(disk.text, PAGE, 'undo restores the bytes before the partial save');
  assert.deepEqual(box.notices, ['Stacki couldn’t apply this edit. ' + 'Stacki encountered an editor error while applying the change.']);
});

test('refused over changed bytes: the conflict notice with the reason', async () => {
  let previewCues = 0;
  const { disk, box, queue, send } = harness(PAGE, {
    onAppliedUrgentEdit: () => {
      previewCues += 1;
    },
  });
  const heading = box.state.model.nodes[0].children[0];
  const options = { coalesceKey: undefined, urgency: true };
  const untitle = editGestures.propsGesture(heading.id, { title: undefined }, options);
  queue.addGesture(PATH, untitle, step());
  disk.text = PAGE.replace('Title', 'Outside');
  assert.deepEqual(await send(PATH, queue.shift(PATH)), { tag: 'conflicted' });
  assert.deepEqual(box.conflicts, ['region-externally-modified']);
  assert.equal(box.state.save.tag, 'conflicted');
  assert.equal(box.state.save.diskChecksum, sha256(disk.text));
  assert.equal(previewCues, 0, 'a refused edit cannot announce a new preview');
});

test('a write that may have landed is never sent again blind: the disk decides', async () => {
  const uncertain = async () => ({ ok: false, error: { code: 'uncertain', message: 'rename?' } });
  const untouched = harness(PAGE, { edit: uncertain });
  const heading = untouched.box.state.model.nodes[0].children[0];
  const options = { coalesceKey: undefined, urgency: true };
  const drop = editGestures.propsGesture(heading.id, { class: undefined }, options);
  untouched.queue.addGesture(PATH, drop, step());
  const again = await untouched.send(PATH, untouched.queue.shift(PATH));
  assert.equal(again.tag, 'failed', 'the disk holds the bytes it was stated against: send again');
  const moved = harness(PAGE, { edit: uncertain });
  moved.queue.addGesture(PATH, drop, step());
  moved.disk.text = PAGE.replace(' class="t"', '');
  assert.deepEqual(await moved.send(PATH, moved.queue.shift(PATH)), { tag: 'conflicted' });
  assert.deepEqual(moved.box.conflicts, ['write-race'], 'it changed: the user decides');
});

test('a preview plans every queued gesture as splices, chained, and writes nothing', async () => {
  const disk = { text: PAGE.replace('One', 'Outside') }; // The disk moved on.
  const origin = pageState(PAGE).origin;
  const [heading, paragraph] = origin.model.nodes[0].children;
  const options = { coalesceKey: undefined, urgency: true };
  const unchanged = {
    ...options,
    stream: undefined,
    request: () => undefined,
    apply: (model) => model,
  };
  const queued = [editGestures.propsGesture(heading.id, titled('a'), options), unchanged, editGestures.propsGesture(paragraph.id, titled('b'), options)];
  const planned = [];
  const preview = async (request, source) => {
    planned.push(request.authoredChecksum);
    const held = { text: source };
    return engine(held)(request); // Planned against the bytes sent, never the disk.
  };
  const shown = await previewGestures({ path: PATH, origin, gestures: queued, preview });
  assert.equal(shown.tag, 'previewed');
  assert.equal(shown.origin.source, BOTH_TITLED);
  assert.equal(shown.origin.checksum, sha256(BOTH_TITLED));
  assert.deepEqual(planned, [sha256(PAGE), sha256(HEADING_TITLED)]);
  assert.equal(disk.text, PAGE.replace('One', 'Outside'), 'nothing written');
  assert.equal(shown.origin.model.nodes[0].children[1].id, paragraph.id, 'handles carried');
});

test('a failed preview never presents a version with a queued edit missing', async () => {
  const origin = pageState(PAGE).origin;
  const heading = origin.model.nodes[0].children[0];
  const gesture = editGestures.propsGesture(heading.id, titled('a'), {
    coalesceKey: undefined,
    urgency: true,
  });
  const previews = [];
  const shown = await previewGestures({
    path: PATH,
    origin,
    gestures: [gesture],
    preview: async (request) => {
      previews.push(request.edit.tag);
      return {
        ok: false,
        error: {
          code: 'rejected',
          reason: 'unsupported-operation',
          message: 'planner failure',
          diskChecksum: origin.checksum,
        },
      };
    },
  });
  assert.deepEqual(shown, {
    tag: 'failed',
    message: 'Stacki encountered an editor error while applying the change.',
  });
  assert.deepEqual(previews, ['set-attribute', 'replace-node', 'replace-page']);
  assert.equal(origin.source, PAGE, 'review cannot mutate the baseline');
});
