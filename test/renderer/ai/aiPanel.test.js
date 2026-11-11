// Goal: the AI panel does what it shows. Opening it lists the project's chats;
// a new chat asks to trust the project before anything starts, then shows what
// the agent still needs (the connector, a sign-in through the terminal);
// pushed events draw streamed text, tool cards with their diff, permission
// cards whose buttons answer, and a turn's changes whose Keep and Undo review
// each file — a drifted undo opening the merge editor; every push is
// acknowledged after it is applied; the rail's foot carries the AI button for a
// role that has the panel; "Fix with AI" reaches the panel ahead of the terminal.
// Method: bundle the real panel, store, rail and agent-task registry with
// esbuild, mount them in jsdom against a fake preload (window.avb) that records
// every call, and push events through its listener as main would.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/aiPanel.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export { default as AiPanel } from './src/features/ai/AiPanel';",
      "export { aiState, resetAiStore, receiveEvents } from './src/features/ai/aiStore';",
      "export { aiAgentTaskHandler, AI_PANEL_HANDLER_PRIORITY } from './src/features/ai/aiAgentTask';",
      "export { registerAgentTaskHandler, requestAgentTask, agentTaskHandlerNames } from './src/lib/agentTasks';",
      "export { default as LeftRail } from './src/app/LeftRail';",
      "export { ConfirmHost } from './src/ui/ConfirmDialog';",
      "export { accountLabel } from './src/features/ai/SetupCard';",
      "export { switchProvider } from './src/features/ai/aiStore';",
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
dom.window.HTMLElement.prototype.scrollTo = function () {};

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const ai = require(output);

const PROJECT = '/site';
const CHAT = `c${'a'.repeat(24)}`;
const TURN = `t${'1'.repeat(16)}`;
const summary = { id: CHAT, agent: 'codex', title: 'New chat', pinned: false, createdAt: 1, updatedAt: 1 };

function fakeMain(over = {}) {
  const calls = [];
  const listeners = { events: undefined, status: undefined };
  // Main's chat list, as the store keeps it: a created chat is listed from then on.
  const chats = [...(over.chats ?? [])];
  let trusted = over.trusted ?? false;
  const record = (name, reply) => async (payload) => {
    calls.push({ name, payload });
    return typeof reply === 'function' ? reply(payload) : reply;
  };
  window.avb = {
    aiAgents: record('aiAgents', () => ({
      trusted,
      agents: [
        { agent: 'claude', state: 'missing-cli' },
        { agent: 'codex', state: over.codex ?? 'ready', adapterVersion: '2.6.0', running: false, downloadMegabytes: 21 },
      ],
      options: [
        { agent: 'claude', options: [] },
        {
          agent: 'codex',
          options: [
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              currentValue: 'small',
              choices: [
                { value: 'small', name: 'Small' },
                { value: 'large', name: 'Large' },
              ],
            },
          ],
        },
      ],
    })),
    aiChats: record('aiChats', () => [...chats]),
    aiChatCreate: record('aiChatCreate', () => {
      chats.push(summary);
      return { ok: true, value: summary };
    }),
    aiChatRead: record('aiChatRead', { ok: true, value: { summary, events: [], full: false } }),
    aiTrust: record('aiTrust', () => {
      trusted = true;
      return { ok: true };
    }),
    aiInstallAgent: record('aiInstallAgent', { ok: true, value: { agent: 'codex', state: 'ready', adapterVersion: '2.6.0', running: false } }),
    aiPrompt: record('aiPrompt', { ok: true, value: { turn: TURN } }),
    aiPermission: record('aiPermission', { ok: true, value: { answered: true } }),
    aiReview: record('aiReview', over.review ?? { tag: 'done', review: 'kept' }),
    aiSetup: record('aiSetup', (payload) => {
      const step = payload.action.kind === 'install' ? 'installing' : (over.setup?.[payload.agent] ?? 'ready');
      return step === 'ready'
        ? { agent: payload.agent, step, account: { name: 'Timothy Ricks', plan: 'Max', email: 'designer@example.com' } }
        : { agent: payload.agent, step };
    }),
    onAiSetup: () => () => undefined,
    aiCancel: record('aiCancel', { ok: true }),
    aiSetOption: record('aiSetOption', { ok: true, value: { set: true } }),
    aiChatUpdate: record('aiChatUpdate', { ok: true, value: summary }),
    aiChatDelete: record('aiChatDelete', { ok: true }),
    aiAck: (chars) => calls.push({ name: 'aiAck', payload: chars }),
    onAiEvents: (callback) => {
      listeners.events = callback;
      return () => undefined;
    },
    onAiAgentStatus: (callback) => {
      listeners.status = callback;
      return () => undefined;
    },
    getFilePath: () => undefined,
    platform: 'darwin',
  };
  return { calls, listeners };
}

async function mount(props = {}) {
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  const merges = [];
  const terminals = [];
  await act(async () => {
    root.render(
      React.createElement(ai.AiPanel, {
        projectPath: PROJECT,
        onOpenTerminal: (command) => terminals.push(command),
        onMerge: (clash, settle) => merges.push({ clash, settle }),
        onOpenExternal: () => undefined,
        renderFrame: (header, body) => React.createElement('div', undefined, header, body),
        ...props,
      }),
    );
  });
  await settle();
  return { container, root, merges, terminals };
}

async function settle() {
  for (let round = 0; round < 5; round++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function button(container, label) {
  const found = [...container.querySelectorAll('button')].find(
    (element) => element.textContent.trim() === label || element.getAttribute('aria-label') === label,
  );
  assert.ok(found, `button ${label}`);
  return found;
}

async function click(element) {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

async function push(listeners, events) {
  await act(async () => {
    listeners.events({ projectPath: PROJECT, chat: CHAT, events, chars: 100 });
  });
  await settle();
}

test('opening the panel goes straight to a new chat with the composer focused; the list is one step back', async (context) => {
  ai.resetAiStore();
  window.localStorage.clear();
  const { calls } = fakeMain({ trusted: true, codex: 'needs-install', setup: { codex: 'missing' } });
  const { container, root } = await mount();
  context.after(() => act(() => root.unmount()));
  assert.equal(calls.filter((call) => call.name === 'aiChatCreate').length, 1, 'a fresh chat, not the list');
  assert.equal(document.activeElement?.tagName, 'TEXTAREA', 'the composer has the keyboard');
  // Codex is not on this computer: one sentence and one button, which runs the installer in main.
  assert.match(container.textContent, /Install Codex/);
  await click(button(container, 'Install Codex'));
  const setup = calls.filter((call) => call.name === 'aiSetup').at(-1);
  assert.deepEqual(setup.payload.action, { kind: 'install' });
  assert.match(container.textContent, /Installing Codex…/);
  const provider = container.querySelector('.ai-composer .ai-provider');
  assert.ok(provider?.querySelector('.dd-icon svg'), 'the composer’s provider trigger shows the agent’s mark');
  assert.equal(calls.find((call) => call.name === 'aiChatCreate').payload.agent, 'claude', 'Claude is the default provider');
  await click(button(container, 'All chats'));
  assert.ok(container.querySelector('.ai-list'), 'the chat list is one step back');
});

test('a reopened panel opens the chat that was open last', async (context) => {
  ai.resetAiStore();
  window.localStorage.setItem('stacki.ai.open./site', CHAT);
  const { calls } = fakeMain({ trusted: true, chats: [summary] });
  const { root } = await mount();
  context.after(() => act(() => root.unmount()));
  assert.equal(calls.filter((call) => call.name === 'aiChatCreate').length, 0);
  assert.ok(calls.some((call) => call.name === 'aiChatRead' && call.payload.chat === CHAT));
});

test('with "ask before allowing" on, a new project asks first', async (context) => {
  ai.resetAiStore();
  window.localStorage.clear();
  const { calls } = fakeMain({ trusted: false });
  const { container, root } = await mount();
  context.after(() => act(() => root.unmount()));
  assert.match(container.textContent, /Let agents work in this project\?/);
  await click(button(container, 'Allow in this project'));
  assert.ok(calls.some((call) => call.name === 'aiTrust'));
});

test('streamed events draw text, tool diffs, permissions and changes, and every push is acknowledged', async (context) => {
  ai.resetAiStore();
  window.localStorage.setItem('stacki.ai.agent', 'codex');
  const { calls, listeners } = fakeMain({
    trusted: true,
    review: {
      tag: 'drifted',
      clash: { path: 'notes.txt', ours: 'now', theirs: 'before', parts: [{ kind: 'clash', ours: 'now', theirs: 'before', changedBy: 'both' }] },
    },
  });
  const { container, root, merges } = await mount();
  context.after(() => act(() => root.unmount()));
  assert.ok(
    [...container.querySelectorAll('.ai-composer [aria-label]')].some((element) => element.getAttribute('aria-label') === 'Model'),
    'the agent’s models are offered before the chat starts',
  );
  await click(button(container, 'New chat'));
  await push(listeners, [
    { kind: 'turn-start', turn: TURN, at: 1 },
    { kind: 'user', turn: TURN, text: 'Change line two', attachments: [], at: 1 },
    { kind: 'text', turn: TURN, role: 'agent', text: 'I will **edit** it.' },
    {
      kind: 'tool',
      turn: TURN,
      call: 'e1',
      title: 'Editing files',
      toolKind: 'edit',
      status: 'in_progress',
      paths: ['/site/notes.txt'],
      diffs: [{ path: '/site/notes.txt', oldText: 'one\ntwo\n', newText: 'one\n2\n' }],
      output: undefined,
      exitCode: undefined,
      parent: undefined,
    },
    {
      kind: 'permission',
      turn: TURN,
      request: 'p1',
      call: 'e1',
      title: 'Edit files',
      options: [
        { id: 'no', name: 'No', kind: 'reject_once' },
        { id: 'yes', name: 'Yes, proceed', kind: 'allow_once' },
      ],
    },
  ]);
  assert.ok(
    calls.some((call) => call.name === 'aiAck' && call.payload === 100),
    'the push is acknowledged after it is applied',
  );
  assert.match(container.textContent, /Change line two/);
  assert.equal(container.querySelector('.ai-markdown strong')?.textContent, 'edit');
  assert.equal(container.querySelector('.ai-diff-path')?.textContent, 'notes.txt');
  assert.ok(container.querySelector('.history-diff-line.added'), 'the diff draws its added line');
  const actions = [...container.querySelectorAll('.ai-permission-actions button')].map((element) => element.textContent);
  assert.deepEqual(actions, ['Yes, proceed', 'No'], 'allow comes first');
  await click(button(container, 'Yes, proceed'));
  const answer = calls.find((call) => call.name === 'aiPermission');
  assert.deepEqual(answer.payload.answer, { kind: 'option', optionId: 'yes' });
  await push(listeners, [
    { kind: 'permission-answered', request: 'p1', outcome: 'selected', optionId: 'yes' },
    { kind: 'changes', turn: TURN, files: [{ path: 'notes.txt', change: 'modified', review: 'pending' }] },
    { kind: 'turn-end', turn: TURN, stop: 'end_turn', message: undefined, at: 2 },
  ]);
  assert.match(container.textContent, /1 file changed/);
  await click(button(container, 'Undo'));
  const review = calls.find((call) => call.name === 'aiReview');
  assert.deepEqual(review.payload.action, { kind: 'undo' });
  assert.equal(merges.length, 1, 'a drifted undo opens the merge editor');
  merges[0].settle('theirs');
  await settle();
  const resolved = calls.filter((call) => call.name === 'aiReview').at(-1);
  assert.deepEqual(resolved.payload.action, { kind: 'resolve', resolution: 'theirs' });
});

test('signing in is a button that runs the CLI’s own login; an expired sign-in offers it again', async (context) => {
  ai.resetAiStore();
  window.localStorage.setItem('stacki.ai.agent', 'codex');
  const { calls } = fakeMain({ trusted: true, setup: { codex: 'signed-out' } });
  const { container, root } = await mount();
  context.after(() => act(() => root.unmount()));
  assert.match(container.textContent, /Sign in to Codex/);
  await click(button(container, 'Sign in with ChatGPT'));
  assert.deepEqual(calls.filter((call) => call.name === 'aiSetup').at(-1).payload.action, { kind: 'signIn' });
});

test('an expired sign-in (the CLI says yes, the agent says no) offers Sign in again and the terminal', async (context) => {
  ai.resetAiStore();
  window.localStorage.setItem('stacki.ai.agent', 'codex');
  const { calls } = fakeMain({ trusted: true, codex: 'sign-in' });
  const { container, root, terminals } = await mount();
  context.after(() => act(() => root.unmount()));
  assert.match(container.textContent, /Sign in to Codex again/);
  await click(button(container, 'Sign in again'));
  assert.deepEqual(calls.filter((call) => call.name === 'aiSetup').at(-1).payload.action, { kind: 'signIn' });
  await click(button(container, 'Use the terminal instead'));
  assert.deepEqual(terminals, ['codex login']);
});

test('the rail carries the AI button at its foot, and Fix with AI reaches the panel before the terminal', async (context) => {
  ai.resetAiStore();
  window.localStorage.setItem('stacki.ai.agent', 'codex');
  const { calls } = fakeMain({ trusted: true });
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  context.after(() => act(() => root.unmount()));
  let selected = 0;
  await act(async () => {
    root.render(
      React.createElement(ai.LeftRail, { active: undefined, onSelect: () => undefined, aiButton: { active: false, onSelect: () => (selected += 1) } }),
    );
  });
  const anchor = container.querySelector('.rail-anchor');
  assert.ok(anchor, 'anchored at the foot');
  assert.equal(anchor, container.querySelector('.rail').lastElementChild);
  await click(anchor.querySelector('button'));
  assert.equal(selected, 1);
  const terminalTasks = [];
  const unregisterTerminal = ai.registerAgentTaskHandler('terminal', 10, async (task) => {
    terminalTasks.push(task);
    return { tag: 'sent', where: 'the terminal' };
  });
  let opened = 0;
  const unregisterPanel = ai.registerAgentTaskHandler(
    'ai-panel',
    ai.AI_PANEL_HANDLER_PRIORITY,
    ai.aiAgentTaskHandler({ projectPath: () => PROJECT, available: () => true, openPanel: () => (opened += 1) }),
  );
  context.after(() => {
    unregisterTerminal();
    unregisterPanel();
  });
  assert.deepEqual(ai.agentTaskHandlerNames(), ['ai-panel', 'terminal']);
  const outcome = await ai.requestAgentTask({
    title: 'Alt text',
    prompt: 'Fix the missing alt text',
    context: { files: ['src/pages/index.astro'], nodeRefs: [], findingIds: [] },
  });
  assert.equal(outcome.tag, 'sent');
  assert.match(outcome.where, /AI panel/);
  assert.equal(opened, 1);
  assert.equal(terminalTasks.length, 0);
  assert.equal(calls.find((call) => call.name === 'aiPrompt')?.payload.text, 'Fix the missing alt text');
});

test('the account line shows a name and plan, falls back to the plan, and keeps the email inside ⋯', async (context) => {
  assert.equal(ai.accountLabel('claude', { name: 'Timothy Ricks', plan: 'Max', email: 'a@b.c' }), 'Timothy Ricks · Max');
  assert.equal(ai.accountLabel('claude', { name: undefined, plan: 'Max', email: 'a@b.c' }), 'Claude Max');
  assert.equal(ai.accountLabel('codex', { name: undefined, plan: undefined, email: undefined }), 'Signed in to ChatGPT');
  ai.resetAiStore();
  window.localStorage.setItem('stacki.ai.agent', 'codex');
  fakeMain({ trusted: true });
  const { container, root } = await mount();
  context.after(() => act(() => root.unmount()));
  assert.match(container.textContent, /Timothy Ricks · Max/);
  assert.doesNotMatch(container.textContent, /designer@example\.com/, 'no email until the menu opens');
  await click(button(container, 'Account options'));
  assert.match(container.querySelector('.ai-account-menu').textContent, /Accountdesigner@example\.com/);
  assert.ok(button(container, 'Sign out'));
});

test('switching provider: an empty chat becomes the other provider’s; a started one stays, and a new chat opens', async (context) => {
  ai.resetAiStore();
  window.localStorage.setItem('stacki.ai.agent', 'codex');
  const { calls } = fakeMain({ trusted: true });
  const { root } = await mount();
  context.after(() => act(() => root.unmount()));
  const created = calls.filter((call) => call.name === 'aiChatCreate').length;
  await act(async () => {
    await ai.switchProvider(CHAT, 'claude', { started: false });
  });
  assert.equal(calls.filter((call) => call.name === 'aiChatDelete').length, 1, 'the empty chat is replaced');
  assert.equal(calls.filter((call) => call.name === 'aiChatCreate').length, created + 1);
  assert.equal(calls.filter((call) => call.name === 'aiChatCreate').at(-1).payload.agent, 'claude');
  await act(async () => {
    await ai.switchProvider(CHAT, 'claude', { started: true });
  });
  assert.equal(calls.filter((call) => call.name === 'aiChatDelete').length, 1, 'a started chat is kept');
  assert.equal(calls.filter((call) => call.name === 'aiChatCreate').length, created + 2);
});
