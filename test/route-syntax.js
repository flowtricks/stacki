// The filename Astro routes with, surviving the panel that lists it.
//
//   node test/route-syntax.js
//
// `[slug]`, `[...rest]` and the dots inside them are not decoration: they are
// what makes a route dynamic, and Astro only consults `getStaticPaths` for a
// dynamic route. So rewriting `[...path].astro` to `-path-.astro` does not
// merely break a URL — it silently disables the export a page was using to
// keep itself out of a production build, and the build says nothing.
//
// The rename ran without anyone asking for one. The inline field commits on
// blur with the current name pre-filled, and the "did anything change?" guard
// compared the SANITIZED candidate against the original — which for a
// bracketed name can never match. So arming the field and clicking away, a
// gesture indistinguishable from opening the page, rewrote the file. Escape
// did it too, by "cancelling" through the same sanitizer.
//
// Two rules, then: the change is judged on what was typed, before sanitizing,
// and the sanitizer keeps the characters Astro routes with.

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

  const entry = path.join(buildDir, 'route-syntax.entry.jsx');
  fs.writeFileSync(
    entry,
    `export { default as PagesPanel } from ${JSON.stringify(
      path.join(__dirname, '..', 'src', 'panels', 'PagesPanel.jsx')
    )};\n`
  );
  const bundle = path.join(buildDir, 'route-syntax.bundle.js');
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
  global.KeyboardEvent = dom.window.KeyboardEvent;
  global.FocusEvent = dom.window.FocusEvent;
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  global.ResizeObserver = dom.window.ResizeObserver;

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const { PagesPanel } = require(bundle);

  // A project with the routes from the report in it, dynamic and static both.
  const page = (name) => ({
    path: `/p/src/pages/${name}`,
    name,
    route: '/' + name.replace(/\.astro$/, ''),
  });
  const scan = {
    pages: [page('kitchen-sink/[...path].astro'), page('blog/[slug].astro'), page('about.astro')],
    pageFolders: ['kitchen-sink', 'blog', '[lang]'],
  };

  const moves = [];
  const folderRenames = [];
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
        onMovePage: (p, to) => moves.push([p.name, to]),
        onCreateFolder: () => {},
        onRenameFolder: (from, to) => folderRenames.push([from, to]),
        onDeleteFolder: () => {},
      })
    );
    await new Promise((r) => setTimeout(r, 30));
  });

  const rowFor = (label, folder) =>
    [...container.querySelectorAll(`.list-item${folder ? '.folder' : ':not(.folder)'}`)].find(
      (el) => el.querySelector('.label')?.textContent?.trim() === label
    );

  // Double-click arms the inline field, which is what makes this reachable
  // without meaning to: it is also how you open a page in a file tree.
  const arm = async (label, folder) => {
    const row = rowFor(label, folder);
    if (!row) return null;
    await act(async () => {
      row.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
    return container.querySelector('.rename-input');
  };

  const type = async (input, value) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        'value'
      ).set;
      setter.call(input, value);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 10));
    });
  };

  const blur = async (input) => {
    await act(async () => {
      input.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
  };

  const press = async (input, key) => {
    await act(async () => {
      input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
  };

  const seen = (list) => JSON.stringify(list);

  // --- the report: opening a dynamic route rewrote it -------------------------
  let input = await arm('[...path]');
  check('a dynamic route can be renamed at all', !!input);
  check('the field starts on the name the file already has', input?.value === '[...path]', input?.value);
  await blur(input);
  check('clicking away from an untouched field renames nothing', moves.length === 0, seen(moves));

  // --- Escape cancelled by committing ----------------------------------------
  input = await arm('[slug]');
  await press(input, 'Escape');
  check('and neither does escaping out of it', moves.length === 0, seen(moves));

  // --- a static name was never at risk, and still is not ---------------------
  input = await arm('about');
  await blur(input);
  check('a plain name confirmed unchanged is still a no-op', moves.length === 0, seen(moves));

  // --- a rename that IS asked for keeps the routing syntax --------------------
  input = await arm('[...path]');
  await type(input, '[...slug]');
  await press(input, 'Enter');
  check(
    'renaming one dynamic route to another keeps the brackets and the dots',
    moves.length === 1 && moves[0][1] === 'kitchen-sink/[...slug].astro',
    seen(moves)
  );

  moves.length = 0;
  input = await arm('about');
  await type(input, '[id]');
  await press(input, 'Enter');
  check(
    'and a static page can be turned into a dynamic one',
    moves.length === 1 && moves[0][1] === '[id].astro',
    seen(moves)
  );

  // --- what the sanitizer still has to stop ----------------------------------
  moves.length = 0;
  input = await arm('[slug]');
  await type(input, '../../escape');
  await press(input, 'Enter');
  check(
    'a rename is one segment: separators do not survive it',
    moves.length === 1 && moves[0][1] === 'blog/escape.astro',
    seen(moves)
  );

  moves.length = 0;
  input = await arm('[slug]');
  await type(input, '..');
  await press(input, 'Enter');
  check('and a name that is only dots is not a name', moves.length === 0, seen(moves));

  moves.length = 0;
  input = await arm('[slug]');
  await type(input, 'my page!');
  await press(input, 'Enter');
  check(
    'everything Astro does not route with is still tidied away',
    moves.length === 1 && moves[0][1] === 'blog/my-page-.astro',
    seen(moves)
  );

  // --- folders route too: `src/pages/[lang]/about.astro` ----------------------
  let folderInput = await arm('[lang]', true);
  check('a bracketed folder can be renamed too', !!folderInput);
  await blur(folderInput);
  check('confirming its own name leaves it alone', folderRenames.length === 0, seen(folderRenames));

  folderInput = await arm('[lang]', true);
  await type(folderInput, '[locale]');
  await press(folderInput, 'Enter');
  check(
    'and renaming it keeps the brackets',
    folderRenames.length === 1 && folderRenames[0][1] === '[locale]',
    seen(folderRenames)
  );

  // --- and the same syntax has to be typeable in the first place -------------
  //
  // The New Page field sanitized with `[^a-zA-Z0-9/_-]+`, which meant a
  // dynamic route could never be CREATED here either — the other half of the
  // same blind spot. This exercises the rule the handler actually calls, not a
  // copy of it.
  const { pageFileName } = require(path.join(__dirname, '..', 'electron', 'pageName.js'));
  const saved = (typed, want) =>
    check(
      `"${typed}" is created as ${want || 'nothing'}`,
      pageFileName(typed) === want,
      pageFileName(typed)
    );

  saved('[...path]', '[...path]');
  saved('[slug]', '[slug]');
  saved('blog/[slug]', 'blog/[slug]');
  saved('[lang]/index', '[lang]/index');
  saved('[...slug].astro', '[...slug]');
  saved('about', 'about');
  saved('my page!', 'my-page-');
  saved('../../evil', 'evil');
  saved('..', '');
  saved('////', '');
  saved('.hidden', 'hidden');

  // The name keeps `/`, so where it lands is checked rather than assumed.
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  const createHandler = mainSrc.slice(
    mainSrc.indexOf("ipcMain.handle('page:create'"),
    mainSrc.indexOf("ipcMain.handle('page:delete'")
  );
  check(
    'creation goes through that one rule',
    /pageFileName\(name\)/.test(createHandler),
    createHandler.slice(0, 300)
  );
  check(
    'and a page can only be written inside src/pages',
    /startsWith\(pagesDir \+ path\.sep\)/.test(createHandler),
    createHandler.slice(0, 400)
  );

  if (failures.length) {
    console.error(`\nroute-syntax: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`route-syntax: ${checked} passed  [the brackets are the route, not the label]`);
  process.exit(0);
})();
