// Goal: in the real Style panel, committing a value with Enter and clearing it from the label's
// menu change the Color field in the same event, on a big stylesheet, with the save still out: the
// label turns blue (or back) and the swatch shows the new colour before the file is written, no frame
// paints the value from before the press, and once the save lands the field equals the file.
//
// Method: the real StylePanel in jsdom over the shared harness (test/helpers/stylePanelHarness.js),
// on the latency fixture's stylesheet (3,000 rules and the heading's own `h2.heading.text-style-h3`
// rule, test/helpers/e2e/fieldLatencyFixture.js), with the colour set by `h2 { color: var(--text) }`
// so the panel's pick (the heading's own rule) does not set it: a commit adds the declaration. Every
// stylesheet write is held in a queue the test releases, so a field that waited on the save could
// not pass. React applies an event's updates in a microtask after it, before any frame, so "in the
// event of the press" is checked once those microtasks have run. Each painted state of the Color row (label state, swatch fill, field text) is recorded
// on every DOM mutation and animation frame (recordFrames); the check is on the states recorded
// from the press onwards. Events are dispatched; nothing is timed.

const test = require('node:test');
const assert = require('node:assert/strict');
const { mountStylePanel, recordFrames, press, key, fieldRow } = require('../../helpers/stylePanelHarness.js');
const { latencyStylesheet, TARGET } = require('../../helpers/e2e/fieldLatencyFixture.js');

const RULE_COUNT = Number(process.env.RULES ?? 3000);
const COMMITTED = 'rgb(10, 20, 30)';

const FIXTURE = {
  sheets: [{ rel: 'src/styles/patterns.css', css: latencyStylesheet(RULE_COUNT).replace('.heading {\n  color: var(--text);', 'h2 {\n  color: var(--text);') }],
  nodes: [
    {
      id: 'n0',
      kind: 'element',
      name: 'section',
      props: {},
      children: [{ id: 'n1', kind: 'element', name: 'h2', props: { class: { type: 'string', value: 'heading text-style-h3' } }, children: [] }],
    },
  ],
  markup: `<section data-avb-p="n0"><h2 id="${TARGET.elementId}" class="heading text-style-h3" data-avb-p="n1">Latency heading</h2></section>`,
  selectedId: 'n1',
};

// The Color row as a person sees it: whether the label is the picked selector's (blue), the
// swatch's fill and the field's text.
function colorRow(container) {
  const input = container.querySelector('input[data-prop="color"]');
  if (input === null) {
    return { field: 'absent' };
  }
  const row = input.closest('.embed-editor_size-row');
  // The label button: blue (`is-active`) when the picked selector sets it, an orange caption otherwise.
  const label = row?.querySelector('button.u-field-label') ?? row?.querySelector('button.embed-editor_size-label');
  const fill = row?.querySelector('.u-color-swatch-fill');
  return {
    picked: label?.classList.contains('is-active') === true,
    swatch: fill?.style.background ?? '',
    field: input.value,
  };
}

// Every stylesheet write waits here until the test releases it, as a slow disk and dev server would.
function holdWrites(panel) {
  const queue = [];
  let fileCss = FIXTURE.sheets[0].css;
  panel.window.avb.writeStyleFile = (payload) =>
    new Promise((resolve) => {
      queue.push(() => {
        fileCss = payload.css;
        resolve({ ok: true });
      });
    });
  return {
    get held() {
      return queue.length;
    },
    releaseAll: () => queue.splice(0).forEach((release) => release()),
    file: () => fileCss,
  };
}

// Types `value` into the Color field and presses Enter, as a person does.
function commit(panel, value) {
  const input = panel.container.querySelector('input[data-prop="color"]');
  assert.ok(input, 'the Color field is there');
  input.focus();
  const setter = Object.getOwnPropertyDescriptor(panel.window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new panel.window.Event('input', { bubbles: true }));
  key(panel, input, 'Enter');
}

// The microtasks after an event, where React applies its updates; no frame can come between.
const afterEvent = () => new Promise((resolve) => queueMicrotask(resolve));

async function mountOnHeading() {
  const panel = await mountStylePanel(FIXTURE);
  await panel.settle();
  const row = colorRow(panel.container);
  assert.notEqual(row.field, 'absent', 'the heading shows a Color field');
  return panel;
}

test('Enter shows the committed colour in the same event, before the save, and settles on the file', async (context) => {
  const panel = await mountOnHeading();
  context.after(() => panel.unmount());
  const writes = holdWrites(panel);
  const before = colorRow(panel.container);
  assert.equal(before.picked, false, 'the colour comes from .heading, not the picked selector');
  const recording = recordFrames(panel, colorRow);
  commit(panel, COMMITTED);
  await afterEvent();
  const atPress = colorRow(panel.container);
  assert.equal(atPress.picked, true, 'the label is the picked selector’s in the event of the press');
  assert.equal(atPress.swatch, COMMITTED, 'the swatch shows the committed colour in the event of the press');
  await panel.settle();
  assert.ok(writes.held > 0, 'the save is still out');
  assert.equal(colorRow(panel.container).picked, true, 'and the field still shows the commit');
  writes.releaseAll();
  await panel.settle();
  const frames = recording.stop();
  const afterPress = frames.slice(frames.findIndex((frame) => frame.picked === true));
  assert.ok(afterPress.length > 0, 'the commit was painted');
  assert.ok(
    afterPress.every((frame) => frame.picked === true && frame.swatch === COMMITTED),
    `no frame after the press went back: ${JSON.stringify(afterPress)}`,
  );
  assert.match(writes.file(), /\{[^}]*color:\s*rgb\(10, 20, 30\);[^}]*\}/, 'the file holds the committed colour');
});

test('Clear shows the next colour in the cascade in the same event, before the save, and settles on the file', async (context) => {
  const panel = await mountOnHeading();
  context.after(() => panel.unmount());
  let writes = holdWrites(panel);
  commit(panel, COMMITTED);
  await panel.settle();
  writes.releaseAll();
  await panel.settle();
  panel.container.querySelector('input[data-prop="color"]').blur();
  await panel.settle();
  assert.equal(colorRow(panel.container).picked, true, 'the picked selector sets the colour');
  writes = holdWrites(panel);
  const recording = recordFrames(panel, colorRow);
  const label = fieldRow(panel, 'Color')?.querySelector('.u-field-label.is-active');
  assert.ok(label, 'the Color label is the picked selector’s');
  await panel.user('open the Clear menu', () => press(panel, label));
  const item = globalThis.document.querySelector('.u-field-label-menu [role="menuitem"]');
  assert.ok(item, 'the Clear menu opened');
  press(panel, item);
  await afterEvent();
  const atPress = colorRow(panel.container);
  assert.equal(atPress.picked, false, 'the label lets go in the event of the press');
  assert.notEqual(atPress.swatch, COMMITTED, 'the swatch no longer shows the cleared colour');
  assert.equal(atPress.field, 'var(--text)', 'the field shows the declaration under it, never an empty field');
  await panel.settle();
  assert.ok(writes.held > 0, 'the save is still out');
  writes.releaseAll();
  await panel.settle();
  const frames = recording.stop();
  const afterPress = frames.slice(frames.findIndex((frame) => frame.picked === false));
  assert.ok(
    afterPress.every((frame) => frame.picked === false && frame.field === 'var(--text)'),
    `no frame after the press showed the cleared value: ${JSON.stringify(afterPress)}`,
  );
  assert.doesNotMatch(writes.file(), /rgb\(10, 20, 30\)/, 'the file no longer holds the cleared colour');
});
