// Goal: re-rendering the Style panel with the same data publishes nothing new to the host.
// The host compares every field by identity and wakes every subscriber on a change; the panel
// used to copy its class lists on each render, so any re-render of the app around it (a hover
// on the canvas, a toolbar update) re-rendered every field's computed-value hook.
// Method: mount the real StylePanel through the shared harness, re-render it with equal but
// newly built lists, and check the published lists keep their identity; then change a list
// and check the change is published.

const test = require('node:test');
const assert = require('node:assert/strict');
const { mountStylePanel } = require('../../helpers/stylePanelHarness.js');

const FIXTURE = {
  sheets: [{ rel: 'src/styles/base.css', css: '.plain { color: red; }' }],
  nodes: [{ id: 'n1', kind: 'element', name: 'p', props: { class: { type: 'string', value: 'plain' } }, children: [] }],
  markup: '<p class="plain" data-avb-p="n1">a</p>',
  selectedId: 'n1',
};

test('equal lists keep their identity across renders, and a changed one is published', async (context) => {
  const panel = await mountStylePanel(FIXTURE);
  context.after(() => panel.unmount());
  panel.rerender({ projectClasses: ['plain', 'card'] });
  await panel.settle();
  const rendered = panel.host().renderedClasses;
  const project = panel.host().projectClasses;
  const nodes = panel.host().nodes;
  panel.rerender({ renderedClasses: [...rendered], projectClasses: ['plain', 'card'] });
  await panel.settle();
  assert.equal(panel.host().renderedClasses, rendered, 'the same rendered classes keep their array');
  assert.equal(panel.host().projectClasses, project, 'the same project classes keep their array');
  assert.equal(panel.host().nodes, nodes, 'the same page model keeps its array');
  panel.rerender({ projectClasses: ['plain', 'card', 'hero'] });
  await panel.settle();
  assert.deepEqual(panel.host().projectClasses, ['plain', 'card', 'hero'], 'a changed list is published');
});
