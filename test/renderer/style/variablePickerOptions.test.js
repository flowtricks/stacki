// The variable picker's view options: "Group variables" (remembered) and "Show all variables" (not).
//
//   node test/renderer/style/variablePickerOptions.test.js
//
// Goal: grouping is on by default, switching it off gives one flat list and survives a reopen
// without a flash of the other mode; a corrupt stored value or a storage that throws reads as the
// default and never throws; "Show all" lists variables the property would refuse, muted and
// pickable, and starts off on every open; the applied variable is always listed; the options menu
// works from the keyboard and leaves the search text alone.
// Method: the real picker is mounted in jsdom over fixtures with a stand-in localStorage. Clicks and
// keys are dispatched events; nothing needs a pointer.

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
  const bundlePath = path.join(buildDirectory, 'variable-picker-options.bundle.js');
  await esbuild.build({
    entryPoints: [repoPath('src/features/style/VariablePicker.tsx')],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
    plugins: [
      stubSources('stub-webflow', {
        'src/features/style/model/webflow.ts': () => ({ contents: 'export const streamProjectVariables = async () => [];', loader: 'js' }),
      }),
    ],
  });
  const optionsPath = path.join(buildDirectory, 'variable-picker-options-storage.bundle.js');
  await esbuild.build({
    entryPoints: [repoPath('src/features/style/pickerOptions.ts')],
    outfile: optionsPath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['react'],
    logLevel: 'silent',
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
  let storageBehavior = 'normal';
  const backing = new Map();
  const storage = {
    getItem: (key) => {
      if (storageBehavior === 'throws') {
        throw new Error('blocked');
      }
      return backing.has(key) ? backing.get(key) : null; // eslint-disable-line stacki/no-null -- Stands in for localStorage, which answers null.
    },
    setItem: (key, value) => {
      if (storageBehavior === 'throws') {
        throw new Error('blocked');
      }
      backing.set(key, value);
    },
  };
  Object.defineProperty(global, 'localStorage', { value: storage, configurable: true });
  global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  global.cancelAnimationFrame = clearTimeout;
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
  const { VariablePicker } = require(bundlePath);
  const pickerOptions = require(optionsPath);

  const make = (name, value, type = 'Size') => ({ name, value, type, collection: 'base.css', group: ':root', binding: `var(--${name})` });
  const variables = [make('button-background', '#111', 'Color'), make('button-text', '#fff', 'Color'), make('w-bold', '700', 'Number'), make('gap', '1rem')];
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  const click = (target) =>
    act(async () => {
      target.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      target.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
      target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
  const keyOn = (target, name) =>
    act(async () => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })));

  const open = async (props = {}) => {
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(VariablePicker, { anchor, vars: variables, loading: false, prop: 'font-weight', onPick() {}, onClose() {}, ...props }));
    });
    await settle();
    const rows = () => [...document.querySelectorAll('.embed-editor_varpicker-item')].map((row) => row.dataset.binding.slice(6, -1));
    const groups = () => document.querySelectorAll('.embed-editor_varpicker-family').length;
    const close = async () => {
      await act(async () => root.unmount());
      host.remove();
      anchor.remove();
    };
    return { rows, groups, close };
  };
  const optionsButton = () => document.querySelector('.embed-editor_varpicker-options');
  const menuItem = (label) =>
    [...document.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]')].find((node) => node.textContent.includes(label));

  // Grouping: on by default, off after the menu, remembered, no flash on reopen.
  {
    const picker = await open({ prop: '--anything' });
    check('grouped by default', picker.groups() === 2, String(picker.groups()));
    await click(optionsButton());
    await settle();
    check('the options button opens a menu with both toggles', !!menuItem('Group variables') && !!menuItem('Show all variables'));
    check('the picker stays open under the menu', !!document.querySelector('.embed-editor_varpicker'));
    await click(menuItem('Group variables'));
    await settle();
    check('turning grouping off gives a flat list', picker.groups() === 0 && picker.rows().length === variables.length);
    check('and it is remembered', backing.get('stacki.variablePicker.grouped') === '0');
    await picker.close();
    const again = await open({ prop: '--anything' });
    check('reopened, it is flat on the first render', again.groups() === 0);
    await again.close();
    backing.set('stacki.variablePicker.grouped', '1');
    const back = await open({ prop: '--anything' });
    check('and on again from storage', back.groups() === 2);
    await back.close();
  }

  // A corrupt value and a storage that throws read as the default and never throw.
  {
    backing.set('stacki.variablePicker.grouped', 'banana');
    const corrupt = await open({ prop: '--anything' });
    check('a corrupt stored value reads as grouped', corrupt.groups() === 2);
    await corrupt.close();
    storageBehavior = 'throws';
    const blocked = await open({ prop: '--anything' });
    check('a storage that throws reads as grouped', blocked.groups() === 2);
    await click(optionsButton());
    await settle();
    await click(menuItem('Group variables'));
    await settle();
    check('and toggling still works for the session', blocked.groups() === 0);
    await blocked.close();
    storageBehavior = 'normal';
    backing.clear();
    check(
      'the pure readers agree',
      pickerOptions.parseGrouped('1') === true &&
        pickerOptions.parseGrouped('0') === false &&
        pickerOptions.parseGrouped('x') === undefined &&
        pickerOptions.parseGrouped(undefined) === undefined,
    );
  }

  // Show all: bypasses the filter, mutes what the property refuses, starts off every open.
  {
    const picker = await open({ prop: 'font-weight' });
    check('the filter hides what is no weight', JSON.stringify(picker.rows()) === JSON.stringify(['w-bold']), picker.rows().join());
    await click(optionsButton());
    await settle();
    await click(menuItem('Show all variables'));
    await settle();
    check('show all lists every variable', picker.rows().length === variables.length, picker.rows().join());
    const gap = document.querySelector('[data-binding="var(--gap)"]');
    check(
      'one the property refuses is muted, with the reason in its tooltip',
      gap?.classList.contains('is-invalid') && /Not a valid value for this property/.test(gap.title),
      gap?.title,
    );
    check('a valid one is not muted', !document.querySelector('[data-binding="var(--w-bold)"]')?.classList.contains('is-invalid'));
    await picker.close();
    const reopened = await open({ prop: 'font-weight' });
    check('show all is off again on the next open', reopened.rows().length === 1);
    await reopened.close();
  }

  // The applied variable is always listed, filtered or not.
  {
    const picker = await open({ prop: 'font-weight', selectedBinding: 'var(--gap)' });
    check('the applied variable stays although it is no weight', picker.rows().includes('gap'), picker.rows().join());
    await picker.close();
  }

  // The menu from the keyboard, with the search text left alone.
  {
    const picker = await open({ prop: '--anything' });
    const search = document.querySelector('.embed-editor_varpicker-search');
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(search, 'button');
      search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await settle();
    await click(optionsButton());
    await settle();
    const first = menuItem('Group variables');
    first.focus();
    await keyOn(first, 'Enter');
    await settle();
    check('Enter on the first item toggles grouping', picker.groups() === 0 || picker.groups() === 2);
    check('the search text is kept', search.value === 'button', search.value);
    await keyOn(document.activeElement ?? first, 'Escape');
    await settle();
    check('Escape closes the menu first and leaves the picker open', !menuItem('Group variables') && !!document.querySelector('.embed-editor_varpicker'));
    await picker.close();
  }

  if (failures.length > 0) {
    console.error(`variablePickerOptions: ${failures.length} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log('variablePickerOptions: ok');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
