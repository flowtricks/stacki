// Goal: Stacki Apps' `node.insert` takes attributes or props, a place of its own
// and a node to replace, and each insert is one gesture: one undo step, one save.
// Method: four layers, each tested on its own with the real modules bundled by
// esbuild. (1) The parser (shared/properties/appsRpc.ts) accepts every good shape
// and refuses each bad one with a reason, including the bounds and `<script>`.
// (2) The anchored placement rule (src/editor/insertTarget.ts) puts a node
// before, after, inside or in place of an anchor, and refuses places that cannot
// hold it rather than moving the node. (3) The gesture (appInsertGesture.ts) asks
// main for the insert and the removal as one request list, adds and prunes
// imports in the same step, and predicts the page that results. (4) Desktop's
// host (desktopAppHost.ts) labels the one step the insert pushed and saves once,
// and passes a refusal through without saving.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');

const contract = load('shared/properties/appsRpc.ts');
const placement = load('src/editor/insertTarget.ts');
const gestures = load('src/app/model/appInsertGesture.ts');
const desktop = load('src/app/shell/desktopAppHost.ts');

const parse = (params) => contract.APP_METHODS['node.insert'].params(params);
const refusal = (params) => {
  try {
    parse(params);
  } catch (error) {
    return String(error.message);
  }
  return undefined;
};

test('the parser keeps today’s calls and reads attributes, props, positions and replace', () => {
  assert.deepEqual(parse({ kind: 'element', tag: 'section' }), {
    item: { kind: 'element', tag: 'section', attributes: {} },
    place: { kind: 'selection' },
    label: undefined,
  });
  assert.deepEqual(parse({ kind: 'component', name: 'Card', props: { title: 'Hi', class: 'big wide' }, position: 'before', anchor: 'n0.1' }), {
    item: { kind: 'component', name: 'Card', props: { title: 'Hi', class: 'big wide' } },
    place: { kind: 'before', anchor: 'n0.1' },
    label: undefined,
  });
  // A new element may start with a class and an inline style: it has none of its own to keep.
  const element = parse({
    kind: 'element',
    tag: 'a',
    attributes: { href: '/x', class: 'link', style: 'color: red', 'data-pin': '1' },
    position: 'inside',
    anchor: 'n2',
  });
  assert.deepEqual(element.item.attributes, { href: '/x', class: 'link', style: 'color: red', 'data-pin': '1' });
  assert.deepEqual(element.place, { kind: 'inside', anchor: 'n2', index: undefined });
  assert.deepEqual(parse({ kind: 'element', tag: 'p', position: 'inside', anchor: 'n2', index: 0 }).place, { kind: 'inside', anchor: 'n2', index: 0 });
  assert.deepEqual(parse({ kind: 'element', tag: 'p', position: 'after', anchor: 'n2' }).place, { kind: 'after', anchor: 'n2' });
  assert.deepEqual(parse({ kind: 'element', tag: 'p', replace: 'n3', label: 'Swap' }).place, { kind: 'replace', nodeId: 'n3' });
  const most = Object.fromEntries(Array.from({ length: contract.APP_RPC_LIMITS.insertAttributesMax }, (_, index) => [`data-a${index}`, 'x']));
  assert.equal(Object.keys(parse({ kind: 'element', tag: 'div', attributes: most }).item.attributes).length, 32, 'the bound itself is allowed');
});

test('the parser refuses each bad shape with its reason', () => {
  const tooMany = Object.fromEntries(Array.from({ length: contract.APP_RPC_LIMITS.insertAttributesMax + 1 }, (_, index) => [`data-a${index}`, 'x']));
  const cases = [
    [{ kind: 'element', tag: 'script' }, /files\.write/],
    [{ kind: 'element', tag: 'style' }, /files\.write/],
    [{ kind: 'element', tag: 'Div' }, /not an element/],
    [{ kind: 'element', tag: 'div', props: { a: 'b' } }, /attributes, not props/],
    [{ kind: 'component', name: 'Card', attributes: { a: 'b' } }, /props, not attributes/],
    [{ kind: 'element', tag: 'div', attributes: ['title'] }, /object/],
    [{ kind: 'element', tag: 'div', attributes: { onclick: 'x()' } }, /Event handler/],
    [{ kind: 'component', name: 'Card', props: { onClick: 'x' } }, /Event handler/],
    [{ kind: 'element', tag: 'div', attributes: { 'client:load': '' } }, /Directives/],
    [{ kind: 'element', tag: 'div', attributes: { 'set:html': '<b>' } }, /Directives/],
    [{ kind: 'element', tag: 'div', attributes: { '1x': '' } }, /not an attribute name/],
    [{ kind: 'element', tag: 'div', attributes: { title: 3 } }, /string/],
    [{ kind: 'element', tag: 'div', attributes: { title: 'x'.repeat(contract.APP_RPC_LIMITS.valueCharsMax + 1) } }, /exceeds/],
    [{ kind: 'element', tag: 'div', attributes: tooMany }, /at most 32/],
    [{ kind: 'element', tag: 'div', attributes: { Title: 'a', title: 'b' } }, /twice/],
    [{ kind: 'element', tag: 'div', attributes: { class: 'a {b}' } }, /class names/],
    [{ kind: 'element', tag: 'div', replace: 'n0', position: 'after', anchor: 'n1' }, /leave out position/],
    [{ kind: 'element', tag: 'div', replace: 'has space' }, /node id/],
    [{ kind: 'element', tag: 'div', anchor: 'n1' }, /need a position/],
    [{ kind: 'element', tag: 'div', index: 0 }, /need a position/],
    [{ kind: 'element', tag: 'div', position: 'around', anchor: 'n1' }, /position must be one of/],
    [{ kind: 'element', tag: 'div', position: 'after' }, /needs an anchor/],
    [{ kind: 'element', tag: 'div', position: 'after', anchor: 7 }, /string/],
    [{ kind: 'element', tag: 'div', position: 'after', anchor: 'n1', index: 0 }, /"inside" only/],
    [{ kind: 'element', tag: 'div', position: 'inside', anchor: 'n1', index: -1 }, /at least 0/],
    [{ kind: 'element', tag: 'div', position: 'inside', anchor: 'n1', index: 1.5 }, /whole number/],
    [{ kind: 'element', tag: 'div', position: 'inside', anchor: 'n1', index: '1' }, /whole number/],
    [{ kind: 'element', tag: 'div', position: 'inside', anchor: 'n1', index: contract.APP_RPC_LIMITS.treeNodesMax }, /below/],
  ];
  for (const [params, reason] of cases) {
    const message = refusal(params);
    assert.ok(message !== undefined, `refused: ${JSON.stringify(params).slice(0, 80)}`);
    assert.match(message, reason, JSON.stringify(params).slice(0, 80));
  }
});

// A page: a section holding a heading and an image, a paragraph, and a loop of items.
const element = (id, name, children = []) => ({ id, kind: 'element', name, props: {}, children });
function page() {
  return {
    imports: [{ name: 'Old', path: '../components/Old.astro', quote: "'" }],
    extraFrontmatter: '',
    nodes: [
      element('s', 'section', [
        element('h', 'h1', [{ id: 'ht', kind: 'text', value: 'Title' }]),
        { id: 'img', kind: 'element', name: 'img', props: {}, children: undefined },
      ]),
      element('p', 'p'),
      { id: 'old', kind: 'component', name: 'Old', props: {}, children: undefined },
      { id: 'loop', kind: 'map', head: 'items.map((item) => (', children: [element('li', 'li')] },
    ],
  };
}
const div = { type: 'element', tag: 'div' };
const place = (position, anchorId, index) => placement.anchoredInsertTarget(page(), { position, anchorId, index }, div, []);

test('an anchored insert lands where it was asked, or is refused with the reason', () => {
  assert.deepEqual(place('before', 'p', undefined), { kind: 'placed', target: { parentId: undefined, index: 1 } });
  assert.deepEqual(place('after', 'p', undefined), { kind: 'placed', target: { parentId: undefined, index: 2 } });
  assert.deepEqual(place('after', 'h', undefined), { kind: 'placed', target: { parentId: 's', index: 1 } });
  assert.deepEqual(place('inside', 's', undefined), { kind: 'placed', target: { parentId: 's', index: 2 } }, 'inside, with no index, is last');
  assert.deepEqual(place('inside', 's', 0), { kind: 'placed', target: { parentId: 's', index: 0 } });
  assert.deepEqual(place('inside', 's', 2), { kind: 'placed', target: { parentId: 's', index: 2 } }, 'the end itself is a place');
  assert.deepEqual(place('replace', 'p', undefined), { kind: 'placed', target: { parentId: undefined, index: 1 } }, 'a replacement goes before the node');
  assert.match(place('inside', 's', 3).reason, /past the anchor's 2 children/);
  assert.match(place('inside', 'img', undefined).reason, /cannot hold a <div>/, 'a void element holds nothing');
  assert.match(place('inside', 'p', undefined).reason, /cannot hold a <div>/, 'a <p> cannot hold a <div>');
  assert.match(place('after', 'ht', undefined).reason, /parent cannot hold a <div>/, 'nothing is climbed out of: the place was named');
  assert.match(place('after', 'nope', undefined).reason, /No element has that id/);
  assert.match(place('inside', 'frontmatter', undefined).reason, /No element has that id/);
  const layout = { imports: [], extraFrontmatter: '', nodes: [element('layout', 'Layout')] };
  assert.match(placement.anchoredInsertTarget(layout, { position: 'replace', anchorId: 'layout', index: undefined }, div, []).reason, /in place of/);
  assert.throws(() => place('after', 'p', 0), /Only an insert inside its anchor takes an index/);
});

const refOf = (id) => ({ path: [id], kind: 'element', span: { start: 0, end: 1 } });

test('an insert, a replacement and their imports are one gesture: one request list, one predicted page', () => {
  const shown = page();
  const node = gestures.withStringProps(element('new', 'div'), { title: 'Hi', class: 'big' });
  assert.deepEqual(node.props, { title: { type: 'string', value: 'Hi' }, class: { type: 'string', value: 'big' } });
  const insertOnly = gestures.appInsertGesture(shown, { node, place: { parentId: undefined, index: 1 }, replacedId: undefined, imports: undefined });
  assert.deepEqual(
    insertOnly.request(refOf).map((edit) => [edit.tag, edit.placement, edit.target?.path[0]]),
    [['insert-node', 'before', 'p']],
  );
  assert.deepEqual(
    insertOnly.apply(shown).nodes.map((candidate) => candidate.id),
    ['s', 'new', 'p', 'old', 'loop'],
  );
  assert.deepEqual(insertOnly.apply(shown).imports, shown.imports, 'an insert alone never prunes an import');

  // Inside, at an index: the node's id stands at that index of the anchor's children.
  const target = placement.anchoredInsertTarget(shown, { position: 'inside', anchorId: 's', index: 1 }, div, []);
  const inside = gestures.appInsertGesture(shown, { node, place: target.target, replacedId: undefined, imports: undefined });
  assert.deepEqual(
    inside.apply(shown).nodes[0].children.map((candidate) => candidate.id),
    ['h', 'new', 'img'],
  );

  // Replacing the component: the new node goes in before it, the component comes out, and its now-unused import goes too.
  const swap = gestures.appInsertGesture(shown, { node, place: { parentId: undefined, index: 2 }, replacedId: 'old', imports: undefined });
  assert.deepEqual(
    swap.request(refOf).map((edit) => [edit.tag, edit.target?.path[0]]),
    [
      ['insert-node', 'old'],
      ['remove-node', 'old'],
      ['set-frontmatter', undefined],
    ],
  );
  const swapped = swap.apply(shown);
  assert.deepEqual(
    swapped.nodes.map((candidate) => candidate.id),
    ['s', 'p', 'new', 'loop'],
  );
  assert.deepEqual(swapped.imports, [], 'the replaced component’s import is pruned in the same step');

  // A component that needs an import: the frontmatter write rides in the same gesture.
  const card = { id: 'card', kind: 'component', name: 'Card', props: {}, children: undefined };
  const imports = [...shown.imports, { name: 'Card', path: '../components/Card.astro', quote: "'" }];
  const added = gestures.appInsertGesture(shown, { node: card, place: { parentId: undefined, index: 0 }, replacedId: undefined, imports });
  assert.deepEqual(
    added.request(refOf).map((edit) => edit.tag),
    ['insert-node', 'set-frontmatter'],
  );
  assert.deepEqual(
    added.apply(shown).imports.map((entry) => entry.name),
    ['Old', 'Card'],
  );

  // A node in a loop stands for every repeat: the swap goes out as one rewrite (no request), never half applied.
  const inLoop = gestures.appInsertGesture(shown, { node: element('new', 'li'), place: { parentId: 'loop', index: 0 }, replacedId: 'li', imports: undefined });
  assert.equal(inLoop.request(refOf), undefined);
  assert.deepEqual(
    inLoop.apply(shown).nodes[3].children.map((candidate) => candidate.id),
    ['new'],
  );
  assert.throws(
    () => gestures.appInsertGesture(shown, { node, place: { parentId: undefined, index: 0 }, replacedId: 'new', imports: undefined }),
    /id of its own/,
  );
  assert.throws(() => gestures.withStringProps({ id: 't', kind: 'text', value: 'x' }, { title: 'x' }), /Only an element or a component/);
});

test('Desktop labels the one step an insert pushed, saves once and names the new node; a refusal is passed on unsaved', async () => {
  const past = [];
  const saves = [];
  const requests = [];
  let answer = { applied: true, nodeId: 'new' };
  // The page as it stands once the save has landed: the swap left the new div where n0 was.
  const saved = { editable: true, source: '<div/>', model: { nodes: [element('new', 'div')] } };
  const shell = {
    pageState: { editable: true, source: '<p/>', model: { nodes: [] } },
    pageStateRef: { current: { pageState: saved } },
    historyRef: { current: { past, future: [], lastPush: 0, lastKey: undefined } },
    insertForApp: async (request) => {
      requests.push(request);
      if (answer.applied) {
        past.push({ kind: 'edits' });
      }
      return answer;
    },
    flushSave: async () => saves.push('save'),
  };
  const host = desktop.desktopAppHost({ current: shell });
  assert.equal(host.insertAttributes.kind, 'able');
  assert.equal(host.insertReplace.kind, 'able');
  const insert = {
    item: { kind: 'element', tag: 'div', attributes: { title: 'Hi' } },
    place: { kind: 'replace', nodeId: 'n0' },
    label: 'Swap in a div',
  };
  assert.deepEqual(await host.insertElement.run(insert), { applied: true, nodeId: 'new' }, 'the id names the node on the saved page');
  assert.deepEqual(requests, [{ item: insert.item, place: insert.place }]);
  assert.equal(past.length, 1, 'one undo step');
  assert.equal(past[0].label, 'Swap in a div');
  assert.equal(saves.length, 1, 'one save');
  // A page closed while the save ran no longer has the node: no id is promised.
  shell.pageStateRef.current.pageState = { editable: true, source: '', model: { nodes: [] } };
  assert.deepEqual(await host.insertElement.run({ ...insert, label: undefined }), { applied: true, nodeId: undefined });
  past.length = 1;
  saves.length = 1;
  requests.length = 1;
  answer = { applied: false, reason: 'That p cannot hold a <div>' };
  assert.deepEqual(await host.insertComponent({ ...insert, item: { kind: 'component', name: 'Card', props: {} } }), answer);
  assert.equal(saves.length, 1, 'a refused insert saves nothing');
  assert.equal(past.length, 1);
  shell.pageState = { editable: false, source: '', model: { nodes: [] } };
  assert.deepEqual(await host.insertElement.run(insert), { applied: false, reason: 'The open page cannot be edited' });
  assert.equal(requests.length, 2, 'a page that cannot be edited is never asked');
});
