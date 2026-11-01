// Goal: src/editor/nodeHandles.ts carries a session's node handles onto a fresh parse
// by the mapping every edit uses (plan §4), never by position or likeness:
// through the app's own splices exactly — the edited node, a renamed tag, a
// moved node and the nodes an insertion created keep or take their handles —
// and through the byte diff otherwise, where only what every minimum script
// keeps whole is carried. Everything else gets a fresh handle named by the
// snapshot's checksum and path, unique in the tree.
// Method: real pages parsed by the real parser; the app's edits planned and
// applied by the real engine (main's translation, the planner), so a reply's
// inverse hunks are the ones main sends; outside edits are text changes. The
// session's handles are made distinct from any parser id before each case.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const load = require('../../helpers/rendererModule');
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const { LIMITS } = require('#dist/shared/core/limits.js');
const { parsePageResult } = require('#dist/shared/page/pageNode.js');
const { NODE_PROJECTOR } = require('#dist/electron/documents/documentDisk.js');
const { buildEditIntent } = require('#dist/electron/documents/editRequests.js');
const { toIntent } = require('#dist/shared/engine/intent.js');
const { planIntent } = require('#dist/shared/engine/planner.js');
const { applySplices, inverseEdits } = require('#dist/shared/engine/splice.js');
const { carryHandles } = load('src/editor/nodeHandles.ts');

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const parse = (source) => {
  const result = parsePageResult(parsePage(source, { locs: true }));
  assert.ok(result.editable, 'the page parses');
  return result.model;
};

// A parse whose ids are session handles `h(i)` in document order: gesture-style
// handles, distinct from any parser id.
const handle = (index) => `g${String(index).padStart(32, '0')}`;
function session(source) {
  let next = 0;
  const visit = (list, depth) => {
    assert.ok(depth <= LIMITS.treeDepthMax, 'session: depth limit');
    return list.map((node) => {
      const id = node.id === 'layout' ? 'layout' : handle(next++); // Before its children.
      const children = Array.isArray(node.children) ? { children: visit(node.children, depth + 1) } : {};
      return { ...node, id, ...children };
    });
  };
  const model = parse(source);
  return { source, model: { ...model, nodes: visit(model.nodes, 0) } };
}

// The app's edit, as main applies it: the reply's text and inverse hunks.
function reply(before, edit) {
  const snapshot = NODE_PROJECTOR.snapshot('/p/page.astro', Buffer.from(before.source));
  const draft = buildEditIntent(edit, snapshot);
  assert.ok(draft.ok, `built (${draft.ok ? '' : draft.error})`);
  const authoredChecksum = snapshot.checksum;
  const intent = toIntent({ id: 't', file: snapshot.path, authoredChecksum, ...draft.value });
  const planned = planIntent({ authored: snapshot, current: snapshot }, intent);
  assert.ok(planned.ok, `planned (${planned.ok ? '' : planned.error})`);
  const source = Buffer.from(applySplices(snapshot.bytes, planned.value.splices)).toString('utf8');
  return { source, own: inverseEdits(planned.value.splices) };
}

function refOf(model, path) {
  let list = model.nodes;
  let node;
  for (const step of path) {
    node = list[step];
    list = Array.isArray(node.children) ? node.children : [];
  }
  return { path, kind: node.kind, span: { start: node.start, end: node.end } };
}

// The first node of the first element gets class="big": an edit of its own bytes.
const bigClass = (page) => ({
  tag: 'set-attribute',
  target: refOf(page.model, [0, 0]),
  name: 'class',
  value: { type: 'string', value: 'big' },
});

const ids = (model) => {
  const out = [];
  const visit = (list, depth) => {
    assert.ok(depth <= LIMITS.treeDepthMax, 'ids: depth limit');
    for (const node of list) {
      out.push(node.id);
      if (Array.isArray(node.children)) {
        visit(node.children, depth + 1);
      }
    }
  };
  visit(model.nodes, 0);
  return out;
};

function carried(before, after, own, predicted) {
  return carryHandles({
    before,
    after: { source: after, seed: sha256(after).slice(0, 16), model: parse(after) },
    own,
    predicted,
  });
}

const NEW = `g${'f'.repeat(32)}`;
const PAGE = '<main>\n  <h1 class="t">Title</h1>\n  <p>One</p>\n  <p>Two</p>\n</main>\n';

test('the app’s own edit carries every handle, the edited node’s included', () => {
  const before = session(PAGE);
  const { source, own } = reply(before, bigClass(before));
  assert.deepEqual(ids(carried(before, source, own, undefined)), ids(before.model));
  const retag = { tag: 'rename-tag', target: refOf(before.model, [0, 1]), to: 'Card' };
  const renamed = reply(before, retag);
  const after = carried(before, renamed.source, renamed.own, undefined);
  assert.deepEqual(ids(after), ids(before.model), 'a tag renamed to a component keeps its handle');
  assert.equal(after.nodes[0].children[1].kind, 'component');
});

test('a removal drops only the removed handles; an insertion takes the gesture’s own', () => {
  const before = session(PAGE);
  const removed = reply(before, { tag: 'remove-node', target: refOf(before.model, [0, 1]) });
  const afterRemoval = carried(before, removed.source, removed.own, undefined);
  assert.deepEqual(ids(afterRemoval), [handle(0), handle(1), handle(2), handle(5), handle(6)]);
  const inserted = reply(before, {
    tag: 'insert-node',
    target: refOf(before.model, [0, 2]),
    placement: 'before',
    content: {
      tag: 'nodes',
      nodes: [{ id: NEW, kind: 'element', name: 'hr', props: {}, children: undefined }],
    },
  });
  // The gesture predicted the new node with its own handle, where it lands.
  const predicted = {
    ...before.model,
    nodes: [
      {
        ...before.model.nodes[0],
        children: [
          before.model.nodes[0].children[0],
          before.model.nodes[0].children[1],
          { id: NEW, kind: 'element', name: 'hr', props: {}, children: undefined },
          before.model.nodes[0].children[2],
        ],
      },
    ],
  };
  const afterInsert = carried(before, inserted.source, inserted.own, predicted);
  assert.deepEqual(ids(afterInsert), [handle(0), handle(1), handle(2), handle(3), handle(4), NEW, handle(5), handle(6)]);
});

test('a moved node keeps its handle at its new place', () => {
  const before = session(PAGE);
  const moved = reply(before, {
    tag: 'move-node',
    target: refOf(before.model, [0, 2]),
    destination: refOf(before.model, [0, 0]),
    placement: 'before',
  });
  const main = before.model.nodes[0];
  const reordered = [main.children[2], main.children[0], main.children[1]];
  const predicted = { ...before.model, nodes: [{ ...main, children: reordered }] };
  const after = carried(before, moved.source, moved.own, predicted);
  assert.equal(after.nodes[0].children[0].id, handle(5), 'the moved paragraph');
  assert.equal(after.nodes[0].children[0].children[0].id, handle(6), 'and its text');
  assert.deepEqual(
    after.nodes[0].children.slice(1).map((node) => node.id),
    [handle(1), handle(3)],
  );
});

test('an outside edit maps through the diff: untouched nodes keep, changed ones are fresh', () => {
  const before = session(PAGE);
  const outside = `${PAGE.replace('<p>One</p>', '<p>Uno</p>')}<footer>f</footer>\n`;
  const after = carried(before, outside, undefined, undefined);
  const handles = ids(after);
  assert.ok(!handles.includes(handle(0)), 'the main element changed inside: a fresh handle');
  assert.ok(handles.includes(handle(1)), 'the untouched heading keeps its handle');
  assert.ok(handles.includes(handle(5)), 'the untouched second paragraph keeps its handle');
  assert.ok(!handles.includes(handle(3)), 'the edited paragraph is fresh');
  assert.ok(!handles.includes(handle(4)), 'and so is its changed text');
  const fresh = handles.filter((handle) => !handle.startsWith('g'));
  assert.ok(fresh.length > 0, 'the changed nodes have fresh handles');
  for (const handle of fresh) {
    assert.match(handle, new RegExp(`^s${sha256(outside).slice(0, 16)}\\.`));
  }
  assert.equal(new Set(handles).size, handles.length, 'handles are unique');
});

test('a tie between minimum scripts carries nothing: the mapper never guesses', () => {
  const before = session(PAGE);
  // `  <hr />` inserted before `  <h1` shares its first bytes: some minimum
  // script matches the heading's `<` to the new rule's. Ambiguous → fresh.
  const tied = PAGE.replace('<main>\n', '<main>\n  <hr />\n');
  const handles = ids(carried(before, tied, undefined, undefined));
  assert.ok(!handles.includes(handle(1)), 'the heading is not guessed');
  assert.ok(handles.includes(handle(5)), 'what no script disputes is still carried');
});

test('an own reply that merged an outside edit maps through the diff, never the splices', () => {
  const before = session(PAGE);
  const { source, own } = reply(before, bigClass(before));
  const merged = source.replace('<p>Two</p>', '<p>Two</p>\n  <p>Three</p>');
  const after = carried(before, merged, own, undefined);
  const handles = ids(after);
  assert.ok(handles.includes(handle(3)), 'an untouched paragraph keeps its handle');
  assert.equal(new Set(handles).size, handles.length, 'handles are unique');
});

test('the layout wrapper keeps its well-known handle; fresh handles never collide', () => {
  const text = "---\nimport Base from '../layouts/Base.astro';\n---\n<Base>\n  <p>a</p>\n</Base>\n";
  const before = { source: text, model: parse(text) };
  assert.equal(before.model.nodes[0].id, 'layout');
  const changed = text.replace('<p>a</p>', '<p>b</p>');
  const after = carried(before, changed, undefined, undefined);
  assert.equal(after.nodes[0].id, 'layout');
});
