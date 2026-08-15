// The dropdown, and the entry picker built on it.
//
//   node test/dropdown.js
//
// A dynamic route's picker lists one option per entry of a collection, so it
// grows with the content: sixty posts is a scroll unless it can be filtered,
// and every option in it is a page the collection generates, which the rest of
// the app draws in purple with a page glyph. This checks the parts of that
// which are easy to break by accident — the filter box narrowing the list, the
// keyboard still landing on the right option once it has, and the classes the
// colour hangs off.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const bundlePath = path.join(buildDir, 'dynamic-picker.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'ui', 'DynamicPicker.jsx')],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has no layout, so it has no scrollIntoView; the popup calls it to
  // keep the highlighted option visible.
  dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = require('react');
  const DynamicPicker = require(bundlePath).default;

  const container = dom.window.document.getElementById('root');
  const reactRoot = createRoot(container);
  const body = dom.window.document.body;
  const all = (selector) => [...body.querySelectorAll(selector)];
  const find = (selector) => body.querySelector(selector);

  const ids = [
    '2025/editorial-calendar-notes',
    '2025/the-cost-of-a-thousand-images',
    '2026/spring/an-mdx-post-with-components',
    '2026/spring/loaders-from-scratch',
    '2026/spring/translating-a-site-without-losing-your-mind',
    'schema-design-for-editors',
    'what-changed-in-the-content-layer',
  ];
  let picked = null;

  const render = (entries) =>
    act(async () => {
      reactRoot.render(
        React.createElement(DynamicPicker, {
          entries: entries.map((label) => ({ label })),
          index: 0,
          onPick: (i) => {
            picked = i;
          },
        })
      );
      await settle(20);
    });

  await render(ids);
  check('the trigger reads as a generated route', !!find('.dd-trigger.collection'));
  check('and carries a page glyph', !!find('.dd-trigger .dd-icon svg'));
  check('showing the current entry', /editorial-calendar-notes/.test(find('.dd-label')?.textContent || ''));

  await act(async () => {
    find('.dd-trigger').click();
    await settle(20);
  });
  check('the popup opens', !!find('.dd-popup'));
  check('purple carries into the list', !!find('.dd-popup.collection'));
  check('every option has a glyph', all('.dd-option .dd-icon svg').length === ids.length, `${all('.dd-option .dd-icon svg').length}`);
  check('the current one is ticked', !!find('.dd-option.selected .dd-check svg'));
  check('the list has a filter box', !!find('.dd-search'));

  // Typing narrows it.
  await act(async () => {
    const input = find('.dd-search');
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'spring');
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await settle(20);
  });
  check('the filter narrows the list', all('.dd-option').length === 3, `${all('.dd-option').length} shown`);
  check(
    'to the options that match',
    all('.dd-option').every((node) => /spring/.test(node.textContent))
  );

  // And Enter picks what the filtered list is highlighting, not what the
  // unfiltered one would have.
  await act(async () => {
    find('.dd-search').dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    );
    await settle(20);
  });
  check('Enter picks from the filtered list', picked === 2, `picked index ${picked}`);
  check('and the popup closes', !find('.dd-popup'));

  // However few entries a collection has. A box that appears at some number of
  // posts is a box nobody can rely on.
  await render(ids.slice(0, 3));
  await act(async () => {
    find('.dd-trigger').click();
    await settle(20);
  });
  check('a short list has one too', !!find('.dd-search'));
  check('and still has its glyphs', all('.dd-option .dd-icon svg').length === 3);

  await act(async () => reactRoot.unmount());

  if (failures.length) {
    console.error(`\ndropdown: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`dropdown: ${checked} passed`);
})();
