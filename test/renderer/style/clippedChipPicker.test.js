// A press on a chip its field clips opens the large value editor AND the variable chooser.
//
//   node test/renderer/style/clippedChipPicker.test.js
//
// Goal: pressing a chip wider than its input used to open only the large editor, and the person
// pressed the chip again inside it to reach the chooser. The same press now opens both, with the
// search focused; a chip that fits still opens only the chooser. The decision is the one
// predicate that already opens the large editor (doesNotFit), so the two cannot disagree.
// Inside the editor the chip toggles the chooser, Escape closes the chooser first and the editor
// second (returning the caret to the field), a pick applies, Enter or Space on a chip acts as a
// press, and a press outside closes both without leaving a hover preview behind.
// Method: the real VariableConnect in jsdom with stubbed variables. Presses and keys are
// dispatched events, so no real pointer is needed on any runner. jsdom has no layout, so
// "clipped" is doesNotFit's own fallback: a value longer than its character budget.

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
  const bundlePath = path.join(buildDirectory, 'clipped-chip.bundle.js');
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

  const LONG = 'calc(var(--w-regular) * 2 + 10px + 5px)';
  const SHORT = 'var(--w-regular)';
  const mount = async (value) => {
    const picks = [];
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        React.createElement(
          VariableConnect,
          { onPick: (next) => picks.push(next), ariaLabel: 'Weight', prop: 'font-weight', code: true },
          React.createElement('input', { className: 'u-input', value, onChange() {} }),
        ),
      );
    });
    await settle();
    const press = (element) => act(async () => element.dispatchEvent(mouse('mousedown')));
    const key = (target, keyName) =>
      act(async () => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true })));
    const editorOpen = () => !!document.querySelector('.var-custom');
    const pickerOpen = () => !!document.querySelector('.embed-editor_varpicker');
    const done = async () => {
      await act(async () => root.unmount());
      host.remove();
    };
    return { picks, host, press, key, editorOpen, pickerOpen, done };
  };
  const fieldChip = (view) => view.host.querySelector('[data-chip]');
  const searchFocused = () => document.activeElement === document.querySelector('.embed-editor_varpicker-search');

  // --- A clipped chip: one press, editor and chooser, search focused.
  {
    const view = await mount(LONG);
    await view.press(fieldChip(view));
    await settle();
    check('a clipped chip opens the large editor', view.editorOpen());
    check('and the chooser in the same press', view.pickerOpen());
    check('with the search focused', searchFocused());
    check('the applied variable is marked', !!document.querySelector('.embed-editor_varpicker-item.is-selected[data-binding="var(--w-regular)"]'));
    check('nothing was picked', view.picks.length === 0);

    // Toggle: the chip inside the editor closes the chooser only, and opens it again.
    const inner = () => document.querySelector('.var-custom [data-chip]');
    await view.press(inner());
    await settle();
    check('the chip in the editor closes the chooser', !view.pickerOpen() && view.editorOpen());
    await view.press(inner());
    await settle();
    check('and opens it again (a toggle, no race)', view.pickerOpen() && view.editorOpen());

    // Escape: the chooser first, the editor second.
    await view.key(document.querySelector('.embed-editor_varpicker-search'), 'Escape');
    await settle();
    check('the first Escape closes the chooser only', !view.pickerOpen() && view.editorOpen());
    await act(async () => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    await settle();
    check('the second Escape closes the editor', !view.editorOpen());
    check('Escape saves nothing', view.picks.length === 0);
    await view.done();
  }

  // --- A chip that fits: the chooser alone.
  {
    const view = await mount(SHORT);
    await view.press(fieldChip(view));
    await settle();
    check('a chip that fits opens the chooser', view.pickerOpen());
    check('and not the large editor', !view.editorOpen());
    await view.done();
  }

  // --- A pick in the combined mode applies and closes both.
  {
    const view = await mount(LONG);
    await view.press(fieldChip(view));
    await settle();
    await act(async () => {
      const row = document.querySelector('.embed-editor_varpicker-item[data-binding="var(--w-bold)"]');
      row.dispatchEvent(mouse('mousedown'));
      row.dispatchEvent(mouse('click'));
    });
    await settle();
    check('a pick closes the chooser', !view.pickerOpen());
    await view.done();
  }

  // --- Keyboard: Enter and Space on a chip do what a press does.
  for (const keyName of ['Enter', ' ']) {
    const view = await mount(LONG);
    await view.key(fieldChip(view), keyName);
    await settle();
    check(`${JSON.stringify(keyName)} on a clipped chip opens editor and chooser`, view.editorOpen() && view.pickerOpen());
    await view.done();
  }
  {
    const view = await mount(SHORT);
    await view.key(fieldChip(view), 'Enter');
    await settle();
    check('Enter on a chip that fits opens the chooser only', view.pickerOpen() && !view.editorOpen());
    await view.done();
  }

  // --- An outside press closes both, and a hover preview does not stay behind.
  {
    const view = await mount(LONG);
    await view.press(fieldChip(view));
    await settle();
    await act(async () => document.querySelector('.embed-editor_varpicker-item[data-binding="var(--w-bold)"]').dispatchEvent(mouse('pointerover')));
    await settle();
    await act(async () => {
      document.body.dispatchEvent(mouse('mousedown'));
    });
    await settle();
    check('an outside press closes the chooser and the editor', !view.pickerOpen() && !view.editorOpen());
    check('and the previewed variable is not saved', view.picks.length === 0, JSON.stringify(view.picks));
    await view.done();
  }

  if (failures.length > 0) {
    console.error(`clippedChipPicker: ${failures.length} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log('clippedChipPicker: ok');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
