// Writing into a query nested inside a rule, from the style panel.
//
//   node test/renderer/style/nestedQueryWrite.test.js
//
// Goal: with a nested query chosen in the context dropdown
// (`.button / @media (width < 50rem)`), a colour picked for the selected
// element lands INSIDE that nested block, both while it is being dragged (the
// live write the canvas shows) and when it is committed, and nothing else in the
// stylesheet changes. A block that held nothing for the element used to get no
// live write at all (only an existing rule was ever updated live), and its
// commit wrote `.button { }` inside `.button { @media { } }`, which is
// `.button .button` and styles nothing. The block may sit in the open
// component's own <style> (written through the open file's model) or in a
// component read from disk while a page is open (written to its file).
//
// Method: the real EmbedEditor mounted in jsdom over a host holding a
// component's model; the context row is picked by its wrapper line, the Borders
// colour swatch is dragged and released, and every CSS text the panel hands the
// host is kept and compared byte for byte with the source it started from.

const fs = require('fs');
const path = require('path');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// The picker measures its square; jsdom lays nothing out, so it is given one.
const SIZE = 240;
const BUTTON_PATH = '/p/src/components/Button.astro';
const INDEX_PATH = '/p/src/pages/index.astro';

// Each stylesheet, with the nested block's contents marked so the expected
// output is the same text with only that line changed.
const SHEETS = [
  {
    name: 'an empty nested block',
    css: '.button {\n  border-color: red;\n  @media (width < 50rem) {\n  }\n}',
    expect: (color) => `.button {\n  border-color: red;\n  @media (width < 50rem) {\n    border-color: ${color};\n  }\n}`,
  },
  {
    name: 'a nested block holding another property',
    css: '.button {\n  border-color: red;\n  @media (width < 50rem) {\n    color: blue;\n  }\n}',
    expect: (color) => `.button {\n  border-color: red;\n  @media (width < 50rem) {\n    color: blue;\n    border-color: ${color};\n  }\n}`,
  },
  {
    name: 'a nested block already setting it',
    css: '.button {\n  border-color: red;\n  @media (width < 50rem) {\n    border-color: #0059ff;\n  }\n}',
    expect: (color) => `.button {\n  border-color: red;\n  @media (width < 50rem) {\n    border-color: ${color};\n  }\n}`,
  },
];

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'nested-query-write.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `export { default as EmbedEditor } from './src/features/style/EmbedEditor'\nexport { setHost } from './src/features/style/model/host'`,
      resolveDir: ROOT,
      loader: 'tsx',
    },
    outfile: bundlePath,
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
  global.MutationObserver = dom.window.MutationObserver;
  global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  global.ResizeObserver = RO;
  dom.window.ResizeObserver = RO;
  dom.window.Element.prototype.scrollIntoView = function () {};
  // eslint-disable-next-line stacki/no-null -- Stubs the platform getContext, which answers null.
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  dom.window.Element.prototype.getBoundingClientRect = function rect() {
    return { x: 0, y: 0, top: 0, left: 0, right: SIZE, bottom: SIZE, width: SIZE, height: SIZE };
  };
  dom.window.addEventListener('error', (event) => check('the panel throws nothing', false, String(event.error?.stack || event.message)));
  global.IS_REACT_ACT_ENVIRONMENT = false;

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { EmbedEditor, setHost } = require(bundlePath);

  const pointer = (type, fx, fy, target) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clientX', { value: fx * SIZE });
    Object.defineProperty(event, 'clientY', { value: fy * SIZE });
    (target ?? dom.window).dispatchEvent(event);
  };

  // Mount the panel on `.button`, pick the nested row, drag a colour and let go.
  // Returns the CSS texts the panel handed over: live ones, then committed ones.
  const pickColour = async ({ css, open }) => {
    const writes = [];
    const anchor = { id: 'n0', kind: 'element', name: 'a', props: { class: { type: 'string', value: 'button' } }, children: [] };
    const astroSource = (inner) => `---\n---\n<a class="button"><slot /></a>\n<style is:global>${inner}</style>\n`;
    dom.window.avb = {
      onCssChanged: () => () => {},
      listStyleFiles: async () => ({ files: [] }),
      listAstroStyleFiles: async () => ({ files: [] }),
      listAssets: async () => ({ entries: [] }),
      readStyleFile: async (filePath) => ({ css: filePath === BUTTON_PATH ? astroSource(css) : '' }),
      writeStyleFile: async ({ css: written }) => {
        const inner = /<style is:global>([\s\S]*)<\/style>/.exec(written)?.[1];
        writes.push({ live: undefined, css: inner, whole: written });
        return { ok: true };
      },
    };
    const component = open === 'component';
    setHost({
      projectPath: '/p',
      nodes: component ? [anchor, { id: 'n1', kind: 'raw', name: 'style', props: { 'is:global': { type: 'bare' } }, inner: css }] : [anchor],
      selectedId: 'n0',
      files: [],
      astroFiles: component ? [] : [{ rel: 'src/components/Button.astro', name: 'Button.astro', path: BUTTON_PATH, size: 1 }],
      openFilePath: component ? BUTTON_PATH : INDEX_PATH,
      openFileKind: component ? 'component' : 'page',
      renderedClasses: ['button'],
      pathOf: () => undefined,
      writeStyleNode: (target, written, immediate) => {
        writes.push({ live: immediate !== true, css: written, target });
        return true;
      },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    root.render(React.createElement(EmbedEditor));
    await wait(800);
    host.querySelector('.embed-editor_context-select .u-select-button')?.click();
    await wait(120);
    const rows = [...document.querySelectorAll('.u-select-option')];
    // Grouped under a header naming its wrapper (embed/contextGroups.ts).
    const nested = rows.find((row) => row.closest('.u-select-group')?.querySelector('.u-select-heading-label')?.textContent === '.button');
    nested?.click();
    await wait(300);
    const swatch = [...host.querySelectorAll('.u-color-swatch')].find((button) => button.getAttribute('aria-label') === 'all border color');
    swatch?.click();
    await wait(60);
    pointer('pointerdown', 0.8, 0.2, document.querySelector('.u-color-sb'));
    await wait(60);
    pointer('pointermove', 0.6, 0.3);
    await wait(60);
    const liveCount = writes.length;
    pointer('pointerup', 0.6, 0.3);
    await wait(500);
    root.unmount();
    host.remove();
    return { offered: nested !== undefined, writes, liveCount, rows: rows.map((row) => (row.textContent || '').trim()) };
  };

  const colourOf = (css) => /@media \(width < 50rem\) \{[^}]*border-color: (#[0-9a-f]{6})/.exec(css ?? '')?.[1];

  for (const sheet of SHEETS) {
    for (const open of ['component', 'page']) {
      const what = `${sheet.name}, ${open === 'component' ? "in the open component's <style>" : 'in a component read from disk'}`;
      const { offered, writes, liveCount, rows } = await pickColour({ css: sheet.css, open });
      check(`${what}: the nested query is offered`, offered, rows.join(' | '));
      check(`${what}: the drag writes live`, liveCount > 0, `${liveCount} live writes`);
      for (const write of writes.slice(0, liveCount)) {
        const colour = colourOf(write.css);
        check(`${what}: each live write lands in the nested block`, colour !== undefined && write.css === sheet.expect(colour), JSON.stringify(write.css));
      }
      const last = writes[writes.length - 1];
      const committed = colourOf(last?.css);
      check(
        `${what}: the commit lands in the nested block, and nothing else changes`,
        committed !== undefined && last.css === sheet.expect(committed),
        JSON.stringify(last?.css),
      );
      if (open === 'component') {
        check(
          `${what}: written to the open file's own block`,
          writes.every((write) => write.target?.nodeId === 'n1' && write.target?.filePath === BUTTON_PATH),
        );
        check(`${what}: the last write is the commit`, last?.live === false);
      } else {
        check(
          `${what}: written to the component's file, around its markup unchanged`,
          writes.every((write) => write.whole.startsWith('---\n---\n<a class="button"><slot /></a>\n<style is:global>')),
        );
      }
    }
  }

  dom.window.close();
  if (failures.length) {
    console.error(`\nnested-query-write: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`nested-query-write: ${checked} passed`);
  process.exit(0);
})();
