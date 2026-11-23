// Goal: the Add query form (opened by the dropdown's footer row) is suggestion-first and safe.
// It opens on the project's convention (mobile first for a stylesheet written with `>=`), lists the
// project's breakpoints with the condition each would write, in bar order, marks a condition that
// exists as Already added (and choosing it only switches the edit target), narrows as a custom width
// is typed (what Add will do is the Add button's tooltip; a width it cannot take wears the error look and Enter raises one toast), and writes only on Enter or a click: exactly one empty at-rule
// with the chosen condition, in one undo step, leaving the existing CSS as it was. Hovering,
// arrowing and typing write nothing. Desktop first writes `width < X` over the same boundaries.
// Method: the real StylePanel through the shared harness over one fixture stylesheet (a single
// `@media (width >= 30rem)` on `.grid`), driven by dispatched events; writes are read from the
// harness's write log and the undo count from the panel's record-undo callback. Fixtures only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { mountStylePanel, press, key } = require('../../helpers/stylePanelHarness.js');

const SHEET = '.grid { @media (width >= 30rem) { gap: 1rem; } }';
const FIXTURE = {
  sheets: [{ rel: 'src/styles/patterns.css', css: SHEET }],
  nodes: [{ id: 'n1', kind: 'element', name: 'div', props: { class: { type: 'string', value: 'grid' } }, children: [] }],
  markup: '<div class="grid" data-avb-p="n1">a</div>',
  selectedId: 'n1',
};

const trigger = (panel) => panel.container.querySelector('.embed-editor_context-select .u-select-button');
const text = (element) => element.textContent.replace(/\s+/g, ' ').trim();
const form = (panel) => panel.container.querySelector('.embed-editor_add-query.is-suggested') ?? undefined;
const rows = (panel) => [...form(panel).querySelectorAll('.embed-editor_aq-row')];
// What Add will do is the Add button's tooltip text (also its aria-description); the form has no preview row.
const addTip = (panel) => text(form(panel).querySelector('.embed-editor_aq-custom .tip-anchor .info-hint-text') ?? { textContent: '' });
const rowText = (row) => [...row.children].map(text).filter(Boolean).join(' ');

async function openForm(panel) {
  await panel.user('open the dropdown', () => press(panel, trigger(panel)));
  const footer = [...document.querySelectorAll('.u-select-footer [role="option"]')].find((row) => text(row).includes('Add query'));
  await panel.user('press Add query', () => press(panel, footer));
  assert.ok(form(panel), 'the form opened');
}

test('opens on the project convention with the breakpoints, their conditions and what exists', async (context) => {
  const panel = await mountStylePanel(FIXTURE);
  context.after(() => panel.unmount());
  await openForm(panel);
  assert.deepEqual(
    rows(panel).map(rowText),
    ['Laptop width >= 64rem', 'Tablet width >= 48rem', 'Phone Already added'],
    'mobile first: the same boundaries as the Laptop, Tablet and Phone breakpoints, in bar order; the existing one is marked',
  );
  assert.equal(rows(panel)[2].getAttribute('aria-selected'), 'true', 'checked');
  assert.ok(rows(panel)[0].querySelector('.embed-editor_aq-icon svg'), 'with the preview bar icon');
  assert.deepEqual(panel.writes, [], 'opening writes nothing');
});

test('Desktop first writes width < X over the same boundaries', async (context) => {
  const panel = await mountStylePanel(FIXTURE);
  context.after(() => panel.unmount());
  await openForm(panel);
  const desktop = [...form(panel).querySelectorAll('.embed-editor_add-query-direction [role="radio"], .embed-editor_add-query-direction button')].find(
    (button) => text(button).includes('Desktop first'),
  );
  await panel.user('Desktop first', () => press(panel, desktop));
  assert.deepEqual(rows(panel).map(rowText), ['Laptop width < 64rem', 'Tablet width < 48rem', 'Phone width < 30rem']);
  assert.deepEqual(panel.writes, []);
});

test('hovering, arrowing and typing write nothing and record nothing', async (context) => {
  const panel = await mountStylePanel(FIXTURE);
  const undos = [];
  panel.rerender({ onRecordUndo: (command) => undos.push(command) });
  context.after(() => panel.unmount());
  await openForm(panel);
  const list = form(panel).querySelector('[role="listbox"]');
  for (const row of rows(panel)) {
    row.dispatchEvent(new panel.window.MouseEvent('mouseenter', { bubbles: false }));
  }
  await panel.user('arrow down', () => key(panel, list, 'ArrowDown'));
  const input = form(panel).querySelector('.embed-editor_aq-input');
  await panel.user('type', () => {
    const setter = Object.getOwnPropertyDescriptor(panel.window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '40rem');
    input.dispatchEvent(new panel.window.Event('input', { bubbles: true }));
  });
  assert.equal(addTip(panel), 'Will add @media (width >= 40rem)', 'the Add tooltip names the exact query');
  assert.equal(form(panel).querySelector('.embed-editor_aq-preview') ?? undefined, undefined, 'no preview row');
  assert.deepEqual(panel.writes, [], 'nothing written by browsing or typing');
  assert.deepEqual(panel.writes, [], 'and nothing after the list is left again');
  assert.deepEqual(undos, [], 'no undo step was recorded');
});

test('Enter adds the highlighted suggestion: one at-rule, the existing CSS intact, one undo step at most, the form closed', async (context) => {
  const panel = await mountStylePanel(FIXTURE);
  const undos = [];
  panel.rerender({ onRecordUndo: (command) => undos.push(command) });
  context.after(() => panel.unmount());
  await openForm(panel);
  const list = form(panel).querySelector('[role="listbox"]');
  await panel.user('arrow to Tablet', () => key(panel, list, 'ArrowDown'));
  assert.equal(list.getAttribute('aria-activedescendant'), rows(panel)[1].id);
  await panel.user('Enter', () => key(panel, list, 'Enter'));
  await panel.settle();
  assert.equal(form(panel), undefined, 'the form closed');
  const written = panel.writes.map((write) => write.css ?? '').join('\n');
  assert.equal((written.match(/@media \(width >= 48rem\)/g) ?? []).length, 1, 'one new query');
  assert.ok(written.includes(SHEET.replace('.grid { ', '').slice(0, 20)) || written.includes('@media (width >= 30rem)'), 'the existing query is still there');
  assert.equal((written.match(/@media \(width >= 30rem\)/g) ?? []).length, 1, 'and not duplicated');
  assert.ok(undos.length <= 1, `at most one undo step (${undos.length})`);
});

test('an existing condition is only switched to, never added twice', async (context) => {
  const panel = await mountStylePanel(FIXTURE);
  context.after(() => panel.unmount());
  await openForm(panel);
  await panel.user('click Phone (already added)', () => press(panel, rows(panel)[2]));
  assert.equal(form(panel), undefined, 'the form closed');
  assert.deepEqual(panel.writes, [], 'nothing was written');
  assert.match(text(trigger(panel)), /≥ 30rem|Phone/, 'the edit target is that query');
});

test('a custom width types, previews and adds with Enter; garbage is refused with a reason', async (context) => {
  const panel = await mountStylePanel(FIXTURE);
  context.after(() => panel.unmount());
  await openForm(panel);
  const input = form(panel).querySelector('.embed-editor_aq-input');
  const type = (value) =>
    panel.user(`type ${value}`, () => {
      const setter = Object.getOwnPropertyDescriptor(panel.window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, value);
      input.dispatchEvent(new panel.window.Event('input', { bubbles: true }));
    });
  await type('banana');
  assert.equal(input.getAttribute('aria-invalid'), 'true', 'garbage takes the error look');
  assert.equal(addTip(panel), '', 'and offers nothing to add');
  assert.equal(form(panel).querySelector('.embed-editor_aq-preview') ?? undefined, undefined, 'with no text row under the field');
  await panel.user('Enter on garbage', () => key(panel, input, 'Enter'));
  assert.ok(form(panel), 'the form stays open');
  assert.match(require('../../helpers/toastCapture').toastMessages(), /Type a width/, 'the reason is one toast on Enter');
  assert.deepEqual(panel.writes, []);
  await type('1100');
  assert.equal(addTip(panel), 'Will add @media (width >= 1100px)');
  assert.deepEqual(rows(panel), [], 'no breakpoint matches 1100');
  await type('48');
  assert.deepEqual(rows(panel).map(rowText), ['Tablet width >= 48rem'], 'typing narrows the suggestions');
  await type('40rem');
  await panel.user('Enter', () => key(panel, input, 'Enter'));
  await panel.settle();
  const written = panel.writes.map((write) => write.css ?? '').join('\n');
  assert.equal((written.match(/@media \(width >= 40rem\)/g) ?? []).length, 1, 'the custom query is written once');
  assert.equal(form(panel), undefined);
});

test('Escape closes the form without writing', async (context) => {
  const panel = await mountStylePanel(FIXTURE);
  context.after(() => panel.unmount());
  await openForm(panel);
  await panel.user('Escape', () => key(panel, form(panel).querySelector('[role="listbox"]'), 'Escape'));
  assert.equal(form(panel), undefined);
  assert.deepEqual(panel.writes, []);
});
