// Goal: opening the clip-path editor from the Style panel shows the selector's
// clip-path and changes nothing. It used to start at its own `none`, count that
// as unwritten, and clear the selector's clip-path the moment it mounted; its
// style lookup sees native class styles only, so the shape never loaded either.
// Method: mount the real editor in jsdom with the panel's writers as spies and
// a panel value of `inset(…)`, wait past the write throttle, then read what it
// wrote and what its code field shows; unmounting is the popover closing, and
// what was written is read only after it. The negative space: a panel with no
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
  // The code field shows the shorthand as written, not four repeated sides.
  assert.ok(text.includes('inset(0.5rem round 2rem)'), 'the code shows the authored shorthand');
  assert.doesNotMatch(text, /0\.5rem 0\.5rem/, 'the sides are not spelled out');
});

// Opening and closing (the unmount) on any authored form writes nothing, and the
// code field keeps its text byte for byte: a longer form is not shortened, nor a
// shorter one lengthened, until the user edits the shape.
test('opening and closing keeps every authored form and writes nothing', async () => {
  for (const value of ['inset(0.5rem 0.5rem 0.5rem 0.5rem round 2rem)', 'inset(1rem 2rem round 2rem / 1rem)', 'circle(4rem)']) {
    const { writes, text } = await open(value);
    assert.deepEqual(writes, [], `opening and closing on ${value} must not write`);
    assert.ok(text.includes(value), `the code shows ${value} as written`);
  }
});

test('opening with no clip-path shows none and writes nothing', async () => {
  const { writes } = await open(undefined);
  assert.deepEqual(writes, []);
});

// The popover's own writer: it commits the editor's last value to the panel's
// setProp when the popover closes. With nothing applied, closing commits
// nothing; with a value applied and not yet settled, closing commits exactly it.
function loadSettledClipPath() {
  const output = repoPath('node_modules/.stacki-test/clip-path-row.cjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  buildSync({
    entryPoints: [repoPath('src/features/style/ClipPathRow.tsx')],
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
  return require(output).useSettledClipPath;
}

async function closeSettled(applied) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const useSettledClipPath = loadSettledClipPath();
  const { createRoot } = require('react-dom/client');
  const calls = [];
  const writers = {
    setProp: (prop, value) => calls.push(['setProp', prop, value]),
    liveSetProp: (prop, value) => calls.push(['liveSetProp', prop, value]),
    clearProp: (prop) => calls.push(['clearProp', prop]),
  };
  function Probe() {
    const { onApply } = useSettledClipPath(writers);
    React.useEffect(() => {
      if (applied !== undefined) {
        onApply(applied);
      }
    }, []);
    return undefined;
  }
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(Probe)));
  await act(async () => root.unmount());
  dom.window.close();
  return calls;
}

test('closing the popover without an edit calls no writer', async () => {
  assert.deepEqual(await closeSettled(undefined), []);
});

test('closing the popover commits an unsettled edit exactly once, as applied', async () => {
  const calls = await closeSettled('inset(1rem round 2rem)');
  assert.deepEqual(calls, [
    ['liveSetProp', 'clip-path', 'inset(1rem round 2rem)'],
    ['setProp', 'clip-path', 'inset(1rem round 2rem)'],
  ]);
});
