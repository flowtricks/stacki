// CSS chips in code editors: variables as the purple chip, a small preview in front of each easing,
// clip-path, shadow layer, gradient and colour that opens the Style panel's editor for it, a chip in
// front of each layered property that opens its whole list, and a create chip where a value is still
// to be written.
//
//   node test/renderer/style/codeChips.test.js
//
// Goal: the chips find exactly the values the panel has editors for, and nothing else; they are only
// drawn, so the document, a copy and a write-back are the CSS as written; and the "Show CSS chips in
// code" setting removes them from an open editor at once and brings them back.
// Method: the scanner (cssValueChips.ts) is checked on its own, over a stylesheet and over markup's
// `<style>` blocks, with the negative space beside each positive: selectors with colons, comments,
// strings, unclosed calls, keywords no editor shows, a gradient the editor cannot hold, colours inside
// comments, strings, urls and variable fallbacks, vendor prefixes and `!important`. Create chips are
// checked as a declaration is typed (an empty value, an unfinished word, a declaration with no `;`
// above another), and the insertion a first write makes is checked on the text and in a view. Then the real
// extension is bundled and mounted in a CodeMirror view in jsdom; a copy event is replayed over a
// selection that spans a chip, the setting is flipped through its store, and a value is written back
// through writeChipValue. Typed variables are checked as pure positions (where `--`, `var(` and
// `var(--na` open the chooser, and the selectors, names, comments and strings where they must not), as
// the edit a pick makes, and as the chooser's open, follow and dismiss steps; which references are
// chips is checked by name and caret, then in a focused view as a reference is spelt. Last, the settings store is read from a stubbed desktop bridge, and the code
// surfaces are scanned to hold that each one carries the chips.

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
      // The keyword chips read the panel's option tables, whose modules also import these.
      export async function getProjectFontFamilies() { return []; }
      export async function getImageAssets() { return []; }
      export async function streamProjectVariables(onAdd) {
        onAdd({ name: 'gap-size', collection: 'Sizes', group: '', value: '1rem', binding: 'var(--_gap-size)', type: 'Size' });
        return [];
      }
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
  const output = repoPath('node_modules/.stacki-test/code-chips.cjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await build({
    stdin: {
      contents: `
        export { cssValueChips, styleBlocks, CHIP_TEXT_CHARS_MAX } from './src/features/style/codeChips/cssValueChips';
        export { codeChipsExtension, drawnCodeChips, setOpenChip, writeChipValue, openChipRange, createdValueFrame, chipsInViewport } from './src/features/style/codeChips/codeChipsExtension';
        export { KEYWORD_PROPERTIES, keywordChoices, isKeywordOf } from './src/features/style/codeChips/keywordOptions';
        export { ENGLISH_TRANSLATE } from './shared/properties/i18n/englishTranslator';
        export { publishCodeChipsMode, currentCodeChipsMode, subscribeCodeChipsMode } from './src/features/style/codeChips/codeChipsPreference';
        export { EditorView } from '@codemirror/view';
        export { EditorState } from '@codemirror/state';
        export { css } from '@codemirror/lang-css';
        export { cursorCharRight } from '@codemirror/commands';
        export { chipTypedVariableAt, chipTypedCompletion, variableChipShown, variableNames, chipTypingExtension, nextFollowing } from './src/features/style/codeChips/chipTyping';
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

const summary = (found) => found.map((chip) => `${chip.kind}:${chip.value}`);

test('a stylesheet has a chip for each value the panel can edit', () => {
  const text = [
    '.grid {',
    '  gap: var(--_gap-size);',
    '  grid-template-columns: repeat(var(--_cols-xs), 1fr);',
    '  transition: opacity 0.3s ease-in-out, transform 0.2s cubic-bezier(0.2, 0, 0, 1);',
    '  clip-path: inset(0 round 1rem);',
    '  box-shadow: 0 2px 4px red, inset 0 0 1px rgba(0, 0, 0, 0.5);',
    '  text-shadow: 1px 1px 2px black;',
    '  background-image: linear-gradient(90deg, red 0%, blue 100%);',
    '  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);',
    '}',
  ].join('\n');
  const found = chips.cssValueChips(text, 'stylesheet');
  assert.deepEqual(summary(found), [
    'variable:var(--_gap-size)',
    'variable:var(--_cols-xs)',
    'layers:opacity 0.3s ease-in-out, transform 0.2s cubic-bezier(0.2, 0, 0, 1)',
    'easing:ease-in-out',
    'easing:cubic-bezier(0.2, 0, 0, 1)',
    'clipPath:inset(0 round 1rem)',
    'layers:0 2px 4px red, inset 0 0 1px rgba(0, 0, 0, 0.5)',
    'boxShadow:0 2px 4px red',
    'boxShadow:inset 0 0 1px rgba(0, 0, 0, 0.5)',
    'layers:1px 1px 2px black',
    'textShadow:1px 1px 2px black',
    'layers:linear-gradient(90deg, red 0%, blue 100%)',
    'gradient:linear-gradient(90deg, red 0%, blue 100%)',
    'easing:cubic-bezier(0.16, 1, 0.3, 1)',
  ]);
  for (const chip of found) {
    assert.equal(text.slice(chip.from, chip.to), chip.value, 'a chip is exactly the text it covers');
  }
  const gap = found[0];
  assert.equal(gap.property, 'gap', 'a variable knows its declaration, for the picker’s filter');
  assert.equal(text.slice(gap.declaration.from, gap.declaration.to), 'var(--_gap-size)');
});

test('values no editor can show, and text that is not a declaration, have no chips', () => {
  const none = (text) => assert.deepEqual(summary(chips.cssValueChips(text, 'stylesheet')), [], text);
  none('a:hover { width: 1px; }');
  none('a:hover var(--x) { width: 1px; }');
  none('/* gap: var(--a); color: red; */ .a { width: 1px; }');
  none('.a { content: "var(--a)"; }');
  none('.a { gap: var(--a; }');
  none('.a { clip-path: none; text-shadow: inherit; transform: unset; }');
  // A variable may hold several shadows: it is the variable's chip, never a one-layer shadow editor.
  assert.deepEqual(summary(chips.cssValueChips('.a { box-shadow: var(--shadow-lg); }', 'stylesheet')), ['variable:var(--shadow-lg)']);
  none('.a { background: linear-gradient(red, transparent var(--divider-size)); }'.replace('var(--divider-size)', '10% 20%'));
  none('.a { animation: spin 1s linear(0, 1) infinite; }');
  // A transition with no easing the editor can draw still has its list chip, and nothing else.
  assert.deepEqual(summary(chips.cssValueChips('.a { transition: opacity 0.3s steps(4); }', 'stylesheet')), ['layers:opacity 0.3s steps(4)']);
  none('.a { transition-property: ease; }');
  none('.a { --my-var: 1rem; }');
  none('.a { avar(--x): 1; width: myvar(--x); }');
  // A custom property is an easing only when its whole value is one.
  none('.a { --gap: ease 2px; }');
});

test('a reference inside a fallback is part of one chip, and a gradient inside a variable is the variable’s', () => {
  const text = '.a { margin: var(--a, var(--b)); background: var(--bg, linear-gradient(red, blue)); }';
  assert.deepEqual(summary(chips.cssValueChips(text, 'stylesheet')), ['variable:var(--a, var(--b))', 'variable:var(--bg, linear-gradient(red, blue))']);
});

test('markup has chips only inside its style blocks', () => {
  const text =
    '<div style="gap: var(--a)">var(--b)</div>\n<style is:global>\n  .a { gap: var(--c) !important; }\n</style>\n<styles>.b { gap: var(--d); }</styles>';
  assert.deepEqual(summary(chips.cssValueChips(text, 'markup')), ['variable:var(--c)']);
  assert.deepEqual(chips.styleBlocks('<style>.a{}'), [{ from: 7, to: 11 }], 'an unclosed block runs to the end');
  assert.deepEqual(chips.styleBlocks('<p>no styles</p>'), []);
});

test('a text past the bound has no chips', () => {
  const text = `.a { gap: var(--a); }${' '.repeat(chips.CHIP_TEXT_CHARS_MAX)}`;
  assert.deepEqual(chips.cssValueChips(text, 'stylesheet'), []);
});

// ─────────────────────────── The extension ───────────────────────────

// The project's variables a view is mounted with: by default every name the source references, so a
// reference is the purple chip (a reference to a name the project lacks is text, tested on its own).
const variablesNamed = (names) =>
  names.map((name) => ({ name: name.slice(2), collection: 'Sizes', group: '', value: '1rem', binding: `var(${name})`, type: 'Size' }));
const referencedNames = (source) => [...new Set([...source.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)].map((match) => match[1]))];

function mount(source, { variables = variablesNamed(referencedNames(source)) } = {}) {
  const opened = [];
  const handlersRef = {
    current: {
      text: () => 'stylesheet',
      variables: () => variables,
      translate: () => (key) => key,
      onOpen: (request) => opened.push(request),
      onView: () => undefined,
    },
  };
  const parent = document.createElement('div');
  document.body.append(parent);
  const view = new chips.EditorView({
    parent,
    state: chips.EditorState.create({ doc: source, extensions: [chips.css(), chips.codeChipsExtension(handlersRef)] }),
  });
  return { view, opened, done: () => view.destroy() };
}

test('a variable is drawn as the purple chip, and a copy across it is the raw text', () => {
  const source = '.a { margin-top: var(--_margin-top); transition: all 1s ease; }';
  const { view, done } = mount(source);
  const token = view.contentDOM.querySelector('.embed-editor_varconnect-token');
  assert.ok(token, 'the variable is the panel’s chip');
  assert.equal(token.textContent, '_margin-top', 'the chip shows the variable’s name');
  assert.ok(view.contentDOM.querySelector('.code-chip.is-ease'), 'the easing has its curve in front of it');
  assert.match(view.contentDOM.textContent, /ease/, 'the easing itself stays text');
  assert.equal(view.state.doc.toString(), source, 'drawing changes nothing in the document');
  // CodeMirror copies only while the page's selection is in the editor, as a person's selection is.
  view.focus();
  view.dispatch({ selection: { anchor: 0, head: source.length } });
  view.observer.readSelectionRange();
  const copied = new Map();
  const event = new dom.window.Event('copy', { bubbles: true, cancelable: true });
  event.clipboardData = { setData: (type, text) => copied.set(type, text), clearData: () => copied.clear(), getData: () => '' };
  view.contentDOM.dispatchEvent(event);
  assert.equal(copied.get('text/plain'), source, 'the copy is the CSS as written, var() and all');
  done();
});

test('the caret steps over a variable chip whole', () => {
  const source = '.a { gap: var(--a); }';
  const { view, done } = mount(source);
  const start = source.indexOf('var(');
  view.dispatch({ selection: { anchor: start } });
  chips.cursorCharRight(view);
  assert.equal(view.state.selection.main.head, start + 'var(--a)'.length, 'one step crosses the whole reference');
  done();
});

test('turning the setting off shows plain CSS at once, and on draws the chips again', () => {
  const { view, done } = mount('.a { gap: var(--a); clip-path: circle(50%); }');
  assert.equal(chips.drawnCodeChips(view).length, 2);
  chips.publishCodeChipsMode('plain');
  assert.equal(view.contentDOM.querySelectorAll('[data-code-chip]').length, 0, 'no chip is drawn');
  assert.deepEqual(chips.drawnCodeChips(view), []);
  chips.publishCodeChipsMode('shown');
  assert.equal(view.contentDOM.querySelectorAll('[data-code-chip]').length, 2, 'both chips are back');
  done();
});

test('pressing a chip opens it, and a write replaces only its range, wherever typing moved it', () => {
  const source = '.a {\n  transition: opacity 1s ease;\n  color: red;\n}';
  const { view, opened, done } = mount(source);
  const chip = view.contentDOM.querySelector('.code-chip.is-ease');
  chip.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(opened.length, 1);
  assert.equal(opened[0].chip.kind, 'easing');
  chips.setOpenChip(view, { from: opened[0].chip.from, to: opened[0].chip.to });
  view.dispatch({ changes: { from: 0, insert: '/* moved */\n' } });
  assert.equal(chips.writeChipValue(view, 'cubic-bezier(0.1, 0.2, 0.3, 1)'), true);
  assert.equal(view.state.doc.toString(), `/* moved */\n${source.replace('ease;', 'cubic-bezier(0.1, 0.2, 0.3, 1);')}`, 'nothing but the value changed');
  assert.equal(chips.writeChipValue(view, 'cubic-bezier(0.1, 0.2, 0.3, 1)'), false, 'writing the same value is no edit');
  const range = chips.openChipRange(view);
  view.dispatch({ changes: { from: range.from, to: range.to } });
  assert.equal(chips.openChipRange(view), undefined, 'a deleted value is no longer open');
  assert.equal(chips.writeChipValue(view, 'ease'), false, 'and nothing is written for it');
  assert.throws(() => chips.writeChipValue(view, ''), /a chip value is never empty/);
  done();
});

// ─────────────────────────── Layers, colours and create chips ───────────────────────────

test('a layered property has a chip for its whole list, and colours have swatches', () => {
  const text = [
    '.a {',
    '  -webkit-transform: translateX(1px);',
    '  filter: blur(2px) drop-shadow(0 0 1px red);',
    '  backdrop-filter: none;',
    '  transition: opacity 1s ease !important;',
    '  color: #ff0000;',
    '  border: 1px solid rgb(0 0 0 / 50%);',
    '  background-color: RebeccaPurple;',
    '  --brand: hsl(10 50% 50%);',
    '}',
  ].join('\n');
  const found = chips.cssValueChips(text, 'stylesheet');
  assert.deepEqual(summary(found), [
    'layers:translateX(1px)',
    'layers:blur(2px) drop-shadow(0 0 1px red)',
    'layers:none',
    'layers:opacity 1s ease',
    'easing:ease',
    'color:#ff0000',
    'color:rgb(0 0 0 / 50%)',
    'color:RebeccaPurple',
    'color:hsl(10 50% 50%)',
  ]);
  assert.equal(found[0].property, 'transform', 'a vendor prefix opens the unprefixed editor');
  assert.equal(found[3].property, 'transition');
  assert.ok(!found[3].value.includes('important'), '`!important` stays outside the range a write replaces');
});

test('colours inside comments, strings, urls and variables, and outside colour properties, have no swatch', () => {
  const kinds = (text) => summary(chips.cssValueChips(text, 'stylesheet'));
  assert.deepEqual(kinds('.a { color: /* red */ var(--ink); }'), ['variable:var(--ink)']);
  assert.deepEqual(kinds('.a { color: var(--ink, red); }'), ['variable:var(--ink, red)'], 'a fallback is the variable’s');
  assert.deepEqual(kinds('.a { color: rgb(var(--r) 0 0); }'), ['variable:var(--r)'], 'a channel in a variable is not a colour yet');
  assert.deepEqual(kinds('.a { background: url("red.png") no-repeat; }'), []);
  assert.deepEqual(kinds('.a { background: url(red.png); }'), []);
  assert.deepEqual(kinds('.a { content: "red"; color: currentColor; }'), []);
  assert.deepEqual(kinds('.a { width: red; font-family: black; }'), [], 'a colour word in a property that holds none');
  assert.deepEqual(kinds('.a { border: 1px solid #ggg; outline: #12 solid; }'), [], 'not a hex colour');
  assert.deepEqual(kinds('.a { color: #12; }'), ['color:#12'], 'an unfinished hex is offered the picker, which replaces it');
  assert.deepEqual(kinds('.a { transform: var(--t); box-shadow: inherit; }'), ['variable:var(--t)'], 'a whole variable or keyword is no list');
});

test('a declaration being typed gets a create chip where its value goes', () => {
  const text = [
    '.a {',
    '  background-image: ',
    '  transition:',
    '  color: re',
    '  transform: ;',
    '  animation: spin',
    '  animation-timing-function: lin;',
    '  clip-path:}',
  ].join('\n');
  const found = chips.cssValueChips(text, 'stylesheet');
  assert.deepEqual(summary(found), ['layers:', 'layers:', 'color:re', 'layers:', 'easing:lin', 'clipPath:']);
  assert.equal(found[0].property, 'background-image', 'an empty background image opens its layer list');
  assert.deepEqual(summary(chips.cssValueChips('.a { background: }', 'stylesheet')), ['gradient:'], 'the shorthand is offered a gradient');
  const image = found[0];
  assert.equal(image.from, image.to, 'a create chip covers nothing');
  assert.equal(image.from, text.indexOf('background-image: ') + 'background-image: '.length, 'it sits after the colon and its space');
  assert.equal(found[1].property, 'transition', 'an unfinished declaration does not swallow the next line');
  assert.equal(found[1].from, text.indexOf('transition:') + 'transition:'.length);
  assert.equal(found[3].property, 'transform');
});

test('no create chip in selectors, comments or strings, for a finished value, or where no editor makes one', () => {
  const none = (text) => assert.deepEqual(summary(chips.cssValueChips(text, 'stylesheet')), [], text);
  none('/* color: */ .a {}');
  none('.a:hover {}');
  none('.a::before {}');
  none('.a { content: "color:"; }');
  none('.a { width: ; height:; }');
  none('.a { color: inherit; color: currentColor; background-image: inherit; }');
  none('.a { animation: spin; }');
  none('.a { color: red; }'.replace('red', 'transparent').replace('transparent', 'unset'));
});

test('a first write into an empty value adds the space and the `;` it needs, and only those', () => {
  const at = (text, marker) => text.indexOf(marker) + marker.length;
  assert.deepEqual(chips.createdValueFrame('.a { color: }', at('.a { color: }', 'color: ')), { before: '', after: ';' });
  assert.deepEqual(chips.createdValueFrame('.a { color:; }', at('.a { color:; }', 'color:')), { before: ' ', after: '' });
  assert.deepEqual(chips.createdValueFrame('.a { color: !important; }', at('.a { color: !important; }', 'color: ')), { before: '', after: ' ' });
  assert.deepEqual(chips.createdValueFrame('.a {\n  color:\n}', at('.a {\n  color:\n}', 'color:')), { before: ' ', after: ';' });
  assert.throws(() => chips.createdValueFrame('a', 5), /the place ends in the text/);
});

test('a create chip inserts its value, then becomes the value’s own chip', () => {
  const source = '.a {\n  color:\n  gap: 1px;\n}';
  const { view, opened, done } = mount(source);
  const create = view.contentDOM.querySelector('.code-chip.is-create');
  assert.ok(create, 'an empty colour has its create chip');
  create.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(opened.length, 1);
  assert.equal(opened[0].chip.kind, 'color');
  assert.equal(opened[0].chip.value, '');
  chips.setOpenChip(view, { from: opened[0].chip.from, to: opened[0].chip.to });
  assert.equal(view.state.doc.toString(), source, 'opening writes nothing');
  assert.equal(chips.writeChipValue(view, '#ff0000'), true);
  assert.equal(view.state.doc.toString(), '.a {\n  color: #ff0000;\n  gap: 1px;\n}');
  const range = chips.openChipRange(view);
  assert.equal(view.state.sliceDoc(range.from, range.to), '#ff0000', 'the open range is the value, not its space or `;`');
  assert.equal(chips.writeChipValue(view, 'rgb(0, 0, 255)'), true);
  assert.equal(view.state.doc.toString(), '.a {\n  color: rgb(0, 0, 255);\n  gap: 1px;\n}', 'a second write replaces the value alone');
  assert.ok(view.contentDOM.querySelector('.code-chip.is-create') === null, 'the create chip has become the colour’s swatch');
  assert.ok(view.contentDOM.querySelector('.code-chip.is-swatch'));
  done();
});

test('only the chips near the viewport are drawn, and every chip can still be found', () => {
  const rule = '.a { gap: var(--a); }\n';
  const text = rule.repeat(400);
  const all = chips.cssValueChips(text, 'stylesheet');
  assert.equal(all.length, 400);
  const seen = chips.chipsInViewport(all, { from: 0, to: rule.length }, text.length);
  assert.ok(seen.length < all.length, 'a long stylesheet draws only what is near the screen');
  assert.ok(seen.length > 0);
  assert.ok(
    seen.every((chip) => chip.from <= rule.length + 2000),
    'within the margin',
  );
  assert.throws(() => chips.chipsInViewport(all, { from: 5, to: 1 }, text.length), /the viewport keeps its order/);
});

// ─────────────────────────── Typed variables, and which references are chips ───────────────────────────

// The text with `|` taken out, and where it was: the caret.
const caretIn = (marked) => ({ text: marked.replace('|', ''), caret: marked.indexOf('|') });
const typedAt = (marked, kind = 'stylesheet') => {
  const { text, caret } = caretIn(marked);
  return chips.chipTypedVariableAt(text, kind, caret);
};

test('`--`, `var(` and `var(--na` in a value open the chooser, filtered by the name typed', () => {
  const bare = typedAt('.a { transform: translate3d(4.6875rem, --|, 0rem); }');
  assert.ok(bare, 'a bare `--` as a function argument');
  assert.equal(bare.typed.query, '');
  assert.equal(bare.prop, 'transform', 'the chooser filters by the declaration');
  const opened = typedAt('.a { gap: var(|) }');
  assert.ok(opened, 'right after `var(`, with the paired `)`');
  assert.equal(opened.typed.query, '');
  assert.equal(opened.typed.end, '.a { gap: var()'.length, 'the paired `)` is replaced with the fragment');
  assert.equal(typedAt('.a { gap: var(--|) }').typed.query, '');
  const spelt = typedAt('.a { gap: var(--s|) }');
  assert.equal(spelt.typed.query, 's', 'the typed name filters the list');
  assert.equal(typedAt('.a { gap: var(--s|ize) }').typed.query, 'size', 'a name the caret is inside is the whole query');
  assert.equal(typedAt('.a { --x: --|; }').prop, undefined, 'a custom property’s value takes any variable');
  assert.ok(typedAt('<style>\n.a { gap: --| }\n</style>', 'markup'), 'inside a markup style block');
});

test('no chooser in a property name, a selector, a comment, a string, or outside a style block', () => {
  const none = (marked, kind = 'stylesheet') => assert.equal(typedAt(marked, kind), undefined, marked);
  none('.a { --foo| }');
  none('.a {\n  --foo|');
  none('.a {\n  color: red\n  --s|');
  none('a:hover --|{ }');
  none('/* gap: --| */');
  none('.a { gap: /* --| */ 1px; }');
  none('.a { content: "--|"; }');
  none(".a { content: 'var(|'; }");
  none('.a { gap: a--|; }');
  none('.a { gap: myvar(|); }');
  none('<div>gap: --|</div><style>.a{}</style>', 'markup');
  none('.a { gap: var(--a)| }');
  assert.throws(() => chips.chipTypedVariableAt('', 'stylesheet', -1), /the caret is not before the text/);
});

test('a pick replaces only the typed fragment, with no doubled `var(`, `--` or `)`', () => {
  const complete = (marked, binding) => {
    const { text } = caretIn(marked);
    const typed = typedAt(marked);
    const edit = chips.chipTypedCompletion(text, typed, binding);
    const next = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
    return next.slice(0, edit.caret) + '|' + next.slice(edit.caret);
  };
  assert.equal(complete('.a { transform: translate3d(1rem, --|, 0rem); }', 'var(--gap)'), '.a { transform: translate3d(1rem, var(--gap)|, 0rem); }');
  assert.equal(complete('.a { gap: var(|) }', 'var(--gap)'), '.a { gap: var(--gap)| }');
  assert.equal(complete('.a { gap: var(--s|) }', 'var(--size)'), '.a { gap: var(--size)| }');
  assert.equal(complete('.a { gap: var(--s|ize) }', 'var(--size)'), '.a { gap: var(--size)| }');
  assert.equal(complete('.a { gap: var(--s|, 1rem); }', 'var(--size)'), '.a { gap: var(--size|, 1rem); }', 'a fallback typed after stays');
  assert.equal(complete('.a { gap: var(--s| }', 'var(--size)'), '.a { gap: var(--size)| }', 'an unclosed reference is closed');
});

test('a reference is a chip only when it names a project variable and the caret is outside it', () => {
  const names = chips.variableNames(variablesNamed(['--gap', '--gap-large']));
  assert.deepEqual([...names], ['--gap', '--gap-large']);
  const chipOf = (text) => chips.cssValueChips(text, 'stylesheet').find((chip) => chip.kind === 'variable');
  const text = '.a { gap: var(--gap); }';
  const chip = chipOf(text);
  assert.equal(chips.variableChipShown(chip, names, undefined), true, 'an existing variable, unfocused');
  assert.equal(chips.variableChipShown(chip, names, chip.to), true, 'the caret just after it');
  assert.equal(chips.variableChipShown(chip, names, chip.from), true, 'the caret just before it');
  assert.equal(chips.variableChipShown(chip, names, chip.to - 1), false, 'the caret inside it, still editing');
  assert.equal(chips.variableChipShown(chipOf('.a { gap: var(--s); }'), names, undefined), false, 'a name the project lacks');
  assert.equal(chips.variableChipShown(chipOf('.a { gap: var(--ga); }'), names, undefined), false, 'a prefix is not the name');
  assert.equal(chips.variableChipShown(chipOf('.a { gap: var(--gap, 1rem); }'), names, undefined), true, 'a fallback, by its own name');
  assert.equal(chips.variableChipShown(chipOf('.a { gap: var(--nope, var(--gap)); }'), names, undefined), false, 'by its own name, not the fallback’s');
  assert.equal(chipOf('.a { gap: var(--gap; }'), undefined, 'an incomplete reference is never found');
});

test('in a view, only known references are chips, and the one being spelt stays text', () => {
  const { view, done } = mount('.a { gap: var(--gap); margin: var(--nope); }', { variables: variablesNamed(['--gap', '--size']) });
  assert.deepEqual(
    chips.drawnCodeChips(view).map((chip) => chip.value),
    ['var(--gap)'],
    'the unknown reference is plain text',
  );
  assert.equal(view.contentDOM.querySelectorAll('.embed-editor_varconnect-token').length, 1);
  view.focus();
  const at = view.state.doc.toString().indexOf('var(--nope)');
  view.dispatch({ changes: { from: at, to: at + 'var(--nope)'.length, insert: 'var(--s)' }, selection: { anchor: at + 'var(--s'.length } });
  assert.equal(view.hasFocus, true, 'the view has the focus, so its caret counts');
  assert.equal(chips.drawnCodeChips(view).length, 1, '`var(--s|)` is text while spelt');
  view.dispatch({ changes: { from: at + 'var(--s'.length, insert: 'ize' }, selection: { anchor: at + 'var(--size'.length } });
  assert.equal(chips.drawnCodeChips(view).length, 1, 'an existing name the caret is still inside stays text');
  view.dispatch({ selection: { anchor: at + 'var(--size)'.length } });
  assert.deepEqual(
    chips.drawnCodeChips(view).map((chip) => chip.value),
    ['var(--gap)', 'var(--size)'],
    'the caret leaving a complete, known reference makes it the chip',
  );
  view.contentDOM.blur();
  done();
});

test('the typing extension reports typed references, and takes keys only while the chooser has them', () => {
  const reports = [];
  let taking = false;
  const handlersRef = {
    current: {
      text: () => 'stylesheet',
      onTyped: (_view, typed, cause) => reports.push({ query: typed?.typed.query, cause }),
      onKey: () => taking,
    },
  };
  const parent = document.createElement('div');
  document.body.append(parent);
  const view = new chips.EditorView({
    parent,
    state: chips.EditorState.create({ doc: '.a { gap: ; }', extensions: [chips.chipTypingExtension(handlersRef)] }),
  });
  const at = '.a { gap: '.length;
  view.dispatch({ changes: { from: at, insert: '--' }, selection: { anchor: at + 2 }, userEvent: 'input.type' });
  assert.deepEqual(reports.at(-1), { query: '', cause: 'input' });
  view.dispatch({ changes: { from: at + 2, insert: 's' }, selection: { anchor: at + 3 }, userEvent: 'input.type' });
  assert.deepEqual(reports.at(-1), { query: 's', cause: 'input' }, 'the filter follows the typing');
  view.dispatch({ selection: { anchor: 0 } });
  assert.deepEqual(reports.at(-1), { query: undefined, cause: 'selection' });
  const press = (key) => {
    const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(event);
    return event.defaultPrevented;
  };
  assert.equal(press('ArrowDown'), false, 'a closed chooser leaves the arrows to the editor');
  taking = true;
  assert.equal(press('ArrowDown'), true, 'an open one takes them');
  assert.equal(press('Escape'), true);
  view.destroy();
  assert.equal(reports.at(-1).query, undefined, 'a view that goes closes its chooser');
});

test('typing opens the chooser, a caret move never does, and Escape keeps it away until the next reference', () => {
  const typed = (start, query) => ({ typed: { start, end: start + query.length, query }, prop: 'gap' });
  const dismissed = { current: undefined };
  assert.equal(chips.nextFollowing({ view: 'v', typed: typed(4, ''), cause: 'selection' }, undefined, dismissed), undefined, 'clicking into a reference');
  const open = chips.nextFollowing({ view: 'v', typed: typed(4, ''), cause: 'input' }, undefined, dismissed);
  assert.equal(open.typed.typed.start, 4, 'typing `--` opens it');
  assert.equal(
    chips.nextFollowing({ view: 'v', typed: typed(4, 's'), cause: 'selection' }, open, dismissed).typed.typed.query,
    's',
    'an open one follows the caret',
  );
  dismissed.current = { view: 'v', start: 4 };
  assert.equal(chips.nextFollowing({ view: 'v', typed: typed(4, 'si'), cause: 'input' }, undefined, dismissed), undefined, 'Escape holds while it is spelt');
  assert.equal(chips.nextFollowing({ view: 'v', typed: undefined, cause: 'input' }, undefined, dismissed), undefined);
  assert.equal(dismissed.current, undefined, 'leaving the reference ends the dismissal');
  assert.ok(chips.nextFollowing({ view: 'v', typed: typed(4, ''), cause: 'input' }, undefined, dismissed), 'the next `--` opens it again');
  dismissed.current = { view: 'v', start: 4 };
  assert.ok(chips.nextFollowing({ view: 'v', typed: typed(20, ''), cause: 'input' }, undefined, dismissed), 'a reference elsewhere is a new trigger');
});

// ─────────────────────────── Keyword chips ───────────────────────────

const KEYWORD_PROPERTY_NAMES = [
  'display',
  'overflow',
  'overflow-x',
  'overflow-y',
  'box-sizing',
  'object-fit',
  'position',
  'float',
  'clear',
  'text-align',
  'text-decoration',
  'font-style',
  'text-transform',
  'direction',
  'word-break',
  'white-space',
  'text-overflow',
  'overflow-wrap',
  'background-clip',
  'mix-blend-mode',
  'outline-style',
  'cursor',
  'pointer-events',
];

test('every keyword property has the panel’s options, and the table holds no other', () => {
  assert.deepEqual(Object.keys(chips.KEYWORD_PROPERTIES).sort(), [...KEYWORD_PROPERTY_NAMES].sort());
  for (const property of KEYWORD_PROPERTY_NAMES) {
    const { segments, list } = chips.keywordChoices(property, chips.ENGLISH_TRANSLATE);
    const options = [...segments, ...list];
    assert.ok(options.length >= 2, `${property} offers a choice`);
    assert.ok(segments.length <= 5, `${property}: the button group fits the popover`);
    assert.ok(
      options.every((option) => option.value.length > 0 && !option.value.startsWith('__') && option.text.length > 0),
      `${property}: every option is a value with a name`,
    );
    assert.equal(new Set(options.map((option) => option.value)).size, options.length, `${property}: no value twice`);
  }
  assert.deepEqual(
    chips.keywordChoices('display', chips.ENGLISH_TRANSLATE).segments.map((option) => option.value),
    ['block', 'flex', 'grid', 'none'],
    'display keeps the panel’s bar',
  );
  assert.ok(
    chips.keywordChoices('text-align', chips.ENGLISH_TRANSLATE).segments.every((option) => option.icon !== undefined),
    'text-align has its icons',
  );
  assert.equal(chips.keywordChoices('cursor', chips.ENGLISH_TRANSLATE).segments.length, 0, 'a long set is a list');
});

test('each keyword property’s value has a keyword chip, its empty value a create chip', () => {
  for (const property of KEYWORD_PROPERTY_NAMES) {
    const { segments, list } = chips.keywordChoices(property, chips.ENGLISH_TRANSLATE);
    const value = [...segments, ...list][0].value;
    const text = `.a { ${property}: ${value} !important; }`;
    const found = chips.cssValueChips(text, 'stylesheet').filter((chip) => chip.kind === 'keyword');
    assert.equal(found.length, 1, `${property}: ${value} has its chip`);
    assert.equal(found[0].property, property);
    assert.equal(found[0].value, value, `${property}: the range is the keyword, not its !important`);
    const empty = chips.cssValueChips(`.a { ${property}: ; }`, 'stylesheet');
    assert.deepEqual(summary(empty), ['keyword:'], `${property}: an empty value offers the choice`);
  }
  assert.equal(chips.cssValueChips('.a { -webkit-box-sizing: content-box; }', 'stylesheet')[0].property, 'box-sizing', 'a vendor prefix too');
  assert.equal(chips.cssValueChips('.a { DISPLAY: Flex; }', 'stylesheet')[0].kind, 'keyword', 'case is no matter');
});

test('a variable, a wide keyword, a calc() or a keyword the panel lacks gets no keyword chip', () => {
  const kinds = (text) => summary(chips.cssValueChips(text, 'stylesheet'));
  assert.deepEqual(kinds('.a { display: var(--display); }'), ['variable:var(--display)']);
  assert.deepEqual(kinds('.a { display: var(--d, flex); }'), ['variable:var(--d, flex)'], 'a fallback is the variable’s');
  assert.deepEqual(kinds('.a { display: inherit; position: initial; text-align: unset; cursor: revert; }'), []);
  assert.deepEqual(kinds('.a { display: table-cell; overflow: hidden auto; text-decoration: underline dotted; }'), []);
  assert.deepEqual(kinds('.a { float: calc(1); }'), []);
  assert.deepEqual(kinds('/* display: flex; */ .a { content: "display: flex"; }'), []);
  assert.equal(chips.isKeywordOf('text-align', ' CENTER '), true);
  assert.equal(chips.isKeywordOf('text-align', 'middle'), false);
});

test('box-shadow, filter and backdrop-filter offer their lists, empty and set', () => {
  for (const property of ['box-shadow', 'filter', 'backdrop-filter']) {
    assert.deepEqual(summary(chips.cssValueChips(`.a { ${property}: ; }`, 'stylesheet')), ['layers:'], `${property}: empty`);
    const value = property === 'box-shadow' ? '0 1px 2px red' : 'blur(2px)';
    const found = chips.cssValueChips(`.a { ${property}: ${value}; }`, 'stylesheet');
    assert.equal(found[0].kind, 'layers', `${property}: set`);
    assert.equal(found[0].property, property);
  }
});

// ─────────────────────────── The setting and the surfaces ───────────────────────────

test('the saved preference is read once from the desktop bridge, and a failure keeps chips on', async () => {
  // The bundle's store has been read by the tests above; a fresh bundle reads the bridge anew.
  const output = repoPath('node_modules/.stacki-test/code-chips-preference.cjs');
  await build({
    entryPoints: [repoPath('src/features/style/codeChips/codeChipsPreference.ts')],
    outfile: output,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['react'],
    logLevel: 'silent',
  });
  const calls = [];
  window.avb = {
    settings: async () => {
      calls.push('get');
      return {
        sound: false,
        usageCountsEnabled: true,
        appsPersonHidden: false,
        aiAskBeforeTrust: false,
        aiTrackChanges: true,
        aiReviewChanges: false,
        codeChips: false,
        canvasScrollbar: 'off',
      };
    },
  };
  const store = require(output);
  assert.equal(store.currentCodeChipsMode(), 'shown', 'on before the saved choice arrives, so the first frame has its chips');
  const stop = store.subscribeCodeChipsMode(() => undefined);
  store.subscribeCodeChipsMode(() => undefined)();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ['get'], 'read once');
  assert.equal(store.currentCodeChipsMode(), 'plain');
  stop();
  delete window.avb;
});

test('every CSS code surface carries the chips', () => {
  const read = (file) => fs.readFileSync(repoPath(file), 'utf8');
  assert.match(
    read('src/features/style/components/CssCodeEditor.tsx'),
    /useCodeChips\(variables\.kind === 'declarations' \? 'stylesheet' : undefined, \{ typing: 'elsewhere' \}\)/,
    'the CSS Code section',
  );
  assert.match(read('src/app/shell/AppPanes.tsx'), /useCodeChips\(codeChipTextOf\(codeWin\?\.language\)\)/, 'the code window: CSS files and <style> nodes');
  assert.match(read('src/app/shell/AppShell.tsx'), /useCodeChips\('markup'\)/, 'the page code panel’s <style> blocks');
  assert.match(read('src/app/settings/StyleTagSettings.tsx'), /useCodeChips\('markup'\)/, 'the style tag setting');
  for (const file of ['src/features/code/CodeWindow.tsx', 'src/features/code/CodePanel.tsx']) {
    assert.match(read(file), /extensions=\{extensions\}/, `${file} hands its caller's chips to the editor`);
    assert.match(read(file), /\{overlay\}/, `${file} draws its caller's chip popups`);
  }
});
