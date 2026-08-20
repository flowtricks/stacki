// Folding a folder shut in the Components panel.
//
//   node test/palette-folds.js
//
// The panel already grouped by folder — what it could not do is put a group
// away, which is the whole use for grouping once a project has more components
// than fit on a screen.
//
// Three things here are easy to get wrong and invisible when they are:
//
//   search   a fold that survives filtering hides the results of the search
//            inside it, and the panel looks like it found nothing
//   scope    folds are remembered per project; a folder called "marketing" in
//            one site says nothing about another
//   the root src/components' own files have no header to click, so they must
//            never be what a fold hides

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

const comp = (name, folder = '') => ({ name, folder, path: `/p/src/components/${folder}${name}.astro` });

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const bundlePath = path.join(buildDir, 'palette.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'panels', 'PalettePanel.jsx')],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.localStorage = dom.window.localStorage;
  global.IS_REACT_ACT_ENVIRONMENT = true;

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = require('react');
  const PalettePanel = require(bundlePath).default;

  const components = [
    comp('Header'),
    comp('Footer'),
    comp('Hero', 'marketing/'),
    comp('Pricing', 'marketing/'),
    comp('Field', 'forms/'),
  ];
  // The folder each one reports is the group key, not the path it was built from.
  components[2].folder = 'marketing';
  components[3].folder = 'marketing';
  components[4].folder = 'forms';

  const container = dom.window.document.getElementById('root');
  let root = createRoot(container);
  const render = async (project = { path: '/p' }) => {
    await act(async () =>
      root.render(
        React.createElement(PalettePanel, {
          project,
          components,
          devUrl: null,
          onInsert: () => {},
          onDragBegin: () => {},
        })
      )
    );
  };

  const $ = (sel) => [...dom.window.document.querySelectorAll(sel)];
  const names = () => $('.palette-item .label').map((el) => el.textContent.trim());
  const headers = () => $('.palette-folder');
  const headerFor = (folder) =>
    headers().find((h) => h.querySelector('.palette-folder-name')?.textContent === folder);
  const click = async (el) => {
    await act(async () => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  };
  const type = async (value) => {
    await act(async () => {
      const el = dom.window.document.querySelector('input');
      const setter = Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        'value'
      ).set;
      setter.call(el, value);
      el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };

  await render();

  check('every folder gets a header', headers().length === 2, String(headers().length));
  check('saying how many are in it', headerFor('marketing')?.querySelector('.palette-folder-count')?.textContent === '2');
  check('and everything starts open', names().length === 5, names().join(','));

  await click(headerFor('marketing'));
  check('folding one hides its components', !names().some((n) => /Hero|Pricing/.test(n)), names().join(','));
  check('and only its own', names().some((n) => /Field/.test(n)), names().join(','));
  check('the root files are never hidden', names().some((n) => /Header/.test(n)), names().join(','));
  check('its header stays, to open it again', !!headerFor('marketing'));

  // The search must not be answered by a fold.
  await type('hero');
  check('a search opens what it needs to show', names().some((n) => /Hero/.test(n)), names().join(','));
  await type('');
  check('and the fold is remembered, not lost', !names().some((n) => /Hero/.test(n)), names().join(','));

  // Remounting is what happens on every trip to another left tab.
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  check('the fold survives leaving the panel', !names().some((n) => /Hero/.test(n)), names().join(','));

  await act(async () => root.unmount());
  root = createRoot(container);
  await render({ path: '/other-project' });
  check(
    'another project does not inherit it',
    names().some((n) => /Hero/.test(n)),
    names().join(',')
  );

  // Collapse-all, the way to look at one group and nothing else.
  const allButton = () => dom.window.document.querySelector('.panel-header button');
  await click(allButton());
  check('collapse-all folds every folder', names().length === 2, names().join(','));
  check('leaving the ungrouped files alone', names().join(',') === 'Header,Footer', names().join(','));
  await click(allButton());
  check('and opens them again', names().length === 5, names().join(','));

  // A corrupt value is not a reason to fail to draw a panel.
  await act(async () => root.unmount());
  dom.window.localStorage.setItem('stacki.paletteFolds', 'not json');
  root = createRoot(container);
  let threw = null;
  try {
    await render();
  } catch (err) {
    threw = err;
  }
  check('a corrupt stored value is ignored, not thrown', !threw, String(threw));
  check('and everything shows', names().length === 5, names().join(','));

  if (failures.length) {
    console.error(`palette-folds: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`palette-folds: ${checked} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
