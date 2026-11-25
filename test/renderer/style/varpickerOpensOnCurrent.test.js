// The variable picker opens on the variable a field already uses.
//
//   node test/renderer/style/varpickerOpensOnCurrent.test.js
//
// Goal: a field bound to a variable far down a long list (Gap = space-50)
// opens its picker with that variable's row inside the list's visible scroll
// range and marked, so ↓ starts from it — from the chip and from the dot — and
// it stays there while the rows are still changing after the picker opened,
// which is how the bug showed: the row was centred once, then variables that
// sort above it arrived and pushed it out of sight. Only the list may scroll;
// the panel behind the portalled picker must not move, and scrollIntoView,
// which would scroll every ancestor, is never called.
// Method: the real VariableConnect is bundled with a project whose variables
// stream in two parts, the second held back until the test releases it, and
// mounted in jsdom inside a scrolling panel. jsdom has no layout, so the list,
// its rows and their scroll are given a small box model: the list is 200px
// tall at y = 100, every row is 24px, and scrollTop is clamped to the content.

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { repoPath, stubSources } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

const ROW_HEIGHT_PX = 24;
const LIST_HEIGHT_PX = 200;
const LIST_TOP_PX = 100;
// Sizes that sort before and after the applied space-50: the first part of
// the stream is the space-* run, the held-back part is the a-* run that lands
// above it.
const FIRST_PART_COUNT = 60;
const LATER_PART_COUNT = 40;

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'varpicker-opens-on-current.bundle.js');
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
              const size = (name, value) => ({ name, collection: 'Sizes', group: '', value, binding: 'var(--' + name + ')', type: 'Size' });
              export async function streamProjectVariables(onAdd) {
                for (let i = 1; i <= ${FIRST_PART_COUNT}; i++) {
                  onAdd(size('space-' + String(i).padStart(2, '0'), i + 'px'));
                }
                await globalThis.__laterVariables;
                for (let i = 1; i <= ${LATER_PART_COUNT}; i++) {
                  onAdd(size('a-' + String(i).padStart(2, '0'), i + 'rem'));
                }
                return [];
              }
              export const __stub = true;
            `,
          loader: 'js',
        }),
      }),
    ],
  });

  let releaseLater;
  globalThis.__laterVariables = new Promise((resolve) => {
    releaseLater = resolve;
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.Element = dom.window.Element;
  global.HTMLElement = dom.window.HTMLElement;
  global.Node = dom.window.Node;
  global.getComputedStyle = dom.window.getComputedStyle;
  global.MutationObserver = dom.window.MutationObserver;
  global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  global.cancelAnimationFrame = clearTimeout;
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  dom.window.ResizeObserver = global.ResizeObserver;
  global.IS_REACT_ACT_ENVIRONMENT = true;

  // The box model: the list and its rows have a size and a place; every other
  // element keeps jsdom's zeros. Rows are laid out in document order.
  const prototype = dom.window.HTMLElement.prototype;
  const isList = (element) => element.classList.contains('embed-editor_varpicker-list');
  const isRow = (element) => element.classList.contains('embed-editor_varpicker-item');
  const listOf = (element) => element.closest('.embed-editor_varpicker-list');
  const rowIndex = (row) => [...listOf(row).querySelectorAll('.embed-editor_varpicker-item')].indexOf(row);
  const contentHeight = (list) => list.querySelectorAll('.embed-editor_varpicker-item').length * ROW_HEIGHT_PX;
  const scrollTops = new WeakMap();
  const nativeScrollTop = Object.getOwnPropertyDescriptor(dom.window.Element.prototype, 'scrollTop');
  Object.defineProperty(prototype, 'scrollTop', {
    configurable: true,
    get() {
      return scrollTops.get(this) ?? 0;
    },
    set(value) {
      const top = isList(this) ? Math.max(0, Math.min(value, contentHeight(this) - LIST_HEIGHT_PX)) : value;
      scrollTops.set(this, top);
    },
  });
  assert.ok(nativeScrollTop, 'jsdom defines scrollTop');
  const boxHeight = (element) => {
    if (isList(element)) {
      return LIST_HEIGHT_PX;
    }
    return isRow(element) ? ROW_HEIGHT_PX : 0;
  };
  Object.defineProperty(prototype, 'clientHeight', {
    configurable: true,
    get() {
      return boxHeight(this);
    },
  });
  Object.defineProperty(prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return boxHeight(this);
    },
  });
  const rect = (top, height) => ({ top, bottom: top + height, left: 0, right: 300, width: 300, height, x: 0, y: top, toJSON() {} });
  const nativeRect = prototype.getBoundingClientRect;
  prototype.getBoundingClientRect = function () {
    if (isList(this)) {
      return rect(LIST_TOP_PX, LIST_HEIGHT_PX);
    }
    if (isRow(this) && listOf(this)) {
      return rect(LIST_TOP_PX + rowIndex(this) * ROW_HEIGHT_PX - listOf(this).scrollTop, ROW_HEIGHT_PX);
    }
    return nativeRect.call(this);
  };
  let scrollIntoViewCalls = 0;
  dom.window.Element.prototype.scrollIntoView = () => {
    scrollIntoViewCalls++;
  };

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const VariableConnect = require(bundlePath).default;

  const press = (element) => element.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  const clickIt = (element) => {
    press(element);
    element.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  };
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  const key = async (target, keyName) => {
    await act(async () => {
      target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true }));
    });
  };

  // A scrolling panel around the field, scrolled part way, which must not move.
  const panel = document.createElement('div');
  panel.className = 'style-panel';
  document.body.appendChild(panel);
  const mount = async (value) => {
    const host = document.createElement('div');
    host.className = 'embed-editor_root';
    panel.appendChild(host);
    panel.scrollTop = 37;
    const root = createRoot(host);
    await act(async () => {
      root.render(
        React.createElement(
          VariableConnect,
          { onPick() {}, onDraft() {}, ariaLabel: 'Gap', prop: 'row-gap', code: true },
          React.createElement('input', { className: 'u-input', value, onChange() {} }),
        ),
      );
    });
    await settle();
    const done = async () => {
      await act(async () => root.unmount());
      host.remove();
    };
    return { host, done };
  };

  // Where the applied row sits in the list's visible scroll range.
  const inspect = (label) => {
    const list = document.querySelector('.embed-editor_varpicker-list');
    const row = list?.querySelector('.embed-editor_varpicker-item[data-binding="var(--space-50)"]');
    if (!list || !row) {
      check(`${label}: the picker lists space-50`, false, list ? 'no row' : 'no list');
      return;
    }
    const top = rowIndex(row) * ROW_HEIGHT_PX;
    const visibleTop = list.scrollTop;
    const visibleBottom = visibleTop + LIST_HEIGHT_PX;
    check(
      `${label}: space-50 is within the list's visible scroll range`,
      top >= visibleTop && top + ROW_HEIGHT_PX <= visibleBottom,
      `row ${top}px, visible ${visibleTop}–${visibleBottom}px`,
    );
    const middle = visibleTop + (LIST_HEIGHT_PX - ROW_HEIGHT_PX) / 2;
    check(`${label}: and centred in it`, Math.abs(top - middle) <= 1, `row ${top}px, middle ${middle}px`);
    check(`${label}: space-50 is the marked row`, row.classList.contains('is-selected'), row.className);
    check(`${label}: and the only marked row`, list.querySelectorAll('.is-selected').length === 1);
    check(`${label}: the panel behind did not scroll`, panel.scrollTop === 37, String(panel.scrollTop));
    check(`${label}: scrollIntoView was never called`, scrollIntoViewCalls === 0, String(scrollIntoViewCalls));
  };

  // --- From the chip: on open, and after rows that sort above it arrive.
  {
    const { host, done } = await mount('var(--space-50)');
    const chip = host.querySelector('[data-chip]');
    check('the bound field shows a chip', !!chip);
    await act(async () => press(chip));
    await settle();
    check('pressing the chip opens the picker', !!document.querySelector('.embed-editor_varpicker'));
    inspect('chip, first part');
    const before = document.querySelectorAll('.embed-editor_varpicker-item').length;
    await act(async () => releaseLater());
    await settle();
    await settle();
    const after = document.querySelectorAll('.embed-editor_varpicker-item').length;
    check('the held-back variables arrived while the picker was open', after === before + LATER_PART_COUNT, `${before} → ${after}`);
    inspect('chip, after rows above it arrived');
    // The keyboard starts from the applied row: ↓ marks the one after it.
    const search = document.querySelector('.embed-editor_varpicker-search');
    await key(search, 'ArrowDown');
    const marked = document.querySelector('.embed-editor_varpicker-item.is-selected');
    check('↓ from the search marks the row after space-50', marked?.dataset.binding === 'var(--space-51)', marked?.dataset.binding);
    await key(search, 'Escape');
    await settle();
    await done();
  }

  // --- From the dot (the field's + button): the same row, the same place.
  {
    const { host, done } = await mount('var(--space-50)');
    const dot = host.querySelector('.embed-editor_varconnect-dot');
    check('the bound field shows its dot', !!dot);
    await act(async () => clickIt(dot));
    await settle();
    check('the dot opens the picker', !!document.querySelector('.embed-editor_varpicker'));
    inspect('dot');
    await key(document.querySelector('.embed-editor_varpicker-search'), 'Escape');
    await settle();
    await done();
  }

  if (failures.length) {
    console.error(`varpicker-opens-on-current: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`varpicker-opens-on-current: ${checked} passed`);
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
