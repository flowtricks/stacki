// Goal: selecting an element whose selector is written in one stylesheet points "Add custom
// styles in:" at that stylesheet, not at the first embed; a manual pick holds until the
// selection changes; and selecting writes nothing.
// Method: the real EmbedEditor mounts in jsdom over a host with two stylesheets (generated
// fixtures): `animation.css` (first in page order, unrelated rules) and `base.css`, which
// holds `.home-hero_height`. The element carries that class and a `data-home-hero-height`
// attribute, so its rule is written for part of the element's own selector. The source
// link's text is the chosen target; every host and disk write is recorded and must stay empty.

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const PAGE = '/p/src/pages/index.astro';
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const SIZE = 240;
let environment;

// The panel, its host setter and a jsdom window, set up once for the file.
async function panelEnvironment() {
  if (environment) {
    return environment;
  }
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'selector-home-panel.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `export { default as EmbedEditor } from './src/features/style/EmbedEditor'\nexport { setHost, getHost } from './src/features/style/model/host'\nexport { subscribeErrorToasts } from './src/ui/errorNotices'`,
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
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: false,
  };
  // Node defines navigator as a getter, so each global is defined, not assigned.
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(global, name, { value, configurable: true, writable: true });
  }
  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  global.ResizeObserver = Observer;
  dom.window.ResizeObserver = Observer;
  dom.window.Element.prototype.scrollIntoView = function () {};
  // eslint-disable-next-line stacki/no-null -- Stubs the platform getContext, which answers null.
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  dom.window.Element.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: SIZE, bottom: SIZE, width: SIZE, height: SIZE });
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  environment = { dom, React, createRoot, ...require(bundlePath) };
  return environment;
}

const classAttr = (value) => ({ type: 'string', value });
const sheet = (rel) => ({ rel, name: path.basename(rel), path: `/p/${rel}`, size: 40 });
const ANIMATION = sheet('src/styles/animation.css');
const BASE = sheet('src/styles/base.css');
const DISK = { [ANIMATION.path]: '.fade { opacity: 0; }', [BASE.path]: '.home-hero_height { height: 361vh; }' };

const element = (id, attributes) => ({ id, kind: 'element', name: 'div', props: { class: classAttr('home-hero_height'), ...attributes }, children: [] });
const other = (id) => ({ id, kind: 'element', name: 'div', props: { class: classAttr('fade') }, children: [] });

async function mountPanel({ nodes, files, disk }) {
  const { dom, React, createRoot, EmbedEditor, setHost } = await panelEnvironment();
  const writes = [];
  const record = (name) => async () => {
    writes.push(name);
    return { ok: true, tag: 'applied' };
  };
  const host = {
    projectPath: '/p',
    selectedId: 'n1',
    nodes,
    files,
    astroFiles: [],
    openFilePath: PAGE,
    openFileKind: 'page',
    renderedClasses: ['home-hero_height'],
    pathOf: () => undefined,
    addClass: record('addClass'),
    addStyleBlock: record('addStyleBlock'),
    writeStyleNode: () => {
      writes.push('writeStyleNode');
      return true;
    },
  };
  dom.window.avb = {
    onCssChanged: () => () => {},
    listStyleFiles: async () => ({ files }),
    listAstroStyleFiles: async () => ({ files: [] }),
    listAssets: async () => ({ entries: [] }),
    readStyleFile: async (filePath) => ({ css: disk[filePath] ?? '' }),
    writeStyleFile: record('writeStyleFile'),
  };
  setHost(host);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(EmbedEditor));
  await wait(900);
  return {
    container,
    writes,
    target: () => container.querySelector('.embed-editor_source-link')?.textContent ?? '',
    select: async (id, renderedClasses) => {
      setHost({ ...host, selectedId: id, renderedClasses });
      await wait(900);
    },
    unmount: () => {
      root.unmount();
      container.remove();
    },
  };
}

test('selecting a selector defined in base.css targets base.css, and writes nothing', async (context) => {
  const panel = await mountPanel({ nodes: [element('n1', { 'data-home-hero-height': { type: 'bare' } }), other('n2')], files: [ANIMATION, BASE], disk: DISK });
  context.after(panel.unmount);
  assert.match(panel.target(), /base\.css/, `the target is the file that defines the selector: ${panel.target()}`);
  assert.deepEqual(panel.writes, []);
});

test('the target follows the canvas selection, and an unrelated selection keeps the current one', async (context) => {
  const panel = await mountPanel({ nodes: [element('n1', { 'data-home-hero-height': { type: 'bare' } }), other('n2')], files: [ANIMATION, BASE], disk: DISK });
  context.after(panel.unmount);
  await panel.select('n2', ['fade']);
  assert.match(panel.target(), /animation\.css/, `the other element's rule is in animation.css: ${panel.target()}`);
  await panel.select('n1', ['home-hero_height']);
  assert.match(panel.target(), /base\.css/);
  assert.deepEqual(panel.writes, []);
});

// Typing a selector adds it as the active one: a pending chip for the element's own full selector.
async function addSelector(panel, text) {
  const { dom } = await panelEnvironment();
  panel.container.querySelector('.embed-editor_selector-well')?.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  await wait(60);
  const input = panel.container.querySelector('input.embed-editor_selector-add');
  assert.ok(input, 'the selector field is drawn');
  input.focus();
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, text);
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await wait(60);
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await wait(900);
}

test('a selector that names the whole element follows the file holding the rule for its class', async (context) => {
  const panel = await mountPanel({ nodes: [element('n1', { 'data-home-hero-height': { type: 'bare' } }), other('n2')], files: [ANIMATION, BASE], disk: DISK });
  context.after(panel.unmount);
  await panel.select('n2', ['fade']);
  assert.match(panel.target(), /animation\.css/);
  await panel.select('n1', ['home-hero_height']);
  await addSelector(panel, 'div.home-hero_height[data-home-hero-height]');
  const chips = [...panel.container.querySelectorAll('.embed-editor_selector-chip.is-active')].map((chip) => chip.textContent);
  assert.ok(
    chips.some((text) => text.includes('data-home-hero-height')),
    `the compound selector is active: ${chips}`,
  );
  assert.match(panel.target(), /base\.css/, `the target is base.css: ${panel.target()}`);
  assert.deepEqual(panel.writes, [], 'adding the pending selector writes nothing');
});

// The person's own pick, made in the source menu like any click.
async function chooseSource(panel, name) {
  panel.container.querySelector('.embed-editor_source-link .u-select-link, .embed-editor_source-link button')?.click();
  await wait(60);
  const option = [...document.querySelectorAll('[role="option"]')].find((candidate) => candidate.textContent.includes(name));
  assert.ok(option, `the menu lists ${name}`);
  option.click();
  await wait(300);
}

test('a manual pick holds while the selection stays, and a new selector goes back to the file that defines it', async (context) => {
  const panel = await mountPanel({ nodes: [element('n1', { 'data-home-hero-height': { type: 'bare' } }), other('n2')], files: [ANIMATION, BASE], disk: DISK });
  context.after(panel.unmount);
  assert.match(panel.target(), /base\.css/);
  await chooseSource(panel, 'animation.css');
  assert.match(panel.target(), /animation\.css/, 'the pick is taken');
  await wait(900);
  assert.match(panel.target(), /animation\.css/, 'and held, not undone by the scan settling');
  await addSelector(panel, 'div.home-hero_height[data-home-hero-height]');
  assert.match(panel.target(), /base\.css/, `a new selector follows its file again: ${panel.target()}`);
  assert.deepEqual(panel.writes, [], 'choosing a target writes nothing');
});

// The owner's heading: component styles are written `:where(.heading)`, and the only plain
// class rules are utilities. The default chip is the component's, and so is the file.
test('h2.heading.heading--2.u-text-center.u-text-balance starts on :where(.heading) and targets the file defining it', async (context) => {
  const utilities = sheet('src/styles/utilities.css');
  const components = sheet('src/styles/heading.css');
  const disk = {
    [utilities.path]: '.u-text-center { text-align: center; }\n.u-text-balance { text-wrap: balance; }',
    [components.path]: ':where(.heading) { margin: 0; }\n:where(.heading--2) { font-size: 2rem; }',
  };
  const heading = {
    id: 'n1',
    kind: 'element',
    name: 'h2',
    props: { class: classAttr('heading heading--2 u-text-center u-text-balance') },
    children: [],
  };
  const panel = await mountPanel({ nodes: [heading], files: [utilities, components], disk });
  context.after(panel.unmount);
  const active = [...panel.container.querySelectorAll('.embed-editor_selector-chip.is-active')].map((chip) => chip.textContent);
  assert.deepEqual(active, [':where(.heading)'], `the default chip is the component's: ${active}`);
  assert.match(panel.target(), /heading\.css/, `and the target is the file defining it: ${panel.target()}`);
  assert.deepEqual(panel.writes, []);
});
