// Goal: the reason an insert-palette item cannot go where the page's selection points is a tooltip anchored on the highlighted row,
// never a note under the list (owner rule: no paragraph is appended into the UI; a note that follows the keyboard highlight moves
// the palette's height with every arrow press). The tip shows for a refused row whether the highlight came from the keyboard or the
// pointer, follows the highlight to the next row and vanishes on an insertable one; the refused row names the reason with
// aria-describedby so a screen reader reads it; a refused row stays listed (the disabled-option rule: shown only because its
// reason is the explanation of the highlighted row) and Enter on it inserts nothing.
// Method: bundle the real InsertSearch, mount it in jsdom with two components (one refused by a stub placementOf, one not), drive it
// with the key and pointer events a person would, and read the DOM: the tooltip element, the row's aria-describedby, and the
// absence of the old `insert-placement-note` block and of any role="status" or role="alert" in the palette.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'insert-placement-tip.cjs');
buildSync({
  stdin: {
    contents: "export { default as InsertSearch } from './src/features/palette/InsertSearch';",
    resolveDir: repoPath('.'),
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  logLevel: 'silent',
  loader: { '.css': 'empty' },
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
});
const palette = require(output);

const REASON = '“body” goes directly inside “html”.';

async function mount() {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.localStorage = dom.window.localStorage;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { Simulate } = require('react-dom/test-utils');
  const container = document.getElementById('root');
  const root = createRoot(container);
  const inserted = [];
  await React.act(async () => {
    root.render(
      React.createElement(palette.InsertSearch, {
        components: [
          { name: 'Alpha', folder: 'Sections', path: '/components/Sections/Alpha.astro' },
          { name: 'Bravo', folder: 'Sections', path: '/components/Sections/Bravo.astro' },
        ],
        onInsert: (item) => inserted.push(item.label),
        // Only Alpha has no valid place here.
        placementOf: (item) => (item.label === 'Alpha' ? { reason: 'body-position', messageKey: 'structure.placement.bodyPosition', params: {} } : undefined),
        onClose: () => {},
      }),
    );
  });
  const act = (run) => React.act(async () => run());
  const rows = () => [...container.querySelectorAll('.insert-item')];
  return {
    container,
    inserted,
    rows,
    highlighted: () => rows().findIndex((row) => row.classList.contains('highlight')),
    tip: () => document.querySelector('[role="tooltip"].settings-info-tip'),
    key: (key) => act(() => Simulate.keyDown(container.querySelector('input'), { key })),
    query: (value) => act(() => Simulate.change(container.querySelector('input'), { target: { value } })),
    hover: (row) => act(() => Simulate.mouseMove(row)),
    async unmount() {
      await React.act(async () => root.unmount());
      dom.window.close();
      delete global.localStorage;
    },
  };
}

test('the refusal is a tooltip on the highlighted row, with the row naming it, and no note under the list', async () => {
  const view = await mount();
  try {
    const alpha = view.rows().find((row) => row.querySelector('.insert-item-label')?.textContent === 'Alpha');
    assert.ok(alpha, 'the refused row stays listed: its reason is what the highlight explains');
    await view.hover(alpha);
    assert.equal(alpha.classList.contains('highlight'), true, 'the pointer highlights it');
    assert.equal(view.tip()?.textContent, REASON, 'the tooltip carries the reason');
    const describedBy = alpha.getAttribute('aria-describedby');
    assert.ok(describedBy, 'the row names its reason');
    assert.equal(document.getElementById(describedBy).textContent, REASON, 'and a screen reader reads the same text');
    assert.equal(view.container.querySelector('.insert-placement-note') ?? undefined, undefined, 'no note under the list');
    assert.equal(view.container.querySelector('[role="status"], [role="alert"]') ?? undefined, undefined, 'no status or alert block in the palette');
  } finally {
    await view.unmount();
  }
});

test('the tooltip follows the highlight: gone on an insertable row, back on the refused one, and Enter on it inserts nothing', async () => {
  const view = await mount();
  try {
    await view.query('');
    const find = (label) => view.rows().find((row) => row.querySelector('.insert-item-label')?.textContent === label);
    const alpha = find('Alpha');
    const bravo = find('Bravo');
    assert.ok(alpha && bravo, 'both components are listed');
    await view.hover(bravo);
    assert.equal(view.tip() ?? undefined, undefined, 'an insertable row has no tooltip');
    assert.equal(bravo.getAttribute('aria-describedby') ?? undefined, undefined, 'and names no reason');
    assert.equal(alpha.getAttribute('aria-describedby') ?? undefined, undefined, 'a refused row that is not highlighted names none either');
    await view.hover(alpha);
    assert.equal(view.tip()?.textContent, REASON, 'the keyboard or pointer highlight on the refused row shows it again');
    await view.key('Enter');
    assert.deepEqual(view.inserted, [], 'a refused item is never inserted');
    await view.hover(bravo);
    assert.equal(view.tip() ?? undefined, undefined, 'the tooltip leaves with the highlight');
    await view.key('Enter');
    assert.deepEqual(view.inserted, ['Bravo'], 'an insertable item is inserted as before');
  } finally {
    await view.unmount();
  }
});
