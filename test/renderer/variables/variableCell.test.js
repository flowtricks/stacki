// Render sparse matrix cells through empty/populated transitions. The same React
// positions are reused, exposing conditional hooks while pinning draft cleanup.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

test('variable cells keep hook order across sparse matrix updates', async () => {
  const output = repoPath('node_modules/.stacki-test/variable-cell.cjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  buildSync({
    entryPoints: [repoPath('src/features/variables/VariableCell.tsx')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  for (const name of ['document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'MutationObserver', 'DOMRect', 'Window']) {
    global[name] = dom.window[name];
  }
  global.getComputedStyle = dom.window.getComputedStyle;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  dom.window.ResizeObserver = global.ResizeObserver;
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const Cell = require(output).default;
  const root = createRoot(document.getElementById('root'));
  const notes = [];
  const onDraft = (name, value) => notes.push({ name, value });
  const cell = {
    name: '--gap',
    value: '1rem',
    file: 'tokens.css',
    selector: ':root',
    column: '0',
    line: 1,
    valueStart: 10,
    valueEnd: 14,
  };
  const sequence = [
    [cell, undefined],
    [undefined, cell],
    [cell, { ...cell, value: '2rem' }],
    [undefined, undefined],
    [undefined, cell],
    [cell, undefined],
  ];
  try {
    for (const values of sequence) {
      await act(async () =>
        root.render(
          React.createElement(
            'div',
            undefined,
            values.map((value, index) => React.createElement(Cell, { key: index, cell: value, onSave() {}, onDraft })),
          ),
        ),
      );
      assert.equal(document.querySelectorAll('.var-cell.empty').length, values.filter((value) => !value).length);
      assert.equal(document.querySelectorAll('.var-cell:not(.empty)').length, values.filter(Boolean).length);
    }
    await act(async () => root.unmount());
    assert.ok(notes.length > sequence.length, 'draft lifecycle ran for populated cells');
    assert.deepEqual(notes.at(-1), { name: '--gap', value: undefined }, 'unmount clears the draft');
    const { renderToStaticMarkup } = require('react-dom/server');
    assert.throws(
      () => renderToStaticMarkup(React.createElement(Cell, { cell: { ...cell, value: 'x'.repeat(1048577) }, onSave() {} })),
      /value limit exceeded/,
    );
  } finally {
    dom.window.close();
  }
});
