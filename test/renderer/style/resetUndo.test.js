// Resetting and undoing in the Style panel: the field, its variable chip, its label and the
// page agree after every step.
//
//   node test/renderer/style/resetUndo.test.js
//
// Goal: after a reset from the blue label, after undo and after redo, the field, the chip
// inside it, the label's state and the element's computed style all show the same value, at
// once and again after the canvas bridge has answered. A hover preview leaves no history
// entry of its own, a commit leaves exactly one, and Escape or leaving the list leaves none.
//
// Method: the real EmbedEditor is mounted in jsdom over a host like Desktop's. The stylesheet
// is a file in memory the stylesheet bridge reads and writes; the canvas bridge answers each
// query from that file after a delay the test sets, so a stale answer would show. The host's
// recordUndo is a copy of the app's push rule (appHistory.ts pushCommand: one step per key
// within 800 ms), and undo and redo run the recorded entry's own functions, as Cmd+Z does.
// Events are dispatched, never a real pointer; the fixture is never a real project.

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const PAGE = '/p/src/pages/index.astro';
const DELAY_MS = 200;
const CSS_INITIAL = `
:root { --brand: #3366ff; --accent: #ff3366; --weight: 500; --weight-bold: 700; --ls: 0.02em; --tt: uppercase; }
.plain { color: red; font-weight: 400; }
.heading { color: var(--brand); font-weight: var(--weight); letter-spacing: var(--ls); text-transform: var(--tt); }
`;

const SIZE = 240;
let environment;

// The panel, its host setter and a jsdom window, set up once for the file.
async function panelEnvironment() {
  if (environment) {
    return environment;
  }
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'selection-first-paint.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `export { default as EmbedEditor } from './src/features/style/EmbedEditor'\nexport { setHost, getHost } from './src/features/style/model/host'\nexport { subscribeErrorToasts } from './src/ui/errorNotices'\nexport { setCanvasFrame, receiveCanvasReply } from './src/editor/canvasQuery'`,
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
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: false,
  };
  // Node defines navigator as a getter, so each global is defined, not assigned.
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(global, name, { value, configurable: true, writable: true });
  }
  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  global.ResizeObserver = Observer;
  dom.window.ResizeObserver = Observer;
  dom.window.Element.prototype.scrollIntoView = function () {};
  // eslint-disable-next-line stacki/no-null -- Stubs the platform getContext, which answers null.
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  dom.window.Element.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: SIZE, bottom: SIZE, width: SIZE, height: SIZE });
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  environment = { dom, React, createRoot, ...require(bundlePath) };
  return environment;
}

const classAttr = (value) => ({ type: 'string', value });
const div = (id, classes) => ({ id, kind: 'element', name: 'div', props: { class: classAttr(classes) }, children: [] });
const CLASS_OF = { n1: 'plain', n2: 'heading' };
const BRIDGE_MS = 150; // The canvas answers this long after it is asked.
const SETTLE_MS = 450; // Past the bridge reply and the writes behind an edit.

// The computed value the canvas would report for `prop` of the element carrying `className`.
function computedFrom(css, className, prop) {
  const variables = {};
  for (const match of css.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) {
    variables[match[1]] = match[2].trim();
  }
  const rule = new RegExp(`\\.${className}\\s*\\{([^}]*)\\}`).exec(css);
  const declaration = rule ? new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+)`).exec(rule[1]) : undefined;
  const text = declaration ? declaration[1].trim() : '';
  return text.replace(/var\((--[\w-]+)\)/g, (whole, name) => variables[name] ?? whole);
}

async function mountPanel() {
  const { dom, React, createRoot, EmbedEditor, setHost, setCanvasFrame, receiveCanvasReply } = await panelEnvironment();
  const disk = { css: CSS_INITIAL, writes: 0 };
  const history = { past: [], future: [], lastKey: undefined, lastPush: 0 };
  const sheet = { rel: 'src/styles/site.css', name: 'site.css', path: '/p/src/styles/site.css', size: 100 };
  const host = {
    projectPath: '/p',
    selectedId: 'n2',
    files: [sheet],
    astroFiles: [],
    openFilePath: PAGE,
    openFileKind: 'page',
    renderedClasses: ['heading'],
    pathOf: (id) => id,
    nodes: [div('n1', 'plain'), div('n2', 'heading')],
    // The app's push rule for a command: the same key within 800 ms is one step.
    recordUndo: (entry) => {
      const now = Date.now();
      const previous = history.past[history.past.length - 1];
      const coalesce =
        entry.coalesceKey !== undefined && entry.coalesceKey === history.lastKey && now - history.lastPush < 800 && previous?.coalesceKey === entry.coalesceKey;
      if (coalesce) {
        previous.redo = entry.redo;
      } else {
        history.past.push({ ...entry });
      }
      history.future.length = 0;
      history.lastKey = entry.coalesceKey;
      history.lastPush = now;
    },
  };
  dom.window.avb = {
    onCssChanged: () => () => {},
    listStyleFiles: async () => ({ files: [sheet] }),
    listAstroStyleFiles: async () => ({ files: [] }),
    listAssets: async () => ({ entries: [] }),
    readStyleFile: async () => ({ css: disk.css }),
    writeStyleFile: async ({ css }) => {
      disk.css = css;
      disk.writes += 1;
      return { ok: true };
    },
  };
  setCanvasFrame({
    postMessage: (message) => {
      if (message?.type !== 'avb:query') {
        return;
      }
      const className = CLASS_OF[message.path] ?? '';
      const matched = Object.fromEntries((message.selectors ?? []).map((selector) => [selector, selector === `.${className}` || selector === 'div']));
      // The answer is read from the file when it is sent, so it is as old as the delay says.
      const computedProps = Object.fromEntries(
        ['color', 'font-weight', 'letter-spacing', 'text-transform'].map((prop) => [prop, computedFrom(disk.css, className, prop)]),
      );
      setTimeout(
        () =>
          receiveCanvasReply({
            id: message.id,
            found: true,
            identity: { tag: 'div', classes: [className], attributes: {} },
            matched,
            computed: {},
            computedProps,
          }),
        BRIDGE_MS,
      );
    },
  });
  setHost(host);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(EmbedEditor));
  await wait(1200);

  const select = async (id) => {
    host.selectedId = id;
    host.renderedClasses = [CLASS_OF[id]];
    setHost({ ...host });
    await wait(SETTLE_MS);
  };
  // The row of the first label with this name, and what it shows: the label's state, the
  // variable chip inside the field, the field's own text.
  const rowOf = (name) => {
    const label = [...container.querySelectorAll('.u-field-label')].find((candidate) => candidate.textContent.trim() === name);
    return label === undefined ? undefined : (label.closest('.u-field-label-wrap') ?? label).parentElement;
  };
  const shown = (name) => {
    const row = rowOf(name);
    assert.ok(row, `the ${name} row exists`);
    const label = [...row.querySelectorAll('.u-field-label')].find((candidate) => candidate.textContent.trim() === name);
    const chip = row.querySelector('[data-chip]');
    const input = row.querySelector('input:not([type="hidden"])');
    return {
      active: label.classList.contains('is-active'),
      chip: chip === null ? '' : chip.textContent.replace(/​/g, '').trim(),
      input: input === null ? undefined : input.value,
    };
  };
  const press = (element, type, init = {}) => element.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
  const reset = (name) =>
    press(
      [...rowOf(name).querySelectorAll('.u-field-label.is-active')].find((label) => label.textContent.trim() === name),
      'click',
      { altKey: true },
    );
  const undo = async () => {
    const entry = history.past.pop();
    assert.ok(entry, 'there is a step to undo');
    history.future.push(entry);
    await entry.undo();
    await wait(SETTLE_MS);
  };
  const redo = async () => {
    const entry = history.future.pop();
    assert.ok(entry, 'there is a step to redo');
    history.past.push(entry);
    await entry.redo();
    await wait(SETTLE_MS);
  };
  const computed = (id, prop) => computedFrom(disk.css, CLASS_OF[id], prop);
  return { dom, container, disk, history, select, rowOf, shown, press, reset, undo, redo, computed, unmount: () => (root.unmount(), container.remove()) };
}

// ── Reset ─────────────────────────────────────────────────────────────────

test('a reset shows the field cleared at once, chip and all, before the canvas answers', async (context) => {
  const panel = await mountPanel();
  context.after(panel.unmount);
  for (const name of ['Color', 'Weight', 'Letter spacing', 'Capitalize']) {
    const before = panel.shown(name);
    assert.ok(before.active && before.chip !== '', `${name} starts as a blue label with a chip: ${JSON.stringify(before)}`);
  }
  for (const name of ['Color', 'Weight', 'Letter spacing', 'Capitalize']) {
    panel.reset(name);
    await wait(60); // Far inside the canvas's answer time.
    const during = panel.shown(name);
    assert.equal(during.active, false, `${name}: the label is no longer blue`);
    assert.equal(during.chip, '', `${name}: no chip while the canvas has not answered`);
    await wait(SETTLE_MS);
    const after = panel.shown(name);
    assert.equal(after.active, false, `${name}: still unset after the canvas answered`);
    assert.equal(after.chip, '', `${name}: still no chip after the canvas answered`);
  }
  assert.ok(
    !/color\s*:|font-weight\s*:|letter-spacing\s*:|text-transform\s*:/.test((/\.heading\s*\{[^}]*\}/.exec(panel.disk.css) ?? [''])[0]),
    'the declarations are gone from the file',
  );
});

test('a reset, its undo and its redo each leave one step and every reader in agreement', async (context) => {
  const panel = await mountPanel();
  context.after(panel.unmount);
  const expectSet = (when) => {
    const state = panel.shown('Color');
    assert.equal(state.active, true, `${when}: the label is blue`);
    assert.equal(state.chip, 'brand', `${when}: the chip is back`);
    assert.equal(panel.computed('n2', 'color'), '#3366ff', `${when}: the page computes the variable's value`);
  };
  const expectUnset = (when) => {
    const state = panel.shown('Color');
    assert.equal(state.active, false, `${when}: the label is plain`);
    assert.equal(state.chip, '', `${when}: no chip`);
    assert.equal(panel.computed('n2', 'color'), '', `${when}: the page computes nothing authored`);
  };
  expectSet('before');
  panel.reset('Color');
  await wait(SETTLE_MS);
  expectUnset('after the reset');
  assert.equal(panel.history.past.length, 1, 'the reset is one undo step');
  await panel.undo();
  expectSet('after undo');
  await panel.redo();
  expectUnset('after redo');
  await panel.undo();
  expectSet('after a second undo');
});

// ── Set, pick, hover ────────────────────────────────────────────────────────

const type = (panel, input, text) => {
  input.focus();
  Object.getOwnPropertyDescriptor(panel.dom.window.HTMLInputElement.prototype, 'value').set.call(input, text);
  input.dispatchEvent(new panel.dom.window.Event('input', { bubbles: true }));
};

test('typing a value is one undo step, and undo and redo bring the field back each way', async (context) => {
  const panel = await mountPanel();
  context.after(panel.unmount);
  await panel.select('n1');
  assert.equal(panel.shown('Letter spacing').active, false, 'the plain element sets no letter spacing');
  const input = panel.rowOf('Letter spacing').querySelector('input');
  type(panel, input, '0.1em');
  await wait(600); // Past the live write that typing sends.
  input.blur();
  await wait(SETTLE_MS);
  assert.equal(panel.shown('Letter spacing').active, true, 'the value is set');
  assert.equal(panel.computed('n1', 'letter-spacing'), '0.1em');
  assert.equal(panel.history.past.length, 1, 'typing then leaving the field is one step');
  await panel.undo();
  assert.equal(panel.shown('Letter spacing').active, false, 'undo: the label is plain');
  assert.equal(panel.rowOf('Letter spacing').querySelector('input').value, '', 'undo: the field is empty');
  assert.equal(panel.computed('n1', 'letter-spacing'), '', 'undo: the page agrees');
  await panel.redo();
  assert.equal(panel.shown('Letter spacing').active, true, 'redo: the label is blue');
  assert.equal(panel.rowOf('Letter spacing').querySelector('input').value, '0.1em', 'redo: the field has the value');
  assert.equal(panel.computed('n1', 'letter-spacing'), '0.1em', 'redo: the page agrees');
});

const frame = () => new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
const hoverRow = async (panel, text) => {
  const row = [...document.querySelectorAll('.u-select-option')].find((option) => option.textContent.includes(text));
  assert.ok(row, `the ${text} row is listed`);
  panel.press(row, 'mouseover', { relatedTarget: document.body });
  await frame();
  await frame();
  return row;
};
const openWeight = async (panel) => {
  const trigger = panel.rowOf('Weight').querySelector('.u-select-button');
  assert.ok(trigger, 'the Weight dropdown is there for a literal weight');
  trigger.click();
  await wait(60);
};

test('hovering rows then picking one is a single undo step that restores the original', async (context) => {
  const panel = await mountPanel();
  context.after(panel.unmount);
  await panel.select('n1');
  await openWeight(panel);
  await hoverRow(panel, '600');
  await hoverRow(panel, '700');
  assert.equal(panel.history.past.length, 0, 'hover previews record no step');
  await wait(900); // Longer than the history's burst window: the pick is a separate burst.
  const row = await hoverRow(panel, '700');
  panel.press(row, 'click');
  await wait(SETTLE_MS);
  assert.equal(panel.computed('n1', 'font-weight'), '700');
  assert.equal(panel.history.past.length, 1, `hover previews add no step; the pick adds one (saw ${panel.history.past.length})`);
  await panel.undo();
  assert.equal(panel.computed('n1', 'font-weight'), '400', 'undo goes straight back to the weight before the hover');
  await panel.redo();
  assert.equal(panel.computed('n1', 'font-weight'), '700');
});

test('hovering rows then leaving or pressing Escape leaves no step and the file as it was', async (context) => {
  const panel = await mountPanel();
  context.after(panel.unmount);
  await panel.select('n1');
  const original = panel.disk.css;
  await openWeight(panel);
  await hoverRow(panel, '900');
  await wait(300);
  panel.press(document.querySelector('.u-select-list'), 'mouseout', { relatedTarget: document.body });
  await wait(SETTLE_MS);
  assert.equal(panel.history.past.length, 0, 'leaving the list leaves no step');
  assert.equal(panel.disk.css, original, 'and the file is as it was');
  await hoverRow(panel, '800');
  await wait(300);
  document.querySelector('.u-select-list').dispatchEvent(new panel.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(SETTLE_MS);
  assert.equal(panel.history.past.length, 0, 'Escape leaves no step');
  assert.equal(panel.disk.css, original, 'and the file is as it was');
});

test('picking another variable is one step, and undo restores the previous value and its chip', async (context) => {
  const panel = await mountPanel();
  context.after(panel.unmount);
  const chip = panel.rowOf('Color').querySelector('[data-chip]');
  assert.ok(chip, 'the colour is a variable chip');
  panel.press(chip, 'mousedown');
  await wait(80);
  const item = document.querySelector('.embed-editor_varpicker-item[data-binding="var(--accent)"]');
  assert.ok(item, 'the picker offers --accent');
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
    panel.press(item, type);
  }
  await wait(SETTLE_MS);
  assert.equal(panel.shown('Color').chip, 'accent', 'the chip names the picked variable');
  assert.equal(panel.computed('n2', 'color'), '#ff3366');
  assert.equal(panel.history.past.length, 1, 'a pick is one step');
  await panel.undo();
  assert.equal(panel.shown('Color').chip, 'brand', 'undo: the previous chip is back');
  assert.equal(panel.computed('n2', 'color'), '#3366ff', 'undo: the page agrees');
  await panel.redo();
  assert.equal(panel.shown('Color').chip, 'accent', 'redo: the picked chip is back');
  assert.equal(panel.computed('n2', 'color'), '#ff3366', 'redo: the page agrees');
});

test.after(() => setTimeout(() => process.exit(0), 100));
