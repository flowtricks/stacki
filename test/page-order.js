// Where a site's front door sits in the list.
//
//   node test/page-order.js
//
// The Pages panel drew every folder first and then every page, and `index` is
// a page — so the home page of a site with folders in it sat underneath
// `about/`, `care/`, `get-involved/` and everything they held. The one page
// nobody has to look for was the one page you had to look for.
//
// `index.astro` is not a page inside a folder, it IS the folder: /about is
// that page, /about/story is a page beneath it. So it goes above the folders,
// at whatever level it is at, and everything else stays below them.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });

  // --- the rule ---------------------------------------------------------------
  const orderOut = path.join(buildDir, 'page-order.bundle.mjs');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'pageOrder.js')],
    outfile: orderOut,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const { comparePageNames, leadsFolders, pageRank } = await import(`file://${orderOut}?v=${Date.now()}`);

  check('the folder’s own page leads', leadsFolders('index.astro') === true);
  check('however it is spelled', leadsFolders('index') === true && leadsFolders('Index.astro') === true);
  check('an .mdx one too', leadsFolders('index.mdx') === true);
  check('a page merely starting with the word does not', leadsFolders('index-old.astro') === false);
  check('nor does anything else', leadsFolders('about.astro') === false && leadsFolders('404.astro') === false);
  check(
    'and among pages it still sorts first',
    ['story.astro', 'index.astro', '404.astro'].sort(comparePageNames)[0] === 'index.astro'
  );
  check('with the numbered ones last', ['story.astro', '404.astro'].sort(comparePageNames)[1] === '404.astro');
  check('naturally, not asciibetically', ['page-10.astro', 'page-2.astro'].sort(comparePageNames)[0] === 'page-2.astro');
  check('the rank is what says so', pageRank('index.astro') === 0 && pageRank('about.astro') === 1);

  // --- the panel that draws it --------------------------------------------------
  const entry = path.join(buildDir, 'page-order.entry.jsx');
  fs.writeFileSync(
    entry,
    `export { default as PagesPanel } from ${JSON.stringify(
      path.join(__dirname, '..', 'src', 'panels', 'PagesPanel.jsx')
    )};\n`
  );
  const bundle = path.join(buildDir, 'page-order.bundle.js');
  await esbuild.build({
    entryPoints: [entry],
    outfile: bundle,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.Element = dom.window.Element;
  global.HTMLElement = dom.window.HTMLElement;
  global.Node = dom.window.Node;
  global.MouseEvent = dom.window.MouseEvent;
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  global.ResizeObserver = dom.window.ResizeObserver;

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const { PagesPanel } = require(bundle);

  // A project shaped like the one that showed this: folders at the root, and
  // the home page among them.
  const page = (name) => ({ path: `/p/src/pages/${name}`, name, route: '/' + name.replace(/(index)?\.astro$/, '') });
  const scan = {
    pages: [
      page('about/beliefs.astro'),
      page('about/index.astro'),
      page('about/story.astro'),
      page('care/baptism.astro'),
      page('index.astro'),
      page('branding.astro'),
      page('404.astro'),
    ],
    pageFolders: ['about', 'care'],
  };

  const container = document.getElementById('root');
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(PagesPanel, {
        scan,
        currentPage: null,
        injectedRoutes: [],
        onSelectRoute: () => {},
        onSelect: () => {},
        onCreate: () => {},
        onDelete: () => {},
        onRescan: () => {},
        onMovePage: () => {},
        onCreateFolder: () => {},
        onRenameFolder: () => {},
        onDeleteFolder: () => {},
      })
    );
    await new Promise((r) => setTimeout(r, 30));
  });

  // What the list reads as, top to bottom: a folder row says its name, a page
  // row says its own.
  const listed = () =>
    [...container.querySelectorAll('.list-item')]
      .filter((el) => !el.classList.contains('pages-injected-head'))
      .map((el) => {
        const label = el.querySelector('.label')?.textContent?.trim() || '';
        return el.classList.contains('folder') ? `${label}/` : label;
      })
      .filter(Boolean);

  const order = listed();
  check('the site’s own page is the first thing in the list', order[0] === 'index', order.join(' · '));
  check('above every folder', order.indexOf('index') < order.indexOf('about/'), order.join(' · '));
  check('the folders are still together, in order', order.indexOf('about/') < order.indexOf('care/'), order.join(' · '));
  check('and the other root pages are still below them', order.indexOf('branding') > order.indexOf('care/'), order.join(' · '));
  check('a numbered page is still last', order[order.length - 1] === '404', order.join(' · '));
  check('nothing was lost on the way', order.length === 9, order.join(' · '));

  // The same rule one level down: `about/index` is the /about page itself, so
  // it leads what is inside the folder rather than sorting among it.
  const inFolder = order.slice(order.indexOf('about/') + 1, order.indexOf('care/'));
  check('a folder’s own page leads what is inside it', inFolder[0] === 'index', order.join(' · '));
  check('with the rest of the folder after it', inFolder.join() === 'index,beliefs,story', inFolder.join());

  // The row that leads is the folder's, not something that happens to be
  // called index: collapsing the folder takes it with it.
  await act(async () => {
    [...container.querySelectorAll('.list-item.folder')]
      .find((el) => el.textContent.includes('about'))
      ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
  });
  const closed = listed();
  check('closing the folder puts its own page away too', closed.filter((r) => r === 'index').length === 1, closed.join(' · '));
  check('and the site’s page is still at the top', closed[0] === 'index' && closed[1] === 'about/', closed.join(' · '));

  if (failures.length) {
    console.error(`\npage-order: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`page-order: ${checked} passed  [the front door is not filed under the furniture]`);
  process.exit(0);
})();
