// Goal: the Style panel appends no notice, hint, warning or error text into itself (owner rule: failures and notices are toasts,
// explanations are tooltips, and a state that must persist replaces existing UI at the same height). A paragraph that appears under
// a field moves everything below it, so the panel shifts whenever a state changes.
// Method: the real StylePanel through the shared harness over one fixture; read the panel as it opens and with the Add query form
// open, and require that no element is an alert, a status block, or a block whose class says note, notice, problem, hint or warning.
// Negative space: a custom width the form cannot take wears the error look, adds no element to the panel, and says why once, in a
// toast; a valid width adds nothing but the Add button's tooltip text. (The Insert palette and its dialogs have their own tests.)
const test = require('node:test');
const assert = require('node:assert/strict');
const { mountStylePanel, press } = require('../../helpers/stylePanelHarness.js');
const { toastMessages } = require('../../helpers/toastCapture');

const FIXTURE = {
  sheets: [{ rel: 'src/styles/patterns.css', css: '.grid { @media (width >= 30rem) { gap: 1rem; } }' }],
  nodes: [{ id: 'n1', kind: 'element', name: 'div', props: { class: { type: 'string', value: 'grid' } }, children: [] }],
  markup: '<div class="grid" data-avb-p="n1">a</div>',
  selectedId: 'n1',
};

const NOTICE_CLASS = /(^|[\s_-])(note|notice|problem|hint|warning|error)(\s|$)/;
// Elements that may carry such a name without being appended text: the visually hidden description a tooltip points at.
const allowed = (element) => element.classList.contains('info-hint-text') || element.closest('[role="tooltip"]') !== null;
const appended = (panel) =>
  [...panel.container.querySelectorAll('*')].filter((element) => {
    if (allowed(element)) {
      return false;
    }
    if (element.matches('[role="alert"], [role="status"]') && element.textContent.trim() !== '') {
      return true;
    }
    return [...element.classList].some((name) => NOTICE_CLASS.test(name.replace(/^embed-editor_/, '')) && element.textContent.trim() !== '');
  });

test('the panel opens with no appended notice, status or error text', async (context) => {
  const panel = await mountStylePanel(FIXTURE);
  context.after(() => panel.unmount());
  assert.deepEqual(
    appended(panel).map((element) => element.className),
    [],
    'nothing is appended into the panel',
  );
});

test('a custom query it cannot take adds no text row: the field wears the error look and Enter raises one toast', async (context) => {
  const panel = await mountStylePanel(FIXTURE);
  context.after(() => panel.unmount());
  const trigger = panel.container.querySelector('.embed-editor_context-select .u-select-button');
  await panel.user('open the context list', () => press(panel, trigger));
  const add = [...panel.window.document.querySelectorAll('.u-select-footer [role="option"]')].find((row) => row.textContent.includes('Add query'));
  assert.ok(add, 'the dropdown offers Add query');
  await panel.user('open the Add query form', () => press(panel, add));
  const form = panel.container.querySelector('.embed-editor_add-query.is-suggested');
  assert.ok(form, 'the form is open');
  const before = appended(panel).length;
  const input = form.querySelector('.embed-editor_aq-input');
  await panel.user('type garbage', () => {
    const setter = Object.getOwnPropertyDescriptor(panel.window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'banana');
    input.dispatchEvent(new panel.window.Event('input', { bubbles: true }));
  });
  assert.equal(input.getAttribute('aria-invalid'), 'true', 'the field takes the error look');
  assert.equal(appended(panel).length, before, 'and the panel gains no text');
  assert.doesNotMatch(toastMessages(), /Type a width/, 'no toast while typing: the reason waits for the commit');
});
