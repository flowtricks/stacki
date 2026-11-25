// Goal: typing in a prop's settings costs the same on the three hundredth key as on the first, and
// keeps nothing per key: no render loop, no state or listener list that grows with every keystroke.
// The owner's Mac ran out of memory twice while this panel's test was running (the cause was a
// test-only assertion diff, docs/memory-safety.md), so the panel's own steady state is pinned here.
// Method: bundle the real panel, give it a component of 120 props read by the real reader, open one
// prop's settings and type 300 keys into its Tooltip box through React's own input path. Then
// compare the heap before and after (with collection forced) and the keystroke times of the first
// and last fifty keys. The bounds are loose on purpose: a leak or a loop is orders past them.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const engine = require('node:v8');
const vm = require('node:vm');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { readComponentProperties } = require('#dist/electron/properties/propertyDefinitions.js');

const PROP_COUNT = 120;
const KEY_COUNT = 300;
const WINDOW_KEYS = 50;
const HEAP_GROWTH_BYTES_MAX = 24 * 1024 * 1024;

test('typing in a prop setting keeps a flat cost and a flat heap', async () => {
  const directory = repoPath('node_modules/.stacki-test/properties-growth');
  fs.mkdirSync(directory, { recursive: true });
  const bundle = path.join(directory, 'panel.js');
  await esbuild.build({
    stdin: { contents: `export {default as Panel} from './src/features/componentProperties/ComponentPropertiesPanel';`, resolveDir: ROOT, loader: 'tsx' },
    outfile: bundle,
    inject: [repoPath('test/helpers/toastCaptureEntry.js')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'Window', 'DOMRect']) {
    global[key] = key === 'window' ? dom.window : dom.window[key];
  }
  global.IS_REACT_ACT_ENVIRONMENT = true;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.Range.prototype.getBoundingClientRect = () => new window.DOMRect();
  window.Range.prototype.getClientRects = () => [];
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const { Panel } = require(bundle);
  // A collection the test can force, without a command-line flag the gate would have to pass.
  engine.setFlagsFromString('--expose-gc');
  const collect = vm.runInNewContext('gc');

  const fields = Array.from({ length: PROP_COUNT }, (_, index) => {
    const type = index % 3 === 0 ? `'a' | 'b' | 'c'` : index % 3 === 1 ? 'string' : 'boolean';
    return `  /** Prop ${index}. */\n  p${index}?: ${type};`;
  });
  const names = Array.from({ length: PROP_COUNT }, (_, index) => `p${index}`).join(', ');
  const data = readComponentProperties(`---\ninterface Props {\n${fields.join('\n')}\n}\nconst { ${names} } = Astro.props;\n---\n<div>{p1}</div>\n`);
  assert.equal(data.properties.length, PROP_COUNT);
  let saves = 0;
  window.avb = {
    onFsChanged: () => () => {},
    componentProperties: async () => ({ ok: true, value: data }),
    editComponentProperties: async () => {
      saves++;
      return { ok: true, value: { ...data, undo: '00000000-0000-4000-8000-000000000000' } };
    },
    revertComponentProperties: async () => ({ ok: true, value: { undo: '00000000-0000-4000-8000-000000000000' } }),
  };
  const root = createRoot(document.getElementById('root'));
  const panel = React.createElement(Panel, {
    projectPath: '/site',
    file: '/site/src/components/Card.astro',
    name: 'Card',
    flushSave: async () => {},
    onSavePhase: () => {},
    onSaved: async () => {},
  });
  await act(async () => root.render(panel));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  const rows = document.querySelectorAll('.property-row-main');
  assert.equal(rows.length, PROP_COUNT);
  await act(async () => rows[1].click());
  const tooltipLabel = [...document.querySelectorAll('.property-editor label')].find((label) => label.textContent.trim().startsWith('Tooltip'));
  assert.ok(tooltipLabel !== undefined, 'the settings form has a Tooltip box');
  const tooltip = tooltipLabel.querySelector('textarea');
  assert.ok(tooltip !== null, 'the Tooltip box is a textarea');

  const setText = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  const keystrokesMs = [];
  let text = '';
  collect();
  const heapBefore = process.memoryUsage().heapUsed;
  for (let key = 0; key < KEY_COUNT; key++) {
    text += String.fromCharCode(97 + (key % 26));
    const startedMs = performance.now();
    await act(async () => {
      setText.call(tooltip, text);
      tooltip.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    keystrokesMs.push(performance.now() - startedMs);
  }
  collect();
  const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
  assert.equal(tooltip.value.length, KEY_COUNT, 'every key reached the box');
  assert.ok(heapGrowth < HEAP_GROWTH_BYTES_MAX, `the heap grew ${Math.round(heapGrowth / 1024)} KB over ${KEY_COUNT} keys`);
  const median = (values) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
  const firstMs = median(keystrokesMs.slice(0, WINDOW_KEYS));
  const lastMs = median(keystrokesMs.slice(-WINDOW_KEYS));
  assert.ok(lastMs < firstMs * 4 + 5, `a key took ${firstMs.toFixed(1)} ms at first and ${lastMs.toFixed(1)} ms at the end`);
  // Typing is debounced into saves; it never saves once per key.
  assert.ok(saves < KEY_COUNT, `${saves} saves for ${KEY_COUNT} keys`);
  await act(async () => root.unmount());
});
