// Which query contexts the style panel offers for the selected element, and
// what picking one does to the canvas.
//
//   node test/renderer/style/contextReach.test.js
//
// Goal, on the pigeon test page's shape (developer_layout > developer_content >
// developer_title, button-wrapper; hero_title outside):
//
// 1. A query nested inside `.developer_layout` is listed, two-line, for every
//    element it can reach, whether or not that element has styles in it yet:
//    developer_title (none there) and developer_layout itself. It is not listed
//    for hero_title, outside the wrapper, where a rule written there would do
//    nothing. The same query also written at the top level is a second row.
// 2. With the nested query chosen, selecting an element it cannot reach puts the
//    panel back on Base.
// 3. Picking a media query moves the canvas inside it (model/queryWidth.ts),
//    and the device change that makes can never return the context to Base: the
//    canvas becomes a `custom` width, and only a switch to Desktop does that.
//
// Method: the real EmbedEditor in jsdom over a host holding the page's model
// and its <style is:global> block; there is no canvas, so reach is decided by
// the source matcher on the page tree. The host's setCanvasWidth is a spy that
// does what the app does with it: the device becomes `custom`.

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

const PAGE_CSS = `
    .developer_layout {
      display: grid;
      @media (width < 42rem) {
        grid-template-columns: 1fr;
        .button-wrapper {
          margin-top: 5rem;
        }
      }
    }
    @media (width < 42rem) {
      .hero_title {
        color: red;
      }
    }
    @media (min-width: 80rem) {
      .hero_title {
        color: blue;
      }
    }
  `;

const element = (id, name, className, children = []) => ({ id, kind: 'element', name, props: { class: { type: 'string', value: className } }, children });

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'context-reach.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `export { default as EmbedEditor } from './src/features/style/EmbedEditor'\nexport { setHost, getHost } from './src/features/style/model/host'`,
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
  dom.window.addEventListener('error', (event) => check('the panel throws nothing', false, String(event.error?.stack || event.message)));
  dom.window.avb = {
    onCssChanged: () => () => {},
    listStyleFiles: async () => ({ files: [] }),
    listAstroStyleFiles: async () => ({ files: [] }),
    listAssets: async () => ({ entries: [] }),
    readStyleFile: async () => ({ css: '' }),
    writeStyleFile: async () => ({ ok: true }),
  };
  global.IS_REACT_ACT_ENVIRONMENT = false;

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { EmbedEditor, setHost } = require(bundlePath);

  const nodes = [
    element('hero', 'h1', 'hero_title'),
    element('layout', 'div', 'developer_layout', [
      element('content', 'div', 'developer_content', [element('title', 'h2', 'developer_title text-style-h1'), element('wrapper', 'div', 'button-wrapper')]),
    ]),
    { id: 'styles', kind: 'raw', name: 'style', props: { 'is:global': { type: 'bare' } }, inner: PAGE_CSS },
  ];
  const widths = [];
  const select = (selectedId, classes) => setHost({ selectedId, renderedClasses: classes });
  setHost({
    projectPath: '/p',
    nodes,
    selectedId: 'title',
    files: [],
    astroFiles: [],
    openFilePath: '/p/src/pages/index.astro',
    openFileKind: 'page',
    renderedClasses: ['developer_title', 'text-style-h1'],
    pathOf: () => undefined,
    device: 'desktop',
    writeStyleNode: () => true,
    setCanvasWidth: (widthPx) => {
      widths.push(widthPx);
      // What the app does: the width field's width, as a `custom` device.
      setHost({ device: 'custom' });
    },
  });
  const host = dom.window.document.getElementById('root');
  createRoot(host).render(React.createElement(EmbedEditor));
  await wait(800);

  const trigger = () => host.querySelector('.embed-editor_context-select .u-select-button');
  const openRows = async () => {
    trigger()?.click();
    await wait(120);
    return [...document.querySelectorAll('.u-select-option')];
  };
  const closeRows = async () => {
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    trigger()?.click();
    await wait(80);
    if (document.querySelectorAll('.u-select-option').length > 0) {
      trigger()?.click();
      await wait(80);
    }
  };
  const describe = (rows) => rows.map((row) => (row.textContent || '').trim()).join(' | ');
  const nestedRow = (rows) => rows.find((row) => row.querySelector('.u-select-overline-text')?.textContent === '.developer_layout');
  const queryRows = (rows, query) =>
    rows.filter((row) => row.querySelector('.u-select-label-line')?.textContent === query || row.querySelector('.u-select-label')?.textContent === query);

  // 1. developer_title: inside the wrapper, nothing in the query for it.
  {
    const rows = await openRows();
    const nested = nestedRow(rows);
    check('developer_title: the nested query is listed', nested !== undefined, describe(rows));
    check(
      'developer_title: on two lines, the wrapper over the query',
      nested?.querySelector('.u-select-label-line')?.textContent === '@media (width < 42rem)',
      nested?.textContent ?? '',
    );
    check('developer_title: the same query at the top level is a second row', queryRows(rows, '@media (width < 42rem)').length === 2, describe(rows));
    check(
      'developer_title: each query row names its stylesheet',
      queryRows(rows, '@media (width < 42rem)').every((row) => row.querySelector('.u-select-tag') !== null),
      describe(rows),
    );
    await closeRows();
  }

  // hero_title: outside the wrapper.
  select('hero', ['hero_title']);
  await wait(800);
  {
    const rows = await openRows();
    check('hero_title: the nested query is not listed', nestedRow(rows) === undefined, describe(rows));
    check('hero_title: the top-level one still is', queryRows(rows, '@media (width < 42rem)').length === 1, describe(rows));
    await closeRows();
  }

  // developer_layout: the wrapper itself.
  select('layout', ['developer_layout']);
  await wait(800);
  {
    const rows = await openRows();
    check('developer_layout: the nested query is listed', nestedRow(rows) !== undefined, describe(rows));
    await closeRows();
  }

  // 2 and 3. Pick the nested query on developer_title, then move outside.
  select('title', ['developer_title', 'text-style-h1']);
  await wait(800);
  {
    const rows = await openRows();
    nestedRow(rows)?.click();
    await wait(300);
    check('picking the nested query selects it', /\.developer_layout/.test(trigger()?.textContent ?? ''), trigger()?.textContent ?? '');
    check('and moves the canvas just inside 42rem (671px at a 16px root)', widths[widths.length - 1] === 671, JSON.stringify(widths));
    check('which leaves the query selected', /\.developer_layout/.test(trigger()?.textContent ?? ''), trigger()?.textContent ?? '');
  }
  select('hero', ['hero_title']);
  await wait(900);
  check('moving outside the wrapper falls back to Base', (trigger()?.textContent ?? '').trim() === 'Base', trigger()?.textContent ?? '');

  // 3. A wide min-width query lands at a desktop-like width; the context stays.
  setHost({ device: 'desktop' });
  await wait(100);
  {
    const rows = await openRows();
    const wide = queryRows(rows, '@media (min-width: 80rem)')[0];
    check('the wide query is offered', wide !== undefined, describe(rows));
    wide?.click();
    await wait(400);
    check('picking it sets the canvas to its bound', widths[widths.length - 1] === 1280, JSON.stringify(widths));
    check('and the width change does not return the panel to Base', /min-width: 80rem/.test(trigger()?.textContent ?? ''), trigger()?.textContent ?? '');
  }
  // The rule it must not trip still holds for a real switch to Desktop.
  setHost({ device: 'desktop' });
  await wait(300);
  check('a switch to Desktop still returns a media context to Base', (trigger()?.textContent ?? '').trim() === 'Base', trigger()?.textContent ?? '');

  dom.window.close();
  if (failures.length) {
    console.error(`\ncontext-reach: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`context-reach: ${checked} passed`);
  process.exit(0);
})();
