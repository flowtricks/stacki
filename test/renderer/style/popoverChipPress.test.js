// Goal: a variable picker opened by pressing a chip right after an element switch stays open
// until the person closes it. The user's report: on a Heading, the first press on the Weight
// chip opened the picker and it closed by itself; a second press stayed. The cause found: the
// edited selector can change with no one pressing anything (the default pick settles when the
// canvas reports classes the page added at runtime), and the Typography section was keyed by
// that selector, so the change remounted the section and every picker and menu in it with it.
// The sections are no longer keyed (model/selectorScope.ts keeps their per-selector state).
// Method: the real StylePanel through the shared harness. Each chip is pressed the way a
// pointer does (pointerdown, mousedown, mouseup, click) right after a switch, with the canvas
// replies held and released in seeded orders around the press, then the page adds a class
// that moves the default pick, scrolls that move nothing and focus moves arrive, and the
// popover log (which records whether a popover was dismissed or unmounted, and in a person's
// step or the panel's own) must hold no close outside a person's step. The large-editor path
// (a chip wider than its field) and the label's Clear menu are held to the same rule, and
// seeded walks mix switches, presses and the panel's own events. Waits on long timers use
// Node's timers module directly: jsdom's window and the panel share the global timer ids.

const test = require('node:test');
const assert = require('node:assert/strict');
const timers = require('node:timers');
const { mountStylePanel, press, key, fieldRow, seededRandom } = require('../../helpers/stylePanelHarness.js');

const CSS = [
  ':root { --display-font-family: "Inter", sans-serif; --display-font-weight: 600; --text-size: 3rem; --tracking: 0.02em; --brand: #0059ff; }',
  '.plain { color: red; }',
  '.heading { font-family: var(--display-font-family); font-weight: var(--display-font-weight); font-size: var(--text-size); letter-spacing: var(--tracking); color: var(--brand); }',
  // Styled, so when the page adds it at runtime the default pick moves to it.
  '.is-ready { font-weight: var(--display-font-weight); font-size: var(--text-size); }',
].join('\n');

const FIXTURE = {
  sheets: [{ rel: 'src/styles/base.css', css: CSS }],
  nodes: [
    { id: 'n1', kind: 'element', name: 'p', props: { class: { type: 'string', value: 'plain' } }, children: [] },
    { id: 'n2', kind: 'element', name: 'h1', props: { class: { type: 'string', value: 'heading' } }, children: [] },
  ],
  markup: '<p class="plain" data-avb-p="n1">a</p><h1 class="heading" data-avb-p="n2">b</h1>',
  selectedId: 'n1',
};

const CHIP_FIELDS = ['Font', 'Weight', 'Size', 'Color', 'Letter spacing'];
const picker = () => document.querySelector('.embed-editor_varpicker') ?? undefined;
// The chip in the field a caption labels: the nearest box around the caption that holds one.
function chipOf(panel, caption) {
  const labels = [...panel.container.querySelectorAll('.u-field-label, label')].filter((element) => element.textContent.trim() === caption);
  for (const label of labels) {
    for (let box = label.parentElement, depth = 0; box !== null && depth < 4; box = box.parentElement, depth += 1) {
      const chip = box.querySelector('[data-chip]');
      if (chip !== null) {
        return chip;
      }
    }
  }
  return undefined;
}
const wait = (milliseconds) => new Promise((resolve) => timers.setTimeout(resolve, milliseconds));
const userCloses = (panel) => panel.popovers.events.filter((event) => event.kind === 'close' && event.cause === 'user');

// The panel's own events after a press: none is a reason to close anything.
async function panelEvents(panel, { seed }) {
  await panel.data('the canvas answers', () => panel.bridge.release({ order: 'shuffle', seed }));
  panel.bridge.mode = 'immediate';
  await panel.data('the page adds a class that moves the default pick', () => panel.setPageClasses('n2', ['is-ready', 'heading']));
  await panel.data('the rematch is answered', () => wait(100));
  const picked = [...panel.container.querySelectorAll('.embed-editor_selector-chip.is-active')].map((chip) => chip.textContent);
  assert.deepEqual(picked, ['.is-ready'], 'the default pick moved, with no one pressing anything');
  await panel.data('a scroll that moves nothing', () => panel.container.dispatchEvent(new panel.window.Event('scroll')));
  await panel.data('focus leaves and returns', () => {
    panel.window.dispatchEvent(new panel.window.Event('blur'));
    panel.window.dispatchEvent(new panel.window.Event('focus'));
  });
  await panel.data('the focus resync and polls run', () => wait(1700));
}

for (const caption of CHIP_FIELDS) {
  test(`the ${caption} chip's picker, opened right after a switch, stays open`, async (context) => {
    const panel = await mountStylePanel(FIXTURE);
    context.after(() => panel.unmount());
    panel.bridge.mode = 'held';
    await panel.user('switch to the heading', () => panel.select('n2'));
    for (let round = 0; round < 32 && chipOf(panel, caption) === undefined && panel.bridge.held > 0; round += 1) {
      await panel.data('an answer lands', () => panel.bridge.release({ order: 'reverse', count: 1 }));
    }
    const chip = chipOf(panel, caption);
    assert.ok(chip, `the ${caption} field shows its variable chip`);
    await panel.user(`press the ${caption} chip`, () => press(panel, chip));
    assert.ok(picker(), 'the press opened the picker');
    await panelEvents(panel, { seed: caption.length });
    assert.deepEqual(panel.popovers.spontaneousCloses(), [], 'no popover closed without a person');
    assert.ok(picker(), 'the picker is still open');
    await panel.user('press Escape', () => key(panel, document.activeElement ?? document.body, 'Escape'));
    assert.equal(picker(), undefined, 'Escape closes it');
    assert.equal(userCloses(panel).length, 1, 'once, by the person');
  });
}

test('the large editor opened from a chip wider than its field stays open, with its picker', async (context) => {
  const panel = await mountStylePanel(FIXTURE);
  context.after(() => panel.unmount());
  // The chip's field is narrower than its value: the press opens the large editor and its chooser.
  const editorClass = 'embed-editor_varconnect-editor';
  const prototype = panel.window.Element.prototype;
  const clientWidth = Object.getOwnPropertyDescriptor(prototype, 'clientWidth');
  const scrollWidth = Object.getOwnPropertyDescriptor(prototype, 'scrollWidth');
  Object.defineProperty(prototype, 'clientWidth', { configurable: true, get: () => 80 });
  Object.defineProperty(prototype, 'scrollWidth', {
    configurable: true,
    get() {
      return this.classList.contains(editorClass) ? 200 : 80;
    },
  });
  context.after(() => {
    Object.defineProperty(prototype, 'clientWidth', clientWidth);
    Object.defineProperty(prototype, 'scrollWidth', scrollWidth);
  });
  await panel.user('switch to the heading', () => panel.select('n2'));
  await panel.user('press the Weight chip', () => press(panel, chipOf(panel, 'Weight')));
  const large = () => document.querySelector('.var-custom') ?? undefined;
  assert.ok(large(), 'the large editor opened');
  assert.ok(picker(), 'with its picker');
  await panelEvents(panel, { seed: 3 });
  assert.ok(large(), 'the large editor is still open');
  assert.ok(picker(), 'and its picker');
  assert.deepEqual(panel.popovers.spontaneousCloses(), []);
});

test('the Clear menu opened right after a switch survives the default pick moving', async (context) => {
  const panel = await mountStylePanel(FIXTURE);
  context.after(() => panel.unmount());
  await panel.user('switch to the heading', () => panel.select('n2'));
  const label = fieldRow(panel, 'Weight')?.querySelector('.u-field-label.is-active');
  assert.ok(label, 'the Weight label is set');
  await panel.user('open the Clear menu', () => press(panel, label));
  assert.ok(document.querySelector('.u-field-label-menu'), 'it opened');
  await panelEvents(panel, { seed: 5 });
  assert.deepEqual(panel.popovers.spontaneousCloses(), []);
  assert.ok(document.querySelector('.u-field-label-menu'), 'it is still open');
});

// Seeded walks: switch then press a chip, with the panel's own events interleaved at random.
for (const seed of [2, 9, 31]) {
  test(`switch-then-press walks never close a popover without a person (seed ${seed})`, async (context) => {
    const panel = await mountStylePanel(FIXTURE);
    context.after(() => panel.unmount());
    const random = seededRandom(seed);
    const pick = (items) => items[Math.floor(random() * items.length)];
    const STEPS_MAX = 60;
    for (let step = 0; step < STEPS_MAX; step += 1) {
      const roll = random();
      if (roll < 0.25) {
        panel.bridge.mode = random() < 0.5 ? 'held' : 'immediate';
        await panel.user(`switch ${step}`, () => panel.select(pick(['n1', 'n2'])));
      } else if (roll < 0.5) {
        const chip = chipOf(panel, pick(CHIP_FIELDS));
        if (chip !== undefined && picker() === undefined) {
          await panel.user(`press a chip ${step}`, () => press(panel, chip));
        }
      } else if (roll < 0.55) {
        if (picker() !== undefined) {
          await panel.user(`escape ${step}`, () => key(panel, document.activeElement ?? document.body, 'Escape'));
        }
      } else if (roll < 0.7) {
        await panel.data(`answers ${step}`, () => panel.bridge.release({ order: 'shuffle', seed: seed + step, count: 1 + Math.floor(random() * 3) }));
      } else if (roll < 0.8) {
        await panel.data(`runtime class ${step}`, () => panel.setPageClasses('n2', random() < 0.5 ? ['is-ready', 'heading'] : ['heading']));
      } else if (roll < 0.9) {
        await panel.data(`scroll ${step}`, () => panel.container.dispatchEvent(new panel.window.Event('scroll')));
      } else {
        await panel.data(`focus ${step}`, () => {
          panel.window.dispatchEvent(new panel.window.Event('blur'));
          panel.window.dispatchEvent(new panel.window.Event('focus'));
        });
      }
      assert.deepEqual(panel.popovers.spontaneousCloses(), [], `seed ${seed}, step ${step}: nothing closed without a person`);
    }
  });
}
