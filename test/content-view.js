// The editor itself, mounted and used.
//
//   node test/content-view.js [projectDir]
//
// Everything else in this suite tests a layer: what the config says, what a
// file survives, what a field descriptor means. This one puts them together the
// way the app does — the real React panel, bound to the real main-process
// modules through a stand-in for the preload bridge, over a copy of a real
// project. Typing in it writes to disk, and what lands on disk is checked.
//
// The panel is built with the project's own esbuild (Vite's) because it is JSX,
// and rendered into jsdom because it is React.

const fs = require('fs');
const path = require('path');
const os = require('os');

const { readContentConfig, validateEntry, stopAllServices } = require('../electron/contentConfig.js');
const { listEntries, writeEntry, countEntries, coveredPaths } = require('../electron/contentEntries.js');
const frontmatter = require('../electron/formats/frontmatter.js');

const DEFAULT_FIXTURE = path.join(os.homedir(), 'Downloads', 'awesome-client-main');
const source = path.resolve(process.argv[2] || process.env.STACKI_CONTENT_FIXTURE || DEFAULT_FIXTURE);

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  if (!fs.existsSync(path.join(source, 'src', 'content.config.ts'))) {
    console.log(`content-view: skipped (no project at ${source})`);
    return;
  }

  const config = await readContentConfig(source, { force: true });
  if (config.error) {
    console.error(`content-view: could not read the config — ${config.error}`);
    process.exit(1);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-view-'));
  fs.cpSync(path.join(source, 'src'), path.join(root, 'src'), { recursive: true });

  // --- the panel, compiled ---------------------------------------------------
  const esbuild = require('esbuild');
  // Inside the repo, so `react` resolves the way it does for the app.
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const bundlePath = path.join(buildDir, 'content-view.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'panels', 'ContentView.jsx')],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    loader: { '.jsx': 'jsx' },
    external: ['react', 'react-dom', 'react/jsx-runtime', '@uiw/react-codemirror', '@codemirror/*', 'codemirror'],
    logLevel: 'silent',
  });

  // --- a browser, and the bridge the renderer talks to -----------------------
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.HTMLElement = dom.window.HTMLElement;
  global.Element = dom.window.Element;
  global.Node = dom.window.Node;
  global.getComputedStyle = dom.window.getComputedStyle;
  // The body field is a CodeMirror editor now: it observes the DOM it is
  // mounted in, and measures itself against the window class by name.
  global.MutationObserver = dom.window.MutationObserver;
  global.Window = dom.window.Window;
  global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  global.cancelAnimationFrame = clearTimeout;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has no layout, so it has no scrollIntoView; the popup calls it to
  // keep the highlighted option visible.
  dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};

  const collectionNamed = (name) => config.collections.find((c) => c.name === name);
  dom.window.avb = {
    contentEntries: async ({ name }) => ({ collection: collectionNamed(name), ...listEntries(root, collectionNamed(name)) }),
    contentTargets: async ({ name }) => ({
      targets: listEntries(root, collectionNamed(name)).entries.map((e) => ({ id: e.id, title: e.title })),
    }),
    contentCollections: async () => ({
      collections: config.collections.map((c) => ({ name: c.name, editable: c.editable, count: countEntries(root, c) })),
      covered: coveredPaths(config.collections),
    }),
    writeContentEntry: async ({ entry, edits, body }) => writeEntry(root, entry, edits, { body }),
    validateContentEntry: async ({ collection, data }) => validateEntry(source, { collection, data }),
    contentRenamePlan: async () => ({ move: { kind: 'file' }, pointers: [] }),
    renameContentEntry: async () => ({ ok: true }),
    listAssets: async () => ({ entries: [] }),
    onAssetsChanged: () => () => {},
    onCmsChanged: () => () => {},
  };

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = require('react');
  const ContentView = require(bundlePath).default;

  const container = dom.window.document.getElementById('root');
  const reactRoot = createRoot(container);
  const project = { path: root };

  const mount = async (name) => {
    await act(async () => {
      reactRoot.render(React.createElement(ContentView, { project, name, hidden: false, onClose: () => {} }));
      await settle(60);
    });
  };
  const text = () => container.textContent;
  const find = (selector) => container.querySelector(selector);
  const all = (selector) => [...container.querySelectorAll(selector)];
  const labelled = (label) =>
    all('.cms-field').find((node) => node.querySelector('label')?.textContent.replace('*', '').trim() === label);

  // --- a markdown collection --------------------------------------------------
  await mount('blog');
  check('blog: entries are listed', all('.cms-item').length === 7, `${all('.cms-item').length} shown`);
  check('blog: the first entry opens', !!find('.cms-detail-title')?.textContent);
  check('blog: required fields are drawn', !!labelled('Title'));
  check('blog: a reference field is a picker', !!labelled('Author')?.querySelector('select'));
  check(
    'blog: the picker offers real entries',
    [...(labelled('Author')?.querySelectorAll('option') || [])].some((o) => /Avery Chen/.test(o.textContent)),
    labelled('Author')?.textContent
  );
  check('blog: tags are chips', (labelled('Tags')?.querySelectorAll('.content-chip') || []).length > 0);
  check('blog: the body is editable', !!find('textarea') && /Body/.test(text()));
  check('blog: a bounded field says so', /3–120 characters/.test(labelled('Title')?.textContent || ''));
  check(
    'blog: an absent optional field is offered, not drawn',
    all('.content-add-field').length > 0,
    'every optional field was drawn as an empty box'
  );

  // Typing in the title writes it to the file, and only it.
  {
    const entry = listEntries(root, collectionNamed('blog')).entries[0];
    const before = fs.readFileSync(path.join(root, entry.file), 'utf8');
    const input = labelled('Title').querySelector('input');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'A title typed into the editor');
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      await settle(700);
    });
    const after = fs.readFileSync(path.join(root, entry.file), 'utf8');
    check('blog: typing saves', frontmatter.parseData(after).title === 'A title typed into the editor');
    check(
      'blog: and touches one line',
      before.split('\n').filter((line, i) => line !== after.split('\n')[i]).length === 1
    );
    check('blog: the body is untouched', frontmatter.parse(before).body === frontmatter.parse(after).body);
  }

  // A value the schema forbids is reported rather than saved silently.
  {
    const input = labelled('Title').querySelector('input');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'ab');
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      await settle(700);
    });
    check('blog: too short is flagged', /At least 3 characters|Too small/.test(labelled('Title').textContent), labelled('Title').textContent);
  }

  // --- a union of blocks -------------------------------------------------------
  await mount('landingPages');
  check('landingPages: entries listed', all('.cms-item').length === 3);
  check('landingPages: blocks are a repeater', all('.cms-repeat-row').length > 1);
  check(
    'landingPages: each block says which kind it is',
    /Hero|Features|Cta/i.test(all('.cms-repeat-row')[0]?.textContent || ''),
    all('.cms-repeat-row')[0]?.textContent
  );

  // --- an entry-level union ----------------------------------------------------
  await mount('siteSettings');
  check('siteSettings: the kind is a switcher', !!find('.content-union-head select'));
  check(
    'siteSettings: with every kind offered',
    (find('.content-union-head select')?.querySelectorAll('option') || []).length === 5
  );

  // --- read-only collections ---------------------------------------------------
  await mount('releases');
  check('releases: nothing to edit', all('.cms-item').length === 0);
  check('releases: and it says why', /rebuilt from scratch|read-only|built by a loader/i.test(text()));

  // --- a parser-shaped collection ---------------------------------------------
  await mount('faqs');
  check('faqs: entries are flattened out of their groups', all('.cms-item').length === 8);
  check('faqs: the parser is declared', /parsed by a function/i.test(text()));
  check(
    'faqs: a field the parser invented is marked',
    /from the parser/i.test(text()),
    'category fields were shown as if they were editable'
  );

  // --- no schema at all --------------------------------------------------------
  await mount('legal');
  check('legal: frontmatter is still editable', all('.cms-field').length > 0);
  check('legal: it says what it is', /Frontmatter/.test(text()));

  await act(async () => reactRoot.unmount());
  fs.rmSync(root, { recursive: true, force: true });

  if (failures.length) {
    console.error(`\ncontent-view: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    stopAllServices();
    process.exit(1);
  }
  console.log(`content-view: ${checked} passed  [${path.basename(source)}]`);
  stopAllServices();
})();
