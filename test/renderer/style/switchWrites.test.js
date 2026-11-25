// Goal: across a switch, every edit lands on the element the app has selected, which is the
// element the Style panel shows from the render that receives the selection. With the canvas
// not yet answered for the next element, a value set and the element writes (add or remove a
// class, remove an attribute, a first style block, the inline style) change that element and
// nothing else, and the previous element is untouched. (The panel used to hold the previous
// element on screen through the wait; the edits then had to be pointed back at it. It no
// longer holds: test/renderer/style/selectionStaleFrames.test.js says why.)
// Method: the real StylePanel in jsdom over the shared harness (test/helpers/stylePanelHarness.js),
// with the canvas replies held, so the wait lasts as long as the test wants. The element writes
// are the app's node-addressed callbacks over an in-memory document of class lists; stylesheet
// writes are the harness's recorded file writes. Events are dispatched; nothing is timed.

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

// The app has selected the heading after the paragraph, with every canvas reply held.
async function switchWithAnswersHeld() {
  const panel = await mountStylePanel(FIXTURE);
  const document = createDocument();
  panel.rerender(document.props);
  await panel.settle();
  panel.bridge.mode = 'held';
  await panel.data('select the heading, canvas answers held', () => panel.select('n2'));
  assert.equal(panel.props.node.id, 'n2', 'the app has selected the heading');
  assert.equal(panel.host().selectedId, 'n2', 'and the panel shows it at once');
  return { panel, document };
}

test('element writes before the canvas answers land on the selected element only', async (context) => {
  const { panel, document } = await switchWithAnswersHeld();
  context.after(() => panel.unmount());
  const beforeParagraph = JSON.stringify(document.of('n1'));
  const host = panel.host();
  assert.deepEqual(await host.addClass('extra', { kind: 'end' }), { tag: 'applied' });
  assert.deepEqual(await host.removeClass('title'), { tag: 'applied' });
  assert.deepEqual(await host.removeAttribute('data-x'), { tag: 'applied' });
  assert.deepEqual(await host.addStyleBlock({ css: '.extra {}\n', className: undefined, placement: { kind: 'end' } }), { tag: 'applied' });
  host.setInlineStyle(host.selectedId, { type: 'string', value: 'color: red' });
  await panel.settle();
  assert.deepEqual(document.of('n2'), { classes: ['extra'], attributes: {}, style: 'color: red', blocks: 1 }, 'the heading took every edit');
  assert.equal(JSON.stringify(document.of('n1')), beforeParagraph, 'the paragraph, selected before, was not touched');
});

test('once the canvas answers, writes still go to the selected element', async (context) => {
  const { panel, document } = await switchWithAnswersHeld();
  context.after(() => panel.unmount());
  panel.bridge.mode = 'immediate';
  await panel.data('the canvas answers', () => panel.bridge.release());
  const label = fieldRow(panel, 'Weight')?.querySelector('.u-field-label.is-active');
  assert.ok(label, 'the heading’s Weight is set by .title');
  await panel.user('open the Clear menu', () => press(panel, label));
  const item = globalThis.document.querySelector('.u-field-label-menu [role="menuitem"]');
  assert.ok(item, 'the Clear menu opened');
  await panel.user('pick Clear', () => press(panel, item));
  const css = panel.writes.at(-1)?.css ?? '';
  assert.ok(!/\.title\s*\{[^}]*font-weight/.test(css), 'the heading’s declaration is cleared');
  assert.match(css, /\.plain\s*\{[^}]*font-weight:\s*500/, 'the paragraph’s rule is untouched');
  await panel.host().addClass('extra', { kind: 'end' });
  assert.deepEqual(document.of('n2').classes, ['title', 'extra']);
  assert.deepEqual(document.of('n1').classes, ['plain'], 'the paragraph is untouched');
});
