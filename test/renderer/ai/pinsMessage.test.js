// Goal: a message of comment pins reads as the person's own pins, never as what the agent was told. The transcript
// shows each pin's number, thumbnail, words and page and element names, and how each stands, taken from the
// subagent titled for it; it shows no path, locator, breakpoint instruction, wave, tag name of the instructions or
// id, and offers no Edit or Resend (its text is only a summary). The host's path is real: the brief goes through
// the prompt builder, whose sent part is what the stored user event carries.
// Method: the transcript bundled with esbuild and mounted in jsdom with a view folded by the real reducer from
// events shaped as the host writes them (the user event from buildPrompt's sent part, Agent calls per pin).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const { waitFor } = require('../../helpers/waitFor.js');

const output = repoPath('node_modules/.stacki-test/pinsMessage.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export { Transcript } from './src/features/ai/transcript/TranscriptView';",
      "export { resetTranscriptUi } from './src/features/ai/transcript/transcriptUi';",
      "export { EMPTY_CHAT, reduceChat } from './src/features/ai/chatReducer';",
      "export { loadAiProject, resetAiStore, openChat, aiState, draftText } from './src/features/ai/aiStore';",
      "export { buildPrompt } from './electron/handlers/ai/promptBlocks';",
      "export { PinsMessage } from './src/features/ai/pins/PinsMessage';",
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
for (const name of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'getComputedStyle', 'localStorage']) {
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
dom.window.HTMLElement.prototype.scrollTo = () => undefined;
dom.window.HTMLElement.prototype.scrollIntoView = () => undefined;

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const ui = require(output);

const CHAT = `c${'a'.repeat(24)}`;
const TURN = `t${'1'.padStart(16, '0')}`;
const THUMB = 'data:image/jpeg;base64,aGVsbG8=';

const entry = (number, over = {}) => ({
  number,
  comment: `Pin words ${number}`,
  pageLabel: 'Home',
  page: 'src/pages/index.astro',
  elementLabel: `Heading ${number}`,
  file: 'src/pages/index.astro',
  locator: `0.${number}`,
  tag: 'h1',
  text: undefined,
  componentFile: 'src/components/Hero.astro',
  breakpointPx: 768,
  images: [],
  ...over,
});

const agentCall = (call, title, status) => ({
  kind: 'tool',
  turn: TURN,
  call,
  title,
  toolKind: 'think',
  status,
  paths: undefined,
  diffs: undefined,
  output: undefined,
  exitCode: undefined,
  parent: undefined,
  at: 1,
  toolName: 'Agent',
});

test('a message of pins: words and names, a status per pin, no instructions, no paths, no ids', async () => {
  window.avb = {
    aiAgents: async () => ({ trusted: true, agents: [], options: [] }),
    aiChats: async () => ({ chats: [], sections: [] }),
    aiAck: () => undefined,
    onAiEvents: () => () => undefined,
    onAiAgentStatus: () => () => undefined,
    onAiSetup: () => () => undefined,
    platform: 'darwin',
  };
  ui.resetTranscriptUi();
  ui.resetAiStore();
  await ui.loadAiProject('/site');
  const brief = { mode: 'subagents', pins: [entry(1, { images: [0] }), entry(2)] };
  const attachments = [{ kind: 'image', name: 'Pinned area', mimeType: 'image/png', data: 'aGVsbG8=', note: 'Pin 1, image 1: the pinned area' }];
  const source = { root: '/site', home: '/home', agent: 'claude', embeddedContext: true, commands: new Set(), read: () => undefined };
  const built = ui.buildPrompt(source, { text: 'Comments on 2 pins\nPin 1: Pin words 1\nPin 2: Pin words 2', attachments, parts: undefined, pins: brief });
  assert.ok(built.ok);
  const view = ui.reduceChat(ui.EMPTY_CHAT, [
    { kind: 'turn-start', turn: TURN, at: 0 },
    {
      kind: 'user',
      turn: TURN,
      text: 'Comments on 2 pins',
      attachments: [{ kind: 'image', name: 'Pinned area', thumbnail: THUMB }],
      at: 0,
      parts: built.value.sent,
    },
    agentCall('toolu_01ABCDEF0123456789', 'Pin 1: Bigger heading', 'completed'),
    agentCall('toolu_01ABCDEF9876543210', 'Pin 2: Less space', 'in_progress'),
  ]);
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(ui.Transcript, {
        view,
        reading: { hidden: new Set(), details: undefined, interrupted: false },
        retryHeldByCard: false,
        projectPath: '/site',
        chatId: CHAT,
        onReview: () => undefined,
        onOpenSubagent: () => undefined,
      }),
    );
  });
  const message = container.querySelector('.ai-pins-message');
  assert.ok(message, 'the message is drawn as pins');
  const shown = message.textContent;
  for (const wanted of ['Comments on 2 pins', 'Pin words 1', 'Pin words 2', 'Home · Heading 1', 'Done', 'Working']) {
    assert.ok(shown.includes(wanted), `shows "${wanted}" in "${shown}"`);
  }
  assert.equal(message.querySelector('img')?.getAttribute('src'), THUMB, 'pin 1 shows the crop it was sent with');
  // The crop opens large. This chat kept no full copy, so it opens the small one and says so.
  const picture = message.querySelector('button.ai-pins-message-picture');
  assert.equal(picture.getAttribute('aria-label'), 'Enlarge Heading 1');
  assert.equal(picture.getAttribute('title'), 'Only a small copy of this image was saved');
  assert.equal(message.querySelectorAll('.ai-pins-message-picture').length, 1, 'a comment with no picture is as it was');
  await act(async () => picture.click());
  assert.equal(document.querySelector('.ai-lightbox-image')?.getAttribute('src'), THUMB);
  await act(async () => document.querySelector('.ai-lightbox-close').click());
  await waitFor({
    what: 'the picture viewer closes',
    read: async () => {
      await act(async () => {});
      return (document.querySelector('.ai-lightbox') ?? undefined) === undefined;
    },
    until: (closed) => closed,
  });
  for (const hidden of ['src/', '.astro', '0.1', 'comment-pins', 'Wave', 'subagent', 'locator', 'toolu_', '768']) {
    assert.ok(!shown.includes(hidden), `shows no "${hidden}"`);
  }
  assert.ok(!/[{}]/u.test(container.textContent), 'no braces anywhere');
  assert.ok(container.querySelector('[aria-label="Edit"], [aria-label="Resend"]') === null, 'no Edit or Resend on a summary');
  await act(async () => root.unmount());
  container.remove();
});

test('a pin that needs the person shows its question with choices and Reply; a pin not started offers nothing to answer', async () => {
  const prompts = [];
  const chat = { id: CHAT, agent: 'claude', title: 'New chat', pinned: false, createdAt: 1, updatedAt: 1, rank: 0, unread: false };
  window.avb = {
    aiAgents: async () => ({ trusted: true, agents: [], options: [] }),
    aiChats: async () => ({ chats: [chat], sections: [] }),
    aiChatRead: async () => ({ ok: true, value: { summary: chat, events: [], full: false } }),
    aiChatUpdate: async () => ({ ok: true, value: chat }),
    aiPrompt: async (payload) => {
      prompts.push(payload);
      return { ok: true, value: { turn: `t${'2'.padStart(16, '0')}` } };
    },
    aiAck: () => undefined,
    onAiEvents: () => () => undefined,
    onAiAgentStatus: () => () => undefined,
    onAiSetup: () => () => undefined,
    platform: 'darwin',
  };
  ui.resetTranscriptUi();
  ui.resetAiStore();
  await ui.loadAiProject('/site');
  await ui.openChat(CHAT);
  const brief = { mode: 'subagents', pins: [entry(1, { model: 'haiku', modelName: 'Haiku' }), entry(2)] };
  const source = { root: '/site', home: '/home', agent: 'claude', embeddedContext: true, commands: new Set(), read: () => undefined };
  const built = ui.buildPrompt(source, { text: 'Comments on 2 pins', attachments: [], parts: undefined, pins: brief });
  assert.ok(built.ok);
  const view = ui.reduceChat(ui.EMPTY_CHAT, [
    { kind: 'turn-start', turn: TURN, at: 0 },
    { kind: 'user', turn: TURN, text: 'Comments on 2 pins', attachments: [], at: 0, parts: built.value.sent },
    agentCall('a1', 'Pin 1: Bigger heading', 'in_progress'),
    { kind: 'text', turn: TURN, role: 'agent', text: 'Question for pin 1: How big?\n- Twice as big\n- A little bigger', at: 2 },
    { kind: 'turn-end', turn: TURN, stop: 'error', message: undefined, at: 3 },
  ]);
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(ui.Transcript, {
        view,
        reading: { hidden: new Set(), details: undefined, interrupted: false },
        retryHeldByCard: false,
        projectPath: '/site',
        chatId: CHAT,
        onReview: () => undefined,
        onOpenSubagent: () => undefined,
      }),
    );
  });
  const [asking, waiting] = [...container.querySelectorAll('.ai-pins-message-pin')];
  assert.match(asking.querySelector('.ai-pin-progress').textContent, /Needs you/);
  assert.equal(asking.querySelector('.ai-pin-ask-words').textContent, 'How big?');
  assert.deepEqual(
    [...asking.querySelectorAll('.ai-pin-ask-choices button')].map((button) => button.textContent),
    ['Twice as big', 'A little bigger', 'Reply'],
  );
  const tag = asking.querySelector('.ai-pins-message-model');
  assert.equal(tag.textContent, 'Chat model', 'its subagent ran without the chosen model: the card says what it ran on');
  assert.match(tag.getAttribute('title'), /You chose Haiku/);
  assert.match(waiting.querySelector('.ai-pin-progress').textContent, /Not started/);
  assert.equal(waiting.querySelector('.ai-pin-ask') ?? undefined, undefined, 'nothing to answer, so nothing asks');
  // A press, then the state it leads to: the chat opens and the message is sent through promises of their own.
  const press = async (element, what, read) => {
    await act(async () => {
      element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await waitFor({ what, read, until: Boolean });
    });
  };
  await press(asking.querySelector('button.ai-pins-message-status'), 'the message box to take the keyboard', () => ui.aiState().composerFocusRequests > 0);
  assert.equal(ui.draftText(ui.aiState().drafts.get(CHAT)), '“Pin words 1”: ', 'the badge opens the message box on that pin');
  await press(asking.querySelector('.ai-pin-ask-choice'), 'the choice to be sent', () => prompts.length > 0);
  assert.equal(prompts.at(-1).text, '“Pin words 1”: Twice as big', 'a choice is sent as the answer about that pin');
  await act(async () => root.unmount());
  const second = createRoot(container);
  await act(async () => {
    second.render(
      React.createElement(ui.Transcript, {
        view: ui.reduceChat(ui.EMPTY_CHAT, [
          { kind: 'turn-start', turn: TURN, at: 0 },
          { kind: 'user', turn: TURN, text: 'Comments on 2 pins', attachments: [], at: 0, parts: built.value.sent },
          { ...agentCall('a1', 'Pin 1: Bigger heading', 'in_progress'), agentModel: 'haiku' },
        ]),
        reading: { hidden: new Set(), details: undefined, interrupted: false },
        retryHeldByCard: false,
        projectPath: '/site',
        chatId: CHAT,
        onReview: () => undefined,
        onOpenSubagent: () => undefined,
      }),
    );
  });
  const named = container.querySelector('.ai-pins-message-model');
  assert.equal(named.textContent, 'Haiku', 'it ran on the chosen model: the card names it quietly');
  assert.equal(named.getAttribute('title') ?? '', '');
  await act(async () => second.unmount());
  container.remove();
});

test('a reloaded chat’s pin crop reads its full copy from the chat', async () => {
  const asked = [];
  const chat = { id: CHAT, agent: 'claude', title: 'New chat', pinned: false, createdAt: 1, updatedAt: 1, rank: 0, unread: false };
  window.avb = {
    aiAgents: async () => ({ trusted: true, agents: [], options: [] }),
    aiChats: async () => ({ chats: [chat], sections: [] }),
    aiChatImage: async (payload) => {
      asked.push(payload);
      return { ok: true, value: { mimeType: 'image/png', data: 'RlVMTA==' } };
    },
    aiAck: () => undefined,
    onAiEvents: () => () => undefined,
    onAiAgentStatus: () => () => undefined,
    onAiSetup: () => () => undefined,
    platform: 'darwin',
  };
  ui.resetTranscriptUi();
  ui.resetAiStore();
  await ui.loadAiProject('/site');
  const original = `${'a'.repeat(32)}.png`;
  const brief = { mode: 'subagents', pins: [entry(1, { images: [0] })] };
  const source = { root: '/site', home: '/home', agent: 'claude', embeddedContext: true, commands: new Set(), read: () => undefined };
  const attachments = [{ kind: 'image', name: 'Pinned area', mimeType: 'image/png', data: 'aGVsbG8=' }];
  const built = ui.buildPrompt(source, { text: 'Comments on 1 pin', attachments, parts: undefined, pins: brief });
  assert.ok(built.ok);
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  await act(async () =>
    root.render(
      React.createElement(ui.PinsMessage, {
        chat: CHAT,
        turn: TURN,
        mode: 'subagents',
        pins: built.value.sent.find((part) => part.kind === 'pins').pins,
        attachments: [{ kind: 'image', name: 'Pinned area', thumbnail: THUMB, original }],
        view: ui.EMPTY_CHAT,
        onOpenSubagent: undefined,
      }),
    ),
  );
  try {
    await act(async () => container.querySelector('.ai-pins-message-picture').click());
    await act(async () => waitFor({ what: 'the full image', read: () => document.querySelector('.ai-lightbox-image')?.getAttribute('src'), until: Boolean }));
    assert.deepEqual(asked, [{ projectPath: '/site', chat: CHAT, image: original }]);
    assert.equal(document.querySelector('.ai-lightbox-image').getAttribute('src'), 'data:image/png;base64,RlVMTA==');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
