// A side label of the spacing box toggles its editor, however fast it is pressed.
//
//   node test/renderer/style/spacingToggle.test.js
//
// Goal: an odd number of presses on a side's label leaves its editor open and an even number
// leaves it shut, at a person's pace and at a quick double or triple press. The soak's rapid
// toggle found the editor shut after presses that should have opened it: a press landing while
// the popover still played its close motion reopened nothing, because the same popover finished
// closing over the request. A draft typed into the editor is written when a new opening replaces
// one that is still closing, and only once.
//
// Method: the real useSpacingBox (SpacingBox.tsx) renders one label and its editor in jsdom with
// real timers, so the popover's open and close motion (popupLifecycle.ts) runs as in the app. A
// press is the event sequence a pointer makes (pointerdown, mousedown, mouseup, click on the
// label), dispatched; the popup's outside-press dismissal hears it as it does in the app. The
// variables source is stubbed: there is no project.

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { repoPath, stubSources } = require('../../helpers/sources.js');

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const QUICK_PRESS_GAP_MS = 40; // The soak's rapid toggle: a press every ~50 ms.
const SLOW_PRESS_GAP_MS = 400; // Past the popover's close motion.
const SETTLE_MS = 400; // Past the last press's open or close motion.

let environment;

async function boxEnvironment() {
  if (environment !== undefined) {
    return environment;
  }
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'spacing-toggle.bundle.js');
  await esbuild.build({
    entryPoints: [repoPath('src/features/style/SpacingBox.tsx')],
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
        'src/features/style/model/webflow.ts': () => ({ contents: 'export async function streamProjectVariables() { return []; }', loader: 'js' }),
      }),
    ],
  });
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost/', pretendToBeVisual: true });
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
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  environment = { dom, React, createRoot, ...require(bundlePath) };
  return environment;
}

async function mountBox() {
  const { dom, React, createRoot, useSpacingBox } = await boxEnvironment();
  const writes = [];
  const shared = {
    read: () => undefined,
    busy: false,
    setProp: (prop, value) => writes.push([prop, value]),
    clearProp: (prop) => writes.push(['clear', prop]),
    liveSetProp: () => undefined,
    onSelectSelector: () => undefined,
  };
  function Box() {
    const { label, editor } = useSpacingBox(shared);
    return React.createElement('div', { className: 'box' }, label('margin-top', 'top'), editor);
  }
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(Box));
  await wait(50);
  const fire = (target, Type, type) => target.dispatchEvent(new Type(type, { bubbles: true, cancelable: true, composed: true, button: 0 }));
  const press = () => {
    const label = container.querySelector('button.embed-editor_spacing-label');
    assert.ok(label, 'the side label is drawn');
    fire(label, dom.window.PointerEvent ?? dom.window.MouseEvent, 'pointerdown');
    fire(label, dom.window.MouseEvent, 'mousedown');
    fire(label, dom.window.MouseEvent, 'mouseup');
    fire(label, dom.window.MouseEvent, 'click');
  };
  const editorShown = () => container.querySelector('.embed-editor_spacing-popover:not([data-popup-phase="closing"])') !== null;
  const field = () => container.querySelector('input.embed-editor_spacing-editor');
  return { dom, container, writes, press, editorShown, field, unmount: () => (root.unmount(), container.remove()) };
}

for (const [gapName, gapMs] of [
  ['quick', QUICK_PRESS_GAP_MS],
  ['slow', SLOW_PRESS_GAP_MS],
]) {
  test(`${gapName} presses on a side label leave its editor open after an odd count and shut after an even one`, async (context) => {
    const box = await mountBox();
    context.after(box.unmount);
    for (let presses = 1; presses <= 6; presses += 1) {
      box.press();
      await wait(gapMs);
      if (gapMs < SETTLE_MS) {
        continue;
      }
      assert.equal(box.editorShown(), presses % 2 === 1, `after ${presses} ${gapName} presses`);
    }
    await wait(SETTLE_MS);
    assert.equal(box.editorShown(), false, `six ${gapName} presses leave the editor shut`);
    box.press();
    await wait(QUICK_PRESS_GAP_MS);
    box.press();
    await wait(QUICK_PRESS_GAP_MS);
    box.press();
    await wait(SETTLE_MS);
    assert.equal(box.editorShown(), true, `three quick presses after ${gapName} ones leave it open`);
    assert.deepEqual(box.writes, [], 'opening and closing an untouched editor writes nothing');
  });
}

test('a draft is written once when a new opening replaces an editor still closing', async (context) => {
  const box = await mountBox();
  context.after(box.unmount);
  box.press();
  await wait(SETTLE_MS);
  const input = box.field();
  assert.ok(input, 'the editor has its field');
  Object.getOwnPropertyDescriptor(box.dom.window.HTMLInputElement.prototype, 'value').set.call(input, '1rem');
  input.dispatchEvent(new box.dom.window.Event('input', { bubbles: true }));
  box.press(); // Closes, playing the close motion.
  await wait(QUICK_PRESS_GAP_MS);
  box.press(); // Opens a new editor while the last still closes.
  await wait(SETTLE_MS);
  assert.equal(box.editorShown(), true, 'the third press opened the editor again');
  assert.deepEqual(box.writes, [['margin-top', '1rem']], 'the typed value was written, once');
});
