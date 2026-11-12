// Goal: the AI panel does what it shows. Opening it lists the project's chats;
// a new chat asks to trust the project before anything starts, then shows what
// the agent still needs (the connector, a sign-in through the terminal);
// pushed events draw streamed text, tool cards with their diff, permission
// cards whose buttons answer, and a turn's changes whose Keep and Undo review
// each file — a drifted undo opening the merge editor; every push is
// acknowledged after it is applied; the rail's foot carries the AI button for a
// role that has the panel; "Fix with AI" reaches the panel ahead of the terminal; a
// draft hand-off (the Apps panel's "Build an app") waits unsent in the composer.
// The integration tests at the end mount the whole panel in each state the overhaul lists (empty chat,
// a running turn with tool groups and a background task, a finished turn with its changes and a diff, a
// waiting permission, an expired sign-in, a failed reply, a compaction under way and failed, the sessions
// list with sections) and check that the pieces draw together: no loading word, the composer's status
// line with the context ring, and only the rows the state calls for.
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
      "export { readSignInFailures } from './src/features/ai/signInTranscript';",
      "export { switchProvider, setDraft, draftText, draftFromText } from './src/features/ai/aiStore';",
      "export { resetChangeDiffs } from './src/features/ai/transcript/changeDiffs';",
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
  'Window',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'HTMLSelectElement',
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
dom.window.HTMLElement.prototype.scrollTo = function () {};
// The composer is a CodeMirror editor, which measures text with Range geometry jsdom does not implement.
const caretBox = { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 };
dom.window.Range.prototype.getBoundingClientRect = () => caretBox;
dom.window.Range.prototype.getClientRects = () => ({ length: 0, item: () => undefined, [Symbol.iterator]: function* () {} });

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const ai = require(output);

const PROJECT = '/site';
const CHAT = `c${'a'.repeat(24)}`;
const TURN = `t${'1'.repeat(16)}`;
const summary = { id: CHAT, agent: 'codex', title: 'New chat', pinned: false, createdAt: 1, updatedAt: 1, rank: 0, unread: false };

function fakeMain(over = {}) {
  const calls = [];
  const listeners = { events: undefined, status: undefined };
  // Main's chat list, as the store keeps it: a created chat is listed from then on.
  const chats = [...(over.chats ?? [])];
  let trusted = over.trusted ?? false;
  // An expired sign-in clears once a sign-in finishes, as the host's does.
  let expired = over.codex === 'sign-in';
  const record = (name, reply) => async (payload) => {
    calls.push({ name, payload });
    return typeof reply === 'function' ? reply(payload) : reply;
  };
  window.avb = {
    aiAgents: record('aiAgents', () => ({
      trusted,
      agents: [
        { agent: 'claude', state: 'missing-cli' },
        {
          agent: 'codex',
          state: expired ? 'sign-in' : over.codex === 'sign-in' ? 'ready' : (over.codex ?? 'ready'),
          adapterVersion: '2.6.0',
          running: false,
          downloadMegabytes: 21,
        },
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
    aiChats: record('aiChats', () => ({ chats: [...chats], sections: over.sections ?? [] })),
    aiDiff: record('aiDiff', over.diff ?? { ok: true, value: { oldText: 'one\ntwo\n', newText: 'one\n2\n' } }),
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
      if (payload.action.kind === 'signIn' && over.signIn !== undefined) {
        if (over.signIn === 'ready') {
          expired = false;
          return { agent: payload.agent, step: 'ready', account: { name: undefined, plan: undefined, email: undefined } };
        }
        return over.signIn === 'failed'
          ? { agent: payload.agent, step: 'failed', during: 'sign-in', message: 'Signing in took too long. Try again.', details: 'codex login: timed out' }
          : { agent: payload.agent, step: 'signing-in', url: 'https://auth.example/login', needsCode: false };
      }
      if (payload.action.kind === 'cancel') {
        return { agent: payload.agent, step: 'signed-out' };
      }
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
  assert.ok(document.activeElement?.classList.contains('cm-content'), 'the composer has the keyboard');
  // Codex is not on this computer: one sentence and one button, which runs the installer in main.
  assert.match(container.textContent, /Install Codex/);
  await click(button(container, 'Install Codex'));
  const setup = calls.filter((call) => call.name === 'aiSetup').at(-1);
  assert.deepEqual(setup.payload.action, { kind: 'install' });
  assert.match(container.textContent, /Installing Codex…/);
  assert.ok(container.querySelector('.ai-status-line .ai-chip-logo svg'), 'the status line’s model chip shows the agent’s mark');
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
    [...container.querySelectorAll('.ai-status-line [aria-label]')].some((element) => element.getAttribute('aria-label') === 'Model'),
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

const RAW_401 = 'Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.';

/** The events of a chat whose reply failed on an expired sign-in, as the host now writes them. */
function expiredTurn(extra = []) {
  return [
    { kind: 'turn-start', turn: TURN, at: 1 },
    { kind: 'user', turn: TURN, text: 'Change line two', attachments: [], at: 1 },
    { kind: 'text', turn: TURN, role: 'agent', text: RAW_401 },
    ...extra,
    { kind: 'turn-end', turn: TURN, stop: 'sign-in', message: 'Sign in to Codex to continue.', at: 2 },
  ];
}

test('a first-time sign-in is one card: Sign in runs the CLI’s login, then waits in the browser with a way back', async (context) => {
  ai.resetAiStore();
  window.localStorage.setItem('stacki.ai.agent', 'codex');
  const { calls } = fakeMain({ trusted: true, setup: { codex: 'signed-out' }, signIn: 'signing-in' });
  const opened = [];
  const { container, root } = await mount({ onOpenExternal: (url) => opened.push(url) });
  context.after(() => act(() => root.unmount()));
  assert.equal(container.querySelectorAll('.ai-signin').length, 1, 'one card, not several');
  assert.match(container.querySelector('.ai-signin strong').textContent, /^Sign in to Codex$/);
  assert.match(container.textContent, /Sign in to start chatting\./);
  assert.ok(button(container, 'Use the terminal instead'));
  assert.equal(container.querySelector('.cm-placeholder').textContent, 'Sign in to Codex to start chatting');
  await click(button(container, 'Sign in'));
  assert.deepEqual(calls.filter((call) => call.name === 'aiSetup').at(-1).payload.action, { kind: 'signIn' });
  // Browser opened: say so, show progress, offer the page again and Cancel.
  assert.match(container.querySelector('.ai-signin strong').textContent, /Finish signing in in your browser/);
  assert.ok(container.querySelector('.ai-signin .ai-spinner'), 'a spinner shows while waiting');
  await click(button(container, 'Didn’t open? Open the page again'));
  assert.deepEqual(opened, ['https://auth.example/login']);
  await click(button(container, 'Cancel'));
  assert.deepEqual(calls.filter((call) => call.name === 'aiSetup').at(-1).payload.action, { kind: 'cancel' });
  assert.match(container.querySelector('.ai-signin strong').textContent, /^Sign in to Codex$/);
});

test('an expired sign-in is one card and nothing red or amber: the raw 401 sits behind Details, the draft survives, Retry comes after', async (context) => {
  ai.resetAiStore();
  window.localStorage.setItem('stacki.ai.agent', 'codex');
  const { calls, listeners } = fakeMain({ trusted: true, codex: 'sign-in', signIn: 'ready' });
  const { container, root, terminals } = await mount();
  context.after(() => act(() => root.unmount()));
  // The legacy record too: an old stored chat has a sign-in notice before its error end.
  await push(listeners, [
    { kind: 'turn-start', turn: TURN, at: 1 },
    { kind: 'user', turn: TURN, text: 'Change line two', attachments: [], at: 1 },
    { kind: 'text', turn: TURN, role: 'agent', text: RAW_401 },
    { kind: 'notice', severity: 'sign-in', text: 'Sign in to Codex to continue.' },
    { kind: 'turn-end', turn: TURN, stop: 'error', message: 'Sign in to Codex to continue.', at: 2 },
  ]);
  assert.equal(container.querySelectorAll('.ai-signin').length, 1);
  assert.equal(container.querySelectorAll('.ai-notice, .ai-error-row').length, 0, 'no red or amber notice, no error row');
  assert.match(container.textContent, /Your session expired\. Sign in again to keep chatting\./);
  assert.doesNotMatch(container.querySelector('.ai-transcript').textContent, /401|authenticate/, 'the raw error is not in the transcript');
  const details = container.querySelector('.ai-signin details');
  assert.ok(details && !details.open, 'Details starts closed');
  assert.equal(details.querySelector('pre').textContent, RAW_401, 'the raw message is kept, in full, for support');
  assert.ok(![...container.querySelectorAll('button')].some((element) => element.textContent.trim() === 'Retry'), 'no loose Retry beside the card');
  // The composer says what to do and keeps what was typed.
  assert.equal(container.querySelector('.cm-placeholder').textContent, 'Sign in to Codex to keep chatting');
  await act(async () => ai.setDraft(CHAT, () => ai.draftFromText('half a thought')));
  assert.equal(container.querySelector('.cm-content').textContent, 'half a thought');
  assert.equal(container.querySelector('.ai-send').disabled, true);
  await click(button(container, 'Use the terminal instead'));
  assert.deepEqual(terminals, ['codex login']);
  // Signing in settles into "Signed in", whose one action sends the interrupted message again; nothing resends itself.
  const prompts = () => calls.filter((call) => call.name === 'aiPrompt').length;
  await click(button(container, 'Sign in'));
  assert.deepEqual(calls.filter((call) => call.name === 'aiSetup').at(-1).payload.action, { kind: 'signIn' });
  assert.equal(container.querySelector('.ai-signin details') ?? undefined, undefined);
  assert.match(container.querySelector('.ai-signin-done').textContent, /Signed in/);
  assert.equal(prompts(), 0, 'signing in sends nothing by itself');
  assert.equal(container.querySelector('.cm-content').textContent, 'half a thought');
  await click(button(container, 'Retry message'));
  assert.equal(prompts(), 1);
  assert.equal(calls.find((call) => call.name === 'aiPrompt').payload.text, 'Change line two');
  assert.equal(container.querySelector('.ai-signin-done') ?? undefined, undefined, 'the confirmation settles away');
});

test('a sign-in that fails says so in one sentence with Try again, its details collapsed', async (context) => {
  ai.resetAiStore();
  window.localStorage.setItem('stacki.ai.agent', 'codex');
  const { listeners } = fakeMain({ trusted: true, codex: 'sign-in', signIn: 'failed' });
  const { container, root } = await mount();
  context.after(() => act(() => root.unmount()));
  await push(listeners, expiredTurn());
  await click(button(container, 'Sign in'));
  assert.equal(container.querySelectorAll('.ai-signin').length, 1);
  assert.match(container.querySelector('.ai-signin strong').textContent, /Sign-in didn’t finish/);
  assert.match(container.textContent, /Signing in took too long\. Try again\./);
  assert.ok(button(container, 'Try again'));
  const details = container.querySelector('.ai-signin details');
  assert.ok(!details.open);
  assert.match(details.querySelector('pre').textContent, /codex login: timed out/);
  assert.match(details.querySelector('pre').textContent, /API Error: 401/, 'the agent’s own words stay with the failure');
});

test('a failure that is not about signing in is a quiet row of its own, never the sign-in card', async (context) => {
  ai.resetAiStore();
  window.localStorage.setItem('stacki.ai.agent', 'codex');
  const { calls, listeners } = fakeMain({ trusted: true });
  const { container, root } = await mount();
  context.after(() => act(() => root.unmount()));
  await push(listeners, [
    { kind: 'turn-start', turn: TURN, at: 1 },
    { kind: 'user', turn: TURN, text: 'Change line two', attachments: [], at: 1 },
    { kind: 'turn-end', turn: TURN, stop: 'error', message: 'Codex stopped: ECONNRESET', at: 2 },
  ]);
  assert.equal(container.querySelectorAll('.ai-signin').length, 0);
  assert.equal(container.querySelectorAll('.ai-notice').length, 0, 'not the amber notice');
  const row = container.querySelector('.ai-error-row');
  assert.ok(row);
  assert.match(row.textContent, /The reply didn’t finish\./);
  assert.equal(row.querySelector('details pre').textContent, 'Codex stopped: ECONNRESET');
  assert.equal(container.querySelectorAll('.ai-retry').length, 0, 'Retry lives in the row');
  await click(row.querySelector('button'));
  assert.equal(calls.find((call) => call.name === 'aiPrompt').payload.text, 'Change line two');
});

test('readSignInFailures finds one sign-in problem however it was recorded, and leaves real output alone', () => {
  const turn = TURN;
  const answer = { kind: 'text', turn, role: 'agent', text: 'Here is the plan for the page.' };
  const modern = ai.readSignInFailures([
    { kind: 'user', turn, text: 'hi', attachments: [], at: 1 },
    { kind: 'text', turn, role: 'agent', text: RAW_401 },
    { kind: 'turn-end', turn, stop: 'sign-in', message: undefined },
  ]);
  assert.deepEqual([...modern.hidden].sort(), [1, 2]);
  assert.equal(modern.details, RAW_401);
  assert.equal(modern.interrupted, true);
  const legacy = ai.readSignInFailures([
    { kind: 'notice', severity: 'sign-in', text: 'Sign in to Claude to continue.' },
    { kind: 'turn-end', turn, stop: 'error', message: 'Sign in to Claude to continue.' },
  ]);
  assert.deepEqual([...legacy.hidden].sort(), [0, 1]);
  assert.equal(legacy.details, 'Sign in to Claude to continue.', 'with no words from the agent, the host’s message stands in');
  const plain = ai.readSignInFailures([answer, { kind: 'turn-end', turn, stop: 'error', message: 'Codex stopped.' }]);
  assert.equal(plain.hidden.size, 0, 'an ordinary error hides nothing');
  assert.equal(plain.interrupted, false);
  const mixed = ai.readSignInFailures([
    { kind: 'text', turn, role: 'agent', text: `${'Long answer about logging in. '.repeat(40)}` },
    { kind: 'turn-end', turn, stop: 'sign-in', message: undefined },
  ]);
  assert.ok(!mixed.hidden.has(0), 'a long agent message is output, not the error');
  const settled = ai.readSignInFailures([
    { kind: 'turn-end', turn, stop: 'sign-in', message: undefined },
    { kind: 'turn-end', turn: `t${'2'.repeat(16)}`, stop: 'end_turn', message: undefined },
  ]);
  assert.equal(settled.interrupted, false, 'a later turn that finished means nothing waits on a retry');
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

test('a draft hand-off (Build an app) waits unsent in the composer: ready or not, in an empty chat when there is one, else a new one', async (context) => {
  const task = { title: 'Build an app', prompt: 'Build me an app', delivery: 'draft', context: { files: [], nodeRefs: [], findingIds: [] } };
  const terminalTasks = [];
  const unregisterTerminal = ai.registerAgentTaskHandler('terminal', 10, async (received) => {
    terminalTasks.push(received);
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
  // A trusted project with a ready agent still only drafts: the person sends it.
  ai.resetAiStore();
  window.localStorage.setItem('stacki.ai.agent', 'codex');
  const ready = fakeMain({ trusted: true });
  const outcome = await ai.requestAgentTask(task);
  assert.equal(outcome.tag, 'sent');
  assert.equal(opened, 1);
  assert.equal(ready.calls.filter((call) => call.name === 'aiPrompt').length, 0, 'nothing is sent');
  assert.equal(ai.draftText(ai.aiState().drafts.get(ai.aiState().open)), 'Build me an app');
  // The same request again reuses that chat: it has no messages, and its box holds only the prompt it was given.
  // A box with the person's own words is another matter, below.
  const created = ready.calls.filter((call) => call.name === 'aiChatCreate').length;
  ai.setDraft(ai.aiState().open, () => ai.draftFromText(''));
  await ai.requestAgentTask(task);
  assert.equal(ready.calls.filter((call) => call.name === 'aiChatCreate').length, created, 'an empty chat is reused');
  assert.equal(ai.draftText(ai.aiState().drafts.get(ai.aiState().open)), 'Build me an app');
  // A chat with a draft the person is writing is left alone: the prompt goes to a new chat.
  ai.setDraft(ai.aiState().open, () => ai.draftFromText('my own words'));
  // (The fake main hands every chat one id, so the count of created chats is what shows a new one was made.)
  await ai.requestAgentTask(task);
  assert.equal(ready.calls.filter((call) => call.name === 'aiChatCreate').length, created + 1, 'a typed draft is never replaced');
  // An agent that is not ready: the prompt waits all the same.
  ai.resetAiStore();
  const missing = fakeMain({ trusted: false, codex: 'missing-cli' });
  await ai.requestAgentTask(task);
  assert.equal(missing.calls.filter((call) => call.name === 'aiPrompt').length, 0);
  assert.equal(ai.draftText(ai.aiState().drafts.get(ai.aiState().open)), 'Build me an app');
  assert.equal(terminalTasks.length, 0, 'the terminal never takes a draft');
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
  // The menu is the shared popup, portalled to the body: it is not inside the panel.
  const menu = [...document.querySelectorAll('[role=menuitem]')].map((item) => item.textContent);
  assert.equal(container.querySelector('.ai-account-menu') ?? undefined, undefined, 'no inline menu box in the panel');
  assert.ok(
    menu.some((text) => /designer@example\.com/.test(text)),
    'the popup names the account',
  );
  assert.ok(menu.includes('Sign out'), 'the popup offers Sign out');
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

test('archived chats are not in the list, and the panel is on screen exactly while it is mounted', async (context) => {
  ai.resetAiStore();
  window.localStorage.clear();
  const other = `c${'b'.repeat(24)}`;
  const archived = { ...summary, id: other, title: 'Old idea', archivedAt: 5 };
  fakeMain({ trusted: true, chats: [summary, archived] });
  const { container, root } = await mount();
  assert.equal(ai.aiState().visibility, 'visible');
  await click(button(container, 'All chats'));
  const titles = [...container.querySelectorAll('.ai-list-title')].map((element) => element.textContent);
  assert.deepEqual(titles, ['New chat'], 'the archived chat is out of the list');
  await act(async () => root.unmount());
  assert.equal(ai.aiState().visibility, 'hidden');
  context.after(() => undefined);
});

test('choosing a slash command completes it in the box and never sends the message', async (context) => {
  ai.resetAiStore();
  window.localStorage.clear();
  const { calls, listeners } = fakeMain({ trusted: true, chats: [summary] });
  window.localStorage.setItem('stacki.ai.open./site', CHAT);
  const { container, root } = await mount();
  context.after(() => act(() => root.unmount()));
  await push(listeners, [{ kind: 'commands', commands: [{ name: 'plan', description: 'Plan the work', hint: undefined }] }]);
  await act(async () => ai.setDraft(CHAT, () => ai.draftFromText('/pl')));
  const option = container.querySelector('.ai-commands [role="option"]');
  assert.ok(option, 'the matching command is offered');
  assert.equal(option.getAttribute('type'), 'button', 'inside the form, so it must not submit it');
  await act(async () => {
    option.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    option.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
  assert.equal(ai.draftText(ai.aiState().drafts.get(CHAT)), '/plan ');
  assert.equal(
    calls.some((call) => call.name === 'aiPrompt'),
    false,
  );
});

// ---------------------------------------------------------------------------
// The whole panel in each state
// ---------------------------------------------------------------------------

/** What every state shares: the panel has loaded, the composer is whole, and nothing says it is still loading. */
function assertWholePanel(container, state) {
  assert.doesNotMatch(container.textContent, /Loading/, `${state}: nothing is still loading`);
  assert.equal(container.querySelector('.ai-skeleton') ?? undefined, undefined, `${state}: no skeleton`);
  assert.ok(container.querySelector('.ai-transcript'), `${state}: the transcript`);
  assert.ok(container.querySelector('.ai-compose .cm-content'), `${state}: the composer’s editor`);
  assert.ok(container.querySelector('.ai-status-line .ai-chip-logo'), `${state}: the status line’s model chip`);
  assert.ok(container.querySelector('.ai-status-line .ai-ring'), `${state}: the context ring`);
  assert.doesNotMatch(container.textContent, /NaN|undefined|\[object/, `${state}: no leaked values`);
}

const tool = (call, title, toolKind, status, over = {}) => ({
  kind: 'tool',
  turn: TURN,
  call,
  title,
  toolKind,
  status,
  paths: [],
  diffs: [],
  output: undefined,
  exitCode: undefined,
  parent: undefined,
  at: 1,
  ...over,
});

test('whole panel: a new chat is empty, with its composer, status line and ring, and no tray', async (context) => {
  ai.resetAiStore();
  window.localStorage.clear();
  fakeMain({ trusted: true });
  const { container, root } = await mount();
  context.after(() => act(() => root.unmount()));
  assertWholePanel(container, 'empty chat');
  assert.match(container.querySelector('.ai-empty').textContent, /Ask for a change/);
  assert.equal(container.querySelector('.ai-tasks') ?? undefined, undefined, 'no tray without background work');
  assert.equal(container.querySelector('.ai-turn-status') ?? undefined, undefined, 'no loader while idle');
  assert.equal(container.querySelector('.ai-stop-square') ?? undefined, undefined, 'Send, not Stop');
});

test('whole panel: a running turn shows its tool group, the loader with a timer, the tray, Stop and the ring’s usage', async (context) => {
  ai.resetAiStore();
  window.localStorage.clear();
  const { calls, listeners } = fakeMain({ trusted: true });
  const { container, root } = await mount();
  context.after(() => act(() => root.unmount()));
  await push(listeners, [
    { kind: 'turn-start', turn: TURN, at: Date.now() - 5000 },
    { kind: 'user', turn: TURN, text: 'Fix the build', attachments: [], at: Date.now() - 5000 },
    { kind: 'usage', used: 41_250, size: 100_000 },
    { kind: 'text', turn: TURN, role: 'thought', text: 'Looking at the config.', at: Date.now() - 4000, until: Date.now() - 3500 },
    tool('t1', 'Read package.json', 'read', 'completed', { paths: ['/site/package.json'], at: Date.now() - 3000 }),
    tool('t2', 'npm run build', 'execute', 'in_progress', { command: 'npm run build', output: 'compiling…', at: Date.now() - 2000 }),
    tool('t3', 'npm run dev', 'execute', 'in_progress', { command: 'npm run dev', background: true, output: 'ready on :4321', at: Date.now() - 1000 }),
  ]);
  assertWholePanel(container, 'running turn');
  assert.ok(container.querySelector('.ai-group'), 'the agent’s work is a group');
  assert.ok(container.querySelector('.ai-turn-status .loader-dots'), 'the loader moves while the turn runs');
  assert.match(container.querySelector('.ai-turn-status').textContent, /\d+s/, 'with a live timer');
  assert.match(container.querySelector('.ai-tasks').textContent, /1 task running/, 'the background command is in the tray');
  assert.ok(container.querySelector('.ai-stop-square'), 'the composer offers Stop');
  assert.equal(container.querySelector('.ai-ring').getAttribute('aria-label'), 'Context usage, 41% used');
  await click(button(container, 'Stop agent'));
  assert.ok(
    calls.some((call) => call.name === 'aiCancel'),
    'the tray’s Stop agent cancels the turn',
  );
});

test('whole panel: a finished turn folds its work, and its changes card loads the diff and opens the file', async (context) => {
  ai.resetAiStore();
  window.localStorage.clear();
  const opened = [];
  // An earlier test loaded this file's diff for the same ids; the card remembers answers across mounts.
  ai.resetChangeDiffs();
  const { calls, listeners } = fakeMain({ trusted: true });
  const { container, root } = await mount({ onOpenFile: (file) => opened.push(file) });
  context.after(() => act(() => root.unmount()));
  await push(listeners, [
    { kind: 'turn-start', turn: TURN, at: 1000 },
    { kind: 'user', turn: TURN, text: 'Change line two', attachments: [], at: 1000 },
    tool('e1', 'Editing files', 'edit', 'completed', { paths: ['/site/notes.txt'], at: 2000 }),
    { kind: 'text', turn: TURN, role: 'agent', text: 'Done: line two is now 2.', at: 3000, until: 3000 },
    { kind: 'changes', turn: TURN, files: [{ path: 'notes.txt', change: 'modified', review: 'pending' }] },
    { kind: 'turn-end', turn: TURN, stop: 'end_turn', message: undefined, at: 63_000 },
  ]);
  assertWholePanel(container, 'finished turn');
  assert.equal(container.querySelector('.ai-group-head').getAttribute('aria-expanded'), 'false', 'the work folded to one line');
  assert.match(container.querySelector('.ai-worked').textContent, /Worked for 1m 2s/);
  const card = container.querySelector('.ai-changes-card');
  assert.match(card.querySelector('.ai-changes-card-title').textContent, /1 file changed/);
  assert.equal(container.querySelector('.ai-turn-status') ?? undefined, undefined, 'no loader after the turn');
  await click(card.querySelector('.ai-file-toggle'));
  const asked = calls.find((call) => call.name === 'aiDiff');
  assert.deepEqual([asked.payload.chat, asked.payload.turn, asked.payload.path], [CHAT, TURN, 'notes.txt'], 'the diff is fetched for this turn and file');
  assert.ok(card.querySelector('.history-diff-line.added'), 'the diff draws inside the card');
  assert.match(card.querySelector('.ai-changes-total').textContent, /\+1/, 'the counts come from the same diff');
  await click(button(card, 'Open notes.txt'));
  assert.deepEqual(opened, ['notes.txt'], 'Open file reaches the shell with a project-relative path');
});

test('whole panel: a waiting permission is a card with the command, answered by its buttons', async (context) => {
  ai.resetAiStore();
  window.localStorage.clear();
  const { calls, listeners } = fakeMain({ trusted: true });
  const { container, root } = await mount();
  context.after(() => act(() => root.unmount()));
  await push(listeners, [
    { kind: 'turn-start', turn: TURN, at: Date.now() - 1000 },
    { kind: 'user', turn: TURN, text: 'Run the tests', attachments: [], at: Date.now() - 1000 },
    tool('x1', 'npm test', 'execute', 'pending', { command: 'npm test' }),
    {
      kind: 'permission',
      turn: TURN,
      request: 'p9',
      call: 'x1',
      title: 'npm test',
      options: [
        { id: 'no', name: 'No', kind: 'reject_once' },
        { id: 'yes', name: 'Yes', kind: 'allow_once' },
      ],
    },
  ]);
  assertWholePanel(container, 'waiting permission');
  const card = container.querySelector('.ai-permission');
  assert.ok(card, 'the request is a card in the transcript');
  assert.match(card.textContent, /npm test/, 'it says what is asked, from the call it names');
  assert.match(container.querySelector('.ai-turn-status').textContent, /Waiting for you/, 'the loader says the agent waits for the person');
  await click(button(card, 'Yes'));
  assert.deepEqual(calls.find((call) => call.name === 'aiPermission').payload.answer, { kind: 'option', optionId: 'yes' });
});

test('whole panel: an expired sign-in is the card above a composer that says what to do, with the ring still there', async (context) => {
  ai.resetAiStore();
  window.localStorage.setItem('stacki.ai.agent', 'codex');
  const { listeners } = fakeMain({ trusted: true, codex: 'sign-in', signIn: 'ready' });
  const { container, root } = await mount();
  context.after(() => act(() => root.unmount()));
  await push(listeners, expiredTurn());
  assertWholePanel(container, 'expired sign-in');
  assert.equal(container.querySelectorAll('.ai-signin').length, 1);
  assert.equal(container.querySelector('.cm-placeholder').textContent, 'Sign in to Codex to keep chatting');
});

test('whole panel: a failed reply is one quiet row with Retry and Details, and the composer stays usable', async (context) => {
  ai.resetAiStore();
  window.localStorage.clear();
  const { listeners } = fakeMain({ trusted: true });
  const { container, root } = await mount();
  context.after(() => act(() => root.unmount()));
  await push(listeners, [
    { kind: 'turn-start', turn: TURN, at: 1 },
    { kind: 'user', turn: TURN, text: 'Do it', attachments: [], at: 1 },
    { kind: 'turn-end', turn: TURN, stop: 'error', message: 'ECONNRESET', at: 2 },
  ]);
  assertWholePanel(container, 'failed reply');
  assert.equal(container.querySelectorAll('.ai-error-row').length, 1);
  assert.equal(container.querySelectorAll('.ai-signin').length, 0);
  assert.equal(container.querySelector('.ai-compose-problem') ?? undefined, undefined, 'nothing blocks the composer');
});

test('whole panel: a compaction shows under way, then failed with the reason the agent gave', async (context) => {
  ai.resetAiStore();
  window.localStorage.clear();
  const { listeners } = fakeMain({ trusted: true });
  const { container, root } = await mount();
  context.after(() => act(() => root.unmount()));
  await push(listeners, [
    { kind: 'turn-start', turn: TURN, at: Date.now() - 1000 },
    { kind: 'user', turn: TURN, text: '/compact', attachments: [], at: Date.now() - 1000 },
    { kind: 'usage', used: 90_000, size: 100_000 },
    { kind: 'compaction', turn: TURN, id: 'k1', status: 'in_progress', at: Date.now() },
  ]);
  assertWholePanel(container, 'compacting');
  assert.equal(container.querySelector('.ai-compaction').textContent.trim(), 'Compacting conversation…');
  assert.match(container.querySelector('.ai-turn-status').textContent, /Compacting conversation/, 'the loader names it too');
  await push(listeners, [
    { kind: 'compaction', turn: TURN, id: 'k1', status: 'failed', at: Date.now(), error: 'OAuth access token has expired' },
    { kind: 'turn-end', turn: TURN, stop: 'end_turn', message: undefined, at: Date.now() },
  ]);
  assertWholePanel(container, 'compaction failed');
  assert.equal(container.querySelector('.ai-compaction').textContent.trim(), 'Compaction failed · OAuth access token has expired');
  assert.equal(
    container.querySelector('.ai-ring').getAttribute('aria-label'),
    'Context usage, 90% used',
    'the ring keeps the usage the failed compaction did not change',
  );
});

test('whole panel: the sessions list groups chats into their sections, with the header, search and no loading word', async (context) => {
  ai.resetAiStore();
  window.localStorage.clear();
  const section = `s${'1'.repeat(16)}`;
  const second = `c${'b'.repeat(24)}`;
  const third = `c${'c'.repeat(24)}`;
  fakeMain({
    trusted: true,
    chats: [
      { ...summary, title: 'Loose chat', rank: 0 },
      { ...summary, id: second, title: 'Header redesign', rank: 0, section },
      { ...summary, id: third, title: 'Pricing page', rank: 1, section, pinned: true, unread: true },
    ],
    sections: [{ id: section, name: 'Marketing', collapsed: false, rank: 0 }],
  });
  window.localStorage.setItem('stacki.ai.open./site', CHAT);
  const { container, root } = await mount();
  context.after(() => act(() => root.unmount()));
  await click(button(container, 'All chats'));
  assert.doesNotMatch(container.textContent, /Loading/);
  assert.equal(container.querySelector('h2').textContent, 'Chats');
  assert.ok(container.querySelector('.ai-sessions-search input'), 'search');
  assert.deepEqual(
    [...container.querySelectorAll('.ai-section-name')].map((name) => name.textContent),
    ['No section', 'Marketing'],
    'the loose chats and the named section are headed',
  );
  const titles = [...container.querySelectorAll('.ai-list-title')].map((element) => element.textContent);
  assert.deepEqual(titles, ['Loose chat', 'Pricing page', 'Header redesign'], 'the loose chat first, then the section with its pinned chat first');
  assert.equal(container.querySelectorAll('.ai-unread-dot').length, 1, 'only the unread chat has its dot');
});
