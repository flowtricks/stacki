// Goal: a drag in the spacing box tells the canvas its value while it moves.
// The band over the page is labelled by whoever reported last, and only the
// hover reported: it reads the file, so the label kept the old value for the
// whole drag ("2rem" under a number already at 3). The drag now reports its own
// value on each frame, with the sides Shift and Alt bring in, and the hover
// stays silent meanwhile, so a modifier pressed mid-drag cannot put the file's
// value back on the band.
// Method: the real EmbedEditor in jsdom over a stylesheet bridge, with the
// host's onSpacingHover recorded, as the app records it to draw the bands. The
// pointer enters the top padding label (the hover reports the file's value),
// presses, moves, moves again with Shift, and releases. Each report is checked
// for its sides, its labels and its `live` values: present on every frame of
// the drag, equal to the label, absent again on release, where the label stays.
// The negative space is the file's value: no report between press and release
// may carry it. The canvas half, sizing the band from `live`, is in
// test/renderer/preview/spacingLive.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
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
  const bundle = path.join(directory, 'spacing-drag-report.bundle.js');
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

test('a drag reports its value to the canvas; the hover stays silent meanwhile', async () => {
  const window = openWindow();
  const { EmbedEditor, setHost } = loadPanel();
  const React = require('react');
  const { createRoot } = require('react-dom/client');

  // One longhand per side: the box reads those on every version of the panel.
  let disk = `.card { ${SIDES.map((side) => `padding-${side}: 2rem;`).join(' ')} }`;
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
  const reports = [];
  const card = { type: 'string', value: 'card' };
  setHost({
    projectPath: '/p',
    nodes: [{ id: 'n1', kind: 'element', name: 'div', props: { class: card } }],
    selectedId: 'n1',
    files: [SHEET],
    astroFiles: [],
    renderedClasses: [],
    pathOf: () => '0.1',
    onSpacingHover: (hover) => reports.push(hover),
  });
  const panel = window.document.getElementById('root');
  const root = createRoot(panel);
  root.render(React.createElement(EmbedEditor));

  // Unmounted on failure too: a mounted panel keeps the process alive.
  try {
    const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
    const until = async (what, read) => {
      for (let tries = 0; tries < POLLS_MAX; tries += 1) {
        const found = read();
        if (found) {
          return found;
        }
        await wait(POLL_MS);
      }
      return assert.fail(`timed out waiting for ${what}`);
    };
    const label = (side) => panel.querySelector(`button[data-prop="padding-${side}"]`);
    const send = async (type, init) => {
      const event = new window.MouseEvent(type, { bubbles: true, clientX: 100, ...init });
      label('top').dispatchEvent(event);
      await wait(POLL_MS * 2);
    };
    const chip = await until('the class chip', () => panel.querySelector('.embed-editor_selector-chip'));
    chip.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await until('the value on the top label', () => label('top')?.textContent === '2rem');
    await until('the label to be ready', () => !label('top').disabled);

    await send('pointerover', { clientY: 100 });
    assert.deepEqual(reports.at(-1), { kind: 'padding', sides: ['top'], labels: { top: '2rem' } });

    reports.length = 0;
    await send('pointerdown', { clientY: 100 });
    await send('pointermove', { clientY: 80 });
    const alone = await until('the drag to report', () => reports.at(-1));
    assert.deepEqual(alone.sides, ['top']);
    assert.notEqual(alone.labels.top, '2rem', 'the label is the dragged value');
    assert.equal(alone.labels.top, label('top').textContent, 'the number the panel shows');
    assert.deepEqual(alone.live, alone.labels, 'and the band is sized from it');

    // Shift mid-drag: the hover sees the modifier change too, and must not answer.
    await send('pointermove', { clientY: 60, shiftKey: true });
    const all = await until('the four sides to report', () => (reports.at(-1).sides.length === 4 ? reports.at(-1) : undefined));
    assert.deepEqual([...all.sides].sort(), ['bottom', 'left', 'right', 'top']);
    assert.equal(new Set(Object.values(all.labels)).size, 1, 'one value on the four bands');
    assert.deepEqual(all.live, all.labels);
    assert.notEqual(all.labels.top, alone.labels.top, 'the value moved on');

    await send('pointerup', { clientY: 60, shiftKey: true });
    const released = reports.at(-1);
    assert.deepEqual(released.labels, all.labels, 'the last value stays on the band');
    assert.equal('live' in released, false, 'and its size is measured again');
    for (const report of reports) {
      assert.ok(report, 'the band is never cleared during the drag');
      assert.equal(Object.values(report.labels).includes('2rem'), false, 'never the file’s value');
    }
    await until('the write', () => disk.includes(`: ${all.labels.top}`) && !disk.includes('2rem'));

    // The drag is over: the hover answers again, with what the file now holds.
    reports.length = 0;
    await until('the panel to settle', () => !label('top').disabled);
    await send('pointerout', { clientY: 60 });
    await send('pointerover', { clientY: 60 });
    const hovered = await until('the hover to report', () => reports.at(-1));
    assert.deepEqual(hovered, { kind: 'padding', sides: ['top'], labels: { top: all.labels.top } });
  } finally {
    root.unmount();
    window.close();
  }
});
