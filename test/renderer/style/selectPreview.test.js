// Goal: a style dropdown's live preview exists only while an option is being explored.
// Methodology: mount the shared Select, hover an option, leave the whole menu without
// choosing, and verify both the rollback and a fresh preview when the pointer returns.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { repoPath } = require('../../helpers/sources.js');

const settle = (milliseconds = 0) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

let runFrame;
const frame = () => runFrame();

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test/select-preview');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'select.js');
  await esbuild.build({
    entryPoints: [repoPath('src/features/style/components/Select.tsx')],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  // Frames the test runs by hand: a timer-driven frame could land inside an act and make
  // "nothing has run yet" depend on machine load.
  const pendingFrames = new Map();
  let frameIdNext = 1;
  dom.window.requestAnimationFrame = (callback) => {
    const id = frameIdNext;
    frameIdNext += 1;
    pendingFrames.set(id, callback);
    return id;
  };
  dom.window.cancelAnimationFrame = (id) => {
    pendingFrames.delete(id);
  };
  runFrame = () => {
    const callbacks = [...pendingFrames.values()];
    pendingFrames.clear();
    callbacks.forEach((callback) => callback(0));
  };
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;

  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const Select = require(bundlePath).default;
  const previews = [];
  const root = createRoot(document.getElementById('root'));
  const options = [
    { value: 'static', label: 'Static' },
    { value: 'relative', label: 'Relative' },
  ];
  function Harness() {
    const [value, setValue] = React.useState('static');
    return React.createElement(Select, {
      value,
      options,
      onChange: setValue,
      onPreview: (next) => {
        previews.push(next);
        // A real live write returns through the computed-style scan as the Select's
        // value. The rollback must stay paused through that parent update.
        setValue(next ?? 'static');
      },
    });
  }

  await act(async () => {
    root.render(React.createElement(Harness));
    await settle();
  });
  await act(async () => {
    document.querySelector('.u-select-button').click();
    await settle();
  });
  const relative = [...document.querySelectorAll('.u-select-option')].find((option) => option.textContent.includes('Relative'));
  const list = document.querySelector('.u-select-list');
  assert.ok(relative, 'the option to preview is rendered');
  assert.ok(list, 'the open menu is rendered');

  await act(async () => {
    relative.dispatchEvent(
      new dom.window.MouseEvent('mouseover', {
        bubbles: true,
        relatedTarget: document.body,
      }),
    );
    await settle();
  });
  // The preview goes out on the next animation frame (see instantFeedback.test.js).
  assert.deepEqual(previews, []);
  await act(async () => {
    await frame();
  });
  assert.deepEqual(previews, ['relative']);

  await act(async () => {
    list.dispatchEvent(
      new dom.window.MouseEvent('mouseout', {
        bubbles: true,
        relatedTarget: document.body,
      }),
    );
    await settle();
  });
  assert.deepEqual(previews, ['relative', undefined]);
  assert.ok(document.querySelector('.u-select-list'), 'leaving rolls back without closing');

  await act(async () => {
    relative.dispatchEvent(
      new dom.window.MouseEvent('mouseover', {
        bubbles: true,
        relatedTarget: document.body,
      }),
    );
    await settle();
  });
  await act(async () => {
    await frame();
  });
  assert.deepEqual(previews, ['relative', undefined, 'relative']);

  // Commit on press: a live preview can rerender the row before mouseup/click.
  await act(async () => {
    const down = new dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0 });
    Object.defineProperty(down, 'pointerType', { value: 'mouse' });
    document.querySelector('.u-select-option.is-active').dispatchEvent(down);
    await settle();
  });
  assert.equal(document.querySelector('.u-select-list') ?? undefined, undefined);
  assert.match(document.querySelector('.u-select-button').textContent, /Relative/);
  assert.deepEqual(previews, ['relative', undefined, 'relative']);

  await act(async () => root.unmount());
  dom.window.close();
  console.log('select-preview: passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
