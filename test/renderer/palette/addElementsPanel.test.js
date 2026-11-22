// Goal: the Add elements panel draws every tile name whole (no ellipsis, no single-line clamp), gives every tile
// one height, lines its headings and grid up on one inset, keeps the group headers calm (sentence case, no
// tracking), remembers folded groups for the session, folds and opens every group from the header button (disabled while
// searching), skips folded tiles with the arrow keys, and clears its search from the clear button.
// Methodology: bundle the real panel with esbuild, mount it in jsdom with the panel's own stylesheet injected, and
// read the markup and the computed styles jsdom cascades. jsdom has no layout, so "one height" is checked as the
// rules that produce it (one tile height token, grid rows at least that tall, no per-tile height) rather than as
// measured pixels; the hidden-window check in the report covers the measured layout.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const stylesheet = fs.readFileSync(repoPath('src/features/palette/addElements.css'), 'utf8');

function loadPanel() {
  const directory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(directory, { recursive: true });
  const output = path.join(directory, 'add-elements-panel.cjs');
  buildSync({
    entryPoints: [repoPath('src/features/palette/AddElementsPanel.tsx')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    external: ['react', 'react-dom', 'react/jsx-runtime'],
  });
  return require(output).default;
}

async function mount(props = {}) {
  const dom = new JSDOM(`<style>${stylesheet}</style><div id="root"></div>`, { url: 'http://localhost', pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.HTMLInputElement = dom.window.HTMLInputElement;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const AddElementsPanel = loadPanel();
  const container = document.getElementById('root');
  const root = createRoot(container);
  const render = async () => {
    await React.act(async () => {
      root.render(React.createElement(AddElementsPanel, { allowSlot: true, onInsert() {}, onPickComponent() {}, ...props }));
    });
  };
  await render();
  return { React, container, dom, render, unmount: () => React.act(async () => root.unmount()) };
}

test('no tile name is cut with an ellipsis, and every tile shares one height', async () => {
  const { container, dom, unmount } = await mount();
  try {
    const tiles = [...container.querySelectorAll('.add-elements-tile')];
    assert.ok(tiles.length > 100, 'every tile is drawn with every group open');
    const view = dom.window;
    for (const label of container.querySelectorAll('.add-elements-label')) {
      assert.doesNotMatch(label.className, /ellipsis|truncate|clamp/, 'no label carries a cutting class');
      const style = view.getComputedStyle(label);
      assert.notEqual(style.textOverflow, 'ellipsis', `${label.textContent} is not cut with an ellipsis`);
      assert.notEqual(style.whiteSpace, 'nowrap', `${label.textContent} may wrap onto a second line`);
      assert.notEqual(style.overflow, 'hidden', `${label.textContent} is not clipped`);
    }
    // One height: no tile sets its own, every tile takes the panel's token as its minimum, and each grid row is at
    // least that tall, so a row of one-line names and a row of two-line names are the same height.
    const heights = new Set(tiles.map((tile) => view.getComputedStyle(tile).minHeight));
    assert.deepEqual([...heights], ['var(--add-elements-tile-height)']);
    for (const tile of tiles) {
      assert.equal(tile.style.height, '', 'no tile sets an inline height');
    }
    const grid = container.querySelector('.add-elements-grid');
    assert.equal(view.getComputedStyle(grid).gridTemplateColumns, 'repeat(3, minmax(0, 1fr))');
    assert.equal(view.getComputedStyle(grid).gridAutoRows, 'minmax(var(--add-elements-tile-height), auto)');
  } finally {
    await unmount();
  }
});

test('the stylesheet cuts no tile name and lines the grid up with the search box', () => {
  const rule = (selector) => {
    const start = stylesheet.indexOf(`\n${selector} {`);
    assert.ok(start >= 0, `${selector} has a rule`);
    return stylesheet.slice(start, stylesheet.indexOf('}', start));
  };
  const label = rule('.add-elements-label');
  assert.doesNotMatch(label, /text-overflow|white-space:\s*nowrap|line-clamp|overflow:\s*hidden/);
  assert.match(label, /overflow-wrap:\s*break-word/);
  assert.match(label, /hyphens:\s*manual/, 'no automatic hyphenation: it split words a line could keep whole');
  assert.match(label, /text-wrap:\s*balance/);
  assert.match(label, /min-height:\s*var\(--add-elements-label-height\)/, 'the name box keeps its line even when empty of text');
  // The body's start inset is the header's, and its end inset leaves room for the 8px gutter, so the grid's two
  // edges are the search box's two edges.
  const body = rule('.add-elements-body');
  assert.match(body, /scrollbar-gutter:\s*stable/);
  assert.match(body, /padding-inline:\s*var\(--add-elements-inset\) calc\(var\(--add-elements-inset\) - var\(--add-elements-scrollbar\)\)/);
  assert.doesNotMatch(stylesheet, /(^|\s)border(?!-radius)[a-z-]*:\s*(?!0|none)/m, 'tiles are set apart by fills, not borders');
  const unmarkedPhysical = stylesheet
    .split('\n')
    .filter((line) => /\b(margin|padding)-(left|right)\b|\b(left|right):/.test(line) && !line.includes('/* physical:'));
  assert.deepEqual(unmarkedPhysical, [], 'logical properties only, for right-to-left, unless a line says why');
});

test('group headers are a sentence-case name and a chevron, and the sections are headings', async () => {
  const { container, dom, unmount } = await mount();
  try {
    const sections = [...container.querySelectorAll('h3.add-elements-section')].map((heading) => heading.textContent);
    assert.deepEqual(sections, ['HTML', 'Astro']);
    const toggle = container.querySelector('.add-elements-toggle');
    assert.ok(toggle);
    assert.equal(toggle.querySelector('.add-elements-group-name')?.textContent, 'Structure');
    assert.equal(toggle.querySelector('.add-elements-count') === null, true, 'no tile count: the header is the name and the chevron');
    assert.equal(toggle.children.length, 2);
    const style = dom.window.getComputedStyle(toggle);
    assert.notEqual(style.textTransform, 'uppercase');
    assert.equal(toggle.classList.contains('panel-block-toggle'), false, 'not the uppercase panel-block header');
    // The name leads the row; the chevron ends it.
    assert.equal(toggle.firstElementChild?.className, 'add-elements-group-name');
    assert.equal(toggle.lastElementChild?.className, 'add-elements-chevron');
  } finally {
    await unmount();
  }
});

test('a folded group stays folded when the panel is opened again in the same session', async () => {
  const first = await mount();
  const { React } = first;
  try {
    const toggle = first.container.querySelector('.add-elements-toggle');
    assert.equal(toggle?.getAttribute('aria-expanded'), 'true');
    await React.act(async () => toggle?.dispatchEvent(new first.dom.window.MouseEvent('click', { bubbles: true })));
    assert.equal(first.container.querySelector('.add-elements-toggle')?.getAttribute('aria-expanded'), 'false');
  } finally {
    await first.unmount();
  }
  const second = await mount();
  try {
    const toggle = second.container.querySelector('.add-elements-toggle');
    assert.equal(toggle?.getAttribute('aria-expanded'), 'false', 'remembered across a remount');
    // Unfold again, so the memory is left as the other tests expect it.
    await second.React.act(async () => toggle?.dispatchEvent(new second.dom.window.MouseEvent('click', { bubbles: true })));
    assert.equal(second.container.querySelector('.add-elements-toggle')?.getAttribute('aria-expanded'), 'true');
  } finally {
    await second.unmount();
  }
});

test('the clear button empties the search and shows only while there is text', async () => {
  const { React, container, unmount } = await mount();
  const { Simulate } = require('react-dom/test-utils');
  try {
    assert.equal(container.querySelector('.panel-search-clear') === null, true, 'an empty box has no clear button');
    const input = container.querySelector('.panel-search input');
    assert.ok(input);
    // PanelSearch reads the box's own value (currentTarget), so the value is set on the element before the event.
    input.value = 'zzzz-nothing';
    await React.act(async () => Simulate.change(input));
    assert.match(container.querySelector('.props-empty')?.textContent ?? '', /zzzz-nothing/, 'the empty state names the search');
    const clear = container.querySelector('.panel-search-clear');
    assert.ok(clear);
    assert.equal(clear.getAttribute('aria-label'), 'Clear search');
    await React.act(async () => Simulate.click(clear));
    assert.equal(container.querySelector('.panel-search-clear') === null, true, 'the button goes with the text');
    assert.ok(container.querySelectorAll('.add-elements-tile').length > 100, 'every tile is back');
  } finally {
    await unmount();
  }
});

test('the header button folds every group, then opens them all, and waits out a search', async () => {
  const { React, container, unmount } = await mount();
  const { Simulate } = require('react-dom/test-utils');
  const button = () => container.querySelector('.panel-header-actions button');
  const expanded = () => [...container.querySelectorAll('.add-elements-toggle')].map((toggle) => toggle.getAttribute('aria-expanded'));
  try {
    // Every group open: the button offers to fold, with the Navigator's wording.
    assert.equal(button()?.getAttribute('aria-label'), 'Collapse all');
    await React.act(async () => Simulate.click(button()));
    assert.ok(
      expanded().every((state) => state === 'false'),
      'every group, HTML and Astro, is folded',
    );
    assert.equal(container.querySelectorAll('.add-elements-tile').length, 0);
    assert.equal(button()?.getAttribute('aria-label'), 'Expand all', 'once all are folded it offers to open them');

    // A search opens every matching group and disables the button, whose press would change nothing visible.
    const input = container.querySelector('.panel-search input');
    input.value = 'heading';
    await React.act(async () => Simulate.change(input));
    assert.equal(button()?.disabled, true);
    assert.ok(container.querySelectorAll('.add-elements-tile').length > 0, 'the matches show though their group is folded');
    input.value = '';
    await React.act(async () => Simulate.change(input));
    assert.equal(button()?.disabled, false);
    assert.ok(
      expanded().every((state) => state === 'false'),
      'the folds come back after the search',
    );

    // One group opened by hand: some group is open again, so the button folds.
    await React.act(async () => Simulate.click(container.querySelector('.add-elements-toggle')));
    assert.equal(button()?.getAttribute('aria-label'), 'Collapse all');
    await React.act(async () => Simulate.click(button()));
    assert.equal(button()?.getAttribute('aria-label'), 'Expand all');
    await React.act(async () => Simulate.click(button()));
    assert.ok(
      expanded().every((state) => state === 'true'),
      'Expand all opens every group',
    );
    assert.equal(button()?.getAttribute('aria-label'), 'Collapse all');
  } finally {
    await unmount();
  }
});

test('arrow keys skip the tiles of a folded group', async () => {
  const { React, container, unmount } = await mount();
  const { Simulate } = require('react-dom/test-utils');
  const focusedId = () => document.activeElement?.getAttribute('data-tile-id');
  const structure = () => container.querySelector('.add-elements-toggle');
  try {
    await React.act(async () => Simulate.click(structure()));
    assert.equal(structure()?.getAttribute('aria-expanded'), 'false');
    const input = container.querySelector('.panel-search input');
    await React.act(async () => Simulate.keyDown(input, { key: 'ArrowDown' }));
    assert.equal(focusedId(), 'tag:h1', 'the first tile shown is Typography’s: Structure’s are skipped');
    // The focused tile's tip is the shared fitted one (FittedTooltip), which keeps it inside the window.
    const tip = container.querySelector('.rail-tooltip.add-elements-tip');
    assert.equal(tip?.getAttribute('data-fitted'), 'true');
    assert.match(tip?.textContent ?? '', /Heading 1.*<h1>/);
    await React.act(async () => Simulate.keyDown(document.activeElement, { key: 'ArrowDown' }));
    assert.equal(focusedId(), 'tag:h4', 'down keeps the column within the open groups');
    await React.act(async () => Simulate.keyDown(document.activeElement, { key: 'ArrowUp' }));
    await React.act(async () => Simulate.keyDown(document.activeElement, { key: 'ArrowUp' }));
    assert.equal(focusedId(), 'tag:h1', 'up stops at the first open row, never in the folded group');
    // Leave every group open for the session memory the other tests share.
    await React.act(async () => Simulate.click(structure()));
  } finally {
    await unmount();
  }
});
