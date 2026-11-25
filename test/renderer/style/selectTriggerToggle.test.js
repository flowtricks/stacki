// Goal: a style dropdown's menu starts closed, its button toggles it, and a press
// outside or Escape closes it; pressing the button of an open menu closes it for good.
// Methodology: mount the shared Select (the Style panel's query dropdown is one),
// open it, then press its button the way a pointer does: pointerdown and mousedown
// on the label inside the button, a pause longer than the popup's exit motion,
// then the click. The click lands on the button itself, as it does when the
// pointer drifts from the label to the chevron between press and release. The
// menu used to read that press as an outside press and close, and the click then
// toggled the closed menu open again. A press outside and Escape must still close it.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { repoPath } = require('../../helpers/sources.js');

const settle = (milliseconds = 0) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
// Longer than POPUP_MOTION_MS (src/ui/popupLifecycle.ts): a press held this long outlasts any exit motion.
const EXIT_WAIT_MS = 250;

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test/select-trigger-toggle');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'select.js');
  await esbuild.build({
    entryPoints: [repoPath('src/features/style/components/Select.tsx')],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div><button id="outside">Outside</button>', { pretendToBeVisual: true });
  // Reduced motion: a closing popup finishes at once (popupDom.js), so the timing below is the pointer's, not the motion's.
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);

  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const Select = require(bundlePath).default;
  const root = createRoot(document.getElementById('root'));
  const options = [
    { value: '', label: 'Base' },
    { value: '@media (hover: hover)', label: '@media (hover: hover)' },
  ];
  function Harness() {
    const [value, setValue] = React.useState('');
    return React.createElement(Select, { value, options, onChange: setValue, ariaLabel: 'Style context' });
  }

  await act(async () => {
    root.render(React.createElement(Harness));
    await settle();
  });
  const button = document.querySelector('.u-select-button');
  const label = button.querySelector('.u-select-label');
  assert.ok(label, 'the button has a label to press');
  const isOpen = () => document.querySelector('.u-select-list') !== null;

  const press = async (pressed, clicked) => {
    await act(async () => {
      pressed.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
      pressed.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      await settle(EXIT_WAIT_MS);
      clicked.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      await settle(EXIT_WAIT_MS);
    });
  };

  assert.equal(isOpen(), false, 'the menu starts closed');
  await act(async () => settle(EXIT_WAIT_MS));
  assert.equal(isOpen(), false, 'and nothing opens it on its own');

  await press(label, button);
  assert.equal(isOpen(), true, 'pressing the closed button opens the menu');

  await press(label, button);
  assert.equal(isOpen(), false, 'pressing the button of the open menu closes it');
  await act(async () => settle(EXIT_WAIT_MS));
  assert.equal(isOpen(), false, 'and the menu stays closed');

  // The negative space: the button is the only press that is not outside.
  await press(label, button);
  assert.equal(isOpen(), true, 'the button opens it again');
  const outside = document.getElementById('outside');
  await press(outside, outside);
  assert.equal(isOpen(), false, 'a press outside still closes the menu');

  await press(label, button);
  assert.equal(isOpen(), true, 'the button opens it once more');
  await act(async () => {
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await settle(EXIT_WAIT_MS);
  });
  assert.equal(isOpen(), false, 'Escape closes the menu');

  await act(async () => root.unmount());
  console.log('select trigger toggle: ok');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
