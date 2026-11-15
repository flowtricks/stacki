// Goal: the style-context dropdown is one flat, compact list. Base is on top; each stylesheet and
// wrapper selector is a small muted section label (never a card); a width query reads as a short
// condition (`≥ 64rem`), or as its project breakpoint (`Laptop` with a muted `< 64rem`) when its one
// boundary is that breakpoint's on the same side of the preview bar, with the raw `@media` text as
// its tooltip; the queries are ordered like the bar (bounded from below, widest first, then bounded
// from above, widest first); everything that is not about width is a plain `Other` section at the
// end, one line per query; "Add query" is pinned at
// the foot; and the closed trigger is one line naming where the picked query is written.
// Keyboard order runs across the sections and skips their labels; every row holds the same trailing
// column; a cut label shows its whole text on hover; the list is height-capped; nothing writes.
// Method: the real StylePanel through the shared harness, over stylesheets that nest three width
// queries in `.grid` (written out of order) and hold a reduced-motion query; a second fixture holds
// the project's default breakpoints' queries. The dropdown is opened, read and driven by dispatched
// events; the pure grouping and ordering (contextGroups.ts, contextRows.ts) are checked on their own
// for direction matching, loose queries and the bound. No pointer, no timing; the CSS is
// read from the stylesheet.

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

// The project's default breakpoints are Laptop < 64rem, Tablet < 48rem, Phone < 30rem (all `down`).
const BREAKPOINT_FIXTURE = {
  ...FIXTURE,
  sheets: [
    {
      rel: 'src/styles/patterns.css',
      css: '.grid { @media (width < 64rem) { gap: 3rem; } @media (max-width: 767px) { gap: 1rem; } @media (width >= 64rem) { gap: 2rem; } @media (width >= 40rem) { gap: 2rem; } @media (width < 30rem) { gap: 1rem; } }',
    },
  ],
};

const trigger = (panel) => panel.container.querySelector('.embed-editor_context-select .u-select-button');
const list = () => document.querySelector('.embed-editor_context-select .u-select-list') ?? undefined;
const text = (element) => element.textContent.replace(/\s+/g, ' ').trim();
// A row's own name: its label's text, without the muted condition that follows a breakpoint's name.
const rowLabel = (row) => {
  const label = row.querySelector('.u-select-label-line') ?? row.querySelector('.u-select-label');
  return [...label.childNodes]
    .filter((node) => node.nodeType === 3)
    .map((node) => node.textContent)
    .join('')
    .trim();
};

// The open list as the flat sequence it is: Base and rows as `{ row, title }`, section labels as `{ heading }`.
function readList() {
  const scroll = list().querySelector(':scope > .u-select-scroll');
  const footer = list().querySelector(':scope > .u-select-footer');
  return [...scroll.children, ...footer.children].map((child) => {
    if (child.classList.contains('u-select-heading')) {
      const chip = child.querySelector('.u-select-tag');
      return { heading: [chip === null ? undefined : text(chip), text(child.querySelector('.u-select-heading-label'))].filter(Boolean).join(' ') };
    }
    return { row: rowLabel(child), ...(child.title === '' ? {} : { title: child.title }) };
  });
}

test('a flat list: Base, section labels with their queries widest first, an Other section, Add query at the foot', async (context) => {
  const panel = await mountStylePanel(FIXTURE);
  context.after(() => panel.unmount());
  await panel.user('open the context dropdown', () => press(panel, trigger(panel)));
  assert.ok(list(), 'the list opened');
  assert.deepEqual(readList(), [
    { row: 'Base' },
    { heading: 'src/styles/patterns.css .grid' },
    { row: '≥ 64rem', title: '@media (width >= 64rem)' },
    { row: '≥ 48rem', title: '@media (width >= 48rem)' },
    { row: '≥ 30rem', title: '@media (width >= 30rem)' },
    { heading: 'Other' },
    { row: '@media (prefers-reduced-motion: reduce)', title: '@media (prefers-reduced-motion: reduce)' },
    { row: 'Add query' },
  ]);
  assert.equal(list().querySelectorAll('.u-select-group').length, 0, 'no group cards');
  assert.equal(list().querySelectorAll('[role="option"] .u-select-tag').length, 0, 'no row repeats its stylesheet chip');
  assert.ok(list().lastElementChild.classList.contains('u-select-footer'), 'Add query is pinned below the scrolling rows');
  assert.ok(list().querySelector('.u-select-scroll .is-footer') === null, 'the footer is not inside the scrolling region');
  assert.ok(list().querySelector('.u-select-scroll').firstElementChild.querySelector('svg'), 'Base carries its icon');
  assert.ok(list().querySelector('.u-select-header') === null, 'no Follow strip while no canvas width is known');
  assert.deepEqual(panel.popovers.spontaneousCloses(), [], "the list closed only by the person's choice");
});

test('queries that are not about width are a plain Other section: always shown, one line each, selectors beneath', async (context) => {
  const panel = await mountStylePanel(FIXTURE);
  context.after(() => panel.unmount());
  await panel.user('open', () => press(panel, trigger(panel)));
  const entries = readList();
  const at = entries.findIndex((entry) => entry.heading === 'Other');
  assert.ok(at > 0, 'a section labelled Other');
  assert.deepEqual(
    entries[at + 1],
    { row: '@media (prefers-reduced-motion: reduce)', title: '@media (prefers-reduced-motion: reduce)' },
    'its raw query is listed directly under it',
  );
  assert.equal(list().querySelectorAll('[aria-expanded]').length, 0, 'nothing expands or collapses');
  assert.equal(list().querySelectorAll('.u-select-expander').length, 0, 'no chevron');
  assert.ok(!text(list()).includes('Other ('), 'no count badge');
  const query = [...list().querySelectorAll('[role="option"]')].find((row) => row.title === '@media (prefers-reduced-motion: reduce)');
  assert.match(text(query.querySelector('.u-select-subline')), /::before/, 'the selectors it holds sit on their own muted line');
  await panel.user('choose it', () => press(panel, query));
  assert.equal(list(), undefined, 'choosing a query closes the list');
  assert.match(text(trigger(panel)), /prefers-reduced-motion/);
  assert.deepEqual(panel.writes, [], 'nothing was written');
});

test('a width query is named for its project breakpoint only on the breakpoint side and boundary', async (context) => {
  const panel = await mountStylePanel(BREAKPOINT_FIXTURE);
  context.after(() => panel.unmount());
  await panel.user('open the context dropdown', () => press(panel, trigger(panel)));
  const rows = readList().filter((entry) => entry.row !== undefined);
  assert.deepEqual(rows.slice(0, 6), [
    { row: 'Base' },
    // Bounded from below first, widest first: not breakpoints (those are `down`), so bare conditions.
    { row: '≥ 64rem', title: '@media (width >= 64rem)' },
    { row: '≥ 40rem', title: '@media (width >= 40rem)' },
    // Then bounded from above, widest first: the Laptop, Tablet and Phone boundaries, `max-width: 767px` being Tablet's 1px-under form.
    { row: 'Laptop', title: '@media (width < 64rem)' },
    { row: 'Tablet', title: '@media (max-width: 767px)' },
    { row: 'Phone', title: '@media (width < 30rem)' },
  ]);
  const laptop = [...list().querySelectorAll('[role="option"]')].find((row) => rowLabel(row).startsWith('Laptop'));
  assert.equal(text(laptop.querySelector('.u-select-detail')), '< 64rem', 'the muted condition follows the name');
  assert.ok(laptop.querySelector('.u-select-icon svg'), 'with the preview bar icon');
  const bare = [...list().querySelectorAll('[role="option"]')].find((row) => rowLabel(row) === '≥ 40rem');
  assert.ok(bare.querySelector('.u-select-icon svg'), 'a bare width has a neutral width icon');
});

test('arrow keys run across the sections, skipping the section labels, and the trigger is one line naming its source', async (context) => {
  const panel = await mountStylePanel(FIXTURE);
  context.after(() => panel.unmount());
  await panel.user('open the context dropdown', () => press(panel, trigger(panel)));
  const seen = [];
  for (let step = 0; step < 5; step += 1) {
    await panel.user(`arrow down ${step}`, () => key(panel, list(), 'ArrowDown'));
    seen.push(rowLabel(list().querySelector('[data-active="true"]')));
  }
  assert.deepEqual(seen, ['≥ 64rem', '≥ 48rem', '≥ 30rem', '@media (prefers-reduced-motion: reduce)', 'Add query']);
  for (let step = 0; step < 3; step += 1) {
    await panel.user('arrow up', () => key(panel, list(), 'ArrowUp'));
  }
  await panel.user('choose', () => key(panel, list(), 'Enter'));
  assert.equal(list(), undefined, 'choosing closes the list');
  const shown = text(trigger(panel));
  assert.match(shown, /≥ 48rem/, 'the trigger shows the condition');
  assert.match(shown, /\.grid/, 'and the selector it is nested in');
  assert.equal(trigger(panel).querySelectorAll('.has-overline').length, 0, 'on one line');
  assert.equal(trigger(panel).title, '@media (width >= 48rem)', 'with the raw query as its tooltip');
  assert.deepEqual(panel.popovers.spontaneousCloses(), [], "the list closed only by the person's choice");
  assert.deepEqual(panel.writes, [], 'nothing was written');
});

test('every row ends in the same column, a dot says what it means, a cut label titles itself, and the list is capped', async (context) => {
  const panel = await mountStylePanel(FIXTURE);
  context.after(() => panel.unmount());
  await panel.user('open the context dropdown', () => press(panel, trigger(panel)));
  for (const row of list().querySelectorAll('[role="option"]')) {
    assert.ok(row.querySelector(':scope > .u-select-check'), `the check and pencil column ends every row: ${text(row)}`);
  }
  const dot = list().querySelector('.u-select-dot');
  assert.equal(dot.title, 'Has styles here');
  assert.equal(dot.getAttribute('aria-label'), 'Has styles here');
  const label = list().querySelector('.u-select-scroll [role="option"] .u-select-label');
  Object.defineProperty(label, 'scrollWidth', { configurable: true, value: 400 });
  Object.defineProperty(label, 'clientWidth', { configurable: true, value: 120 });
  label.dispatchEvent(new panel.window.MouseEvent('mouseover', { bubbles: true }));
  label.dispatchEvent(new panel.window.MouseEvent('mouseenter', { bubbles: false }));
  assert.equal(label.title, text(label), 'a cut label carries its whole text');
  const css = fs.readFileSync(repoPath('src/features/style/utilities.css'), 'utf8');
  assert.match(
    css,
    /\.embed-editor_context-select \.u-select-list \{\s*max-height: min\(36rem, 80vh, var\(--select-room, 100vh\)\);/,
    'the list is capped and scrolls inside',
  );
  assert.match(
    css,
    /\.u-select-list\.has-footer > \.u-select-scroll \{[^}]*overflow-y: auto;[^}]*overscroll-behavior: contain;/,
    'the rows scroll in a contained region',
  );
  assert.doesNotMatch(css, /scrollbar-gutter/, 'no reserved gutter: it left an empty strip on the right of a list that does not scroll');
  assert.match(css, /\.u-select-list\.has-footer \{[^}]*overflow: hidden;/, 'and the pinned strip and footer sit outside it');
  assert.doesNotMatch(css, /\.u-select-group/, 'no group cards remain in the stylesheet');
  assert.match(css, /\.embed-editor_context-select \.u-select-option \{[^}]*min-height: 2rem;/, 'rows are 32px');
});

test('the sections: the preview bar order, width queries only, everything else in Other after, loose queries after the groups', () => {
  const { groupContexts, CONTEXT_GROUP_ENTRIES_MAX } = loadRenderer('src/features/style/embed/contextGroups.ts');
  const context = (key, source, embedAtContext) => ({ key, label: key, breakpoint: undefined, embedAtContext, ...(source === undefined ? {} : { source }) });
  const groups = groupContexts(
    [
      { context: context('typed', undefined, '@media (width >= 10rem)'), wrapper: undefined },
      { context: context('', undefined, ''), wrapper: undefined },
      { context: context('b', 'one', '@media (width < 40rem)'), wrapper: '.a' },
      { context: context('c', 'one', '@media (hover: hover)'), wrapper: '.a' },
      { context: context('d', 'one', '@media (width < 20rem)'), wrapper: '.a' },
      { context: context('e', 'one', '@media (width >= 20rem)'), wrapper: '.a' },
      { context: context('f', 'two', '@media print'), wrapper: undefined },
    ],
    [],
  );
  assert.deepEqual(
    groups.map((group) =>
      group.kind === 'group' ? group.items.map((item) => item.context.key) : group.kind === 'other' ? group.items.map((item) => item.context.key) : group.kind,
    ),
    // Base; the group: bounded from below first, then from above, widest first; then the loose one; then Other.
    ['base', ['e', 'b', 'd'], 'loose', ['c', 'f']],
  );
  assert.equal(groups[groups.length - 1].kind, 'other');
  assert.throws(
    () =>
      groupContexts(
        Array.from({ length: CONTEXT_GROUP_ENTRIES_MAX + 1 }, () => ({ context: context('x', 'one', ''), wrapper: undefined })),
        [],
      ),
    /bounded/,
  );
});

test('ordering and naming rules: direction and boundary must both match; ties keep declaration order', () => {
  const { describeCondition, orderByBar } = loadRenderer('src/features/style/embed/contextRows.ts');
  const { BREAKPOINT_DEFAULTS } = loadRenderer('shared/properties/projectBreakpoints.ts');
  const described = (query) => describeCondition(query, BREAKPOINT_DEFAULTS);
  assert.equal(described('@media (width < 64rem)').breakpoint.id, 'laptop');
  assert.equal(described('@media (max-width: 1023px)').breakpoint.id, 'laptop', 'the inclusive form one pixel under');
  assert.equal(described('@media (width <= 1024px)').breakpoint.id, 'laptop', 'px for rem');
  assert.equal(described('@media (width >= 64rem)').breakpoint, undefined, 'the other direction is not the Laptop');
  assert.equal(described('@media (width < 63rem)').breakpoint, undefined, 'another value is not the Laptop');
  assert.equal(described('@media (30rem <= width < 48rem)').breakpoint, undefined, 'a range is not one breakpoint');
  assert.equal(described('@media (30rem <= width < 48rem)').condition, '≥ 30rem, < 48rem');
  assert.equal(described('@media (width < 64rem)').condition, '< 64rem');
  assert.deepEqual(described('@media (prefers-color-scheme: dark)'), { kind: 'other' });
  assert.deepEqual(described('@container card (width > 20rem)'), { kind: 'other' });
  assert.deepEqual(described('@media (width >= 30rem) and (hover: hover)'), { kind: 'other' });
  const items = ['@media (width < 20rem)', '@media (width >= 20rem)', '@media (width < 40rem)', '@media (width >= 40rem)', '@media (min-width: 640px)'].map(
    (query, index) => ({ index, query, condition: described(query) }),
  );
  assert.deepEqual(
    orderByBar(items).map((item) => item.query),
    ['@media (width >= 40rem)', '@media (min-width: 640px)', '@media (width >= 20rem)', '@media (width < 40rem)', '@media (width < 20rem)'],
    'from below widest first (ties in declaration order), then from above widest first',
  );
});

test('the open list is positioned once on open; hovering rows and re-rendering never write its scroll position', async (context) => {
  const panel = await mountStylePanel(FIXTURE);
  context.after(() => panel.unmount());
  const proto = panel.window.Element.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, 'scrollTop');
  let writes = 0;
  Object.defineProperty(proto, 'scrollTop', {
    configurable: true,
    get: original?.get,
    set(value) {
      writes += 1;
      original?.set?.call(this, value);
    },
  });
  context.after(() => (original ? Object.defineProperty(proto, 'scrollTop', original) : delete proto.scrollTop));
  await panel.user('open the context dropdown', () => press(panel, trigger(panel)));
  const opened = writes;
  assert.ok(opened <= 1, `at most one positioning write on open (${opened})`);
  const rows = [...list().querySelectorAll('[role="option"]')];
  for (const row of rows) {
    await panel.user('hover a row', () => press(panel, row, 'mouseover'));
    row.dispatchEvent(new panel.window.MouseEvent('mouseenter', { bubbles: false }));
  }
  assert.equal(writes, opened, 'crossing rows with the pointer never scrolls the list');
  assert.deepEqual(panel.popovers.spontaneousCloses(), [], "the list closed only by the person's choice");
});
