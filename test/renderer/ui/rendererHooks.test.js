// Render real hooks with stable callbacks, dispatch browser pointer events, and
// check gesture thresholds, cancellation and cursor cleanup across unmount.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'renderer-hooks.bundle.cjs');
buildSync({
  stdin: {
    contents: `export { default as useListReorder } from './src/ui/useListReorder.ts';
    export { usePointerDrag } from './src/ui/usePointerDrag.ts';`,
    resolveDir: ROOT,
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
});
const { useListReorder, usePointerDrag } = require(output);
const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
Object.assign(global, {
  window: dom.window,
  document: dom.window.document,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
});
const moves = [];
const onMove = (source, target) => moves.push([source, target]);
function Rows() {
  const reorder = useListReorder({ count: 2, onMove });
  return React.createElement(
    'div',
    undefined,
    [0, 1].map((index) => React.createElement('div', { ...reorder.rowProps(index), key: index, 'data-row': index }, index)),
  );
}
const root = createRoot(document.getElementById('root'));
const pointer = async (target, type, clientY) => {
  await act(async () =>
    target.dispatchEvent(
      new window.MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientY,
      }),
    ),
  );
};
async function main() {
  await act(async () => root.render(React.createElement(Rows)));
  const rows = document.querySelectorAll('[data-row]');
  rows.forEach((row, index) => {
    row.getBoundingClientRect = () => ({ top: index * 20, height: 20 });
  });
  await pointer(rows[0], 'pointerdown', 5);
  await pointer(window, 'pointermove', 25);
  assert.equal(document.body.style.cursor, 'grabbing');
  await pointer(window, 'pointerup', 45);
  assert.deepEqual(moves, [[0, 2]]);
  assert.equal(document.body.style.cursor, '');
  await pointer(rows[0], 'pointerdown', 5);
  await pointer(window, 'pointerup', 6);
  assert.equal(moves.length, 1);
  await pointer(rows[0], 'pointerdown', 5);
  await pointer(window, 'pointermove', 25);
  await act(async () => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })));
  await pointer(window, 'pointerup', 45);
  assert.equal(moves.length, 1);
  assert.equal(document.body.style.cursor, '');

  const positions = [];
  let ended = 0;
  function Handle() {
    const begin = usePointerDrag();
    return React.createElement(
      'button',
      {
        onPointerDown: (event) =>
          begin(event, {
            onMove: (next) => positions.push(next.clientY),
            onEnd: () => {
              ended++;
            },
            cursor: 'ew-resize',
          }),
      },
      'Drag',
    );
  }
  await act(async () => root.render(React.createElement(Handle)));
  await pointer(document.querySelector('button'), 'pointerdown', 0);
  await pointer(window, 'pointermove', 20);
  await pointer(window, 'pointerup', 30);
  assert.equal(positions.at(-1), 30);
  assert.equal(ended, 1);
  assert.equal(document.body.style.cursor, '');
  await pointer(document.querySelector('button'), 'pointerdown', 0);
  await act(async () => root.unmount());
  assert.equal(ended, 2);
  assert.equal(document.body.style.cursor, '');
  dom.window.close();
  console.log('renderer-hooks: stable callbacks, gestures, cancellation and cleanup passed');
}
main().catch((error) => {
  console.error(error);
  dom.window.close();
  process.exitCode = 1;
});
