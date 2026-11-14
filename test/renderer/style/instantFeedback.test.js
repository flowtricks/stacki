// Goal: the Weight dropdown and its blue label answer a pointer at once.
//
//   node test/renderer/style/instantFeedback.test.js
//
// Two latencies were reported on Typography > Weight:
//   1. Hovering a row lagged. The highlight is local state, but the live preview it implies
//      (canvas message, file save, undo bookkeeping) ran in the same task as the highlight's
//      commit, so each row crossed waited on the one before. Now the highlight commits alone
//      and the preview goes out on the next animation frame, once, for the row last landed on.
//   2. Resetting from the blue label showed the old value and the blue label until the save
//      and the model rebuild behind it finished, though the canvas had already changed.
//      Now the label and field read as unset in the same event, and hand back to the model
//      when the clear settles, which is also the rollback when the save failed.
//
// Method: mount the real WeightField (real Select, FieldLabel) in jsdom and dispatch events;
// no real pointer. The frame budget is "this event" or "the next animation frame", never a
// wall-clock threshold. The clear's save is a promise the test holds open, so a UI change
// that waited on it could not pass. The "before" lines run the same field without the hold.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, repoPath } = require('../../helpers/sources.js');

let act;
let runFrame;
const frame = () =>
  act(async () => {
    runFrame();
  });

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test/instant-feedback');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'bundle.js');
  await esbuild.build({
    stdin: {
      contents: `export { WeightField } from './src/features/style/FontFields'
export { useOptimisticClear } from './src/features/style/embed/useOptimisticClear'`,
      resolveDir: ROOT,
      loader: 'tsx',
    },
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
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
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  global.MutationObserver = dom.window.MutationObserver;
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  dom.window.Element.prototype.getBoundingClientRect = function rect() {
    return { x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20 };
  };
  dom.window.Element.prototype.scrollIntoView = () => {};
  dom.window.avb = { listAssets: async () => ({ entries: [] }) };

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  act = React.act;
  const { WeightField, useOptimisticClear } = require(bundlePath);

  const declared = (value) => ({
    source: 'selected',
    overridden: false,
    winner: { selectorText: '.card', value, important: false },
    selectedValue: { value, important: false },
    contributors: [],
  });

  // The panel's side of a clear: the model rebuild the test settles by hand.
  let model = new Map([['font-weight', declared('500')]]);
  let releaseClear = () => {};
  const clearCalls = [];
  const previews = [];
  const baseClear = (prop) => {
    clearCalls.push(prop);
    return new Promise((resolve) => {
      releaseClear = resolve;
    });
  };
  let held = true; // false = the "before" panel, which reads the model alone
  function Harness() {
    const optimistic = useOptimisticClear(model, baseClear);
    const read = held ? optimistic.read : (prop) => model.get(prop);
    const clearProp = held ? optimistic.clearProp : baseClear;
    return React.createElement(WeightField, {
      read,
      busy: false,
      setProp: () => {},
      clearProp,
      liveSetProp: (prop, value) => previews.push(value),
      onProvenance: () => {},
      onSelectSelector: () => {},
    });
  }
  const root = createRoot(document.getElementById('root'));
  const render = () =>
    act(async () => {
      root.render(React.createElement(Harness));
    });
  await render();

  // ── Hover ───────────────────────────────────────────────────────────────
  await act(async () => {
    document.querySelector('.u-select-button').click();
  });
  const rows = () => [...document.querySelectorAll('.u-select-option')];
  const rowFor = (text) => rows().find((row) => row.textContent.includes(text));
  const hover = (row) =>
    act(async () => {
      row.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
    });
  previews.length = 0;

  await hover(rowFor('600'));
  assert.ok(rowFor('600').classList.contains('is-active'), 'the hovered row is highlighted in the event itself');
  assert.deepEqual(previews, [], 'no preview work ran in the same task as the highlight');
  await frame();
  assert.deepEqual(previews, ['600'], 'the preview goes out by the next animation frame');

  // Rows crossed inside one frame: every one highlights at once, only the last previews.
  previews.length = 0;
  await hover(rowFor('700'));
  assert.ok(rowFor('700').classList.contains('is-active'));
  await hover(rowFor('800'));
  assert.ok(rowFor('800').classList.contains('is-active'));
  await hover(rowFor('900'));
  assert.ok(rowFor('900').classList.contains('is-active'));
  assert.deepEqual(previews, [], 'crossing rows sends nothing until the frame');
  await frame();
  assert.deepEqual(previews, ['900'], 'one preview, for the row the pointer rests on');

  // Leaving without a pick puts the page back, and nothing is left waiting.
  previews.length = 0;
  await act(async () => {
    document.querySelector('.u-select-list').dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
  });
  await frame();
  assert.deepEqual(previews, [undefined], 'leaving reverts once');
  await act(async () => {
    document.querySelector('.u-select-button').click(); // close
  });

  // ── Reset from the blue label ───────────────────────────────────────────
  const label = () => document.querySelector('.u-field-label');
  const trigger = () => document.querySelector('.u-select-button .u-select-value, .u-select-button');
  const optionClick = () =>
    act(async () => {
      document.querySelector('.u-field-label.is-active').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, altKey: true }));
    });

  assert.ok(document.querySelector('.u-field-label.is-active'), 'the label is blue while the rule sets the weight');
  assert.match(trigger().textContent, /500/);

  // Before: the same click with a panel that reads the model alone.
  held = false;
  await render();
  await optionClick();
  assert.equal(clearCalls.length, 1);
  const staleBlue = document.querySelector('.u-field-label.is-active') !== null;
  const staleValue = /500/.test(trigger().textContent);
  console.log(`before: after the click, label blue=${staleBlue}, field still shows 500=${staleValue} (until the save and model rebuild settle)`);
  assert.ok(staleBlue && staleValue, 'baseline: without the hold the panel waits for the model');
  model = new Map([['font-weight', declared('500')]]);
  releaseClear();
  await render();

  // After: the held panel, with the save still pending.
  held = true;
  clearCalls.length = 0;
  await render();
  await optionClick();
  assert.equal(clearCalls.length, 1, 'the clear is requested in the click');
  assert.equal(document.querySelector('.u-field-label.is-active') ?? undefined, undefined, 'the blue label is gone in the click, with the save still pending');
  assert.ok(!/500/.test(trigger().textContent), 'the field no longer shows the cleared weight in the click');
  console.log('after: label and field update in the click event (0 frames), save still pending');
  assert.ok(label(), 'the label stays, as a plain caption');

  // The save settles and the model agrees: it stays cleared.
  model = new Map();
  await act(async () => {
    releaseClear();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(document.querySelector('.u-field-label.is-active') ?? undefined, undefined, 'a landed clear stays cleared');

  // The save fails: the model still has the value, so the hold lifting is the rollback.
  model = new Map([['font-weight', declared('500')]]);
  await render();
  assert.ok(document.querySelector('.u-field-label.is-active'));
  await optionClick();
  assert.equal(document.querySelector('.u-field-label.is-active') ?? undefined, undefined);
  await act(async () => {
    releaseClear();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.ok(document.querySelector('.u-field-label.is-active'), 'a clear that did not land puts the value back');
  assert.match(trigger().textContent, /500/);

  await act(async () => root.unmount());
  dom.window.close();
  console.log('instant-feedback: passed');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
