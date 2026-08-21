// Editing what a chip is bound to, per chip.
//
//   node test/chip-edit.js
//
// A prop value can hold more than one binding — `` `${media} ${theme}` `` is two
// purple chips in one field. Opening what a binding is DEFINED by used to be a
// pencil beside the field, and a pencil beside a field can only ever mean one
// thing: it was wired to the value only when the field held exactly one chip,
// so in a field holding two it silently did nothing at all.
//
// So it moved into the menu that a chip already opens, where "the value" is
// never ambiguous — it is the chip that was pressed. The failure this guards is
// the quiet one: a menu that opens on the second chip and offers to edit the
// first. Both chips are real here, and both are pressed.

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
  const entry = path.join(buildDir, 'chip-edit.entry.jsx');
  fs.writeFileSync(
    entry,
    `export { BindField } from ${JSON.stringify(path.join(__dirname, '..', 'src', 'panels', 'PropsPanel.jsx'))};\n`
  );
  const bundle = path.join(buildDir, 'chip-edit.bundle.js');
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
  global.MutationObserver = dom.window.MutationObserver;
  global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  global.DOMRect = dom.window.DOMRect;
  global.Window = dom.window.Window;
  global.Element = dom.window.Element;
  global.HTMLElement = dom.window.HTMLElement;
  global.Node = dom.window.Node;
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  global.ResizeObserver = dom.window.ResizeObserver;
  dom.window.Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 });
  dom.window.Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} });

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const { BindField } = require(bundle);

  // `media` is a const in this file; `theme` is imported from another. The two
  // have different answers to "edit it", which is how we can tell which chip
  // the menu is speaking for.
  const FRONTMATTER = 'const media = "(min-width: 40em)";\nconst spare = 1;\n';
  const IMPORTS = "import theme from '../lib/theme.js';\n";

  const mount = async (value) => {
    const host = document.createElement('div');
    document.getElementById('root').appendChild(host);
    const root = createRoot(host);
    const opened = [];
    const wrote = [];
    await act(async () => {
      root.render(
        React.createElement(BindField, {
          value,
          placeholder: '',
          bindCtx: {},
          dataCtx: {
            frontmatter: FRONTMATTER,
            imports: IMPORTS,
            onSetFrontmatter: (code) => wrote.push(code),
            onOpenSymbol: (name) => opened.push(name),
          },
          onChange: () => {},
        })
      );
    });
    const chips = () => [...host.querySelectorAll('.expr-chip')];
    const press = async (chip) => {
      await act(async () => {
        chip.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
      });
    };
    // Every action row in the open menu, by its text.
    const menuRows = () => [...document.querySelectorAll('.bind-menu .dp-foot')].map((r) => r.textContent.trim());
    // A missing row is a FAILURE, not a crash: this is exactly what regresses,
    // and a stack trace buries which case it was.
    const clickRow = async (match) => {
      const row = [...document.querySelectorAll('.bind-menu .dp-foot')].find((r) => r.textContent.includes(match));
      check(`the menu offers "${match}"`, !!row, `rows were ${JSON.stringify(menuRows())}`);
      if (!row) return false;
      await act(async () => {
        row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      });
      return true;
    };
    return {
      host, chips, press, menuRows, clickRow, opened, wrote,
      menuOpen: () => !!document.querySelector('.bind-menu'),
      done: async () => { await act(async () => root.unmount()); host.remove() },
    };
  };

  // --- Two chips in one field -----------------------------------------------
  {
    const m = await mount({ type: 'expr', value: '`${media} ${theme}`' });
    check('both bindings draw as chips', m.chips().length === 2, `${m.chips().length} chips: ${m.host.textContent}`);
    // The pencil that could only speak for one of them is gone.
    check('the field has no pencil beside it', !m.host.querySelector('.attr-asset-toggle'), m.host.innerHTML.slice(0, 200));

    // First chip: a const in this file, so the row offers to edit it here.
    await m.press(m.chips()[0]);
    check('pressing a chip opens the menu', m.menuOpen(), 'no menu');
    check(
      'and the menu offers to edit THAT chip',
      m.menuRows().some((t) => t === 'Edit media'),
      JSON.stringify(m.menuRows())
    );

    // Second chip: imported, so the row offers to open its file instead.
    await m.press(m.chips()[1]);
    check(
      'the second chip gets its own answer',
      m.menuRows().some((t) => t === 'Open where theme is defined'),
      JSON.stringify(m.menuRows())
    );
    check(
      'and not the first chip’s',
      !m.menuRows().some((t) => t.includes('media')),
      JSON.stringify(m.menuRows())
    );

    // …and taking it does the thing for the chip that was pressed.
    await m.clickRow('Open where theme');
    check('choosing it opens that symbol', m.opened.join(',') === 'theme', JSON.stringify(m.opened));
    check('and closes the menu', !m.menuOpen(), 'menu still open');

    // The local one edits in place, under the field, rather than opening a file.
    await m.press(m.chips()[0]);
    await m.clickRow('Edit media');
    check('editing a local const opens it in place', !!document.querySelector('.var-src'), 'no inline editor');
    check('and does not open a file', m.opened.join(',') === 'theme', JSON.stringify(m.opened));
    await m.done();
  }

  // --- Nothing to edit -------------------------------------------------------
  {
    // A binding to something no frontmatter declares and no import names: the
    // row would have nowhere to go, so it isn't offered.
    const m = await mount({ type: 'expr', value: '`${nowhere}`' });
    check('an unfindable binding still opens the menu', (await m.press(m.chips()[0]), m.menuOpen()));
    check('but offers no edit row', !m.menuRows().some((t) => t.startsWith('Edit') || t.startsWith('Open where')), JSON.stringify(m.menuRows()));
    check('while still offering the rest of it', m.menuRows().some((t) => t.includes('Write an expression')), JSON.stringify(m.menuRows()));
    await m.done();
  }

  if (failures.length) {
    console.error(`chip-edit: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`chip-edit: ${checked} passed  [per chip, in the menu]`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
