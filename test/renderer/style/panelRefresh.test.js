// Goal: the Style panel's matched selectors follow the page around the selected element. Deleting
// the paragraph after a heading makes the heading the last child, so `.card-body > :where(:last-child)`
// now matches it; the panel shows that chip without the element being reselected, keeps the
// selector the person picked, never empties the chip list between states, and writes nothing.
// Method: the real StylePanel through the shared harness over one stylesheet; the fake canvas is a
// jsdom document that answers each query with element.matches. The page changes (the paragraph is
// removed from the canvas document, the model drops its node) exactly as the frame and the app do
// on a delete, and the canvas announces a rendering, which is the signal the panel re-asks on.
// The rule is written `:last-child` here: jsdom's selector engine answers `:where(:last-child)` from a
// cache that a removal does not clear, so the owner's `:where` form is checked in Chromium by hand.
const test = require('node:test');
const assert = require('node:assert/strict');
const { mountStylePanel, press } = require('../../helpers/stylePanelHarness.js');

const FIXTURE = {
  sheets: [
    {
      rel: 'src/styles/global.css',
      css: '.card-body > :last-child { margin-bottom: 0; }\n.heading { color: red; }\n.heading:where(.big) { color: blue; }\n.card-body > h2 { font-size: 2rem; }',
    },
  ],
  nodes: [
    {
      id: '0',
      kind: 'element',
      name: 'div',
      props: { class: { type: 'string', value: 'card-body' } },
      children: [
        { id: '0.0', kind: 'element', name: 'h2', props: { class: { type: 'string', value: 'heading' } }, children: [] },
        { id: '0.1', kind: 'element', name: 'p', props: {}, children: [] },
      ],
    },
  ],
  markup: '<div class="card-body" data-avb-p="0"><h2 class="heading" data-avb-p="0.0">H</h2><p data-avb-p="0.1">P</p></div>',
  selectedId: '0.0',
};

const chips = (panel) => [...panel.container.querySelectorAll('.embed-editor_selector-chip')].map((chip) => chip.textContent.replace(/\s+/g, ' ').trim());
const hasLastChild = (panel) => chips(panel).some((text) => text.includes(':last-child'));
let counter = 0;

async function deleteParagraph(panel) {
  panel.page.window.document.querySelector('[data-avb-p="0.1"]').remove();
  const [card] = panel.props.model.nodes;
  const next = [{ ...card, children: card.children.slice(0, 1) }];
  panel.rerender({ model: { nodes: next } });
  // The canvas announces the rendering the frame produced.
  panel.noteRendered();
  await panel.settle();
}

test('the :last-child chip appears after the sibling is deleted, without reselecting', async (context) => {
  const panel = await mountStylePanel(FIXTURE);
  context.after(() => panel.unmount());
  counter += 1;
  panel.rerender({ project: { path: `/fixture-refresh-${counter}` } });
  await panel.settle();
  assert.equal(hasLastChild(panel), false, 'the heading is not the last child yet');
  assert.ok(chips(panel).length > 0, 'the well has its chips');
  await deleteParagraph(panel);
  assert.equal(hasLastChild(panel), true, 'the new match is listed');
  assert.deepEqual(panel.writes, [], 'a refresh writes nothing');
});

test('the chip list is never empty between the two states', async (context) => {
  const panel = await mountStylePanel(FIXTURE);
  context.after(() => panel.unmount());
  counter += 1;
  panel.rerender({ project: { path: `/fixture-refresh-${counter}` } });
  await panel.settle();
  const seen = [];
  const observer = new panel.window.MutationObserver(() => seen.push(chips(panel).length));
  observer.observe(panel.container, { childList: true, subtree: true, characterData: true });
  await deleteParagraph(panel);
  observer.disconnect();
  assert.ok(seen.length === 0 || seen.every((count) => count > 0), `the chips were empty in a frame: ${seen.join(',')}`);
});

test('the selector the person picked survives the recompute', async (context) => {
  const panel = await mountStylePanel(FIXTURE);
  context.after(() => panel.unmount());
  counter += 1;
  panel.rerender({ project: { path: `/fixture-refresh-${counter}` } });
  await panel.settle();
  const other = [...panel.container.querySelectorAll('.embed-editor_selector-chip')].find((chip) => !chip.classList.contains('is-active'));
  assert.ok(other, 'there is a chip to pick');
  const pickedText = other.textContent;
  await panel.user('pick a selector', () => press(panel, other));
  const active = () => [...panel.container.querySelectorAll('.embed-editor_selector-chip.is-active')].map((chip) => chip.textContent);
  assert.deepEqual(active(), [pickedText]);
  await deleteParagraph(panel);
  assert.deepEqual(active(), [pickedText], 'the manual pick is still the active selector');
});
