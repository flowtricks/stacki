// Editing what a chip is bound to, per chip.
//
//   node test/renderer/props/chipEdit.test.js
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
const { repoPath } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const entry = path.join(buildDirectory, 'chip-edit.entry.jsx');
  fs.writeFileSync(entry, `export { BindField } ` + `from ${JSON.stringify(repoPath('src/features/props/PropsPanel.tsx'))};\n`);
  const bundle = path.join(buildDirectory, 'chip-edit.bundle.js');
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
  dom.window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  global.ResizeObserver = dom.window.ResizeObserver;
  dom.window.Range.prototype.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  });
  dom.window.Range.prototype.getClientRects = () => ({
    length: 0,
    // eslint-disable-next-line stacki/no-null -- Stubs DOMRectList.item, which answers null.
    item: () => null,
    [Symbol.iterator]: function* () {},
  });

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
          bindContext: {},
          dataContext: {
            frontmatter: FRONTMATTER,
            imports: IMPORTS,
            onSetFrontmatter: (code) => wrote.push(code),
            onOpenSymbol: (name) => opened.push(name),
          },
          onChange: () => {},
        }),
      );
    });
    const chips = () => [...host.querySelectorAll('.expr-chip')];
    const press = async (chip) => {
      await act(async () => {
        chip.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
      });
    };
    // Every action row in the open menu, by its text.
    const menuRows = () => [...document.querySelectorAll('.bind-menu .dp-foot')].map((row) => row.textContent.trim());
    // A missing row is a FAILURE, not a crash: this is exactly what regresses,
    // and a stack trace buries which case it was.
    const clickRow = async (match) => {
      const row = [...document.querySelectorAll('.bind-menu .dp-foot')].find((row) => row.textContent.includes(match));
      check(`the menu offers "${match}"`, !!row, `rows were ${JSON.stringify(menuRows())}`);
      if (!row) {
        return false;
      }
      await act(async () => {
        row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      });
      return true;
    };
    return {
      host,
      chips,
      press,
      menuRows,
      clickRow,
      opened,
      wrote,
      menuOpen: () => !!document.querySelector('.bind-menu'),
      done: async () => {
        await act(async () => root.unmount());
        host.remove();
      },
    };
  };

  // --- Two chips in one field -----------------------------------------------
  {
    const mounted = await mount({ type: 'expr', value: '`${media} ${theme}`' });
    check('both bindings draw as chips', mounted.chips().length === 2, `${mounted.chips().length} chips: ${mounted.host.textContent}`);
    // The pencil that could only speak for one of them is gone.
    check('the field has no pencil beside it', !mounted.host.querySelector('.attr-asset-toggle'), mounted.host.innerHTML.slice(0, 200));

    // First chip: a const in this file, so the row offers to edit it here.
    await mounted.press(mounted.chips()[0]);
    check('pressing a chip opens the menu', mounted.menuOpen(), 'no menu');
    check(
      'and the menu offers to edit THAT chip',
      mounted.menuRows().some((label) => label === 'Edit media'),
      JSON.stringify(mounted.menuRows()),
    );

    // Second chip: imported, so the row offers to open its file instead.
    await mounted.press(mounted.chips()[1]);
    check(
      'the second chip gets its own answer',
      mounted.menuRows().some((label) => label === 'Open where theme is defined'),
      JSON.stringify(mounted.menuRows()),
    );
    check('and not the first chip’s', !mounted.menuRows().some((label) => label.includes('media')), JSON.stringify(mounted.menuRows()));

    // …and taking it does the thing for the chip that was pressed.
    await mounted.clickRow('Open where theme');
    check('choosing it opens that symbol', mounted.opened.join(',') === 'theme', JSON.stringify(mounted.opened));
    check('and closes the menu', !mounted.menuOpen(), 'menu still open');

    // The local one edits in place, under the field, rather than opening a file.
    await mounted.press(mounted.chips()[0]);
    await mounted.clickRow('Edit media');
    check('editing a local const opens it in place', !!document.querySelector('.var-src'), 'no inline editor');
    check('and does not open a file', mounted.opened.join(',') === 'theme', JSON.stringify(mounted.opened));
    await mounted.done();
  }

  // --- Nothing to edit -------------------------------------------------------
  {
    // A binding to something no frontmatter declares and no import names: the
    // row would have nowhere to go, so it isn't offered.
    const mounted = await mount({ type: 'expr', value: '`${nowhere}`' });
    check('an unfindable binding still opens the menu', (await mounted.press(mounted.chips()[0]), mounted.menuOpen()));
    check(
      'but offers no edit row',
      !mounted.menuRows().some((label) => label.startsWith('Edit') || label.startsWith('Open where')),
      JSON.stringify(mounted.menuRows()),
    );
    check(
      'while still offering the rest of it',
      mounted.menuRows().some((label) => label.includes('Write an expression')),
      JSON.stringify(mounted.menuRows()),
    );
    await mounted.done();
  }

  if (failures.length) {
    console.error(`chip-edit: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`chip-edit: ${checked} passed  [per chip, in the menu]`);
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
