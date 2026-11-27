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
      "export { listPosition } from './src/features/ai/pins/PinList';",
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
  onAiSetup: (listener) => {
    pushSetup = listener;
    return () => undefined;
  },
  aiSetup: async (payload) => {
    setupCalls.push(payload.action.kind);
    return { agent: payload.agent, step: 'signing-in', url: undefined, needsCode: false, output: '' };
  },
};
let pushSetup;
const setupCalls = [];

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

test('Claude billed beyond the subscription: the warning stands over the bar, with the way to sign in', async () => {
  const root = await mount();
  const warning = () => document.querySelector('.ai-pin-bar-slot > .ai-billing');
  const account = { name: undefined, plan: 'Max', email: undefined, source: 'account' };
  try {
    for (const quiet of [
      { agent: 'claude', step: 'ready', account },
      { agent: 'claude', step: 'signed-out' },
      { agent: 'claude', step: 'signed-out', reason: 'not-subscription' },
      { agent: 'claude', step: 'unchecked' },
    ]) {
      await act(async () => pushSetup(quiet));
      assert.equal(warning() === null, true, `no warning: ${quiet.step} ${quiet.reason ?? ''}`);
    }
    for (const loud of [
      { agent: 'claude', step: 'ready', account, billing: 'extra-usage' },
      { agent: 'claude', step: 'signed-out', reason: 'billed' },
    ]) {
      await act(async () => pushSetup(loud));
      assert.equal(warning()?.querySelector('.ai-billing-label').textContent, 'Billed per use, not your subscription');
      assert.equal(warning()?.querySelector('button').textContent, 'Sign in with subscription');
    }
    await act(async () => Simulate.mouseEnter(warning().querySelector('.ai-billing-label')));
    await untilTip();
    assert.equal(tipText(), 'Stacki stopped the reply to avoid more charges.');
    await act(async () => Simulate.click(warning().querySelector('button')));
    await settle();
    assert.deepEqual(setupCalls, ['signIn']);
  } finally {
    await act(async () => root.unmount());
  }
});

test('the list opens upward, centred on the bar, and stays inside a narrow or short window', () => {
  const window = { width: 1600, height: 1000 };
  const wide = ui.listPosition({ left: 700, top: 940, width: 200 }, window);
  assert.deepEqual(wide, { position: 'fixed', left: 610, width: 380, bottom: 68, maxHeight: 520 });
  assert.equal(ui.listPosition({ left: 650, top: 940, width: 300 }, window).left, 610, 'a wider bar keeps the same centre');
  const edge = ui.listPosition({ left: 20, top: 940, width: 100 }, window);
  assert.equal(edge.left, 8);
  const narrow = ui.listPosition({ left: 60, top: 240, width: 200 }, { width: 320, height: 300 });
  assert.deepEqual([narrow.left, narrow.width, narrow.maxHeight], [8, 304, 224]);
});

const agent = (turn, call, number) => ({
  kind: 'tool',
  turn,
  call,
  title: `Pin ${number}: Change`,
  toolKind: 'think',
  status: 'in_progress',
  paths: undefined,
  diffs: undefined,
  output: undefined,
  exitCode: undefined,
  parent: undefined,
  toolName: 'Agent',
  at: Date.now(),
});
const step = (turn, call, parent, toolKind, file) => ({ ...agent(turn, call, 0), title: 'Step', toolKind, paths: [file], parent, toolName: undefined });

test('the open list shows each working pin’s own step live, and a finished one’s state with no clock', async () => {
  const root = await mount();
  try {
    await pinOne();
    await pinOne();
    await pinOne();
    await act(async () => void (await ui.pins.sendAllPins(translate)));
    const turn = `t${'1'.padStart(16, '0')}`;
    const push = (events) => act(async () => ui.ai.receiveEvents({ projectPath: '/site', chat: CHAT, events }));
    const rows = () =>
      [...document.querySelectorAll('.ai-pin-list .ai-pin-row')].map((row) => [
        row.querySelector('.ai-pin-live-words')?.textContent,
        row.querySelector('.ai-agent-time') !== null,
      ]);
    await push([
      { kind: 'turn-start', turn, at: Date.now() },
      { kind: 'user', turn, text: 'Pins', attachments: [], at: Date.now() },
    ]);
    await act(async () => ui.pins.setPinListOpen('open'));
    await settle();
    assert.deepEqual(rows(), [
      ['Starting', false],
      ['Starting', false],
      ['Starting', false],
    ]);
    await push([
      agent(turn, 'a1', 1),
      agent(turn, 'a2', 2),
      step(turn, 's1', 'a1', 'edit', 'src/components/Hero.astro'),
      step(turn, 's2', 'a2', 'read', 'src/styles/base.css'),
    ]);
    assert.deepEqual(rows(), [
      ['Editing Hero.astro', true],
      ['Reading base.css', true],
      ['Waiting', false],
    ]);
    await push([{ ...agent(turn, 'a1', 1), status: 'failed' }]);
    assert.deepEqual(rows()[0], ['Didn’t finish', false]);
    assert.deepEqual(rows()[1], ['Reading base.css', true], 'one pin’s end changes no other row');
    const count = () => document.querySelector('.ai-pin-bar button[aria-expanded]').textContent;
    assert.equal(count(), '2 working', 'the pin that did not finish is not counted as working');
    await push([{ kind: 'turn-end', turn, stop: 'cancelled', message: undefined, at: Date.now() }]);
    assert.equal(count(), '3 pins');
  } finally {
    await act(async () => root.unmount());
  }
});
