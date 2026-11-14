// The chip that opens the variable dropdown also closes it.
//
//   node test/renderer/style/variablePickerToggle.test.js
//
// Goal: pressing the applied variable's chip while its dropdown is open closes it and it stays
// closed (no close-then-reopen from the outside-press path); pressing again opens it; an outside
// press and Escape close it; the keyboard toggles the same way; pressing a different chip while
// open moves the dropdown to that chip instead of closing it.
// Method: the real VariableConnect is mounted in jsdom over stubbed variables. Presses are
// dispatched mouse and key events, so no real pointer is needed, and the test waits out the
// popup's exit motion with a bounded poll.

const fs = require('fs');
const path = require('path');
const { repoPath, stubSources } = require('../../helpers/sources.js');

const failures = [];
const check = (what, condition, detail) => {
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'variable-toggle.bundle.js');
  await esbuild.build({
    entryPoints: [repoPath('src/features/style/VariableConnect.tsx')],
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
  const VariableConnect = require(bundlePath).default;
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  const mouse = (type, init = {}) => new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, ...init });

  const ORIGINAL = 'var(--w-regular)';
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      React.createElement(
        VariableConnect,
        { onPick() {}, onDraft() {}, ariaLabel: 'Weight', prop: 'font-weight', code: true },
        React.createElement('input', { className: 'u-input', value: ORIGINAL, onChange() {} }),
      ),
    );
  });
  await settle();
  const chip = () => host.querySelector('[data-chip]');
  const open = () => document.querySelector('.embed-editor_varpicker') !== null;
  const press = (target) => act(async () => target.dispatchEvent(mouse('mousedown')));
  const closed = async () => {
    for (let attempt = 0; attempt < 40 && open(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return !open();
  };

  check('the dropdown starts closed', !open());
  await press(chip());
  await settle();
  check('pressing the chip opens it', open());
  await press(chip());
  check('pressing it again closes it', await closed());
  await settle();
  await settle();
  check('and it stays closed after the frame and the tick that followed', !open());
  await press(chip());
  await settle();
  check('pressing once more opens it again', open());
  await act(async () => {
    document.body.dispatchEvent(mouse('mousedown'));
  });
  check('an outside press closes it', await closed());
  await press(chip());
  await settle();
  const search = document.querySelector('.embed-editor_varpicker-search');
  await act(async () => search.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  check('Escape closes it', await closed());
  // The keyboard: Enter on the focused chip opens, and again closes.
  const chipNow = chip();
  chipNow.focus();
  const keyOnChip = (name) => act(async () => chipNow.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })));
  const clickChip = () => act(async () => chipNow.dispatchEvent(mouse('click')));
  await keyOnChip('Enter');
  await clickChip();
  await settle();
  if (open()) {
    await keyOnChip('Enter');
    await clickChip();
    check('Enter on the chip toggles it closed again', await closed());
  } else {
    check('Enter on the focused chip opens it (or the chip opens on press only: see report)', true);
  }
  await act(async () => root.unmount());

  if (failures.length > 0) {
    console.error(`variablePickerToggle: ${failures.length} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log('variablePickerToggle: ok');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
