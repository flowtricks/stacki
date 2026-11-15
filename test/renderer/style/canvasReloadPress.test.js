// A press the canvas reports late, or replays, never closes what the person opened after it.
//
//   node test/renderer/style/canvasReloadPress.test.js
//
// Goal: on a freshly reloaded canvas, a click on the page reached the app late. The page posted its
// `avb:click-node` a few hundred milliseconds after the press (busy with its first render), and the
// app's click ladder asked again and got a second answer carrying `replay`. By then the person had
// pressed a chip in the panel, and either message closed its picker, 230 to 270 ms after it opened,
// with no panel commit to say why (soak SP-04). A canvas press closes a popover only when it was
// made after the popover opened: the frame stamps each press with the input event's own time
// (`pressedAtMs`, frameTargets.ts), and a replay is never a new press. A press stamped after the
// popup opened, or one from a canvas that does not stamp (Studio's preview client), still closes it.
// Method: the real VariableConnect in jsdom over stubbed variables. The canvas is the window's
// message events, dispatched in the order a reload produces them (the parent's blur, the late
// click, the replay); presses and keys are dispatched events, so it is the same on every runner.

const fs = require('fs');
const path = require('path');
const { repoPath, stubSources } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked += 1;
  if (!condition) {
    failures.push(`  ${what}${detail === undefined ? '' : `\n    ${detail}`}`);
  }
};

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'canvas-reload-press.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `export { default as VariableConnect } from './src/features/style/VariableConnect';
        export { epochNowMs, isCanvasPressMessage } from './src/ui/popupDismiss';`,
      resolveDir: repoPath('.'),
      loader: 'ts',
    },
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
    plugins: [
      stubSources('stub-variables', {
        'src/features/style/model/webflow.ts': () => ({
          contents: `
            const weight = (name, value) => ({ name, collection: 'Weights', group: '', value, binding: 'var(--' + name + ')', type: 'Number' });
            export async function streamProjectVariables(onAdd) {
              for (const [name, value] of [['w-light', '300'], ['w-regular', '400'], ['w-bold', '700']]) onAdd(weight(name, value));
              return [];
            }
            export const __stub = true;
          `,
          loader: 'js',
        }),
      }),
    ],
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true });
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  Object.assign(global, {
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle,
    MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
  global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  global.cancelAnimationFrame = clearTimeout;
  dom.window.requestAnimationFrame = global.requestAnimationFrame;
  dom.window.cancelAnimationFrame = global.cancelAnimationFrame;
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  dom.window.ResizeObserver = global.ResizeObserver;
  dom.window.Element.prototype.scrollIntoView = () => {};

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const { VariableConnect, epochNowMs, isCanvasPressMessage } = require(bundlePath);
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  // Past the popup's 160 ms exit motion, so a close shows as the picker gone.
  const settleMotion = async () => {
    for (let step = 0; step < 8; step += 1) {
      await settle();
    }
  };
  const mouse = (type, init = {}) => new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  const canvasMessage = (data) => act(async () => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data })));
  const pickerOpen = () => document.querySelector('.embed-editor_varpicker') !== null;
  const CLICK = { type: 'avb:click-node', path: '0.0.0.0', occurrence: 0, outside: false, x: 138, y: 188 };

  // --- The contract on its own.
  const opened = epochNowMs();
  check('a press stamped after the popup opened is a press on it', isCanvasPressMessage({ ...CLICK, pressedAtMs: opened + 5 }, { openedAtMs: opened }));
  check('a press stamped before it opened is not', !isCanvasPressMessage({ ...CLICK, pressedAtMs: opened - 120 }, { openedAtMs: opened }));
  check('a replayed click is never a new press', !isCanvasPressMessage({ ...CLICK, replay: 3 }, { openedAtMs: opened }));
  check('nor without an open time', !isCanvasPressMessage({ ...CLICK, replay: 3 }));
  check('an unstamped press is taken at its word', isCanvasPressMessage(CLICK, { openedAtMs: opened }));
  check('a malformed stamp is taken as unstamped', isCanvasPressMessage({ ...CLICK, pressedAtMs: 'soon' }, { openedAtMs: opened }));
  check('other messages are not presses', !isCanvasPressMessage({ type: 'avb:hover-node' }) && !isCanvasPressMessage(undefined));

  // --- The reload sequence, against the real picker.
  const mount = async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        React.createElement(
          VariableConnect,
          { onPick() {}, ariaLabel: 'Weight', prop: 'font-weight', code: true },
          React.createElement('input', { className: 'u-input', value: 'var(--w-regular)', onChange() {} }),
        ),
      );
    });
    await settle();
    return {
      host,
      done: async () => {
        await act(async () => root.unmount());
        host.remove();
      },
    };
  };
  {
    const view = await mount();
    // The canvas press: the parent loses focus to the frame (the frame is not this document here,
    // so focus stays put, as when the press lands on the frame's own scroll bar or margin).
    const pressedAtMs = epochNowMs();
    await act(async () => dom.window.dispatchEvent(new dom.window.Event('blur')));
    await new Promise((resolve) => setTimeout(resolve, 15));
    // The person presses the chip before the page has said anything.
    await act(async () => view.host.querySelector('[data-chip]').dispatchEvent(mouse('mousedown')));
    await settle();
    check('the chip opens its picker', pickerOpen());
    // The page's late click, stamped with the press's own time, then the ladder's replay.
    await canvasMessage({ ...CLICK, pressedAtMs });
    await settleMotion();
    check('the late click from before the picker opened leaves it open', pickerOpen());
    await canvasMessage({ ...CLICK, replay: 1, pressedAtMs: epochNowMs() });
    await settleMotion();
    check('the replayed click leaves it open', pickerOpen());
    // A press the person makes in the canvas now does close it.
    await canvasMessage({ ...CLICK, pressedAtMs: epochNowMs() });
    await settleMotion();
    check('a new press in the canvas closes it', !pickerOpen());
    await view.done();
  }
  {
    const view = await mount();
    await act(async () => view.host.querySelector('[data-chip]').dispatchEvent(mouse('mousedown')));
    await settle();
    await canvasMessage(CLICK);
    await settleMotion();
    check('an unstamped canvas press (Studio) still closes the picker', !pickerOpen());
    await view.done();
  }

  if (failures.length > 0) {
    console.error(`canvasReloadPress: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`canvasReloadPress: ${checked} passed`);
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
