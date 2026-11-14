// Variables hidden from suggestions stay out of the picker, except the applied one.
//
//   node test/renderer/style/variablePickerHidden.test.js
//
// Goal: the Variables panel's "hide from suggestions" setting (.stacki/variables.json) is honoured
// by the variable picker: a hidden name is absent from the list by default, the variable applied
// to the property being edited is always listed and marked, "Show all" brings hidden ones back
// dimmed with the eye-off mark and the panel's tooltip, and a toggle in the panel's store changes
// an open list at once.
// Method: the real VariableConnect in jsdom over stubbed variables, with the project's hidden-names
// store backed by an in-memory file. Presses are dispatched events.

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
  const bundlePath = path.join(buildDirectory, 'hidden-suggestions.bundle.js');
  await esbuild.build({
    stdin: {
      contents:
        "export { default } from './src/features/style/VariableConnect';\nexport { setHost, getHost } from './src/features/style/model/host';\nexport { hiddenVariablesStore, forgetHiddenVariables } from './src/ipc/hiddenVariables';",
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

  const fakeStorage = () => {
    let source;
    return { read: async () => ({ source }), write: async (write) => ((source = write.source), { source }) };
  };
  const PROJECT = '/fixture/project';
  const bundle = require(bundlePath);
  const VariableConnect = bundle.default;
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  const mouse = (type, init = {}) => new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  const mount = async (value) => {
    bundle.forgetHiddenVariables();
    const store = bundle.hiddenVariablesStore(PROJECT, fakeStorage());
    bundle.setHost({ ...bundle.getHost(), projectPath: PROJECT });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        React.createElement(
          VariableConnect,
          { onPick() {}, ariaLabel: 'Weight', prop: 'font-weight', code: true },
          React.createElement('input', { className: 'u-input', value, onChange() {} }),
        ),
      );
    });
    await settle();
    await act(async () => host.querySelector('[data-chip]').dispatchEvent(mouse('mousedown')));
    await settle();
    const row = (name) => document.querySelector(`.embed-editor_varpicker-item[data-binding="var(--${name})"]`);
    const done = async () => {
      await act(async () => root.unmount());
      host.remove();
    };
    return { store, row, done };
  };
  const showAll = async () => {
    await act(async () => document.querySelector('.embed-editor_varpicker-options').dispatchEvent(mouse('click')));
    await settle();
    const item = [...document.querySelectorAll('[role^="menuitem"]')].find((node) => /show all/i.test(node.textContent));
    await act(async () => item.dispatchEvent(mouse('click')));
    await settle();
  };

  // --- Hidden names are absent by default; the others stay.
  {
    const view = await mount('var(--w-regular)');
    check('every variable is listed before anything is hidden', !!view.row('w-light') && !!view.row('w-bold'));
    await act(async () => void (await view.store.hide('--w-light')));
    await settle();
    check('a hidden variable leaves an open list at once', view.row('w-light') === null);
    check('the others stay', !!view.row('w-bold') && !!view.row('w-regular'));

    // --- Show all brings it back, dimmed, with the mark and the panel's tooltip.
    await showAll();
    const dimmed = view.row('w-light');
    check('show all lists the hidden variable', dimmed !== null);
    check('dimmed', dimmed?.classList.contains('is-hidden') === true);
    check('with the eye-off mark', dimmed?.querySelector('.embed-editor_varpicker-item-hidden') !== null);
    check("and the panel's tooltip", (dimmed?.getAttribute('title') ?? '').includes('Hidden from variable suggestions'), dimmed?.getAttribute('title'));
    check('a visible variable is not marked', view.row('w-bold')?.classList.contains('is-hidden') === false);

    // --- Showing it again in the panel's store clears the mark live.
    await act(async () => void (await view.store.show('--w-light')));
    await settle();
    check('showing it again clears the mark', view.row('w-light')?.classList.contains('is-hidden') === false);
    await view.done();
  }

  // --- The applied variable is always listed and marked, hidden or not.
  {
    const view = await mount('var(--w-regular)');
    await act(async () => void (await view.store.hide('--w-regular')));
    await settle();
    const applied = view.row('w-regular');
    check('the applied variable stays listed though hidden', applied !== null);
    check('and stays selected', applied?.classList.contains('is-selected') === true);
    await view.done();
  }

  if (failures.length > 0) {
    console.error(`variablePickerHidden: ${failures.length} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log('variablePickerHidden: ok');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
