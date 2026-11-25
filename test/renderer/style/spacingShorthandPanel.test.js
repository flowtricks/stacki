// Goal: the spacing box, as mounted in the panel, shows a `padding` shorthand
// on its four sides and writes drags back compact. The model half is pinned in
// spacingShorthand.test.js; this suite checks that the panel is wired to it: a
// shorthand that reaches the labels, and a commit that goes through the padding
// writer instead of appending a longhand beside the shorthand.
// Method: the real EmbedEditor in jsdom over a stylesheet bridge whose
// `writeStyleFile` keeps the CSS as the disk would. One `.card` rule holds
// `padding: 2rem` next to a declaration that must survive. The class chip is
// picked, then the side labels are dragged as a user drags them: Shift moves
// the four sides, Alt the opposite pair, no key one side. After each gesture
// the written CSS is parsed and its padding declarations listed, and the four
// labels are read back, since a value the panel wrote but no longer shows is
// the defect this replaces. An Alt-click, the reset gesture, ends on a side
// that was grouped into an axis. Waits poll for the condition they need.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const postcss = require('postcss');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const SIDES = ['top', 'right', 'bottom', 'left'];
const POLL_MS = 25;
const POLLS_MAX = 200;
const SHEET = {
  rel: 'src/styles/main.css',
  name: 'main.css',
  path: '/p/src/styles/main.css',
  size: 10,
};

// The jsdom window the panel runs in, with the globals React and the panel read.
function openWindow() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  const { window } = dom;
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.Element.prototype.setPointerCapture = () => {};
  window.Element.prototype.releasePointerCapture = () => {};
  global.window = window;
  global.document = window.document;
  global.navigator = window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = false;
  for (const key of ['ResizeObserver', 'MutationObserver', 'Element', 'HTMLElement', 'Node']) {
    global[key] = window[key];
  }
  for (const key of ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    global[key] = window[key].bind(window);
  }
  return window;
}

// The panel and its host setter, bundled as the app loads them.
function loadPanel() {
  const directory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(directory, { recursive: true });
  const bundle = path.join(directory, 'spacing-shorthand-panel.bundle.js');
  esbuild.buildSync({
    stdin: {
      contents: [
        "export { default as EmbedEditor } from './src/features/style/EmbedEditor';",
        "export { setHost } from './src/features/style/model/host';",
      ].join('\n'),
      resolveDir: ROOT,
      loader: 'tsx',
    },
    outfile: bundle,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
  return require(bundle);
}

test('the spacing box reads a padding shorthand and writes drags back compact', async () => {
  const window = openWindow();
  const { EmbedEditor, setHost } = loadPanel();
  const React = require('react');
  const { createRoot } = require('react-dom/client');

  let disk = '.card { color: red; padding: 2rem; }';
  window.avb = {
    onCssChanged: () => () => {},
    listStyleFiles: async () => ({ files: [SHEET] }),
    listAstroStyleFiles: async () => ({ files: [] }),
    listAssets: async () => ({ entries: [] }),
    readStyleFile: async () => ({ css: disk }),
    writeStyleFile: async ({ css }) => {
      disk = css;
      return { ok: true };
    },
  };
  const card = { type: 'string', value: 'card' };
  setHost({
    projectPath: '/p',
    nodes: [{ id: 'n1', kind: 'element', name: 'div', props: { class: card } }],
    selectedId: 'n1',
    files: [SHEET],
    astroFiles: [],
    renderedClasses: [],
    pathOf: () => '0.1',
  });
  const panel = window.document.getElementById('root');
  const root = createRoot(panel);
  root.render(React.createElement(EmbedEditor));

  // Unmounted on failure too: a mounted panel keeps the process alive.
  try {
    const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
    // Poll until `read` returns something, failing with `what` at the bound.
    const until = async (what, read) => {
      for (let tries = 0; tries < POLLS_MAX; tries += 1) {
        const found = read();
        if (found) {
          return found;
        }
        await wait(POLL_MS);
      }
      return assert.fail(`timed out waiting for ${what}\n${disk}`);
    };
    const label = (side) => panel.querySelector(`button[data-prop="padding-${side}"]`);
    const shown = () => SIDES.map((side) => label(side)?.textContent);
    const padding = () =>
      postcss
        .parse(disk)
        .first.nodes.filter((node) => node.type === 'decl' && node.prop.startsWith('padding'))
        .map((declaration) => [declaration.prop, declaration.value]);
    const send = async (side, type, init) => {
      label(side).dispatchEvent(new window.MouseEvent(type, { bubbles: true, ...init }));
      await wait(POLL_MS);
    };
    // Press `side`, move by (dx, dy) with `modifiers` held, release, and wait for
    // the write: the padding on disk differs from what it was.
    const drag = async (side, [dx, dy], modifiers = {}) => {
      const before = JSON.stringify(padding());
      await until(`the ${side} label to be ready`, () => label(side) && !label(side).disabled);
      await send(side, 'pointerdown', { clientX: 100, clientY: 100, ...modifiers });
      await send(side, 'pointermove', { clientX: 100 + dx, clientY: 100 + dy, ...modifiers });
      await send(side, 'pointerup', { clientX: 100 + dx, clientY: 100 + dy, ...modifiers });
      await until(`the ${side} drag to be written`, () => JSON.stringify(padding()) !== before);
      await until('the panel to settle', () => SIDES.every((each) => !label(each)?.disabled));
    };

    // The element's first class is the default pick, highlighted from the first paint;
    // a click on it would deselect it, so it is clicked only when another is picked.
    const chip = await until('the class chip', () => panel.querySelector('.embed-editor_selector-chip'));
    if (!chip.classList.contains('is-active')) {
      chip.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    }
    await until('the shorthand on the four sides', () => (shown().every((text) => text === '2rem') ? shown() : undefined));
    assert.equal(disk, '.card { color: red; padding: 2rem; }', 'showing it writes nothing');

    // Shift: four sides move together, and the rule still holds one declaration.
    await drag('top', [0, -18], { shiftKey: true });
    const [[allProp, all]] = padding();
    assert.deepEqual([padding().length, allProp], [1, 'padding'], disk);
    assert.notEqual(all, '2rem', 'the drag changed the value');
    await until('the four labels to follow', () => shown().every((text) => text === all));

    // Alt: the opposite pair moves; every side is still set, so the rule holds
    // one `padding` with a value per axis (`padding: 2rem 3rem`).
    await drag('left', [-16, 0], { altKey: true });
    assert.deepEqual(
      padding().map(([prop]) => prop),
      ['padding'],
      disk,
    );
    const [block, inline] = padding()[0][1].split(' ');
    assert.equal(block, all, 'the block axis kept its value');
    assert.notEqual(inline, all);
    await until('the labels to follow each axis', () => JSON.stringify(shown()) === JSON.stringify([block, inline, block, inline]));

    // No key: one side changes; still one `padding`, now naming all three values it needs.
    await drag('top', [0, -16]);
    assert.deepEqual(
      padding().map(([prop]) => prop),
      ['padding'],
      disk,
    );
    const [top, right, bottom] = padding()[0][1].split(' ');
    assert.notEqual(top, block);
    assert.equal(bottom, block, 'the bottom kept the axis value');
    assert.equal(right, inline);

    // Alt-click resets a side that has no declaration of its own any more.
    const before = JSON.stringify(padding());
    for (const type of ['pointerdown', 'pointerup', 'click']) {
      await send('left', type, { clientX: 100, clientY: 100, altKey: true });
    }
    await until('the reset to be written', () => JSON.stringify(padding()) !== before);
    assert.deepEqual(
      padding().map(([prop]) => prop),
      ['padding-top', 'padding-bottom', 'padding-right'],
      disk,
    );
    assert.equal(padding()[2][1], inline, 'the right side kept the axis value');
    await until('the left label to read as unset', () => label('left')?.textContent === '0');

    const color = postcss.parse(disk).first.nodes.find((node) => node.prop === 'color');
    assert.equal(color?.value, 'red', 'the rule’s other declaration is untouched');
  } finally {
    root.unmount();
    window.close();
  }
});
