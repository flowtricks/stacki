// Goal: the owner's bug stays fixed. Sending the pins takes the Send button away under the pointer; its tip must go with
// it, not stay over the pill saying there is nothing to send. With nothing to send there is no Send and no message about
// it, and the mode's own tip does not survive the mode being left under the pointer.
// Method: the real PinBar and stores, bundled with esbuild, mounted in jsdom against a fake preload. The pointer is a
// mouseenter with no matching mouseleave, which is what a browser gives a button that is removed. The tip's wait is the
// hook's real timer, waited for with a bounded poll.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const { waitFor } = require('../../helpers/waitFor.js');

const output = repoPath('node_modules/.stacki-test/pinBarTooltip.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export { PinBar } from './src/features/ai/pins/PinBar';",
      "export * as pins from './src/features/ai/pins/pinStore';",
      "export * as ai from './src/features/ai/aiStore';",
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
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
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

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { Simulate } = require('react-dom/test-utils');
const ui = require(output);

const CHAT = `c${'a'.repeat(24)}`;
const summary = { id: CHAT, agent: 'claude', title: 'New chat', pinned: false, createdAt: 1, updatedAt: 1, rank: 0, unread: false };
const ok = (value) => ({ ok: true, value });

dom.window.avb = {
  platform: 'darwin',
  aiAgents: async () => ({
    trusted: true,
    agents: [{ agent: 'claude', state: 'ready', adapterVersion: '1.0.0', running: false, downloadMegabytes: 1 }],
    options: [],
  }),
  aiChats: async () => ({ chats: [summary], sections: [] }),
  aiChatRead: async () => ok({ summary, events: [], full: false }),
  aiChatUpdate: async () => ok(summary),
  aiPrompt: async () => ok({ turn: `t${'1'.padStart(16, '0')}` }),
  aiPinsRead: async () => ok({ board: { version: 1, pins: [] }, images: [] }),
  aiPinsWrite: async () => ok({ saved: true }),
  aiScreenshot: async () => ok({ mimeType: 'image/png', data: 'aGVsbG8=', width: 10, height: 10 }),
  aiAck: () => undefined,
  onAiEvents: () => () => undefined,
  onAiAgentStatus: () => () => undefined,
  onAiSetup: () => () => undefined,
};

const translate = (key) => key;
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const tipText = () => [...document.querySelectorAll('[role="tooltip"]')].map((tip) => tip.textContent).join(' | ');
// The tip opens after its own wait: each poll lets React draw in an act of its own, until the tip is there.
const untilTip = async () => {
  await waitFor({
    what: 'a tooltip',
    read: async () => {
      await act(async () => undefined);
      return tipText();
    },
    until: (text) => text !== '',
  });
};
const send = () => document.querySelector('.ai-pin-send, .ai-pin-send-waiting');

async function mount() {
  ui.ai.resetAiStore();
  ui.pins.resetPinStore();
  await ui.ai.loadAiProject('/site');
  await ui.ai.openChat(CHAT);
  await ui.pins.loadPins('/site');
  ui.pins.setCommentMode('on');
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(ui.PinBar)));
  return root;
}

async function pinOne() {
  await act(async () => {
    const id = ui.pins.dropPin(
      {
        anchor: { path: '0.1', occurrence: 0, at: { x: 0.5, y: 0.5 }, tag: 'h1', text: 'Welcome' },
        place: {
          page: 'src/pages/index.astro',
          pageLabel: 'Home',
          scope: undefined,
          file: 'src/pages/index.astro',
          locator: '0.1',
          elementLabel: 'Heading',
          componentFile: undefined,
          breakpointPx: 768,
        },
      },
      translate,
    );
    ui.pins.setPinComment(id, 'Bigger');
    ui.pins.savePinBox();
  });
}

test('sending takes Send and its tip with it, and nothing says there is nothing to send', async () => {
  const root = await mount();
  try {
    assert.equal(send()?.textContent, undefined, 'no pins, no Send');
    await pinOne();
    await waitFor({ what: 'the Send button', read: () => (send() ?? undefined) !== undefined, until: Boolean });
    await act(async () => Simulate.mouseEnter(send()));
    await untilTip();
    assert.match(tipText(), /one message|same time|subagent/i, 'the useful tip says how they are sent');
    await act(async () => Simulate.click(send()));
    for (let round = 0; round < 8; round += 1) {
      await settle();
    }
    assert.equal(send()?.textContent, undefined, 'sent pins leave no Send');
    assert.equal(tipText(), '', 'and no bubble');
    assert.doesNotMatch(document.body.textContent, /Nothing to send|ai\.pins\.send\.none/);
    assert.deepEqual(ui.pins.sendReadiness(ui.pins.pinState(), ui.ai.aiState()), { kind: 'empty', count: 0 });
  } finally {
    await act(async () => root.unmount());
  }
});

test('the mode tip goes when the mode is left under the pointer, and does not return with it', async () => {
  const root = await mount();
  try {
    await act(async () => Simulate.mouseEnter(document.querySelector('.ai-pin-bar-mode')));
    await untilTip();
    await act(async () => ui.pins.setCommentMode('off'));
    await settle();
    await act(async () => ui.pins.setCommentMode('on'));
    await settle();
    assert.equal(tipText(), '');
  } finally {
    await act(async () => root.unmount());
  }
});
