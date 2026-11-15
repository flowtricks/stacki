// Goal: while the Style panel holds the previous element on screen across a switch (StylePanel
// useSwitchHold: the app has already selected the next element, the canvas has not answered
// for it yet), every edit lands on the element the person SEES. A value set from a control, a
// Clear, and the element writes (add or remove a class, remove an attribute, a first style
// block, the inline style) change that element and nothing else; a write for an element the
// tree no longer holds as the same element is refused in plain words and writes nothing; and
// once the next element is shown, writes go to it.
// Method: the real StylePanel in jsdom over the shared harness (test/helpers/stylePanelHarness.js),
// with the canvas replies held, so the hold lasts as long as the test wants (the harness never
// fires deadlines: this is also "the canvas never answers"). The element writes are the app's
// node-addressed callbacks over an in-memory document of class lists; stylesheet writes are the
// harness's recorded file writes. Events are dispatched; nothing is timed.

const test = require('node:test');
const assert = require('node:assert/strict');
const { mountStylePanel, press, fieldRow } = require('../../helpers/stylePanelHarness.js');

const FIXTURE = {
  sheets: [
    {
      rel: 'src/styles/base.css',
      css: ['.plain { font-weight: 500; }', '.title { font-weight: 700; }'].join('\n'),
    },
  ],
  nodes: [
    {
      id: 'n0',
      kind: 'element',
      name: 'section',
      props: {},
      children: [
        { id: 'n1', kind: 'element', name: 'p', props: { class: { type: 'string', value: 'plain' } }, children: [] },
        { id: 'n2', kind: 'element', name: 'h2', props: { class: { type: 'string', value: 'title' } }, children: [] },
      ],
    },
  ],
  markup: '<section data-avb-p="n0"><p class="plain" data-avb-p="n1">a</p><h2 class="title" data-avb-p="n2">b</h2></section>',
  selectedId: 'n1',
};

// The app's element writes over a document of class lists and attributes, by node id, the way
// AppPanes addresses app.addClassToNode and its siblings.
function createDocument() {
  const elements = new Map([
    ['n1', { classes: ['plain'], attributes: { 'data-x': '1' }, style: undefined, blocks: 0 }],
    ['n2', { classes: ['title'], attributes: { 'data-x': '1' }, style: undefined, blocks: 0 }],
  ]);
  const applied = { tag: 'applied' };
  const edit = (nodeId, change) => {
    const element = elements.get(nodeId);
    assert.ok(element, `the app writes to a node it has (${nodeId})`);
    change(element);
    return Promise.resolve(applied);
  };
  return {
    snapshot: () => JSON.stringify([...elements]),
    of: (nodeId) => elements.get(nodeId),
    props: {
      onAddClass: (name, _placement, nodeId) => edit(nodeId, (element) => element.classes.push(name)),
      onRemoveClass: (name, nodeId) => edit(nodeId, (element) => element.classes.splice(element.classes.indexOf(name), 1)),
      onRemoveAttribute: (name, nodeId) => edit(nodeId, (element) => delete element.attributes[name]),
      onAddStyleBlock: (_request, nodeId) =>
        edit(nodeId, (element) => {
          element.blocks += 1;
        }),
      onSetInlineStyle: (nodeId, style) => {
        void edit(nodeId, (element) => {
          element.style = style?.value;
        });
      },
    },
  };
}

// The panel holding n1 while the app has selected n2, with every canvas reply held.
async function heldSwitch() {
  const panel = await mountStylePanel(FIXTURE);
  const document = createDocument();
  panel.rerender(document.props);
  await panel.settle();
  panel.bridge.mode = 'held';
  await panel.data('select the heading, canvas answers held', () => panel.select('n2'));
  assert.equal(panel.props.node.id, 'n2', 'the app has selected the heading');
  assert.equal(panel.host().selectedId, 'n1', 'and the panel still shows the paragraph');
  return { panel, document };
}

const lastCss = (panel) => panel.writes.at(-1)?.css ?? '';

test('element writes during a hold land on the shown element only', async (context) => {
  const { panel, document } = await heldSwitch();
  context.after(() => panel.unmount());
  const beforeHeading = JSON.stringify(document.of('n2'));
  const host = panel.host();
  assert.deepEqual(await host.addClass('extra', { kind: 'end' }), { tag: 'applied' });
  assert.deepEqual(await host.removeClass('plain'), { tag: 'applied' });
  assert.deepEqual(await host.removeAttribute('data-x'), { tag: 'applied' });
  assert.deepEqual(await host.addStyleBlock({ css: '.extra {}\n', className: undefined, placement: { kind: 'end' } }), { tag: 'applied' });
  host.setInlineStyle(host.selectedId, { type: 'string', value: 'color: red' });
  await panel.settle();
  assert.deepEqual(document.of('n1'), { classes: ['extra'], attributes: {}, style: 'color: red', blocks: 1 }, 'the paragraph took every edit');
  assert.equal(JSON.stringify(document.of('n2')), beforeHeading, 'the heading, selected in the app, was not touched');
});

test('a value set and a Clear during a hold change the shown element’s rule only', async (context) => {
  const { panel } = await heldSwitch();
  context.after(() => panel.unmount());
  const label = fieldRow(panel, 'Weight')?.querySelector('.u-field-label.is-active');
  assert.ok(label, 'the paragraph’s Weight is set by .plain');
  await panel.user('open the Clear menu', () => press(panel, label));
  const item = document.querySelector('.u-field-label-menu [role="menuitem"]');
  assert.ok(item, 'the Clear menu opened');
  await panel.user('pick Clear', () => press(panel, item));
  const css = lastCss(panel);
  assert.ok(!/\.plain\s*\{[^}]*font-weight/.test(css), 'the paragraph’s declaration is cleared');
  assert.match(css, /\.title\s*\{[^}]*font-weight:\s*700/, 'the heading’s rule is untouched');
  assert.equal(panel.host().selectedId, 'n1', 'all while the paragraph is still shown');
});

test('a write for an element the tree no longer holds is refused and writes nothing', async (context) => {
  const { panel, document } = await heldSwitch();
  context.after(() => panel.unmount());
  // An insertion during the hold: node ids are tree paths, so n1 is now another element.
  const moved = structuredClone(FIXTURE.nodes);
  moved[0].children[0] = { id: 'n1', kind: 'element', name: 'div', props: { class: { type: 'string', value: 'inserted' } }, children: [] };
  panel.rerender({ model: { nodes: moved } });
  await panel.settle();
  const before = document.snapshot();
  const outcome = await panel.host().addClass('extra', { kind: 'end' });
  assert.equal(outcome.tag, 'refused');
  assert.equal(outcome.message, 'This element changed while the next one was loading, so nothing was written. Try again.');
  panel.host().setInlineStyle('n1', { type: 'string', value: 'color: red' });
  await panel.settle();
  assert.equal(document.snapshot(), before, 'nothing was written, to either element');
});

test('once the next element is shown, writes go to it', async (context) => {
  const { panel, document } = await heldSwitch();
  context.after(() => panel.unmount());
  panel.bridge.mode = 'immediate';
  await panel.data('the canvas answers', () => panel.bridge.release());
  assert.equal(panel.host().selectedId, 'n2', 'the heading is shown');
  await panel.host().addClass('extra', { kind: 'end' });
  assert.deepEqual(document.of('n2').classes, ['title', 'extra']);
  assert.deepEqual(document.of('n1').classes, ['plain'], 'the paragraph is untouched');
});
