// Goal: after frames from a recording are added to the chat, the keyboard is back in the composer's editor: the
// real panel, the real capture bar under the microphone, the real region selector, recording bar and "Pick frames"
// sheet (a modal Popup that restores focus to what had it when it closes), and then document.activeElement is the
// CodeMirror editor with the caret at the end of the draft. The same after a plain screenshot. Problems in the flow
// are toasts, never a paragraph under the composer.
// Method: bundle the real AiPanel with esbuild, mount it in jsdom against a fake preload (window.avb) that answers
// the chat channels and `ai:screenshot` / `ai:record` as main would, drive it with real events, and wait on the
// observable state (test/helpers/waitFor.js), never on a fixed pause. No window is opened and nothing is recorded.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const { waitFor } = require('../../helpers/waitFor.js');

const output = repoPath('node_modules/.stacki-test/screenshotFocus.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export { default as AiPanel } from './src/features/ai/AiPanel';",
      "export { aiState, resetAiStore, setDraft, draftFromText } from './src/features/ai/aiStore';",
      "export { subscribeErrorToasts } from './src/ui/errorNotices';",
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
global.innerWidth = 1200;
global.innerHeight = 800;
// Frames fall back to data URLs where there are no object URLs.
URL.createObjectURL = undefined;
dom.window.HTMLElement.prototype.scrollTo = function () {};
dom.window.Element.prototype.scrollIntoView = function () {};
dom.window.HTMLElement.prototype.setPointerCapture = function () {};
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const ai = require(output);

const PROJECT = '/site';
const ID = `r${'d'.repeat(16)}`;
const frames = [0, 1, 2].map((index) => ({ index, atMs: index * 100, width: 800, height: 600, thumb: 'AAAA' }));

function fakeMain() {
  const summary = { id: `c${'b'.repeat(24)}`, agent: 'claude', title: 'New chat', pinned: false, createdAt: 1, updatedAt: 1, rank: 0, unread: false };
  const chats = [];
  window.avb = {
    aiAgents: async () => ({
      trusted: true,
      agents: [{ agent: 'claude', state: 'ready', adapterVersion: '0.105.0', running: false }],
      options: [{ agent: 'claude', options: [] }],
      remembered: { claude: [], codex: [] },
    }),
    aiChats: async () => ({ chats: [...chats], sections: [] }),
    aiChatCreate: async () => {
      chats.push(summary);
      return { ok: true, value: summary };
    },
    aiChatRead: async () => ({ ok: true, value: { summary, events: [], full: false } }),
    aiChatUpdate: async () => ({ ok: true, value: summary }),
    aiRemember: async () => ({ ok: true, value: { claude: [], codex: [] } }),
    aiSetup: async (payload) => ({ agent: payload.agent, step: 'ready', account: { name: undefined, plan: undefined, email: undefined, source: 'account' } }),
    aiAutoCompactGet: async () => ({ percent: undefined }),
    onAiSetup: () => () => undefined,
    aiAck: () => undefined,
    onAiEvents: () => () => undefined,
    onAiAgentStatus: () => () => undefined,
    getFilePath: () => undefined,
    microphoneStatus: async () => ({ status: 'granted', appName: 'Stacki', settingsAvailable: true }),
    microphoneRequest: async () => ({ status: 'granted', appName: 'Stacki', settingsAvailable: true }),
    aiMentions: async () => ({ ok: true, value: [] }),
    settings: async () => ({
      sound: false,
      usageCountsEnabled: true,
      appsPersonHidden: false,
      aiAskBeforeTrust: false,
      aiTrackChanges: true,
      aiReviewChanges: false,
      codeChips: true,
    }),
    listAgents: async () => ({ agents: [], paired: [], truncated: false }),
    onInstructionsChanged: () => () => undefined,
    platform: 'darwin',
    aiScreenshot: async () => ({ ok: true, value: { mimeType: 'image/png', data: 'iVBORw0KGgo=', width: 40, height: 20 } }),
    aiRecord: async (payload) => {
      switch (payload.action.kind) {
        case 'start':
          return { ok: true, value: { kind: 'started', id: ID } };
        case 'status':
          return { ok: true, value: { kind: 'status', state: 'recording', elapsedMs: 300, frames: 3, bytes: 30, stopReason: undefined } };
        case 'stop':
          return { ok: true, value: { kind: 'stopped', frames, fps: 10, stopReason: 'person' } };
        case 'frame':
          return { ok: true, value: { kind: 'frame', image: { mimeType: 'image/jpeg', data: '/9j/', width: 800, height: 600 } } };
        default:
          return { ok: true, value: { kind: 'discarded' } };
      }
    },
  };
}

// Wait on what can be seen, a few milliseconds a poll, inside act so React's updates land.
// Wait on what can be seen: each poll first lets React apply what has arrived (an empty act), then reads.
const until = (what, read, holds = (value) => value) =>
  waitFor({
    what,
    read: async () => {
      await act(async () => undefined);
      return read();
    },
    until: holds,
    pollIntervalMs: 5,
    pollCountMax: 600,
  });

const pointer = (target, type, x, y) => {
  const event = new window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, buttons: 1 });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  return act(async () => target.dispatchEvent(event));
};

async function mount(context) {
  ai.resetAiStore();
  window.localStorage.clear();
  fakeMain();
  const toasts = [];
  context.after(
    ai.subscribeErrorToasts(
      (notice) => toasts.push(notice),
      () => undefined,
    ),
  );
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  await act(async () =>
    root.render(
      React.createElement(ai.AiPanel, {
        projectPath: PROJECT,
        onOpenTerminal: () => undefined,
        onMerge: () => undefined,
        onOpenExternal: () => undefined,
        renderFrame: (header, body) => React.createElement('div', undefined, header, body),
      }),
    ),
  );
  await until('the composer', () => document.querySelector('.ai-composer .cm-content'));
  context.after(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = '';
  });
  return { container, toasts };
}

const editor = () => document.querySelector('.ai-composer .cm-content');
const caretAtEnd = () => {
  const selection = document.getSelection();
  const content = editor();
  return (
    selection !== null &&
    content !== null &&
    content.contains(selection.anchorNode) &&
    selection.anchorOffset === (selection.anchorNode.textContent ?? '').length
  );
};

async function dragRegion() {
  const layer = await until('the region selector', () => document.querySelector('.ai-region-layer'));
  await pointer(layer, 'pointerdown', 20, 20);
  await pointer(layer, 'pointermove', 220, 120);
  await pointer(layer, 'pointerup', 220, 120);
}

test('after "Add frames to chat" the keyboard is in the composer editor, caret at the end, with no inline notice', async (context) => {
  const { container, toasts } = await mount(context);
  await act(async () => ai.setDraft(ai.aiState().open, () => ai.draftFromText('look at this')));
  const mic = await until('the microphone', () => container.querySelector('.ai-capture-slot button'));
  // The bar opens from the microphone; the Record segment is the one that records.
  await act(async () => mic.focus());
  const record = container.querySelector('.ai-capture-mode');
  await act(async () => record.click());
  await dragRegion();
  const stop = await until('the recording bar', () => document.querySelector('.ai-record-stop'));
  await act(async () => stop.click());
  const use = await until('the Pick frames sheet', () => document.querySelector('.ai-frame-use'));
  await act(async () => use.click());
  const add = [...document.querySelectorAll('.ai-frame-actions button')].find((button) => button.textContent.startsWith('Add'));
  await act(async () => add.click());
  await until('the sheet to close', () => document.querySelector('.ai-frame-sheet') === null);
  await until('the composer editor to hold the keyboard', () => document.activeElement === editor() || editor().contains(document.activeElement));
  assert.ok(caretAtEnd(), 'the caret is at the end of the draft');
  assert.equal(container.querySelectorAll('.ai-attachment').length, 1, 'the frame is attached');
  assert.ok(document.querySelector('.ai-compose-problem') === null, 'no paragraph of text under the composer');
  assert.deepEqual(toasts, [], 'and nothing went wrong');
});

test('after a plain screenshot the keyboard is in the composer editor', async (context) => {
  const { container } = await mount(context);
  const mic = await until('the microphone', () => container.querySelector('.ai-capture-slot button'));
  await act(async () => mic.focus());
  await act(async () => container.querySelector('.ai-capture-photo').click());
  await dragRegion();
  await until('the screenshot to attach', () => container.querySelectorAll('.ai-attachment').length === 1);
  await until('the composer editor to hold the keyboard', () => document.activeElement === editor() || editor().contains(document.activeElement));
});

test('a recording main no longer has is a toast with Record again, and the sheet closes; nothing is written under the composer', async (context) => {
  const { container, toasts } = await mount(context);
  const answer = window.avb.aiRecord;
  window.avb.aiRecord = async (payload) =>
    payload.action.kind === 'frame' ? { ok: false, error: { code: 'invalid', message: 'This recording is no longer available.' } } : answer(payload);
  const mic = await until('the microphone', () => container.querySelector('.ai-capture-slot button'));
  await act(async () => mic.focus());
  await act(async () => container.querySelector('.ai-capture-mode').click());
  await dragRegion();
  const stop = await until('the recording bar', () => document.querySelector('.ai-record-stop'));
  await act(async () => stop.click());
  const use = await until('the Pick frames sheet', () => document.querySelector('.ai-frame-use'));
  await act(async () => use.click());
  const add = [...document.querySelectorAll('.ai-frame-actions button')].find((button) => button.textContent.startsWith('Add'));
  await act(async () => add.click());
  await until('the toast', () => toasts.length > 0);
  assert.equal(toasts[0].message, 'This recording is no longer available.');
  assert.deepEqual(
    toasts[0].recovery.map((action) => action.label),
    ['Record again'],
  );
  await until('the sheet to close', () => document.querySelector('.ai-frame-sheet') === null);
  assert.ok(document.querySelector('.ai-compose-problem') === null, 'no paragraph of text under the composer');
  assert.ok(document.querySelector('.ai-frame-notice') === null, 'and none in the sheet');
});
