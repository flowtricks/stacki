// Goal: a comment pin's box takes `@` mentions as the chat's does. Picking one makes a chip, never the raw path; the
// chip is deleted whole, survives Save, a reload of the stored board and reopening, and is drawn as a chip in the box,
// the pin list, a sent pin's box and the "Comments on N pins" card. What the agent receives for it is what the chat
// would send for the same words: the compact reference in the text, and a file or instructions as the same blocks.
// Pins stored before chips read unchanged, and damaged or oversized chip data falls back to the words, losing no pin.
// Method: the real contract parsers on values; then the real PinOverlay, popover, list and card in jsdom, driven
// through the editor and its keys, and the payload `aiPrompt` receives built into agent blocks by the host's real
// buildPrompt beside the chat's own parts for the same draft.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const { waitFor } = require('../../helpers/waitFor.js');

const output = repoPath('node_modules/.stacki-test/pinChips.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export { PinOverlay } from './src/features/ai/pins/PinOverlay';",
      "export { PinBar } from './src/features/ai/pins/PinBar';",
      "export { PinsMessage } from './src/features/ai/pins/PinsMessage';",
      "export * as pins from './src/features/ai/pins/pinStore';",
      "export { pinWordsOf } from './src/features/ai/pins/pinModel';",
      "export * as ai from './src/features/ai/aiStore';",
      "export { EMPTY_CHAT } from './src/features/ai/chatReducer';",
      "export { mentionComponentsOf, setMentionComponents } from './src/features/ai/mentions/componentMentions';",
      "export { parsePinBoard, parsePinBoardStrict } from './shared/properties/ai/commentPins';",
      "export { parseSentPins, parsePinBrief, sentPinsOf, PIN_LIMITS } from './shared/properties/ai/commentPinBrief';",
      "export { promptPartsOf, plainTextOf, parsePromptParts } from './shared/properties/ai/mentions';",
      "export { buildPrompt } from './electron/handlers/ai/promptBlocks';",
      "export { EditorView } from '@codemirror/view';",
    ].join('\n'),
    resolveDir: repoPath('.'),
    loader: 'tsx',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  loader: { '.css': 'empty', '.svg': 'empty' },
  external: ['react', 'react-dom', 'react-dom/client', 'react-dom/server', 'react/jsx-runtime'],
  logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
require('../../helpers/popupDom').installPopupDOM(dom.window);
global.window = dom.window;
for (const name of [
  'document',
  'navigator',
  'HTMLElement',
  'HTMLIFrameElement',
  'Element',
  'Node',
  'Event',
  'KeyboardEvent',
  'MouseEvent',
  'getComputedStyle',
  'localStorage',
  'MutationObserver',
  'getSelection',
  'Range',
  'Selection',
  'DOMRect',
  'Window',
]) {
  Object.defineProperty(global, name, { value: dom.window[name], configurable: true, writable: true });
}
global.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0);
global.requestAnimationFrame = dom.window.requestAnimationFrame;
global.cancelAnimationFrame = (handle) => clearTimeout(handle);
global.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
dom.window.focus = () => undefined;
dom.window.Element.prototype.scrollIntoView = () => undefined;
dom.window.HTMLElement.prototype.scrollTo = () => undefined;
// A caret is one box, so the `@` menu has an anchor; jsdom has no layout of its own.
const caretBox = { top: 10, left: 10, bottom: 30, right: 20, width: 10, height: 20 };
dom.window.Range.prototype.getBoundingClientRect = () => caretBox;
dom.window.Range.prototype.getClientRects = () => ({
  length: 1,
  0: caretBox,
  item: () => caretBox,
  [Symbol.iterator]: function* () {
    yield caretBox;
  },
});
dom.window.document.hasFocus = () => true;

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const ui = require(output);

const CHAT = `c${'a'.repeat(24)}`;
const TURN = `t${'1'.padStart(16, '0')}`;
const BUTTON = 'src/components/Button.astro';
const NOTES = 'docs/notes.md';
const buttonChip = { kind: 'component', path: BUTTON, name: 'Button' };
const fileChip = { kind: 'file', path: NOTES, name: 'notes.md' };
const variableChip = { kind: 'css', target: 'variable', name: '--brand-1', path: 'src/styles/global.css' };
const PLACE = {
  page: 'src/pages/index.astro',
  pageLabel: 'Home',
  scope: undefined,
  file: 'src/pages/index.astro',
  locator: '0.1',
  elementLabel: 'Layout',
  componentFile: undefined,
  breakpointPx: 445,
};
const ANCHOR = { path: '0.1', occurrence: 0, at: { x: 0.5, y: 0.5 }, tag: 'h1', text: 'Welcome' };
const stored = (over = {}) => ({
  id: `p${'1'.repeat(16)}`,
  number: 1,
  createdAt: 1,
  updatedAt: 1,
  comment: 'Bigger',
  images: [],
  savedAt: 1,
  anchor: ANCHOR,
  place: PLACE,
  included: true,
  delivery: { kind: 'draft' },
  ...over,
});
const CHIPPED = [
  { kind: 'text', text: 'Use ' },
  { kind: 'chip', chip: buttonChip },
  { kind: 'text', text: ' with ' },
  { kind: 'chip', chip: variableChip },
];

test('stored chips are read within bounds; older pins read unchanged; bad chips leave the words', () => {
  const comment = ui.plainTextOf(CHIPPED);
  assert.equal(comment, `Use ${BUTTON} with css:var(--brand-1) (src/styles/global.css)`);
  const read = (over) => ui.parsePinBoard({ version: 1, pins: [JSON.parse(JSON.stringify(stored(over)))] }).pins[0];
  assert.equal('segments' in read({}), false, 'a pin from before chips holds only its words');
  assert.deepEqual(read({ comment, segments: CHIPPED }).segments, CHIPPED);
  assert.deepEqual(read({ comment, edit: { comment, segments: CHIPPED, images: [] } }).edit.segments, CHIPPED);
  for (const [why, segments] of [
    ['a path outside the project', [{ kind: 'chip', chip: { kind: 'file', path: '../secret', name: 'x' } }]],
    ['an unknown kind', [{ kind: 'chip', chip: { kind: 'nonsense' } }]],
    ['more segments than a draft holds', Array.from({ length: 300 }, () => ({ kind: 'chip', chip: buttonChip }))],
    ['chips that do not say what the comment says', [{ kind: 'chip', chip: fileChip }]],
    ['not a list', 'chips'],
  ]) {
    const pin = read({ comment, segments });
    assert.equal(pin.comment, comment, `${why}: the pin and its words stay`);
    assert.equal(pin.segments, undefined, why);
  }
  assert.doesNotThrow(() => ui.parsePinBoardStrict({ version: 1, pins: [stored({ comment, segments: 'damaged' })] }));
  const long = ui.pinWordsOf([
    { kind: 'text', text: 'a'.repeat(ui.PIN_LIMITS.commentCharsMax - 4) },
    { kind: 'chip', chip: buttonChip },
    { kind: 'text', text: 'tail' },
  ]);
  assert.ok(long.comment.length <= ui.PIN_LIMITS.commentCharsMax);
  assert.equal(long.segments, undefined, 'a chip that does not fit goes whole');
});

// ---------------------------------------------------------------------------
// The box, the list, the card and the send
// ---------------------------------------------------------------------------

const calls = [];
let storedBoard = { version: 1, pins: [] };
const ok = (value) => ({ ok: true, value });
const summary = { id: CHAT, agent: 'claude', title: 'New chat', pinned: false, createdAt: 1, updatedAt: 1, rank: 0, unread: false };
dom.window.avb = {
  platform: 'darwin',
  aiPinsRead: async () => ok({ board: storedBoard, images: [] }),
  aiPinsWrite: async (payload) => {
    storedBoard = JSON.parse(JSON.stringify(payload.board));
    return ok({ saved: true });
  },
  aiAgents: async () => ({
    trusted: true,
    agents: [{ agent: 'claude', state: 'ready', adapterVersion: '1.0.0', running: false, downloadMegabytes: 1 }],
    options: [],
  }),
  aiChats: async () => ({ chats: [summary], sections: [] }),
  aiChatRead: async () => ok({ summary, events: [], full: false }),
  aiChatUpdate: async () => ok(summary),
  aiAck: () => undefined,
  onAiEvents: () => () => undefined,
  onAiAgentStatus: () => () => undefined,
  onAiSetup: () => () => undefined,
  aiMentions: async () => ok([{ kind: 'file', path: NOTES, name: 'notes.md' }]),
  aiPrompt: async (payload) => {
    calls.push(payload);
    return ok({ turn: TURN });
  },
};

const settle = async () => {
  for (let round = 0; round < 6; round += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
};
const until = async (what, read) => {
  await waitFor({
    what,
    read: async () => {
      await act(async () => undefined);
      return read();
    },
    until: Boolean,
  });
  await settle();
};
const render = async (element) => {
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  await act(async () => root.render(element));
  await settle();
  return {
    host,
    async close() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
};
const overlay = () => {
  const pin = ui.pins.pinState().board.pins[0];
  return React.createElement(ui.PinOverlay, {
    rects: { 0.1: [{ x: 10, y: 10, w: 100, h: 20 }] },
    scale: 1,
    placed: [{ pin, path: '0.1' }],
    detached: new Set(),
    progressOf: ui.pins.progressOf,
    recapture: () => undefined,
  });
};
const editor = () => ui.EditorView.findFromDOM(document.querySelector('.ai-pin-popover .cm-editor'));
const typeText = async (text) => {
  for (const character of text) {
    await act(async () => {
      const view = editor();
      view.focus();
      const at = view.state.selection.main.head;
      view.dispatch({ changes: { from: at, insert: character }, selection: { anchor: at + 1 }, userEvent: 'input.type' });
    });
  }
  await settle();
};
const press = async (key) => {
  await act(async () => void editor().contentDOM.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
  await settle();
};
const picker = () => document.querySelector('[role="listbox"]') ?? undefined;
const options = () => [...document.querySelectorAll('[role="option"]')];
const pills = (selector) => [...document.querySelectorAll(`${selector} .chip-editor-chip-label`)].map((label) => label.textContent);
const boxOpen = () => ui.pins.pinState().open !== undefined;
const working = () => ui.pins.pinState().board.pins[0].edit;

async function start() {
  calls.length = 0;
  storedBoard = { version: 1, pins: [] };
  ui.setMentionComponents(ui.mentionComponentsOf([{ path: `/site/${BUTTON}`, file: BUTTON, name: 'Button', folder: '', schema: [], slots: [] }], '/site'));
  ui.ai.resetAiStore();
  ui.pins.resetPinStore();
  await ui.ai.loadAiProject('/site');
  await ui.ai.openChat(CHAT);
  await ui.pins.loadPins('/site');
  ui.pins.setCommentMode('on');
  return ui.pins.dropPin({ anchor: ANCHOR, place: PLACE }, (key) => key);
}

test('@ in a pin box makes a chip with the chat’s menu and keys, and it survives saving and reopening', async () => {
  const id = await start();
  const view = await render(overlay());
  try {
    await typeText('Use @Butt');
    await until('the menu is open', () => picker() !== undefined && options().some((row) => row.textContent.includes('Button')));
    await press('Escape');
    assert.equal(picker(), undefined, 'Escape closes the menu');
    assert.equal(boxOpen(), true, 'and not the box');
    await typeText('o');
    await press('Backspace');
    await act(async () => {
      const code = editor();
      code.dispatch({ changes: { from: 4, to: code.state.doc.length, insert: '' }, selection: { anchor: 4 } });
    });
    await typeText('@Butt');
    await until('the menu is open again', () => picker() !== undefined && options().some((row) => row.textContent.includes('Button')));
    await press('Enter');
    assert.equal(boxOpen(), true, 'Enter chose a row; it did not save');
    assert.deepEqual(working().segments?.[1], { kind: 'chip', chip: buttonChip });
    assert.equal(working().comment, `Use ${BUTTON} `);
    assert.deepEqual(pills('.ai-pin-popover .cm-content'), ['Button'], 'a chip, not the path');
    assert.doesNotMatch(editor().contentDOM.textContent, /src\/components/);

    // A second chip by pointer: a press in the menu is not a press outside the box.
    await typeText('@notes');
    await until('the file is offered', () => options().some((row) => row.textContent.includes('notes.md')));
    const row = options().find((candidate) => candidate.textContent.includes('notes.md'));
    await act(async () => {
      for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
        row.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true }));
      }
    });
    await settle();
    assert.equal(boxOpen(), true);
    assert.deepEqual(pills('.ai-pin-popover .cm-content'), ['Button', 'notes.md']);

    // Backspace takes a chip whole.
    await press('Backspace');
    await press('Backspace');
    assert.deepEqual(pills('.ai-pin-popover .cm-content'), ['Button']);
    assert.equal(working().segments.filter((segment) => segment.kind === 'chip').length, 1);

    await press('Enter');
    assert.equal(boxOpen(), false, 'Enter saves');
    await ui.pins.flushPinSave();
    assert.deepEqual(storedBoard.pins[0].segments?.[1], { kind: 'chip', chip: buttonChip }, 'stored with its chip');

    // The project opened again reads the stored board.
    await ui.pins.closePins();
    await ui.pins.loadPins('/site');
    ui.pins.setCommentMode('on');
    await act(async () => ui.pins.openPin(id));
    await settle();
    assert.deepEqual(pills('.ai-pin-popover .cm-content'), ['Button'], 'reopened, still a chip');
    await typeText(' please');
    assert.equal(working().segments[1].chip.path, BUTTON, 'editing keeps it');
    await press('Enter');
  } finally {
    await view.close();
  }

  const bar = await render(React.createElement(ui.PinBar));
  try {
    await act(async () => ui.pins.setPinListOpen('open'));
    await settle();
    assert.deepEqual(pills('.ai-pin-list .ai-pin-row-comment'), ['Button'], 'a chip in the list');
  } finally {
    await bar.close();
  }
});

test('pasted text is only text: a chip cannot be pasted in without what it names', async () => {
  await start();
  const view = await render(overlay());
  try {
    const clipboard = { types: ['text/plain'], files: [], getData: (type) => (type === 'text/plain' ? `pasted ￼ ${BUTTON}` : '') };
    const event = new window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: clipboard });
    await act(async () => void editor().contentDOM.dispatchEvent(event));
    await settle();
    assert.equal(working().comment, `pasted  ${BUTTON}`);
    assert.equal(working().segments, undefined);
  } finally {
    await view.close();
  }
});

const SOURCE = {
  root: '/site',
  home: '/home',
  agent: 'claude',
  embeddedContext: true,
  commands: new Set(),
  read: (file) => (file.endsWith(NOTES) ? 'Brand notes' : undefined),
};

test('Send gives the agent what the chat would for the same words, and the card draws the chips', async () => {
  const id = await start();
  const draft = [...CHIPPED, { kind: 'text', text: ' as in ' }, { kind: 'chip', chip: fileChip }];
  ui.pins.setPinSegments(id, draft);
  ui.pins.savePinBox();
  assert.equal(await ui.pins.sendAllPins((key) => key), true);
  assert.equal(calls.length, 1);
  const sent = calls[0];
  const brief = ui.parsePinBrief(JSON.parse(JSON.stringify(sent.pins)));
  assert.equal(brief.pins[0].comment, ui.plainTextOf(draft), 'the words carry the chat’s own references');
  const pinned = ui.buildPrompt(SOURCE, {
    text: sent.text,
    attachments: sent.attachments,
    parts: ui.parsePromptParts(JSON.parse(JSON.stringify(sent.parts))),
    pins: brief,
  });
  assert.ok(pinned.ok);
  const chat = ui.buildPrompt(SOURCE, { text: ui.plainTextOf(draft), attachments: [], parts: ui.promptPartsOf(draft, () => '') });
  assert.ok(chat.ok);
  const resources = (built) => built.value.blocks.filter((block) => block.type !== 'text');
  assert.ok(resources(chat).length === 1, 'the chat attaches the mentioned file');
  assert.deepEqual(resources(pinned), resources(chat), 'and so does the pin');
  const words = pinned.value.blocks.map((block) => block.text ?? '').join('\n');
  for (const reference of [BUTTON, 'css:var(--brand-1) (src/styles/global.css)', `@${NOTES}`]) {
    assert.ok(words.includes(reference), reference);
  }
  assert.match(words, /Pin 1 mentions: @docs\/notes\.md/);
  assert.match(words, /Some pins mention files, skills or instructions/);

  const kept = ui.parseSentPins(JSON.parse(JSON.stringify(ui.sentPinsOf(brief))));
  assert.deepEqual(kept[0].segments, draft, 'the transcript keeps the chips');
  const card = await render(
    React.createElement(ui.PinsMessage, {
      chat: CHAT,
      turn: TURN,
      mode: 'subagents',
      pins: kept,
      attachments: [],
      view: ui.EMPTY_CHAT,
      onOpenSubagent: undefined,
    }),
  );
  try {
    assert.deepEqual(pills('.ai-pins-message-comment'), ['Button', '--brand-1', 'notes.md']);
  } finally {
    await card.close();
  }

  const box = await render(overlay());
  try {
    await act(async () => ui.pins.openPin(id));
    await settle();
    assert.deepEqual(pills('.ai-pin-sent-comment'), ['Button', '--brand-1', 'notes.md'], 'the sent pin’s box');
  } finally {
    await box.close();
  }
});

test('a pin naming a component that is gone is not sent, as the chat would not send it', async () => {
  const id = await start();
  const view = await render(overlay());
  try {
    ui.pins.setPinSegments(id, [{ kind: 'chip', chip: buttonChip }]);
    await settle();
    await press('Enter');
    ui.setMentionComponents([]);
    assert.equal(await ui.pins.sendAllPins((key) => key), false);
    assert.equal(calls.length, 0);
    assert.equal(ui.pins.pinState().board.pins[0].delivery.kind, 'draft');
  } finally {
    await view.close();
  }
});
