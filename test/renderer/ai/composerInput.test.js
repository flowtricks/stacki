// Goal: the composer's input behaves as a message box with chips. `@` opens the picker under
// the caret with the built-in instructions, skills and files in groups; Enter or a click makes a
// chip, and Esc closes the picker and keeps the typed `@`; Backspace removes a chip whole and undo
// brings it back; Enter, Cmd+Enter, Ctrl+Enter and Shift+Enter report send, queue, queue and a new
// line; an input method that is composing neither opens the picker nor sends; a paste is plain text
// (a file path stays text, a stray placeholder character is stripped); a file dragged from the
// Pages or Assets panel becomes a chip and a folder or `..` does not; the `/` menu still completes
// the agent's commands; a draft that changes from outside (cleared on send, dictation, Build an
// app) replaces the text and is not undoable; at sixteen chips the picker says so and adds none; an
// empty or failed search says so; the App builder chip copies the bundled instructions and says
// "Copied" for a moment, in the box and in a sent message.
// Method: bundle the real input and its chip editor for jsdom with esbuild and mount it with React
// against a fake search; drive the editor with the keyboard events and transactions it receives from
// the browser. jsdom has no layout, so Range geometry is faked (one box where a caret is); where the
// picker lands on screen is checked in the Electron render probe, not here.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/composerInput.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export { ComposerInput, matchingCommands } from './src/features/ai/composer/ComposerInput';",
      "export { MentionChipView } from './src/features/ai/mentions/MentionChipView';",
      "export { appBuildPrompt } from './src/features/apps/appPrompt';",
      "export { subscribeErrorToasts } from './src/ui/errorNotices';",
      "export { EditorView } from '@codemirror/view';",
    ].join('\n'),
    resolveDir: repoPath('package.json').replace(/package\.json$/, ''),
    loader: 'tsx',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  loader: { '.css': 'empty', '.svg': 'empty' },
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
require('../../helpers/popupDom').installPopupDOM(dom.window);
global.window = dom.window;
for (const name of [
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'KeyboardEvent',
  'MouseEvent',
  'getComputedStyle',
  'MutationObserver',
  'Window',
]) {
  Object.defineProperty(global, name, { value: dom.window[name], configurable: true, writable: true });
}
global.IS_REACT_ACT_ENVIRONMENT = true;
global.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0);
dom.window.requestAnimationFrame = global.requestAnimationFrame;
global.cancelAnimationFrame = (handle) => clearTimeout(handle);
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
// A caret is one box, so the picker has an anchor; jsdom has no layout of its own.
const box = { top: 10, left: 10, bottom: 30, right: 20, width: 10, height: 20 };
dom.window.Range.prototype.getBoundingClientRect = () => box;
dom.window.Range.prototype.getClientRects = () => ({
  length: 1,
  0: box,
  item: () => box,
  [Symbol.iterator]: function* () {
    yield box;
  },
});
dom.window.document.hasFocus = () => true;
const clipboard = [];
Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText: async (text) => void clipboard.push(text) }, configurable: true });

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const input = require(output);

const settle = async (rounds = 4) => {
  for (let round = 0; round < rounds; round++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 90));
    });
  }
};

// A new container for each mount: the earlier roots are unmounted first, so no popup or editor of a previous mount lingers.
const roots = [];
async function freshHost() {
  await act(async () => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
  });
  document.body.replaceChildren();
  const host = document.createElement('div');
  document.body.append(host);
  return host;
}
function rootFor(host) {
  const root = createRoot(host);
  roots.push(root);
  return root;
}

const file = (name, folder = 'docs') => ({ kind: 'file', path: `${folder}/${name}`, name });
const skill = (name) => ({ kind: 'skill', name, description: `${name} does things`, source: 'project', path: `.claude/skills/${name}/SKILL.md` });
const CANDIDATES = [skill('lumos'), file('AGENTS.md', '.'), file('apps.md'), file('guide.md')].map((candidate) =>
  candidate.path === './AGENTS.md' ? { ...candidate, path: 'AGENTS.md' } : candidate,
);
const searches = [];
const search = async (query) => {
  searches.push(query);
  const needle = query.toLowerCase();
  return { ok: true, value: CANDIDATES.filter((candidate) => needle === '' || `${candidate.name}${candidate.path}`.toLowerCase().includes(needle)) };
};

const text = (value) => ({ kind: 'text', text: value });
const chip = (value) => ({ kind: 'chip', chip: value });
const fileChip = (pathText) => chip({ kind: 'file', path: pathText, name: pathText.split('/').pop() });
const builderChip = chip({ kind: 'builtin', id: 'app-builder', title: 'App builder instructions' });

// The draft is held the way the composer holds it: `segments` in, `onSegmentsChange` out, kept in React state.
function Harness({ record, options }) {
  const [segments, setSegments] = React.useState(record.segments);
  record.set = setSegments;
  return React.createElement(input.ComposerInput, {
    agent: 'claude',
    commands: options.commands ?? [],
    placeholder: 'Ask anything',
    inputRef: record.focus,
    segments,
    onSegmentsChange: (next) => {
      record.changes.push(next);
      record.segments = next;
      setSegments(next);
    },
    onSend: (key) => record.sent.push(key),
    searchMentions: options.search ?? search,
  });
}

async function mount(options = {}) {
  const host = await freshHost();
  const record = { sent: [], changes: [], segments: options.segments ?? [], root: rootFor(host), focus: React.createRef() };
  record.redraw = (segments) => {
    record.segments = segments;
    return act(async () => record.set(segments));
  };
  await act(async () => record.root.render(React.createElement(Harness, { record, options })));
  await settle(1);
  record.view = input.EditorView.findFromDOM(host.querySelector('.cm-editor'));
  assert.ok(record.view, 'the editor is mounted');
  record.view.focus();
  return record;
}

const press = (view, key, init = {}) => {
  const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  view.contentDOM.dispatchEvent(event);
  return event;
};
const typeText = async (record, value) => {
  const view = record.view;
  const head = view.state.selection.main.head;
  await act(async () => view.dispatch({ changes: { from: head, insert: value }, selection: { anchor: head + value.length }, userEvent: 'input.type' }));
  await settle(2);
};
const rowsOf = () => [...document.querySelectorAll('.chip-picker-option')].map((row) => row.querySelector('.chip-picker-label').textContent);
const groupsOf = () => [...document.querySelectorAll('.chip-picker-heading')].map((heading) => heading.textContent);
const pills = () => [...document.querySelectorAll('.cm-content .chip-editor-chip')].map((pill) => pill.textContent);

test('typing @ opens the picker with the three groups, and Enter makes the highlighted row a chip', async () => {
  const record = await mount();
  await typeText(record, 'Update @');
  assert.deepEqual(groupsOf(), ['Built-in', 'Skills', 'Files']);
  assert.deepEqual(rowsOf(), ['App builder instructions', 'lumos', 'AGENTS.md', 'apps.md', 'guide.md']);
  await typeText(record, 'ap');
  assert.deepEqual(rowsOf(), ['App builder instructions', 'apps.md'], 'the query narrows built-in rows and the search');
  await act(async () => void press(record.view, 'ArrowDown'));
  await act(async () => void press(record.view, 'Enter'));
  await settle(2);
  assert.deepEqual(record.segments, [text('Update '), fileChip('docs/apps.md'), text(' ')]);
  assert.deepEqual(pills(), ['apps.md']);
  assert.equal(document.querySelectorAll('.chip-picker').length, 0, 'the picker closes once it has chosen');
  assert.deepEqual(record.sent, [], 'Enter chose a row, it did not send');
});

test('a click on a row chooses it, and the chip is atomic: Backspace removes it whole and undo brings it back', async () => {
  const record = await mount();
  await typeText(record, '@');
  const lumos = [...document.querySelectorAll('.chip-picker-option')].find((row) => row.textContent.startsWith('lumos'));
  await act(async () => lumos.click());
  await settle(2);
  assert.deepEqual(record.segments, [chip({ kind: 'skill', name: 'lumos', source: 'project', path: '.claude/skills/lumos/SKILL.md' }), text(' ')]);
  record.view.dispatch({ selection: { anchor: 1 } });
  await act(async () => void press(record.view, 'Backspace'));
  assert.deepEqual(record.segments, [text(' ')], 'one key removes the whole chip');
  assert.equal(pills().length, 0);
  await act(async () => void press(record.view, 'z', { ctrlKey: true }));
  assert.equal(pills().length, 1, 'undo restores the chip');
  assert.deepEqual(
    record.segments.map((segment) => segment.kind),
    ['chip', 'text'],
  );
  await act(async () => void press(record.view, 'y', { ctrlKey: true }));
  assert.equal(pills().length, 0, 'redo removes it again');
});

test('Escape closes the picker and keeps the typed @; typing on does not reopen it', async () => {
  const record = await mount();
  await typeText(record, 'hello @gu');
  assert.deepEqual(rowsOf(), ['guide.md']);
  await act(async () => void press(record.view, 'Escape'));
  assert.equal(document.querySelectorAll('.chip-picker').length, 0);
  assert.deepEqual(record.segments, [text('hello @gu')]);
  await typeText(record, 'i');
  assert.equal(document.querySelectorAll('.chip-picker').length, 0, 'the same @ stays dismissed');
  await typeText(record, ' and @');
  assert.equal(document.querySelectorAll('.chip-picker').length, 1, 'a new @ opens it again');
});

test('the picker with no results says so; a failed search says so and still offers the built-in instructions', async () => {
  const none = await mount();
  await typeText(none, '@qqq');
  assert.deepEqual(rowsOf(), []);
  assert.match(document.querySelector('.chip-picker-empty').textContent, /No matches/);
  await act(async () => void press(none.view, 'Enter'));
  assert.deepEqual(none.sent, ['send'], 'with nothing to choose Enter is the send key');

  const failing = await mount({
    search: async () => {
      throw new Error('no project');
    },
  });
  await typeText(failing, '@app');
  assert.deepEqual(rowsOf(), ['App builder instructions']);
  const refused = await mount({ search: async () => ({ ok: false, error: { code: 'invalid', message: 'nope' } }) });
  await typeText(refused, '@zzz');
  assert.match(document.querySelector('.chip-picker-empty').textContent, /Couldn.t search/);
});

test('an over-long query opens nothing and asks for nothing', async () => {
  searches.length = 0;
  const record = await mount();
  await typeText(record, `@${'x'.repeat(80)}`);
  assert.equal(document.querySelectorAll('.chip-picker').length, 0);
  assert.ok(!searches.some((query) => query.length > 64), 'the host was never asked for the long query');
});

test('at sixteen chips the picker says so and adds none', async () => {
  const sixteen = Array.from({ length: 16 }, (_, index) => fileChip(`docs/f${index}.md`));
  const record = await mount({ segments: sixteen });
  await typeText(record, '@');
  assert.match(document.querySelector('.chip-picker-empty').textContent, /Up to 16 mentions/);
  await act(async () => void press(record.view, 'Enter'));
  assert.equal(pills().length, 16);
});

test('the send keys are reported, and an input method that is composing owns Enter', async () => {
  const record = await mount();
  await typeText(record, 'hi');
  await act(async () => void press(record.view, 'Enter'));
  await act(async () => void press(record.view, 'Enter', { ctrlKey: true }));
  await act(async () => void press(record.view, 'Enter', { metaKey: true }));
  assert.deepEqual(record.sent, ['send', 'queue', 'queue']);
  await act(async () => void press(record.view, 'Enter', { shiftKey: true }));
  assert.deepEqual(record.sent, ['send', 'queue', 'queue'], 'Shift+Enter sends nothing');
  assert.equal(record.view.state.doc.toString(), 'hi\n', 'and is a new line');

  record.sent.length = 0;
  await act(async () => void record.view.contentDOM.dispatchEvent(new dom.window.Event('compositionstart', { bubbles: true })));
  assert.equal(record.view.compositionStarted, true);
  await act(async () => void press(record.view, 'Enter'));
  assert.deepEqual(record.sent, [], 'Enter while composing does not send');
  await act(async () => void record.view.contentDOM.dispatchEvent(new dom.window.Event('compositionend', { bubbles: true })));
  await settle(2);
  await act(async () => void press(record.view, 'Enter'));
  assert.deepEqual(record.sent, ['send'], 'once the composition ends Enter sends again');
});

test('a paste is plain text: a file path stays text, a stray placeholder is stripped, a file paste adds nothing', async () => {
  const record = await mount({ segments: [fileChip('docs/apps.md')] });
  record.view.dispatch({ selection: { anchor: record.view.state.doc.length } });
  const paste = (clipboardData) => {
    const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: clipboardData });
    return act(async () => void record.view.contentDOM.dispatchEvent(event));
  };
  await paste({ getData: (type) => (type === 'text/plain' ? '/Users/me/site/docs/guide.md' : ''), files: [] });
  assert.deepEqual(
    record.segments,
    [fileChip('docs/apps.md'), text('/Users/me/site/docs/guide.md')],
    'a path pasted as text is text, and the chip is still there',
  );
  await paste({ getData: (type) => (type === 'text/plain' ? 'a￼b' : ''), files: [] });
  assert.equal(record.view.state.doc.toString().endsWith('/Users/me/site/docs/guide.mdab'), true, 'the placeholder character never arrives');
  assert.equal(pills().length, 1);
  const before = record.view.state.doc.toString();
  await paste({ getData: () => '', files: [{ name: 'a.png' }] });
  assert.equal(record.view.state.doc.toString(), before, 'a file paste leaves the text to the composer');
});

test('a file dragged from the Pages or Assets panel becomes a chip; a folder, a path outside the project and anything else do not', async () => {
  const record = await mount({ segments: [text('Use ')] });
  const drop = (types, data) => {
    const event = new dom.window.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { types, getData: (type) => data[type] ?? '' } });
    return act(async () => void record.view.contentDOM.dispatchEvent(event));
  };
  await drop(['avb/asset'], { 'avb/asset': 'public/logo.svg' });
  assert.deepEqual(pills(), ['logo.svg']);
  await drop(['avb/page'], { 'avb/page': JSON.stringify({ path: 'src/pages/index.astro', name: 'index' }) });
  assert.deepEqual(pills().sort(), ['index.astro', 'logo.svg']);
  for (const [types, data] of [
    [['avb/asset'], { 'avb/asset': 'public/images' }],
    [['avb/asset'], { 'avb/asset': '../secret.md' }],
    [['avb/page'], { 'avb/page': JSON.stringify({ path: '/etc/hosts.conf', name: 'x' }) }],
    [['text/plain'], { 'text/plain': 'a.md' }],
  ]) {
    await drop(types, data);
  }
  assert.equal(pills().length, 2, 'none of the refused drops added a chip');
});

test('the / menu completes the agent’s commands: arrows move, Enter and a click choose, and it is closed once a space is typed', async () => {
  const commands = [
    { name: 'compact', description: 'Shrink the conversation' },
    { name: 'review', description: 'Review the diff' },
    { name: 'init', description: 'Write a CLAUDE.md' },
  ];
  const record = await mount({ commands });
  await typeText(record, '/');
  assert.equal(document.querySelectorAll('.ai-commands button').length, 3);
  await typeText(record, 'i');
  assert.deepEqual(
    [...document.querySelectorAll('.ai-commands .ai-command-name')].map((name) => name.textContent),
    ['/init', '/review'],
    'names that start with the query come first',
  );
  await act(async () => void press(record.view, 'ArrowDown'));
  await act(async () => void press(record.view, 'Enter'));
  assert.deepEqual(record.segments, [text('/review ')]);
  assert.equal(document.querySelectorAll('.ai-commands button').length, 0, 'closed by the space');
  assert.deepEqual(record.sent, [], 'choosing did not send');

  const clicked = await mount({ commands });
  await typeText(clicked, '/rev');
  await act(
    async () => void document.querySelector('.ai-commands button').dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true })),
  );
  assert.deepEqual(clicked.segments, [text('/review ')]);
  assert.deepEqual(input.matchingCommands(commands, 'plain'), []);
  assert.deepEqual(input.matchingCommands(commands, '/a b'), []);
});

test('a draft that changes from outside replaces the text without being reported back, and is not undoable', async () => {
  const record = await mount();
  await typeText(record, 'typed');
  record.changes.length = 0;
  await record.redraw([text('typed by voice'), builderChip, text(' ')]);
  assert.equal(record.view.state.doc.toString().includes('typed by voice'), true);
  assert.equal(pills().length, 1, 'a chip put in from outside is drawn');
  assert.deepEqual(record.changes, [], 'the editor did not echo it');
  await record.redraw([]);
  assert.equal(record.view.state.doc.length, 0, 'a send that cleared the draft empties the box');
  await act(async () => void press(record.view, 'z', { ctrlKey: true }));
  assert.equal(record.view.state.doc.length, 0, 'undo does not bring back what was sent');
});

test('the same draft passed again is not a change: the caret stays where it is', async () => {
  const record = await mount({ segments: [text('hello world')] });
  record.view.dispatch({ selection: { anchor: 5 } });
  await record.redraw([text('hello '), text('world')]);
  assert.equal(record.view.state.selection.main.head, 5);
});

test('a caller with a plain string still works: it sees the text, chips as their plain text', async () => {
  const host = await freshHost();
  const changes = [];
  const root = rootFor(host);
  await act(async () =>
    root.render(
      React.createElement(input.ComposerInput, {
        agent: 'codex',
        commands: [],
        placeholder: 'x',
        inputRef: React.createRef(),
        value: 'old',
        onChange: (next) => changes.push(next),
        onSend: () => undefined,
      }),
    ),
  );
  const view = input.EditorView.findFromDOM(host.querySelector('.cm-editor'));
  assert.equal(view.state.doc.toString(), 'old');
  await act(async () => view.dispatch({ changes: { from: 3, insert: '!' }, userEvent: 'input.type' }));
  assert.deepEqual(changes, ['old!']);
});

test('the App builder chip copies the bundled instructions and says Copied for a moment', async () => {
  clipboard.length = 0;
  const record = await mount({ segments: [text('Build '), builderChip, text(' ')] });
  const pill = document.querySelector('.cm-content .chip-editor-chip[data-chip-kind="builtin"]');
  assert.match(pill.getAttribute('aria-label'), /Click to copy/, 'hover says what it is');
  await act(async () => pill.click());
  await settle(1);
  assert.deepEqual(clipboard, [input.appBuildPrompt()]);
  assert.equal(pill.querySelector('.chip-editor-chip-label').textContent, 'Copied');
  assert.deepEqual(record.sent, []);
  await new Promise((resolve) => setTimeout(resolve, 1650));
  assert.equal(pill.querySelector('.chip-editor-chip-label').textContent, 'App builder instructions');
});

test('a chip in a sent message is the same pill; the instructions chip copies and says Copied; a file chip is plain unless given a click', async () => {
  clipboard.length = 0;
  const host = await freshHost();
  const root = rootFor(host);
  let clicks = 0;
  await act(async () =>
    root.render(
      React.createElement(
        'div',
        {},
        React.createElement(input.MentionChipView, { chip: { kind: 'builtin', id: 'app-builder' } }),
        React.createElement(input.MentionChipView, { chip: { kind: 'file', path: 'docs/apps.md' } }),
        React.createElement(input.MentionChipView, {
          chip: { kind: 'skill', name: 'lumos', path: '.claude/skills/lumos/SKILL.md' },
          onClick: () => (clicks += 1),
        }),
      ),
    ),
  );
  const [builder, plain, skillView] = [...host.querySelectorAll('.chip-editor-chip')];
  assert.equal(builder.tagName, 'BUTTON');
  assert.equal(plain.tagName, 'SPAN');
  assert.equal(plain.textContent, 'apps.md');
  assert.equal(plain.getAttribute('title'), 'docs/apps.md');
  await act(async () => builder.click());
  await settle(1);
  assert.deepEqual(clipboard, [input.appBuildPrompt()]);
  assert.equal(builder.textContent, 'Copied');
  await act(async () => skillView.click());
  assert.equal(clicks, 1);
  await new Promise((resolve) => setTimeout(resolve, 1650));
  assert.equal(builder.textContent, 'App builder instructions');
});
