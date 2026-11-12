// Goal: chips in the editor behave as single atomic characters, and the draft survives the
// conversions the composer relies on: segments to document and back, Backspace and Delete
// removing a chip whole, undo and redo bringing it back, a typed or pasted placeholder
// being refused, an input method composing next to a chip leaving it alone, and the
// `@` trigger being recognised only where a mention can start.
// Method: part 1 is the pure model (src/ui/chipEditor/chipModel.ts), including its bounds
// and the trigger table. Part 2 mounts a real CodeMirror EditorView in jsdom (it has no
// layout, so only the pure state and command behaviour is checked here; the caret popup
// anchoring is checked in the Electron render probe) and drives it with the editor's own
// commands and transactions: the same code paths the keyboard reaches.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const load = require('../../helpers/rendererModule');
const { repoPath } = require('../../helpers/sources.js');

const { CHIP_CHARACTER, CHIP_COUNT_MAX, SEGMENTS_MAX, TRIGGER_QUERY_CHARS_MAX, documentToSegments, findTrigger, segmentsToDocument } =
  load('src/ui/chipEditor/chipModel.ts');

const chip = (name) => ({ kind: 'file', name });

test('segments become a document with one placeholder per chip, and back', () => {
  const segments = [
    { kind: 'text', text: 'Read ' },
    { kind: 'chip', chip: chip('a.md') },
    { kind: 'text', text: ' and ' },
    { kind: 'chip', chip: chip('b.md') },
  ];
  const document = segmentsToDocument(segments);
  assert.equal(document.text, `Read ${CHIP_CHARACTER} and ${CHIP_CHARACTER}`);
  assert.deepEqual(document.chips, [chip('a.md'), chip('b.md')]);
  assert.deepEqual(documentToSegments(document), segments);
});

test('chips next to each other, at the ends, and an empty draft round trip', () => {
  for (const segments of [
    [],
    [{ kind: 'chip', chip: chip('a') }],
    [
      { kind: 'chip', chip: chip('a') },
      { kind: 'chip', chip: chip('b') },
    ],
    [
      { kind: 'text', text: 'x' },
      { kind: 'chip', chip: chip('a') },
    ],
  ]) {
    assert.deepEqual(documentToSegments(segmentsToDocument(segments)), segments);
  }
  assert.deepEqual(documentToSegments(segmentsToDocument([{ kind: 'text', text: '' }])), [], 'empty text vanishes');
});

test('the model refuses what the editor could not hold', () => {
  assert.throws(() => segmentsToDocument([{ kind: 'text', text: `a${CHIP_CHARACTER}b` }]), /hold no placeholder character/);
  assert.throws(() => documentToSegments({ text: `a${CHIP_CHARACTER}`, chips: [] }), /one chip per placeholder/);
  assert.throws(() => documentToSegments({ text: 'a', chips: [chip('x')] }), /one chip per placeholder/);
  const many = Array.from({ length: CHIP_COUNT_MAX + 1 }, () => ({ kind: 'chip', chip: chip('x') }));
  assert.throws(() => segmentsToDocument(many), /too many chips/);
  assert.throws(() => segmentsToDocument(Array.from({ length: SEGMENTS_MAX + 1 }, () => ({ kind: 'text', text: 'a' }))), /too many segments/);
  const longest = Array.from({ length: CHIP_COUNT_MAX }, () => ({ kind: 'chip', chip: chip('x') }));
  assert.equal(segmentsToDocument(longest).chips.length, CHIP_COUNT_MAX, 'the bound itself is allowed');
});

test('the trigger counts only at a word start', () => {
  assert.deepEqual(findTrigger('@', '@'), { offset: 0, query: '' });
  assert.deepEqual(findTrigger('look at @sk', '@'), { offset: 8, query: 'sk' });
  assert.deepEqual(findTrigger(`${CHIP_CHARACTER}@a`, '@'), { offset: 1, query: 'a' }, 'right after a chip');
  assert.equal(findTrigger('me@example', '@'), undefined, 'an address');
  assert.equal(findTrigger('@sk then', '@'), undefined, 'the word ended');
  assert.equal(findTrigger('', '@'), undefined);
  assert.equal(findTrigger('hello', '@'), undefined);
  assert.equal(findTrigger(`@${'x'.repeat(TRIGGER_QUERY_CHARS_MAX + 1)}`, '@'), undefined, 'an over-long query');
  assert.deepEqual(findTrigger(`@${'x'.repeat(TRIGGER_QUERY_CHARS_MAX)}`, '@')?.query.length, TRIGGER_QUERY_CHARS_MAX);
  assert.throws(() => findTrigger('a', '@@'), /one character/);
});

// Part 2: CodeMirror in jsdom.

const directory = repoPath('node_modules/.stacki-test/chip-editor');
fs.mkdirSync(directory, { recursive: true });
const bundle = path.join(directory, 'chipEditor.cjs');
buildSync({
  stdin: {
    contents: `
      export * from './src/ui/chipEditor/chipEditor';
      export * from './src/ui/chipEditor/chipTrigger';
      export { EditorView } from '@codemirror/view';
      export { history, undo, redo, deleteCharBackward, deleteCharForward, cursorCharLeft, cursorCharRight } from '@codemirror/commands';
    `,
    resolveDir: repoPath('.'),
    loader: 'ts',
  },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
  loader: { '.css': 'empty' },
});

const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.Node = dom.window.Node;
global.Element = dom.window.Element;
global.HTMLElement = dom.window.HTMLElement;
global.MutationObserver = dom.window.MutationObserver;
global.Window = dom.window.Window;
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
global.IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
// CodeMirror measures text with Range geometry jsdom does not implement.
const rectangle = { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 };
dom.window.Range.prototype.getBoundingClientRect = () => rectangle;
dom.window.Range.prototype.getClientRects = () => ({ length: 0, item: () => undefined, [Symbol.iterator]: function* () {} });
const editorModule = require(bundle);
const { createChipEditor, EditorView, history, undo, redo, deleteCharBackward, deleteCharForward } = editorModule;

function open(segments) {
  const editor = createChipEditor({ describe: (value) => ({ label: value.name, title: `File ${value.name}`, kind: value.kind }) });
  const host = dom.window.document.getElementById('host');
  host.innerHTML = '';
  const view = new EditorView({ state: editor.createState(segments, [history()]), parent: host });
  return { editor, view, text: () => view.state.doc.toString(), segments: () => editor.readSegments(view.state) };
}

test('a draft opens with its chips drawn as pills and reads back unchanged', () => {
  const segments = [
    { kind: 'text', text: 'See ' },
    { kind: 'chip', chip: chip('AGENTS.md') },
    { kind: 'text', text: ' now' },
  ];
  const { view, segments: read } = open(segments);
  assert.deepEqual(read(), segments);
  const pills = view.dom.querySelectorAll('.chip-editor-chip');
  assert.equal(pills.length, 1);
  assert.equal(pills[0].textContent, 'AGENTS.md');
  assert.equal(pills[0].getAttribute('aria-label'), 'File AGENTS.md');
  assert.equal(pills[0].getAttribute('data-chip-kind'), 'file');
  assert.equal(pills[0].getAttribute('contenteditable'), 'false');
});

test('a draft that arrives holding a chip opens with the caret after it, so typing continues behind the chip', () => {
  const { view, editor, segments } = open([
    { kind: 'chip', chip: chip('App builder instructions') },
    { kind: 'text', text: ' ' },
  ]);
  assert.equal(view.state.selection.main.empty, true, 'the selection is collapsed');
  assert.equal(view.state.selection.main.head, view.state.doc.length, 'the caret is at the end, after the chip and its trailing space');
  view.dispatch(view.state.replaceSelection('Make a timer'));
  assert.deepEqual(segments(), [
    { kind: 'chip', chip: chip('App builder instructions') },
    { kind: 'text', text: ' Make a timer' },
  ]);
  const replaced = view.state.update(
    editor.replaceSegments(view.state, [
      { kind: 'chip', chip: chip('x') },
      { kind: 'text', text: ' ' },
    ]),
  ).state;
  assert.equal(replaced.selection.main.head, replaced.doc.length, 'a draft replaced from outside also leaves the caret at the end');
});

test('inserting a chip replaces the typed trigger and leaves the caret after it', () => {
  const { editor, view, segments } = open([{ kind: 'text', text: 'Use @ag' }]);
  view.dispatch(editor.insertChip(view.state, chip('AGENTS.md'), { from: 4, to: 7 }));
  assert.deepEqual(segments(), [
    { kind: 'text', text: 'Use ' },
    { kind: 'chip', chip: chip('AGENTS.md') },
    { kind: 'text', text: ' ' },
  ]);
  assert.equal(view.state.selection.main.head, 6);
});

test('Backspace right after a chip removes the whole chip, not a piece of it', () => {
  const { editor, view, segments, text } = open([
    { kind: 'text', text: 'a' },
    { kind: 'chip', chip: chip('x.md') },
    { kind: 'text', text: 'b' },
  ]);
  view.dispatch({ selection: { anchor: 2 } });
  deleteCharBackward(view);
  assert.equal(text(), 'ab');
  assert.deepEqual(segments(), [{ kind: 'text', text: 'ab' }]);
  assert.equal(editor.chipCount(view.state), 0);
});

test('Delete just before a chip removes it whole', () => {
  const { view, segments } = open([
    { kind: 'text', text: 'a' },
    { kind: 'chip', chip: chip('x.md') },
    { kind: 'text', text: 'b' },
  ]);
  view.dispatch({ selection: { anchor: 1 } });
  deleteCharForward(view);
  assert.deepEqual(segments(), [{ kind: 'text', text: 'ab' }]);
});

test('undo brings a deleted chip back with its payload, and redo removes it again', () => {
  const segments = [
    { kind: 'text', text: 'a' },
    { kind: 'chip', chip: chip('x.md') },
    { kind: 'text', text: 'b' },
  ];
  const { view, segments: read } = open(segments);
  view.dispatch({ selection: { anchor: 2 } });
  deleteCharBackward(view);
  assert.equal(read().length, 1);
  undo(view);
  assert.deepEqual(read(), segments);
  assert.equal(view.dom.querySelectorAll('.chip-editor-chip').length, 1, 'drawn again');
  redo(view);
  assert.deepEqual(read(), [{ kind: 'text', text: 'ab' }]);
  undo(view);
  assert.deepEqual(read(), segments);
});

test('undo of an insertion removes the chip and redo restores it', () => {
  const { editor, view, segments: read } = open([{ kind: 'text', text: 'hi ' }]);
  view.dispatch({ selection: { anchor: 3 } });
  view.dispatch(editor.insertChip(view.state, chip('y.md')));
  assert.equal(editor.chipCount(view.state), 1);
  undo(view);
  assert.equal(editor.chipCount(view.state), 0);
  redo(view);
  assert.deepEqual(read(), [
    { kind: 'text', text: 'hi ' },
    { kind: 'chip', chip: chip('y.md') },
    { kind: 'text', text: ' ' },
  ]);
});

test('deleting a range that spans several chips and text, then undoing, restores all of them', () => {
  const segments = [
    { kind: 'chip', chip: chip('a') },
    { kind: 'text', text: ' mid ' },
    { kind: 'chip', chip: chip('b') },
  ];
  const { view, segments: read } = open(segments);
  view.dispatch({ changes: { from: 0, to: view.state.doc.length }, userEvent: 'delete.selection' });
  assert.deepEqual(read(), []);
  undo(view);
  assert.deepEqual(read(), segments);
});

test('a placeholder typed, pasted or dropped is refused', () => {
  const { view, segments } = open([{ kind: 'text', text: 'ab' }]);
  view.dispatch({ changes: { from: 1, insert: CHIP_CHARACTER }, userEvent: 'input.type' });
  view.dispatch({ changes: { from: 1, insert: `x${CHIP_CHARACTER}y` }, userEvent: 'input.paste' });
  view.dispatch({ changes: { from: 1, insert: CHIP_CHARACTER }, userEvent: 'input.drop' });
  assert.deepEqual(segments(), [{ kind: 'text', text: 'ab' }]);
});

test('composing next to a chip leaves the chip alone', () => {
  const { view, segments } = open([
    { kind: 'chip', chip: chip('x.md') },
    { kind: 'text', text: ' ' },
  ]);
  view.dispatch({ selection: { anchor: 2 } });
  // An input method replaces its provisional text again and again as the user composes.
  view.dispatch({ changes: { from: 2, insert: 'に' }, userEvent: 'input.type.compose' });
  view.dispatch({ changes: { from: 2, to: 3, insert: '日本' }, userEvent: 'input.type.compose' });
  view.dispatch({ changes: { from: 2, to: 4, insert: '日本語' }, userEvent: 'input.type.compose' });
  assert.deepEqual(segments(), [
    { kind: 'chip', chip: chip('x.md') },
    { kind: 'text', text: ' 日本語' },
  ]);
});

test('typing in front of a chip and replacing around it keep every chip attached to its own placeholder', () => {
  const { view, segments } = open([
    { kind: 'text', text: 'one ' },
    { kind: 'chip', chip: chip('a') },
    { kind: 'text', text: ' two ' },
    { kind: 'chip', chip: chip('b') },
  ]);
  view.dispatch({ changes: { from: 0, insert: 'START ' }, userEvent: 'input.type' });
  view.dispatch({ changes: { from: view.state.doc.length, insert: ' END' }, userEvent: 'input.type' });
  const chips = segments().filter((segment) => segment.kind === 'chip');
  assert.deepEqual(
    chips.map((segment) => segment.chip.name),
    ['a', 'b'],
  );
  assert.equal(segments()[0].text, 'START one ');
});

test('the chip limit stops further insertion', () => {
  const full = Array.from({ length: CHIP_COUNT_MAX }, () => ({ kind: 'chip', chip: chip('x') }));
  const { editor, view } = open(full);
  assert.equal(editor.chipCount(view.state), CHIP_COUNT_MAX);
  assert.equal(editor.insertChip(view.state, chip('one more')), undefined);
});

test('replacing the whole draft swaps text and chips together', () => {
  const { editor, view, segments } = open([{ kind: 'chip', chip: chip('old') }]);
  view.dispatch(
    editor.replaceSegments(view.state, [
      { kind: 'text', text: 'new ' },
      { kind: 'chip', chip: chip('fresh') },
    ]),
  );
  assert.deepEqual(segments(), [
    { kind: 'text', text: 'new ' },
    { kind: 'chip', chip: chip('fresh') },
  ]);
});

test('the trigger reports the @ query only while the cursor is in it and the editor has focus and is not composing', async () => {
  const reports = [];
  const { chipTrigger } = editorModule;
  const editor = createChipEditor({ describe: (value) => ({ label: value.name }) });
  const host = dom.window.document.getElementById('host');
  host.innerHTML = '';
  const view = new EditorView({
    state: editor.createState([], [chipTrigger({ trigger: '@', onChange: (next) => reports.push(next === undefined ? undefined : next.query) })]),
    parent: host,
  });
  // The report waits for CodeMirror's measure phase, which runs on the next animation frame.
  const frame = () => new Promise((resolve) => setTimeout(resolve, 60));
  await frame();
  assert.deepEqual(reports, [], 'nothing without focus');
  Object.defineProperty(view, 'hasFocus', { get: () => true });
  view.dispatch({ changes: { from: 0, insert: '@' }, selection: { anchor: 1 }, userEvent: 'input.type' });
  await frame();
  view.dispatch({ changes: { from: 1, insert: 'sk' }, selection: { anchor: 3 }, userEvent: 'input.type' });
  await frame();
  view.dispatch({ changes: { from: 3, insert: ' ' }, selection: { anchor: 4 }, userEvent: 'input.type' });
  await frame();
  assert.deepEqual(reports, ['', 'sk', undefined]);
  view.dispatch({ changes: { from: 4, insert: 'x@' }, selection: { anchor: 6 }, userEvent: 'input.type' });
  await frame();
  assert.deepEqual(reports, ['', 'sk', undefined], 'an @ inside a word is not a trigger');
  view.destroy();
});

test('undo of one history group that inserted a chip and then deleted it leaves no pill behind', () => {
  // Insert the chip, Backspace over the space and over the chip, all within one undo group, then undo: the group ends
  // without the chip, so the restore effect from the second delete must not draw a pill over the character that is there.
  const { editor, view, segments: read, text } = open([{ kind: 'text', text: '@' }]);
  view.dispatch(editor.insertChip(view.state, chip('x.md'), { from: 0, to: 1 }));
  deleteCharBackward(view);
  deleteCharBackward(view);
  undo(view);
  assert.equal(text(), '@');
  assert.equal(editor.chipCount(view.state), 0, 'no chip is claimed');
  assert.deepEqual(read(), [{ kind: 'text', text: '@' }]);
  assert.equal(view.dom.querySelectorAll('.chip-editor-chip').length, 0);
});
