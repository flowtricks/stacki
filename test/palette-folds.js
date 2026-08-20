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
  // The panel and the dialog host go in one bundle, because the panel asks a
  // question through a module-level handle the host installs — two bundles are
  // two copies of that module and the question is asked of nobody. Which is
  // exactly how "New folder…" shipped broken: `confirmDialog` with no host
  // answers no, and a test rendering only the panel never noticed.
  const entry = path.join(buildDir, 'palette-entry.jsx');
  fs.writeFileSync(
    entry,
    "export { default } from '" +
      path.join(__dirname, '..', 'src', 'panels', 'PalettePanel.jsx') +
      "';\nexport { ConfirmHost } from '" +
      path.join(__dirname, '..', 'src', 'ui', 'ConfirmDialog.jsx') +
      "';\n",
    'utf8'
  );
  await esbuild.build({
    entryPoints: [entry],
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
  const { ConfirmHost } = require(bundlePath);

  const components = [
    comp('Header'),
    comp('Footer'),
    comp('Hero', 'marketing/'),
    comp('Pricing', 'marketing/'),
    comp('Field', 'forms/'),
    { name: 'Base', folder: 'layouts', isLayout: true, path: '/p/src/layouts/Base.astro' },
  ];
  // The folder each one reports is the group key, not the path it was built from.
  components[2].folder = 'marketing';
  components[3].folder = 'marketing';
  components[4].folder = 'forms';

  const moved = [];
  const container = dom.window.document.getElementById('root');
  let root = createRoot(container);
  const render = async (project = { path: '/p' }) => {
    await act(async () =>
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(ConfirmHost),
          React.createElement(PalettePanel, {
          project,
          components,
          devUrl: null,
          onInsert: () => {},
          onDragBegin: () => {},
          onMove: (comp, folder) => moved.push([comp.name, folder]),
          })
        )
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

  check('every folder gets a header', headers().length === 3, String(headers().length));
  check('saying how many are in it', headerFor('marketing')?.querySelector('.palette-folder-count')?.textContent === '2');
  check('and everything starts open', names().length === 6, names().join(','));

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
  check('and opens them again', names().length === 6, names().join(','));

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
  check('and everything shows', names().length === 6, names().join(','));

  // --- the header control stays put ----------------------------------------
  //
  // It used to be rendered only while a folder was visible, so a search that
  // matched nothing took it out of the header and everything under it jumped by
  // its height. Whether folders exist is not a question about the search.

  await act(async () => root.unmount());
  dom.window.localStorage.clear();
  root = createRoot(container);
  await render();

  const foldAll = () => dom.window.document.querySelector('.panel-header button');
  check('the control is in the header', !!foldAll());
  check('and live, with folders to fold', foldAll().disabled === false);

  await type('aa'); // matches nothing at all
  check('a search that finds nothing keeps it there', !!foldAll(), 'the header lost its button');
  check('greyed rather than gone', foldAll().disabled === true);
  check('saying why', /while you search/.test(foldAll().title), foldAll().title);
  await type('');
  check('and live again once the search is over', foldAll().disabled === false);

  // --- filing a component into a folder ------------------------------------

  await act(async () => root.unmount());
  dom.window.localStorage.clear();
  root = createRoot(container);
  await render();

  const rowFor = (name) =>
    $('.palette-item').find((el) => el.querySelector('.label')?.textContent.trim().startsWith(name));
  const rightClick = async (el) => {
    await act(async () =>
      el.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    );
  };
  const menu = () => $('.ctx-menu .ctx-menu-item').map((el) => el.textContent.trim());

  await rightClick(rowFor('Header'));
  check('a root component is offered every folder', menu().includes('Move to marketing') && menu().includes('Move to forms'), menu().join(' | '));
  check(
    'and not a move to where it already is',
    !menu().includes('Move to Components'),
    menu().join(' | ')
  );
  check('with a new folder always available', menu().includes('New folder…'), menu().join(' | '));
  // src/layouts is a group in this panel, not a folder under src/components:
  // filing a component "into layouts" would make a src/components/layouts.
  check(
    'but the layouts group is not somewhere to file a component',
    !menu().includes('Move to layouts'),
    menu().join(' | ')
  );

  await act(async () =>
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  );
  check('Escape closes it', $('.ctx-menu').length === 0);

  await rightClick(rowFor('Hero'));
  check('one already in a folder can come back out', menu().includes('Move to Components'), menu().join(' | '));
  check('and go sideways', menu().includes('Move to forms'), menu().join(' | '));
  check('but is not offered its own folder', !menu().includes('Move to marketing'), menu().join(' | '));

  await act(async () =>
    $('.ctx-menu .ctx-menu-item')
      .find((el) => el.textContent.trim() === 'Move to forms')
      .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );
  check('choosing one asks for the move', JSON.stringify(moved) === '[["Hero","forms"]]', JSON.stringify(moved));
  check('and closes the menu', $('.ctx-menu').length === 0);

  // --- naming a new folder ---------------------------------------------------
  //
  // The whole point of the menu: with no folders yet, this is the ONLY way to
  // make one, so a dialog that does not ask for a name leaves the panel with a
  // feature that cannot be used at all.

  moved.length = 0;
  await rightClick(rowFor('Header'));
  await act(async () =>
    $('.ctx-menu .ctx-menu-item')
      .find((el) => el.textContent.trim() === 'New folder…')
      .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  );

  const field = () => dom.window.document.querySelector('.confirm-field input');
  const confirmBtn = () => dom.window.document.querySelector('.modal-footer button.primary');

  // Everything below types into that field, so a missing one is reported as the
  // one failure it is rather than thrown as a TypeError five lines later. This
  // is how it shipped: the dialog rendered its title, its body and its buttons,
  // and no way to answer.
  check(
    'a field is what it asks with',
    !!field(),
    `the dialog rendered: ${dom.window.document.querySelector('.modal')?.textContent}`
  );
  if (!field()) {
    check('…so the rest of this cannot be checked', false, 'no input to type a folder name into');
  } else {
  check('and it holds the focus', dom.window.document.activeElement === field());
  check('with nothing typed, it cannot be confirmed', confirmBtn()?.disabled === true);

  await act(async () => {
    const el = field();
    const setter = Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      'value'
    ).set;
    setter.call(el, 'marketing');
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  check(
    'a name that is already a folder is refused',
    confirmBtn()?.disabled === true,
    dom.window.document.querySelector('.confirm-field-problem')?.textContent
  );

  const typeName = async (value) => {
    await act(async () => {
      const el = field();
      const setter = Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        'value'
      ).set;
      setter.call(el, value);
      el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };

  // Held to lowercase at the point of naming, so the row in the panel and the
  // directory on disk say the same thing. Refused out loud rather than
  // corrected behind the typing.
  await typeName('Blog');
  check('a capital is refused', confirmBtn()?.disabled === true);
  check(
    'and says why',
    /lowercase/i.test(dom.window.document.querySelector('.confirm-field-problem')?.textContent || ''),
    dom.window.document.querySelector('.confirm-field-problem')?.textContent
  );

  await typeName('blog');
  check('a new one is not', confirmBtn()?.disabled === false);

  await act(async () => confirmBtn().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  check(
    'and confirming moves it there under the name that was typed',
    JSON.stringify(moved) === '[["Header","blog"]]',
    JSON.stringify(moved)
  );
  }

  if (failures.length) {
    console.error(`palette-folds: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`palette-folds: ${checked} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
