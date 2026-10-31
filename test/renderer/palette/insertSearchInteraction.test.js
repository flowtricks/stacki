// Goal: same-named components remain distinct while the insert search filters its rows.
// Method: mount the real palette, type and navigate results, and inspect rows and insert targets.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

test('duplicate component names cannot leave stale highlighted search results', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { Simulate } = require('react-dom/test-utils');
  const directory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(directory, { recursive: true });
  const output = path.join(directory, 'insert-search-interaction.cjs');
  buildSync({
    entryPoints: [repoPath('src/features/palette/InsertSearch.tsx')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
  });
  const InsertSearch = require(output).default;
  const container = document.getElementById('root');
  const root = createRoot(container);
  const inserted = [];
  const components = [
    { name: 'PlanYourVisit', folder: 'Forms', path: '/components/Forms/PlanYourVisit.astro' },
    { name: 'PlanYourVisit', folder: 'Section', path: '/components/Section/PlanYourVisit.astro' },
    { name: 'Paragraph', folder: 'Typography', path: '/components/Typography/Paragraph.astro' },
  ];
  const labels = () =>
    [...container.querySelectorAll('.insert-item-label')].map((row) => row.textContent);
  const highlighted = () => container.querySelectorAll('.insert-item.highlight');
  const query = async (value) => {
    await React.act(async () => {
      Simulate.change(container.querySelector('input'), { target: { value } });
    });
  };
  try {
    await React.act(async () => {
      root.render(
        React.createElement(InsertSearch, {
          components,
          onInsert: (item) => inserted.push(item),
          onClose() {},
        }),
      );
    });
    // "paragraph" also names the `<p>` element, listed after matching components.
    await query('paragraph');
    assert.deepEqual(
      labels(),
      ['Paragraph', '<p>'],
      'unmatched duplicate names must leave the DOM',
    );
    assert.equal(highlighted().length, 1);
    await query('plan');
    assert.deepEqual(labels(), ['PlanYourVisit', 'PlanYourVisit']);
    await React.act(async () => {
      Simulate.mouseEnter(container.querySelectorAll('.insert-item')[1]);
    });
    assert.equal(highlighted().length, 1, 'pointer navigation keeps one active row');
    await React.act(async () => {
      Simulate.keyDown(container.querySelector('input'), { key: 'Enter' });
    });
    assert.equal(inserted[0].path, components[1].path, 'Enter inserts the highlighted file');
    await query('paragraph');
    assert.deepEqual(labels(), ['Paragraph', '<p>']);
    assert.equal(highlighted().length, 1);
    await query('no-such-component');
    assert.deepEqual(labels(), []);
    assert.equal(highlighted().length, 0);
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
  }
});
