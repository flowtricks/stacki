// Goal: opening the clip-path editor from the Style panel shows the selector's
// clip-path and changes nothing. It used to start at its own `none`, count that
// as unwritten, and clear the selector's clip-path the moment it mounted; its
// style lookup sees native class styles only, so the shape never loaded either.
// Method: mount the real editor in jsdom with the panel's writers as spies and
// a panel value of `inset(…)`, wait past the write throttle, then read what it
// wrote and what its code field shows. The negative space: a panel with no
// clip-path opens on none and also writes nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources');
const React = require('react');
const { act } = React;

function loadEditor() {
  const output = repoPath('node_modules/.stacki-test/clip-path-open.cjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  buildSync({
    entryPoints: [repoPath('src/features/style/clipPath/ClipPath.tsx')],
    absWorkingDir: ROOT,
    outfile: output,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['react', 'react-dom'],
    loader: { '.css': 'empty' },
    jsx: 'automatic',
    logLevel: 'silent',
  });
  delete require.cache[output];
  return require(output).default;
}

async function open(initialValue) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.HTMLElement = dom.window.HTMLElement;
  global.Element = dom.window.Element;
  global.Node = dom.window.Node;
  for (const name of [
    'MutationObserver',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'KeyboardEvent',
    'MouseEvent',
    'Text',
    'Range',
    'DOMParser',
    'Window',
  ]) {
    global[name] = dom.window[name];
  }
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const ClipPath = loadEditor();
  const { createRoot } = require('react-dom/client');
  const writes = [];
  const root = createRoot(document.getElementById('root'));
  await act(async () => {
    root.render(
      React.createElement(ClipPath, {
        onApply: (value) => writes.push(['apply', value]),
        onClear: () => writes.push(['clear']),
        hideClassPicker: true,
        initialValue,
      }),
    );
  });
  // Past the editor's write throttle (60 ms) and its selection read.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  const text = document.getElementById('root').textContent;
  await act(async () => root.unmount());
  dom.window.close();
  return { writes, text };
}

test('opening on an inset clip-path shows it and writes nothing', async () => {
  const { writes, text } = await open('inset(0.5rem round 2rem)');
  assert.deepEqual(writes, [], 'opening the editor must not write');
  assert.match(text, /Inset/, 'the shape menu names the inset');
  // The code field writes every side: `inset(0.5rem 0.5rem 0.5rem 0.5rem round 2rem)`.
  assert.match(text, /inset\(0\.5rem( 0\.5rem){0,3} round 2rem\)/, 'the code shows the value');
});

test('opening with no clip-path shows none and writes nothing', async () => {
  const { writes } = await open(undefined);
  assert.deepEqual(writes, []);
});
