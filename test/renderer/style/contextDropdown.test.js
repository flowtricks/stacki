// Goal: the style-context dropdown reads at a glance. Base is pinned on top, the queries
// are grouped by where they are written (one header per stylesheet and wrapper selector,
// never the chip repeated on each row), width queries go from the narrowest boundary up with
// the others after them, "Add query" is pinned at the foot, and the closed trigger still
// says where the picked query is written. Keyboard order runs across the groups and skips
// their headers; every row holds the same trailing column, so a pencil or a check appearing
// never shifts it; a cut label shows its whole text on hover; the list is height-capped.
// Method: the real StylePanel through the shared harness, over two stylesheets: one nests
// three width queries in `.grid`, written out of order, the other holds a reduced-motion
// query. The dropdown is opened, read and driven by dispatched keys; the pure grouping
// (contextGroups.ts) is checked on its own for loose queries and its bound. No pointer, no
// timing; the CSS cap is read from the stylesheet.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { mountStylePanel, press, key } = require('../../helpers/stylePanelHarness.js');
const loadRenderer = require('../../helpers/rendererModule.js');
const { repoPath } = require('../../helpers/sources.js');

const FIXTURE = {
  sheets: [
    { rel: 'src/styles/base.css', css: '@media (prefers-reduced-motion: reduce) { *, ::before, ::after { transition: none; } }\n.grid { display: grid; }' },
    {
      rel: 'src/styles/patterns.css',
      css: '.grid { @media (width >= 64rem) { gap: 3rem; } @media (width >= 30rem) { gap: 1rem; } @media (width >= 48rem) { gap: 2rem; } }',
    },
  ],
  nodes: [{ id: 'n1', kind: 'element', name: 'div', props: { class: { type: 'string', value: 'grid' } }, children: [] }],
  markup: '<div class="grid" data-avb-p="n1">a</div>',
  selectedId: 'n1',
};

const trigger = (panel) => panel.container.querySelector('.embed-editor_context-select .u-select-button');
const list = () => document.querySelector('.embed-editor_context-select .u-select-list') ?? undefined;
const text = (element) => element.textContent.replace(/\s+/g, ' ').trim();

// The open list as sections: loose rows and groups with their header and rows.
function readList() {
  return [...list().children].map((child) => {
    if (child.classList.contains('u-select-group')) {
      const heading = child.querySelector('.u-select-heading');
      const chip = heading.querySelector('.u-select-tag');
      return {
        group: [chip === null ? undefined : text(chip), text(heading.querySelector('.u-select-heading-label'))].filter(Boolean).join(' '),
        chips: child.querySelectorAll('.u-select-tag').length,
        rows: [...child.querySelectorAll('[role="option"]')].map((row) =>
          text(row.querySelector('.u-select-label-line') ?? row.querySelector('.u-select-label')),
        ),
      };
    }
    return { row: text(child) };
  });
}

test('Base on top, queries grouped by source and sorted by width, Add query at the foot', async (context) => {
  const panel = await mountStylePanel(FIXTURE);
  context.after(() => panel.unmount());
  await panel.user('open the context dropdown', () => press(panel, trigger(panel)));
  assert.ok(list(), 'the list opened');
  assert.deepEqual(readList(), [
    { row: 'Base' },
    { group: 'src/styles/patterns.css .grid', chips: 1, rows: ['@media (width >= 30rem)', '@media (width >= 48rem)', '@media (width >= 64rem)'] },
    { group: 'src/styles/base.css', chips: 0, rows: ['@media (prefers-reduced-motion: reduce)'] },
    { row: 'Add query' },
  ]);
  for (const group of list().querySelectorAll('.u-select-group')) {
    assert.equal(group.getAttribute('role'), 'group', 'a group is a group to assistive technology');
    assert.ok(document.getElementById(group.getAttribute('aria-labelledby')), 'named by its header');
  }
  assert.equal(list().querySelectorAll('[role="option"] .u-select-tag').length, 0, 'no row repeats its stylesheet chip');
  assert.ok(list().lastElementChild.classList.contains('is-footer'), 'Add query is the pinned footer');
  assert.ok(list().firstElementChild.querySelector('svg'), 'Base carries its icon');
});

test("arrow keys run across the groups, skipping headers, and the trigger names the pick's source", async (context) => {
  const panel = await mountStylePanel(FIXTURE);
  context.after(() => panel.unmount());
  await panel.user('open the context dropdown', () => press(panel, trigger(panel)));
  const seen = [];
  for (let step = 0; step < 5; step += 1) {
    await panel.user(`arrow down ${step}`, () => key(panel, list(), 'ArrowDown'));
    seen.push(text(list().querySelector('[data-active="true"]')));
  }
  assert.deepEqual(seen, [
    '@media (width >= 30rem)',
    '@media (width >= 48rem)',
    '@media (width >= 64rem)',
    '@media (prefers-reduced-motion: reduce)*, ::before, ::after',
    'Add query',
  ]);
  await panel.user('arrow up', () => key(panel, list(), 'ArrowUp'));
  await panel.user('arrow up again', () => key(panel, list(), 'ArrowUp'));
  await panel.user('choose', () => key(panel, list(), 'Enter'));
  assert.equal(list(), undefined, 'choosing closes the list');
  const shown = text(trigger(panel));
  assert.match(shown, /@media \(width >= 64rem\)/, 'the trigger shows the query');
  assert.match(shown, /\.grid/, 'and the selector it is nested in');
  assert.match(shown, /patterns\.css/, 'and the stylesheet it is written in');
  assert.deepEqual(panel.popovers.spontaneousCloses(), [], "the list closed only by the person's choice");
});

test('every row holds the same trailing column, a cut label titles itself, and the list is capped', async (context) => {
  const panel = await mountStylePanel(FIXTURE);
  context.after(() => panel.unmount());
  await panel.user('open the context dropdown', () => press(panel, trigger(panel)));
  for (const row of list().querySelectorAll('[role="option"]')) {
    assert.equal(row.lastElementChild.className, 'u-select-check', `the check and pencil column ends every row: ${text(row)}`);
  }
  const label = list().querySelector('.u-select-group [role="option"] .u-select-label, .u-select-group [role="option"] .u-select-label-line');
  Object.defineProperty(label, 'scrollWidth', { configurable: true, value: 400 });
  Object.defineProperty(label, 'clientWidth', { configurable: true, value: 120 });
  label.dispatchEvent(new panel.window.MouseEvent('mouseover', { bubbles: true }));
  label.dispatchEvent(new panel.window.MouseEvent('mouseenter', { bubbles: false }));
  assert.equal(label.title, text(label), 'a cut label carries its whole text');
  const css = fs.readFileSync(repoPath('src/features/style/utilities.css'), 'utf8');
  assert.match(css, /\.embed-editor_context-select \.u-select-list \{\s*max-height: min\(20rem, 70vh\);/, 'the list is capped and scrolls inside');
  assert.match(css, /\.u-select-option\.is-footer \{\s*position: sticky;/, 'with the footer pinned');
  assert.doesNotMatch(
    css.slice(css.indexOf('.u-select-group {'), css.indexOf('.embed-editor_context-select .u-select-option .u-select-subline')),
    /(^|[\s;{])border(-(top|right|bottom|left|width|style|color))?\s*:/,
    'groups are set apart by fills and space, not lines',
  );
});

test('grouping keeps loose queries after the groups and states its bound', () => {
  const { groupContexts, CONTEXT_GROUP_ENTRIES_MAX } = loadRenderer('src/features/style/embed/contextGroups.ts');
  const context = (key, source, embedAtContext) => ({ key, label: key, breakpoint: undefined, embedAtContext, ...(source === undefined ? {} : { source }) });
  const groups = groupContexts([
    { context: context('typed', undefined, '@media (width >= 10rem)'), wrapper: undefined },
    { context: context('', undefined, ''), wrapper: undefined },
    { context: context('b', 'one', '@media (width < 40rem)'), wrapper: '.a' },
    { context: context('c', 'one', '@media (hover: hover)'), wrapper: '.a' },
    { context: context('d', 'one', '@media (width < 20rem)'), wrapper: '.a' },
  ]);
  assert.deepEqual(
    groups.map((group) => (group.kind === 'group' ? group.items.map((item) => item.context.key) : group.kind)),
    ['base', ['d', 'b', 'c'], 'loose'],
  );
  assert.throws(
    () => groupContexts(Array.from({ length: CONTEXT_GROUP_ENTRIES_MAX + 1 }, () => ({ context: context('x', 'one', ''), wrapper: undefined }))),
    /bounded/,
  );
});
