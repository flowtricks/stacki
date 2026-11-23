// Goal: the canvas's own scrollbar (src/features/preview/CanvasScrollbar.tsx) tells each page where Chromium's bar
// starts, draws a thumb only for a page that scrolls and only where Chromium draws none, sits in the gutter just outside
// the frame (never over the page) at a constant on-screen size, and scrolls the page when the track is
// pressed or the thumb dragged.
// Method: the real component, bundled with esbuild, is mounted in jsdom next to a real iframe inside the frame holder,
// as SizedFrame mounts it. What it posts to the iframe is captured; the frame's reports are MessageEvents whose source
// is the iframe's window, as in the app. jsdom has no layout, so the track's box is at the origin and every position
// is read from the inline styles the component writes. Presses and drags are pointer events on the track and the
// window, as usePointerDrag listens; animation frames are held and run by each pointer step, never waited for.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test/canvas-scrollbar');
fs.mkdirSync(directory, { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: "export { CanvasScrollbar } from './src/features/preview/CanvasScrollbar.tsx';",
    resolveDir: ROOT,
    loader: 'jsx',
  },
  outfile: path.join(directory, 'scrollbar.js'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});

const frames = new Map();
let frameCount = 0;
// Runs the held animation frames, those they ask for in turn included; bounded, as a drag asks one frame per step.
const runFrames = () => {
  for (let round = 0; round < 10 && frames.size > 0; round += 1) {
    const due = [...frames.values()];
    frames.clear();
    for (const callback of due) {
      callback(performance.now());
    }
  }
};
const REPORT = { type: 'avb:page-scroll', topPx: 1600, heightPx: 4000, viewHeightPx: 800, chromium: false };

function installDOM() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const { window } = dom;
  for (const key of [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'HTMLIFrameElement',
    'Element',
    'Node',
    'MutationObserver',
    'CustomEvent',
    'MessageEvent',
  ]) {
    global[key] = key === 'window' ? window : window[key];
  }
  // Animation frames are held, and each pointer step runs the ones it asked for (`runFrames`), so no test guesses a delay.
  frames.clear();
  global.requestAnimationFrame = (callback) => {
    frameCount += 1;
    frames.set(frameCount, callback);
    return frameCount;
  };
  global.cancelAnimationFrame = (id) => frames.delete(id);
  global.IS_REACT_ACT_ENVIRONMENT = true;
  return dom;
}

// Mounts the bar in a frame holder with an iframe, as SizedFrame does; `props` are the bar's own.
async function mount(props) {
  const dom = installDOM();
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const { CanvasScrollbar } = require(path.join(directory, 'scrollbar.js'));
  const holder = { current: undefined };
  let current = props;
  function Frame() {
    const frameRef = React.useRef(undefined);
    holder.current = frameRef;
    return React.createElement(
      'div',
      { ref: frameRef, className: 'frame-sized' },
      React.createElement('iframe', { title: 'Site', src: 'http://localhost:4321/#avb-design' }),
      React.createElement(CanvasScrollbar, { frameRef, ...current }),
    );
  }
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(Frame)));
  const iframe = document.querySelector('iframe');
  const posted = [];
  iframe.contentWindow.postMessage = (message, origin) => posted.push({ message, origin });
  return {
    dom,
    posted,
    iframe,
    frame: () => holder.current.current,
    rerender: async (next) => {
      current = { ...current, ...next };
      await act(async () => root.render(React.createElement(Frame)));
    },
    // A report from the page in the iframe, or from `source` when another window sends it.
    report: async (data, source = iframe.contentWindow) => {
      await act(async () => {
        window.dispatchEvent(new window.MessageEvent('message', { data, source }));
      });
    },
    load: async () => {
      await act(async () => {
        iframe.dispatchEvent(new window.Event('load'));
      });
    },
    // The DOM answers null for "none": converted here, where it is read.
    bar: () => document.querySelector('.canvas-scrollbar') ?? undefined,
    thumb: () => document.querySelector('.canvas-scrollbar-thumb') ?? undefined,
    pointer: async (target, type, clientY) => {
      await act(async () => {
        target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientY }));
        runFrames();
      });
    },
    close: async () => {
      await act(async () => root.unmount());
      dom.window.close();
    },
  };
}

const px = (value) => Number.parseFloat(value);

test('each page is told where Chromium’s bar starts: on mount, on every load, and when the setting changes', async (context) => {
  const view = await mount({ scale: 1, chromiumFromPx: 1023 });
  context.after(view.close);
  // Mounted before the spy: the first word went to the real postMessage. A load says it again.
  await view.load();
  assert.deepEqual(view.posted.at(-1), { message: { type: 'avb:canvas-scrollbar', chromiumFromPx: 1023 }, origin: 'http://localhost:4321' });
  await view.rerender({ chromiumFromPx: undefined });
  assert.deepEqual(view.posted.at(-1).message, { type: 'avb:canvas-scrollbar' });
});

test('no bar until the page reports, none where Chromium draws its own, none for a page that does not scroll', async (context) => {
  const view = await mount({ scale: 1, chromiumFromPx: undefined });
  context.after(view.close);
  assert.equal(view.bar(), undefined);
  await view.report({ ...REPORT, chromium: true });
  assert.equal(view.bar(), undefined, 'Chromium draws its own bar');
  await view.report({ ...REPORT, heightPx: 800 });
  assert.equal(view.bar(), undefined, 'nothing to scroll');
  // Another window's report, or a malformed one, changes nothing.
  await view.report(REPORT, view.dom.window);
  await view.report({ ...REPORT, topPx: -1 });
  assert.equal(view.bar(), undefined);
  await view.report(REPORT);
  assert.ok(view.bar(), 'a page that scrolls, with no Chromium bar: the canvas draws one');
  // A new page: nothing is known of its scroll until it reports.
  await view.load();
  assert.equal(view.bar(), undefined);
});

test('the bar sits in the gutter just outside the frame, never over the page, at the same size on screen at any zoom', async (context) => {
  const view = await mount({ scale: 1, chromiumFromPx: undefined });
  context.after(view.close);
  await view.report(REPORT);
  // 800 of 4000 visible on the 800px track, 1600 of 3200 scrolled: a 160px thumb 320px down.
  assert.equal(px(view.thumb().style.height), 160);
  assert.equal(px(view.thumb().style.top), 320);
  assert.equal(px(view.bar().style.width), 5);
  assert.equal(px(view.bar().style.right), -7, 'in the gutter, 2px from the frame: within a fluid frame’s 9px gutter');
  // At half zoom the frame is drawn at half size: the bar's frame pixels double so the screen sees the same bar.
  await view.rerender({ scale: 0.5 });
  assert.equal(px(view.bar().style.width), 10);
  assert.equal(px(view.bar().style.right), -14);
  await view.report({ ...REPORT, topPx: 0, heightPx: 1_000_000 });
  assert.equal(px(view.thumb().style.height), 48, 'a long page keeps a 24px thumb on screen');
});

test('a press on the track jumps the thumb under the pointer, and a drag scrolls the page with it', async (context) => {
  const view = await mount({ scale: 1, chromiumFromPx: undefined });
  context.after(view.close);
  await view.report({ ...REPORT, topPx: 0 });
  view.posted.length = 0;
  // The thumb is 0–160; a press at 600 centres it there: offset 520 of 640 to travel, 2600 of 3200 scrolled.
  await view.pointer(view.bar(), 'pointerdown', 600);
  assert.deepEqual(view.posted.at(-1), { message: { type: 'avb:page-scroll-to', topPx: 2600 }, origin: 'http://localhost:4321' });
  assert.ok(view.frame().classList.contains('scrolling'), 'the iframe lets the drag pass while it lasts');
  await view.pointer(view.dom.window, 'pointermove', 700);
  assert.equal(view.posted.at(-1).message.topPx, 3100);
  await view.pointer(view.dom.window, 'pointermove', 5000);
  assert.equal(view.posted.at(-1).message.topPx, 3200, 'past the end: the end of the page');
  await view.pointer(view.dom.window, 'pointerup', 5000);
  assert.ok(!view.frame().classList.contains('scrolling'));
  // A press on the thumb keeps the point it was caught at: no jump, the page follows the move.
  await view.report({ ...REPORT, topPx: 0 });
  view.posted.length = 0;
  await view.pointer(view.bar(), 'pointerdown', 40);
  assert.equal(view.posted.length, 0, 'caught where it is: nothing to jump');
  await view.pointer(view.dom.window, 'pointermove', 104);
  assert.equal(view.posted.at(-1).message.topPx, 320, '64px of thumb is 320px of page');
  await view.pointer(view.dom.window, 'pointerup', 104);
});
