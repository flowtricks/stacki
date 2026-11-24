// Variable chips in a custom property's value: `--_gap-size: var(--section-space-large);` draws its
// reference as the purple chip, as `grid-column-gap: var(--_gap-size);` beside it does.
//
//   node test/renderer/style/codeChipsCustomProperties.test.js
//
// Goal: every complete `var(--name)` in a declaration's value is found, whatever the declared name
// starts with after its `--` (Lumos' private `--_gap-size`, a digit, a non-ASCII letter); before the
// fix the scanner took a custom property's name to need a letter there, so every `--_x:` declaration
// was skipped and its references stayed plain text. The negative space beside it: references inside
// comments and strings, and unclosed ones, are never chips, and a reference to a name the project
// lacks is found by the scanner but drawn as text, as everywhere else in the editor.
// Method: the scanner (cssValueChips.ts) is bundled and checked on its own over small texts and over
// the three `.gap-*` rules of the Studio fixture's utilities.css; then the real extension is mounted in
// a CodeMirror view in jsdom with those rules, and the drawn chips are read from the DOM, unfocused
// and with the reference selected as the audits' click-to-code selects it.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath, stubSources } = require('../../helpers/sources.js');

const VARIABLES_STUB = {
  'src/features/style/model/webflow.ts': () => ({
    contents: `
      export async function getProjectFontFamilies() { return []; }
      export async function getImageAssets() { return []; }
      export async function streamProjectVariables() { return []; }
    `,
    loader: 'js',
  }),
};

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true });
require('../../helpers/popupDom').installPopupDOM(dom.window);
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
for (const name of [
  'Element',
  'HTMLElement',
  'Node',
  'Text',
  'Range',
  'MutationObserver',
  'getComputedStyle',
  'KeyboardEvent',
  'MouseEvent',
  'DOMParser',
  'Window',
  'Event',
]) {
  global[name] = dom.window[name];
}
global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
global.cancelAnimationFrame = clearTimeout;
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 });

let chips;
before(async () => {
  const output = repoPath('node_modules/.stacki-test/code-chips-custom-properties.cjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await build({
    stdin: {
      contents: `
        export { cssValueChips } from './src/features/style/codeChips/cssValueChips';
        export { codeChipsExtension, drawnCodeChips } from './src/features/style/codeChips/codeChipsExtension';
        export { variableChipShown, variableNames } from './src/features/style/codeChips/chipTyping';
        export { EditorView } from '@codemirror/view';
        export { EditorState } from '@codemirror/state';
        export { css } from '@codemirror/lang-css';
      `,
      resolveDir: ROOT,
      loader: 'ts',
    },
    outfile: output,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react-dom/server', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
    plugins: [stubSources('stub-variables', VARIABLES_STUB)],
  });
  chips = require(output);
});

const variables = (text) => chips.cssValueChips(text, 'stylesheet').filter((chip) => chip.kind === 'variable');
const values = (text) => variables(text).map((chip) => chip.value);

// The three rules of the owner's report, as the Studio fixture has them.
const FIXTURE = fs.readFileSync(repoPath('studio/test/fixtures/site/src/styles/utilities.css'), 'utf8');
const GAP_RULES = ['small', 'medium', 'large'].map((size) => {
  const start = FIXTURE.indexOf(`.gap-${size} {`);
  assert.ok(start >= 0, `the fixture has .gap-${size}`);
  return FIXTURE.slice(start, FIXTURE.indexOf('}', start) + 1);
});

test('a custom property’s value has a chip for its reference, whatever its name starts with', () => {
  assert.deepEqual(values('.a { --_gap-size: var(--section-space-large); }'), ['var(--section-space-large)']);
  assert.deepEqual(values('.a { --gap: var(--b); }'), ['var(--b)'], 'a name that starts with a letter, as before');
  assert.deepEqual(values('.a { --1x: var(--b); }'), ['var(--b)'], 'a name that starts with a digit');
  assert.deepEqual(values('.a { --_: var(--b); }'), ['var(--b)'], 'a one-character name');
  assert.deepEqual(values('.a { --é-size: var(--b); }'), ['var(--b)'], 'a non-ASCII name');
  assert.deepEqual(values('.a { --_x: var(--b) !important; }'), ['var(--b)'], 'the flag is not part of the value');
  const [chip] = variables('.a { --_gap-size: var(--s); }');
  assert.ok(chip !== undefined);
  assert.equal(chip.property, undefined, 'a custom property’s reference has no property to filter its picker by');
});

test('nested, fallback and several references in a custom property’s value', () => {
  assert.deepEqual(values('.a { --_x: calc(var(--a) * 2 + var(--b)); }'), ['var(--a)', 'var(--b)'], 'each reference inside calc()');
  assert.deepEqual(values('.a { --_x: var(--a, var(--b)); }'), ['var(--a, var(--b))'], 'a fallback is part of one reference');
  assert.deepEqual(values('.a { --_x: var(--a) var(--b), var(--c); }'), ['var(--a)', 'var(--b)', 'var(--c)']);
  assert.deepEqual(values('.a { --_x: clamp(var(--min), 2vw, var(--max)); }'), ['var(--min)', 'var(--max)']);
});

test('references in comments and strings, and unclosed ones, are never chips', () => {
  assert.deepEqual(values('.a { --_x: /* var(--y) */ 1px; }'), []);
  assert.deepEqual(values('/* --_x: var(--y); */ .a { width: 1px; }'), []);
  assert.deepEqual(values('.a { content: "var(--x)"; --_x: "var(--y)"; }'), []);
  assert.deepEqual(values('.a { --_x: var(--y; }'), []);
});

test('an unfinished declaration above a `--_x:` line is cut there, so the next line keeps its chip', () => {
  const text = '.a {\n  grid-column-gap:\n  --_gap-size: var(--s);\n}';
  assert.deepEqual(values(text), ['var(--s)']);
});

test('the fixture’s three --_gap-size lines each have their reference', () => {
  for (const [index, size] of ['small', 'medium', 'large'].entries()) {
    const rule = GAP_RULES[index];
    assert.ok(rule !== undefined);
    assert.deepEqual(values(rule), ['var(--_gap-size)', 'var(--_gap-size)', `var(--section-space-${size})`], rule);
  }
});

test('a reference to a name the project lacks is found, and drawn as text', () => {
  const [chip] = variables('.a { --_x: var(--nowhere); }');
  assert.ok(chip !== undefined, 'the scanner finds it whether or not it resolves');
  assert.equal(chips.variableChipShown(chip, chips.variableNames([]), undefined), false);
});

// ─────────────────────────── In an editor ───────────────────────────

const variablesNamed = (names) =>
  names.map((name) => ({ name: name.slice(2), collection: 'Sizes', group: '', value: '1rem', binding: `var(${name})`, type: 'Size' }));

function mount(source, names) {
  const handlersRef = {
    current: {
      text: () => 'stylesheet',
      variables: () => variablesNamed(names),
      translate: () => (key) => key,
      onOpen: () => undefined,
      onView: () => undefined,
    },
  };
  const parent = document.createElement('div');
  document.body.append(parent);
  const view = new chips.EditorView({
    parent,
    state: chips.EditorState.create({ doc: source, extensions: [chips.css(), chips.codeChipsExtension(handlersRef)] }),
  });
  return { view, done: () => view.destroy() };
}

const drawnNames = (view) => [...view.contentDOM.querySelectorAll('.embed-editor_varconnect-token')].map((token) => token.textContent);

test('the editor draws the purple chip on each of the three --_gap-size lines', () => {
  const source = GAP_RULES.join('\n\n');
  const names = ['--_gap-size', '--section-space-small', '--section-space-medium', '--section-space-large'];
  const { view, done } = mount(source, names);
  assert.deepEqual(drawnNames(view), [
    '_gap-size',
    '_gap-size',
    'section-space-small',
    '_gap-size',
    '_gap-size',
    'section-space-medium',
    '_gap-size',
    '_gap-size',
    'section-space-large',
  ]);
  assert.equal(view.state.doc.toString(), source, 'drawing changes nothing in the document');
  // The audits' click-to-code selects the reference: the caret ends after it, so it stays a chip.
  const from = source.indexOf('var(--section-space-large)');
  view.focus();
  view.dispatch({ selection: { anchor: from, head: from + 'var(--section-space-large)'.length } });
  assert.ok(drawnNames(view).includes('section-space-large'), 'a selected reference is still its chip');
  done();
});

test('an unknown reference in a custom property stays text in the editor, and nothing breaks', () => {
  const source = '.a { --_x: var(--nowhere); gap: var(--_x); }';
  const { view, done } = mount(source, ['--_x']);
  assert.deepEqual(drawnNames(view), ['_x']);
  assert.match(view.contentDOM.textContent, /var\(--nowhere\)/);
  assert.deepEqual(
    chips.drawnCodeChips(view).map((chip) => chip.value),
    ['var(--_x)'],
  );
  done();
});
