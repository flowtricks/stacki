// Goal: nudging a variable in the Variables sheet shows on the canvas at once and
// reaches the file as a bounded number of writes, none of which our own guard
// refuses, while an edit made by someone else is still refused. Held arrow keys
// used to trail the field by a full commit (a read for undo, the write, a reread
// of every variable, another read) per step.
// Method: the frame message contract is parsed with good and hostile input; the
// save lanes run against a fake file that checks each write's range the way
// cssVars.setVariable does; the live-override tracker is driven through draft,
// save and abandon; the frame half paints into a jsdom document; and a real
// VariableCell is rendered to time a nudge from keystroke to canvas message.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const loadRenderer = require('../../helpers/rendererModule');

const contract = loadRenderer('shared/properties/liveVariables.ts');
const edits = loadRenderer('src/features/variables/liveVariableEdits.ts');

const ROOT = { selector: ':root', context: [], name: '--display-min', value: '40' };

test('live variable messages accept declarations and refuse anything that could escape them', () => {
  assert.deepEqual(contract.parseLiveVariableMessage({ type: 'avb:live-variable', op: 'set', variable: ROOT }), {
    type: 'avb:live-variable',
    op: 'set',
    variable: ROOT,
  });
  assert.deepEqual(contract.parseLiveVariableMessage({ type: 'avb:live-variable', op: 'drop', variable: ROOT, until: '41' })?.until, '41');
  assert.deepEqual(contract.parseLiveVariableMessage({ type: 'avb:live-variable', op: 'clear' }), { type: 'avb:live-variable', op: 'clear' });
  const bad = [
    undefined,
    'avb:live-variable',
    { type: 'avb:live-variable' },
    { type: 'avb:live-variable', op: 'paint', variable: ROOT },
    { type: 'avb:other', op: 'set', variable: ROOT },
    { type: 'avb:live-variable', op: 'set', variable: { ...ROOT, value: '40; color: red' } },
    { type: 'avb:live-variable', op: 'set', variable: { ...ROOT, value: '40 } body { display: none' } },
    { type: 'avb:live-variable', op: 'set', variable: { ...ROOT, value: '40 !important' } },
    { type: 'avb:live-variable', op: 'set', variable: { ...ROOT, value: '' } },
    { type: 'avb:live-variable', op: 'set', variable: { ...ROOT, value: 'x'.repeat(2_001) } },
    { type: 'avb:live-variable', op: 'set', variable: { ...ROOT, name: 'color' } },
    { type: 'avb:live-variable', op: 'set', variable: { ...ROOT, selector: ':root{' } },
    { type: 'avb:live-variable', op: 'set', variable: { ...ROOT, context: Array(9).fill('@media (min-width: 1px)') } },
    { type: 'avb:live-variable', op: 'set', variable: { ...ROOT, context: 'not a list' } },
    { type: 'avb:live-variable', op: 'drop', variable: ROOT, until: '1}' },
  ];
  for (const input of bad) {
    assert.equal(contract.parseLiveVariableMessage(input), undefined, JSON.stringify(input));
  }
});

test('the override sheet wraps each declaration in its own context', () => {
  assert.equal(contract.liveVariablesCss([ROOT]), ':root { --display-min: 40 !important; }');
  assert.equal(
    contract.liveVariablesCss([{ ...ROOT, selector: '.dark', context: ['@media (min-width: 600px)'] }]),
    '@media (min-width: 600px) { .dark { --display-min: 40 !important; } }',
  );
});

// A file that checks every write the way cssVars.setVariable does.
function fakeFile(text, { latencyMs = 5 } = {}) {
  const file = { text, writes: [], refused: 0 };
  file.write = async (cell, value) => {
    await new Promise((resolve) => setTimeout(resolve, latencyMs));
    file.writes.push(value);
    if (file.text.slice(cell.valueStart, cell.valueEnd) !== cell.value) {
      file.refused += 1;
      return false;
    }
    file.text = file.text.slice(0, cell.valueStart) + value + file.text.slice(cell.valueEnd);
    return true;
  };
  return file;
}

const TEXT = ':root { --display-min: 40; --display-max: 131; }';
const CELL = {
  name: '--display-min',
  value: '40',
  file: 'src/styles/global.css',
  selector: ':root',
  valueStart: TEXT.indexOf('40'),
  valueEnd: TEXT.indexOf('40') + 2,
  line: 1,
  column: 'c0',
};

test('a held arrow key is a bounded number of writes, each made from the range the last one left', async () => {
  const file = fakeFile(TEXT);
  const idle = [];
  const saves = edits.createVariableSaves(file.write, { onIdle: (_cell, value) => idle.push(value) });
  // 40 → 140, every step from the same rendered cell, as a field that has not reread yet sends them.
  const pending = [];
  for (let step = 41; step <= 140; step += 1) {
    pending.push(saves.save(CELL, String(step)));
  }
  await Promise.all(pending);
  assert.equal(file.refused, 0);
  assert.ok(file.writes.length <= 2, `expected at most 2 writes, saw ${file.writes.length}`);
  assert.equal(file.text, ':root { --display-min: 140; --display-max: 131; }');
  assert.deepEqual(idle, ['140']);
  assert.equal(saves.busy(CELL), false);
});

test('an edit made by someone else is still refused', async () => {
  const file = fakeFile(TEXT);
  const idle = [];
  const saves = edits.createVariableSaves(file.write, { onIdle: (_cell, value) => idle.push(value) });
  file.text = ':root { --display-min: 52; --display-max: 131; }';
  await saves.save(CELL, '41');
  assert.equal(file.refused, 1);
  assert.equal(file.text, ':root { --display-min: 52; --display-max: 131; }');
  assert.deepEqual(idle, [undefined]);
});

test('cellAfterWrite moves the range with the value, and asserts an ordered range', () => {
  assert.deepEqual(edits.cellAfterWrite(CELL, '9'), { ...CELL, value: '9', valueEnd: CELL.valueStart + 1 });
  assert.throws(() => edits.cellAfterWrite({ ...CELL, valueEnd: CELL.valueStart - 1 }, '9'), /Assertion failed: cellAfterWrite: the range is ordered/);
});

test('an override is held through its save and released with the value written', () => {
  const posted = [];
  const live = edits.createLiveVariables((message) => posted.push(message));
  live.draft(ROOT, '41');
  live.draft(ROOT, '42');
  live.saving(ROOT);
  live.draft(ROOT, undefined); // The field cleared because its save finished: not an abandonment.
  live.saved(ROOT, '42');
  assert.deepEqual(
    posted.map((message) => [message.op, message.variable?.value, message.until]),
    [
      ['set', '41', undefined],
      ['set', '42', undefined],
      ['drop', '42', '42'],
    ],
  );
  posted.length = 0;
  live.draft(ROOT, '43');
  live.draft(ROOT, undefined); // Escape: dropped at once.
  live.saved(ROOT, '43'); // Nothing is saving: ignored.
  assert.deepEqual(
    posted.map((message) => [message.op, message.until]),
    [
      ['set', undefined],
      ['drop', undefined],
    ],
  );
  posted.length = 0;
  live.draft(ROOT, '44');
  live.saving(ROOT);
  live.saved(ROOT, undefined); // The write failed: the page keeps the file's value.
  assert.deepEqual(
    posted.map((message) => [message.op, message.until]),
    [
      ['set', undefined],
      ['drop', undefined],
    ],
  );
});

function installDom() {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
  global.window = dom.window;
  for (const name of [
    'document',
    'navigator',
    'HTMLElement',
    'HTMLStyleElement',
    'HTMLInputElement',
    'Element',
    'Node',
    'MutationObserver',
    'DOMRect',
    'Window',
  ]) {
    global[name] = dom.window[name];
  }
  global.getComputedStyle = dom.window.getComputedStyle;
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  return dom;
}

test('the frame paints overrides into one sheet and clears them', () => {
  installDom();
  const frame = loadRenderer('electron/preload/frameLiveVariables.ts');
  assert.equal(frame.receiveLiveVariables({ type: 'avb:query' }), false);
  assert.equal(frame.receiveLiveVariables({ type: 'avb:live-variable', op: 'set', variable: { ...ROOT, value: '41' } }), true);
  const sheet = () => document.getElementById('avb-live-variables')?.textContent;
  assert.equal(sheet(), ':root { --display-min: 41 !important; }');
  frame.receiveLiveVariables({ type: 'avb:live-variable', op: 'set', variable: { ...ROOT, value: '42' } });
  assert.equal(sheet(), ':root { --display-min: 42 !important; }');
  frame.receiveLiveVariables({ type: 'avb:live-variable', op: 'drop', variable: ROOT });
  assert.equal(sheet(), '');
  frame.receiveLiveVariables({ type: 'avb:live-variable', op: 'set', variable: ROOT });
  frame.receiveLiveVariables({ type: 'avb:live-variable', op: 'clear' });
  assert.equal(sheet(), '');
  assert.equal(document.querySelectorAll('#avb-live-variables').length, 1);
});

test('a nudge reaches the canvas in the same task, and the file once the key is released', async () => {
  const dom = installDom();
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  dom.window.ResizeObserver = global.ResizeObserver;
  const output = repoPath('node_modules/.stacki-test/live-variable-cell.cjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  buildSync({
    stdin: {
      contents:
        "export { default as Cell } from './src/features/variables/VariableCell.tsx';\nexport { VariablePreviewContext } from './src/features/variables/liveVariableEdits.ts';\n",
      resolveDir: repoPath('.'),
      loader: 'ts',
    },
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
  delete require.cache[output];
  const { Cell, VariablePreviewContext } = require(output);
  const React = require('react');
  const { act } = require('react');
  const { createRoot } = require('react-dom/client');

  const previews = [];
  const saves = [];
  const preview = (cell, value) => previews.push({ value, atMs: performance.now() });
  const onSave = async (cell, value) => {
    saves.push(value);
  };
  const root = createRoot(document.getElementById('root'));
  await act(async () => {
    root.render(React.createElement(VariablePreviewContext.Provider, { value: preview }, React.createElement(Cell, { cell: CELL, onSave })));
  });
  const input = document.querySelector('input.var-input');
  assert.ok(input);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  const latencies = [];
  for (const value of ['41', '42', '43']) {
    const startedMs = performance.now();
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    const shown = previews.find((entry) => entry.value === value);
    assert.ok(shown, `the canvas heard ${value}`);
    latencies.push(shown.atMs - startedMs);
  }
  // Nothing written while the key is held.
  assert.deepEqual(saves, []);
  assert.deepEqual(
    previews.map((entry) => entry.value),
    ['41', '42', '43'],
  );
  await act(async () => {
    input.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'ArrowUp', bubbles: true }));
  });
  assert.deepEqual(saves, ['43']);
  console.log(`nudge → canvas message: ${latencies.map((ms) => ms.toFixed(2)).join(', ')} ms`);
  await act(async () => root.unmount());
});
