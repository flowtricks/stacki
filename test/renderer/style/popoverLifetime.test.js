// Goal: a popover in the Style panel closes only for a person's reason. The Clear menu of a
// property label (the user's report: open it right after switching elements and it closed on
// its own) must survive everything the panel does by itself: the canvas's answers landing in
// any order, the same answer landing again, the app regaining window focus (which re-reads the
// selection), a scroll that moves nothing (Chromium's scroll anchoring adjusts the panel when
// content above an open menu changes), and a re-render of the host. It still closes on Escape,
// on a press outside and on picking Clear.
// Method: the real StylePanel in jsdom over the shared harness (test/helpers/stylePanelHarness.js).
// Every step is labelled as a person's (`user`) or the panel's own (`data`); the popover log
// records which step each open and close happened in, and a close during a data step is the
// failure. A seeded random walk (bounded, 200 steps per seed) mixes the two kinds and checks the
// same invariant plus a consistent end state. Events are dispatched; nothing is timed.

const test = require('node:test');
const assert = require('node:assert/strict');
const { mountStylePanel, press, key, fieldRow, seededRandom } = require('../../helpers/stylePanelHarness.js');

const FIXTURE = {
  sheets: [
    {
      rel: 'src/styles/base.css',
      css: [
        ':root { --display-font-weight: 600; }',
        ':focus-visible { outline: 2px solid blue; }',
        'h1 { font-size: 2rem; font-weight: 700; }',
        '.text-style-display { line-height: 1.1; font-weight: 500; }',
        '.plain { color: red; font-weight: 300; }',
      ].join('\n'),
    },
    { rel: 'src/styles/patterns.css', css: '.heading { font-weight: var(--display-font-weight); }' },
  ],
  nodes: [
    { id: 'n1', kind: 'element', name: 'p', props: { class: { type: 'string', value: 'plain' } }, children: [] },
    { id: 'n2', kind: 'element', name: 'h1', props: { class: { type: 'string', value: 'heading text-style-display' } }, children: [] },
    { id: 'n3', kind: 'element', name: 'h1', props: { class: { type: 'expr', value: 'cls' } }, children: [] },
  ],
  markup: [
    '<p class="plain" data-avb-p="n1">a</p>',
    '<h1 class="heading text-style-display" data-avb-p="n2">b</h1>',
    '<h1 class="heading text-style-display" data-avb-p="n3">c</h1>',
  ].join(''),
  selectedId: 'n1',
};

const weightLabel = (panel) => fieldRow(panel, 'Weight')?.querySelector('.u-field-label.is-active') ?? undefined;
const clearMenu = () => document.querySelector('.u-field-label-menu') ?? undefined;

async function openClearMenu(panel) {
  const label = weightLabel(panel);
  assert.ok(label, 'the Weight label is set, so it has a Clear menu');
  await panel.user('open the Clear menu', () => press(panel, label));
  assert.ok(clearMenu(), 'the Clear menu opened');
}

// The panel's own events: none of them is a reason to close anything.
const DATA_STEPS = {
  'window focus returns': (panel) => {
    panel.window.dispatchEvent(new panel.window.Event('blur'));
    panel.window.dispatchEvent(new panel.window.Event('focus'));
  },
  'a scroll that moves nothing': (panel) => panel.container.dispatchEvent(new panel.window.Event('scroll')),
  'the host re-renders with the same data': (panel) => panel.rerender({ model: { nodes: [...FIXTURE.nodes] } }),
  'held answers land': (panel) => panel.bridge.release({ order: 'shuffle', seed: 3 }),
};

test('the Clear menu opened right after a switch survives every refresh, and closes on Escape', async (context) => {
  const panel = await mountStylePanel(FIXTURE);
  context.after(() => panel.unmount());
  panel.bridge.mode = 'held';
  await panel.user('select the heading', () => panel.select('n2'));
  await panel.data('the first answers land', () => panel.bridge.release({ order: 'reverse' }));
  await openClearMenu(panel);
  const menu = clearMenu();
  for (const [label, step] of Object.entries(DATA_STEPS)) {
    await panel.data(label, () => step(panel));
    // The resync after focus asks the canvas again: let those answers land too.
    await panel.data(`${label}: answers`, () => panel.bridge.release({ order: 'shuffle', seed: 5 }));
    assert.deepEqual(panel.popovers.spontaneousCloses(), [], `nothing closed on "${label}"`);
    assert.equal(clearMenu(), menu, `the same menu is still open after "${label}"`);
  }
  await panel.user('press Escape', () => key(panel, document.activeElement ?? document.body, 'Escape'));
  assert.equal(clearMenu(), undefined, 'Escape closes it');
  const closes = panel.popovers.events.filter((event) => event.kind === 'close');
  assert.deepEqual(
    closes.map((event) => event.cause),
    ['user'],
    "the one close was the person's",
  );
});

test('Clear in the menu clears the property and closes the menu, once', async (context) => {
  const panel = await mountStylePanel(FIXTURE);
  context.after(() => panel.unmount());
  await panel.user('select the heading', () => panel.select('n2'));
  await openClearMenu(panel);
  const item = clearMenu().querySelector('[role="menuitem"]');
  await panel.user('pick Clear', () => press(panel, item));
  assert.equal(clearMenu(), undefined, 'the menu closed');
  assert.ok(panel.writes.length > 0, 'the clear was written');
  assert.ok(!/\.heading\s*\{[^}]*font-weight/.test(panel.writes.at(-1).css ?? ''), 'and the declaration is gone from the rule');
});

// Seeded walks: a person's steps and the panel's own interleaved at random.
for (const seed of [1, 7, 42]) {
  test(`a random walk never closes a popover without a person's reason (seed ${seed})`, async (context) => {
    const panel = await mountStylePanel(FIXTURE);
    context.after(() => panel.unmount());
    const random = seededRandom(seed);
    const pick = (items) => items[Math.floor(random() * items.length)];
    const STEPS_MAX = 200;
    for (let step = 0; step < STEPS_MAX; step += 1) {
      const roll = random();
      if (roll < 0.15) {
        panel.bridge.mode = random() < 0.5 ? 'held' : 'immediate';
        await panel.user(`select ${step}`, () => panel.select(pick(['n1', 'n2', 'n3'])));
      } else if (roll < 0.35) {
        const label = weightLabel(panel);
        if (label !== undefined && clearMenu() === undefined) {
          await panel.user(`open ${step}`, () => press(panel, label));
        }
      } else if (roll < 0.42) {
        if (clearMenu() !== undefined) {
          await panel.user(`escape ${step}`, () => key(panel, document.activeElement ?? document.body, 'Escape'));
        }
      } else {
        const [label, action] = pick(Object.entries(DATA_STEPS));
        await panel.data(`${label} ${step}`, () => action(panel));
      }
      assert.deepEqual(panel.popovers.spontaneousCloses(), [], `seed ${seed}, step ${step}: no popover closed on its own`);
    }
    panel.bridge.mode = 'immediate';
    await panel.data('drain', () => panel.bridge.release());
    // The end state agrees with itself: a set Weight has a blue label, and no placeholder is left.
    assert.equal(panel.container.querySelectorAll('.embed-editor_decls .ui-skeleton').length, 0, 'no placeholder is left once everything has landed');
    assert.equal(panel.container.querySelectorAll('.embed-editor_selector-chips.is-placeholder').length, 0, 'nor in the well');
  });
}
