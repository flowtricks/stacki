// Hovering a variable in the picker previews it; leaving without a pick puts the value back.
//
//   node test/renderer/style/variableHoverPreview.test.js
//
// Goal: pointing at a row (or moving the keyboard mark, which shares the path) shows that
// variable in the field and on the canvas through the field's transient draft channel
// (onDraft), and every way out without a pick restores exactly the value the chooser
// opened on: leaving the list, Escape, an outside press, the window losing focus,
// unmounting (a selection or project change). A pick commits the last previewed value
// without passing through the original. A preview never commits: onPick, the only path to
// the stylesheet, history, the dirty flag and saves, is not called until a pick. Rapid
// hovers coalesce to one draft per animation frame, the latest winning.
// Method: the real VariableConnect is mounted in jsdom with the project's variables
// stubbed. Hover is dispatched as pointerover/pointerout and keys as keydown events, so
// no real pointer is needed and the test behaves the same on every platform.

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
  const bundlePath = path.join(buildDirectory, 'variable-hover-preview.bundle.js');
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
  const mount = async () => {
    const drafts = [];
    const picks = [];
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        React.createElement(
          VariableConnect,
          { onPick: (value) => picks.push(value), onDraft: (value) => drafts.push(value), ariaLabel: 'Weight', prop: 'font-weight', code: true },
          React.createElement('input', { className: 'u-input', value: ORIGINAL, onChange() {} }),
        ),
      );
    });
    await settle();
    await act(async () => host.querySelector('[data-chip]').dispatchEvent(mouse('mousedown')));
    await settle();
    const rowOf = (name) => document.querySelector(`.embed-editor_varpicker-item[data-binding="var(--${name})"]`);
    const hover = (name) => act(async () => rowOf(name).dispatchEvent(mouse('pointerover')));
    const leaveList = () =>
      act(async () => document.querySelector('.embed-editor_varpicker-list').dispatchEvent(mouse('pointerout', { relatedTarget: document.body })));
    const key = (target, keyName) =>
      act(async () => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true })));
    const open = () => !!document.querySelector('.embed-editor_varpicker');
    const done = async () => {
      await act(async () => root.unmount());
      host.remove();
    };
    return { drafts, picks, hover, leaveList, key, open, rowOf, root, host, done };
  };
  const last = (list) => list[list.length - 1];

  // --- Hover previews, and leaving the list restores.
  {
    const view = await mount();
    check('the picker opened', view.open());
    await view.hover('w-bold');
    await settle();
    check('hover previews the row in the draft', last(view.drafts) === 'var(--w-bold)', JSON.stringify(view.drafts));
    check('a preview is not a commit', view.picks.length === 0);
    await view.hover('w-light');
    await settle();
    check('moving to another row previews that one', last(view.drafts) === 'var(--w-light)', JSON.stringify(view.drafts));
    await view.leaveList();
    await settle();
    check('leaving the list restores the original', last(view.drafts) === ORIGINAL, JSON.stringify(view.drafts));
    const count = view.drafts.length;
    await view.leaveList();
    await settle();
    check('restoring twice does nothing more (idempotent)', view.drafts.length === count, JSON.stringify(view.drafts));
    await view.key(document.querySelector('.embed-editor_varpicker-search'), 'Escape');
    await settle();
    check('Escape without a preview leaves the value alone', last(view.drafts) === ORIGINAL && view.picks.length === 0);
    await view.done();
  }

  // --- Rapid hovers coalesce to one frame, the latest winning.
  {
    const view = await mount();
    await act(async () => {
      for (const name of ['w-light', 'w-regular', 'w-bold']) {
        view.rowOf(name).dispatchEvent(mouse('pointerover'));
      }
    });
    await settle();
    check('three hovers in one frame make one draft', view.drafts.length === 1, JSON.stringify(view.drafts));
    check('and it is the latest', last(view.drafts) === 'var(--w-bold)', JSON.stringify(view.drafts));
    await view.done();
  }

  // --- A pending frame is cancelled when the pointer leaves: no stale preview afterwards.
  {
    const view = await mount();
    await act(async () => {
      view.rowOf('w-bold').dispatchEvent(mouse('pointerover'));
      document.querySelector('.embed-editor_varpicker-list').dispatchEvent(mouse('pointerout', { relatedTarget: document.body }));
    });
    await settle();
    check('a hover cancelled by leaving never previews', !view.drafts.includes('var(--w-bold)'), JSON.stringify(view.drafts));
    await view.done();
  }

  // --- Escape, an outside press and the window losing focus restore.
  {
    const view = await mount();
    await view.hover('w-bold');
    await settle();
    await view.key(document.querySelector('.embed-editor_varpicker-search'), 'Escape');
    await settle();
    check('Escape closes the picker', !view.open());
    check('Escape restores the original', last(view.drafts) === ORIGINAL, JSON.stringify(view.drafts));
    check('Escape commits nothing', view.picks.length === 0);
    await view.done();
  }
  {
    const view = await mount();
    await view.hover('w-bold');
    await settle();
    await act(async () => {
      document.body.dispatchEvent(mouse('mousedown'));
      document.body.dispatchEvent(mouse('mouseup'));
      document.body.dispatchEvent(mouse('click'));
    });
    await settle();
    check('an outside press restores the original', last(view.drafts) === ORIGINAL, JSON.stringify(view.drafts));
    check('an outside press commits nothing', view.picks.length === 0);
    await view.done();
  }
  {
    const view = await mount();
    await view.hover('w-bold');
    await settle();
    await act(async () => dom.window.dispatchEvent(new dom.window.Event('blur')));
    await settle();
    check('the window losing focus restores the original', last(view.drafts) === ORIGINAL, JSON.stringify(view.drafts));
    await view.done();
  }

  // --- Unmounting with a preview showing (selection or project change) restores.
  {
    const view = await mount();
    await view.hover('w-bold');
    await settle();
    await view.done();
    check('unmounting while previewing restores the original', last(view.drafts) === ORIGINAL, JSON.stringify(view.drafts));
  }

  // --- A pick after a preview commits the previewed value with no frame of the original.
  {
    const view = await mount();
    await view.hover('w-bold');
    await settle();
    const before = view.drafts.length;
    await act(async () => {
      const row = view.rowOf('w-bold');
      row.dispatchEvent(mouse('mousedown'));
      row.dispatchEvent(mouse('mouseup'));
      row.dispatchEvent(mouse('click'));
    });
    await settle();
    check('the pick commits the hovered variable', view.picks.length === 1 && view.picks[0] === 'var(--w-bold)', JSON.stringify(view.picks));
    check(
      'no draft passes through the original between preview and commit',
      view.drafts.slice(before).every((value) => value !== ORIGINAL),
      JSON.stringify(view.drafts),
    );
    check('the picker closed after the pick', !view.open());
    await view.done();
    check('and unmounting after a pick does not restore the original', !view.drafts.slice(before).includes(ORIGINAL), JSON.stringify(view.drafts));
  }

  // --- The keyboard previews through the same path and Escape restores.
  {
    const view = await mount();
    const search = document.querySelector('.embed-editor_varpicker-search');
    await view.key(search, 'ArrowDown');
    await settle();
    check('the arrow previews the next row', last(view.drafts) !== undefined && last(view.drafts) !== ORIGINAL, JSON.stringify(view.drafts));
    await view.key(search, 'Escape');
    await settle();
    check('Escape after an arrow restores the original', last(view.drafts) === ORIGINAL, JSON.stringify(view.drafts));
    check('the keyboard preview commits nothing', view.picks.length === 0);
    await view.done();
  }

  if (failures.length > 0) {
    console.error(`variableHoverPreview: ${failures.length} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log('variableHoverPreview: ok');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
