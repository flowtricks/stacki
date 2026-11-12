// Goal: the composer does what it draws. The box is slim and sends with Enter; while a turn runs Enter
// steers, Cmd+Enter queues (the queue shows above the box with Send now and remove, and sends when the turn
// ends), Stop and Escape cancel; the status line's model chip opens the model menu (numbers choose a model,
// "Effort" opens its rows with a check and a Recommended pill, Ultracode is a switch only when the agent
// offers it); the mode chip opens the Mode menu (descriptions, numbers, Recommended on Auto) and choosing
// Bypass permissions asks once per chat through the app's dialog; the context ring is neutral, amber and red
// at 70% and 90%, and its panel says "N tokens of M" and offers Compact only to agents that can, never while
// a turn runs. No native select is drawn anywhere in the composer.
// Method: bundle the real panel and store with esbuild, mount them in jsdom against a fake preload
// (window.avb) that records every call, and push events through its listener as main would. Layout and
// colour are checked in the Electron render probe, not here: jsdom has no layout.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/composer.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export { default as AiPanel } from './src/features/ai/AiPanel';",
      "export { aiState, resetAiStore, setDraft, draftFromText, draftText } from './src/features/ai/aiStore';",
      "export { ConfirmHost } from './src/ui/ConfirmDialog';",
      "export { forgetDangerousModeConfirmations } from './src/features/ai/composer/ModeMenu';",
      "export { contextSentence } from './src/features/ai/composer/ContextRing';",
      "export { agentBadge } from './src/features/ai/agentSwitch';",
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
dom.window.HTMLElement.prototype.scrollTo = function () {};
dom.window.Element.prototype.scrollIntoView = function () {};
// CodeMirror measures text through Range boxes, which jsdom does not lay out.
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const ai = require(output);

const PROJECT = '/site';
const CHAT = `c${'b'.repeat(24)}`;
const TURN = `t${'2'.repeat(16)}`;

const choice = (value, name, description) => ({ value, name, description });
const CLAUDE_OPTIONS = [
  {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    currentValue: 'default',
    choices: [
      choice('default', 'Manual', 'Always ask before making changes'),
      choice('acceptEdits', 'Accept edits', 'Automatically accept all file edits'),
      choice('plan', 'Plan', 'Create a plan before making changes'),
      choice('auto', 'Auto', 'Claude handles permission decisions'),
      choice('bypassPermissions', 'Bypass permissions', 'Accepts all permissions'),
    ],
  },
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    currentValue: 'sonnet',
    choices: [
      choice('opus', 'Opus 5.5'),
      choice('fable', 'Fable 5.2'),
      choice('sonnet', 'Sonnet 5.5'),
      choice('haiku', 'Haiku 5.5'),
      choice('old', 'Sonnet 4.5'),
    ],
  },
  {
    id: 'effort',
    name: 'Effort',
    category: 'thought_level',
    currentValue: 'medium',
    choices: [
      choice('default', 'Default'),
      choice('low', 'Low'),
      choice('medium', 'Medium'),
      choice('high', 'High'),
      choice('xhigh', 'Xhigh'),
      choice('max', 'Max'),
    ],
  },
  { id: 'ultracode', name: 'Ultracode', category: 'model_config', currentValue: 'off', choices: [choice('on', 'On'), choice('off', 'Off')] },
];
const withoutUltracode = CLAUDE_OPTIONS.filter((option) => option.id !== 'ultracode');
const CODEX_OPTIONS = [
  {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    currentValue: 'read-only',
    choices: [
      choice('read-only', 'Read-only', 'Reads only'),
      choice('workspace-write', 'Workspace access', 'Edits inside the project'),
      choice('agent', 'Auto review', 'Reviews its own work'),
      choice('agent-full-access', 'Full access', 'Everything'),
    ],
  },
  { id: 'model', name: 'Model', category: 'model', currentValue: 'gpt', choices: [choice('gpt', 'GPT 5')] },
];

function fakeMain({ agent = 'claude', options = CLAUDE_OPTIONS } = {}) {
  const calls = [];
  const listeners = { events: undefined };
  const summary = { id: CHAT, agent, title: 'New chat', pinned: false, createdAt: 1, updatedAt: 1, rank: 0, unread: false };
  const chats = [];
  const record = (name, reply) => async (payload) => {
    calls.push({ name, payload });
    return typeof reply === 'function' ? reply(payload) : reply;
  };
  window.avb = {
    aiAgents: record('aiAgents', () => ({
      trusted: true,
      agents: [
        { agent: 'claude', state: 'ready', adapterVersion: '0.105.0', running: false },
        { agent: 'codex', state: 'ready', adapterVersion: '2.6.0', running: false },
      ],
      options: [
        { agent: 'claude', options: agent === 'claude' ? options : [] },
        { agent: 'codex', options: agent === 'codex' ? options : [] },
      ],
    })),
    // Main lists a created chat from then on; a list that forgot it would close the chat the panel just opened.
    aiChats: record('aiChats', () => ({ chats: [...chats], sections: [] })),
    aiChatCreate: record('aiChatCreate', (payload) => {
      const created = { ...summary, agent: payload.agent };
      chats.push(created);
      return { ok: true, value: created };
    }),
    aiChatRead: record('aiChatRead', { ok: true, value: { summary, events: [], full: false } }),
    aiPrompt: record('aiPrompt', { ok: true, value: { turn: TURN } }),
    aiSteer: record('aiSteer', { ok: true, value: { turn: TURN, outcome: 'steered' } }),
    aiCompact: record('aiCompact', { ok: true, value: { started: true } }),
    aiCancel: record('aiCancel', { ok: true }),
    aiSetOption: record('aiSetOption', { ok: true, value: { set: true } }),
    aiChatUpdate: record('aiChatUpdate', { ok: true, value: summary }),
    aiSetup: record('aiSetup', (payload) => ({
      agent: payload.agent,
      step: 'ready',
      account: { name: undefined, plan: undefined, email: undefined },
    })),
    onAiSetup: () => () => undefined,
    aiAck: () => undefined,
    onAiEvents: (callback) => {
      listeners.events = callback;
      return () => undefined;
    },
    onAiAgentStatus: () => () => undefined,
    getFilePath: () => undefined,
    platform: 'darwin',
  };
  return { calls, listeners };
}

async function settle() {
  for (let round = 0; round < 5; round++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(context, over) {
  ai.resetAiStore();
  ai.forgetDangerousModeConfirmations();
  window.localStorage.clear();
  if (over?.agent === 'codex') {
    window.localStorage.setItem('stacki.ai.agent', 'codex');
  }
  const main = fakeMain(over);
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        React.Fragment,
        undefined,
        React.createElement(ai.AiPanel, {
          projectPath: PROJECT,
          onOpenTerminal: () => undefined,
          onMerge: () => undefined,
          onOpenExternal: () => undefined,
          renderFrame: (header, body) => React.createElement('div', undefined, header, body),
        }),
        React.createElement(ai.ConfirmHost),
      ),
    );
  });
  await settle();
  context.after(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.innerHTML = '';
  });
  const live = (options) => push(main.listeners, [{ kind: 'options', options }]);
  return { ...main, container, live };
}

async function push(listeners, events) {
  await act(async () => {
    listeners.events({ projectPath: PROJECT, chat: CHAT, events, chars: 100 });
  });
  await settle();
}

const running = (listeners) => push(listeners, [{ kind: 'turn-start', turn: TURN, at: 1 }]);
const idle = (listeners, stop = 'end_turn') => push(listeners, [{ kind: 'turn-end', turn: TURN, stop, message: undefined, at: 2 }]);

const click = async (element) => {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
};
const key = async (target, init) => {
  await act(async () => {
    target.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });
  await settle();
};
const byLabel = (label) => document.querySelector(`[aria-label="${label}"]`);
const rows = (selector = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]') => [...document.querySelectorAll(selector)];
const rowNamed = (name) => rows().find((row) => row.querySelector('.menu-label')?.textContent === name);
// The input is a CodeMirror editor: text reaches it as the store's draft (what dictation and "Build an app" do),
// and keys go to its content element.
const inputElement = () => document.querySelector('.ai-composer .cm-content');
const inputText = () => ai.draftText(ai.aiState().drafts.get(CHAT) ?? { segments: [], attachments: [] });
const placeholderText = () => document.querySelector('.ai-composer .cm-placeholder').textContent;
const setText = async (text) => {
  await act(async () => ai.setDraft(CHAT, () => ai.draftFromText(text)));
  await settle();
  return inputElement();
};
const callsNamed = (calls, name) => calls.filter((call) => call.name === name);

test('the box is one slim row: a plus, the input with its placeholder, the microphone, and no native select anywhere', async (context) => {
  const { container } = await mount(context);
  assert.ok(container.querySelector('.ai-composer .ai-plus'), 'a plus at the left');
  assert.match(placeholderText(), /^⏎ to send, .+⏎ to queue for later$/);
  assert.ok(byLabel('Dictate'), 'the microphone stays at the right');
  assert.ok(container.querySelector('.ai-stop') === null, 'no stop while idle');
  assert.equal(container.querySelectorAll('select').length, 0, 'never a native select');
  assert.ok(container.querySelector('.ai-composer .ai-chip') === null, 'the settings live under the box, not in it');
  assert.ok(container.querySelector('.ai-status-line'), 'one quiet status line');
});

test('Enter sends when idle and nothing when the box is empty', async (context) => {
  const { calls, container } = await mount(context);
  const box = await setText('Hello');
  await key(box, { key: 'Enter' });
  const sent = callsNamed(calls, 'aiPrompt');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.text, 'Hello');
  assert.equal(inputText(), '', 'the box clears');
  await key(inputElement(), { key: 'Enter' });
  assert.equal(callsNamed(calls, 'aiPrompt').length, 1, 'an empty box sends nothing');
});

test('while a turn runs: Stop appears, Enter steers, the queue key queues, Escape in an empty box stops', async (context) => {
  const { calls, listeners, container } = await mount(context);
  await running(listeners);
  const stop = container.querySelector('.ai-stop');
  assert.ok(stop, 'Stop replaces Send while the agent works');
  assert.ok(container.querySelector('button[type="submit"]') === null);
  assert.match(placeholderText(), /^⏎ to steer, /);
  let box = await setText('Also use tabs');
  await key(box, { key: 'Enter' });
  assert.equal(callsNamed(calls, 'aiSteer').length, 1, 'Enter steers');
  assert.equal(callsNamed(calls, 'aiSteer')[0].payload.text, 'Also use tabs');
  assert.equal(callsNamed(calls, 'aiPrompt').length, 0, 'a steer is not a second prompt');
  box = await setText('Then run the tests');
  await key(box, { key: 'Enter', ctrlKey: true });
  assert.equal(callsNamed(calls, 'aiSteer').length, 1, 'the queue key does not steer');
  assert.equal(container.querySelectorAll('.ai-queued').length, 1, 'the queued message shows above the box');
  assert.match(container.querySelector('.ai-queued-text').textContent, /Then run the tests/);
  assert.equal(inputText(), '', 'the box is free for the next message');
  await click(stop);
  assert.equal(callsNamed(calls, 'aiCancel').length, 1, 'the Stop button cancels the turn');
  await key(inputElement(), { key: 'Escape' });
  assert.equal(callsNamed(calls, 'aiCancel').length, 2, 'Escape in an empty box stops too');
  box = await setText('typing');
  await key(box, { key: 'Escape' });
  assert.equal(callsNamed(calls, 'aiCancel').length, 2, 'Escape with words in the box leaves the turn alone');
});

test('a queued message sends when the turn ends, can be sent now, and can be removed', async (context) => {
  const { calls, listeners, container } = await mount(context);
  await running(listeners);
  for (const text of ['first', 'second', 'third']) {
    const box = await setText(text);
    await key(box, { key: 'Enter', ctrlKey: true });
  }
  assert.equal(container.querySelectorAll('.ai-queued').length, 3);
  await click(container.querySelectorAll('.ai-queued-remove')[2]);
  assert.equal(container.querySelectorAll('.ai-queued').length, 2, 'remove drops one');
  await click(container.querySelectorAll('.ai-queued-send')[1]);
  assert.equal(callsNamed(calls, 'aiSteer').at(-1).payload.text, 'second', 'Send now steers that message into the running turn');
  assert.equal(container.querySelectorAll('.ai-queued').length, 1);
  await idle(listeners);
  const prompts = callsNamed(calls, 'aiPrompt');
  assert.equal(prompts.length, 1, 'the turn ended: the queue sends its first message');
  assert.equal(prompts[0].payload.text, 'first');
  assert.equal(container.querySelectorAll('.ai-queued').length, 0);
});

test('a turn that did not end normally holds the queue as Paused until Resume', async (context) => {
  const { calls, listeners, container } = await mount(context);
  await running(listeners);
  const box = await setText('after this');
  await key(box, { key: 'Enter', ctrlKey: true });
  await idle(listeners, 'error');
  assert.equal(callsNamed(calls, 'aiPrompt').length, 0, 'nothing sends itself after a failure');
  assert.match(container.querySelector('.ai-queue-paused').textContent, /Paused/);
  await click([...container.querySelectorAll('.ai-queue-paused button')].find((element) => element.textContent === 'Resume'));
  assert.equal(callsNamed(calls, 'aiPrompt').length, 1);
  assert.equal(callsNamed(calls, 'aiPrompt')[0].payload.text, 'after this');
});

test('the model chip names the model and effort; its menu lists models with numbers and a check, and a digit chooses', async (context) => {
  const { calls, live } = await mount(context);
  await live(CLAUDE_OPTIONS);
  const chip = byLabel('Model');
  assert.match(chip.textContent, /Sonnet 5\.5/);
  assert.match(chip.textContent, /Medium/);
  await click(chip);
  const labels = rows().map((row) => row.querySelector('.menu-label').textContent);
  assert.deepEqual(labels, ['Opus 5.5', 'Fable 5.2', 'Sonnet 5.5', 'Haiku 5.5', 'Effort', 'Ultracode', 'More models', 'Agent']);
  assert.equal(rowNamed('Opus 5.5').querySelector('.menu-key').textContent, '1');
  assert.equal(rowNamed('Haiku 5.5').querySelector('.menu-key').textContent, '4');
  assert.equal(rowNamed('Sonnet 5.5').querySelectorAll('.menu-check svg').length, 1, 'a check on the current model');
  assert.equal(rowNamed('Opus 5.5').querySelectorAll('.menu-check svg').length, 0);
  assert.match(rowNamed('Effort').textContent, /Medium/);
  await key(document.activeElement, { key: '1' });
  const set = callsNamed(calls, 'aiSetOption');
  assert.deepEqual([set[0].payload.option, set[0].payload.value], ['model', 'opus'], 'the digit chooses that model');
  assert.equal(rows().length, 0, 'choosing closes the menu');
});

test('Effort opens its rows: the description, Recommended on Medium, a check, Extra for xhigh, an info mark on Max', async (context) => {
  const { calls, live } = await mount(context);
  await live(CLAUDE_OPTIONS);
  await click(byLabel('Model'));
  await click(rowNamed('Effort'));
  const menus = [...document.querySelectorAll('[role="menu"]')];
  const submenu = menus.at(-1);
  assert.match(submenu.textContent, /Higher effort means more thorough responses, but takes longer and uses your limits faster\./);
  const levels = [...submenu.querySelectorAll('[role="menuitemradio"]')];
  assert.deepEqual(
    levels.map((row) => row.querySelector('.menu-label').textContent),
    ['Low', 'Medium', 'High', 'Extra', 'Max'],
    'the table’s order, the adapter’s "default" left out, xhigh named Extra',
  );
  const medium = levels[1];
  assert.match(medium.textContent, /Recommended/);
  assert.equal(medium.querySelectorAll('.menu-check svg').length, 1);
  assert.equal(levels[0].textContent.includes('Recommended'), false);
  assert.ok(levels[4].querySelector('.menu-info'), 'Max carries an info mark');
  assert.ok(levels[3].querySelector('.menu-info') === null);
  await click(levels[2]);
  const set = callsNamed(calls, 'aiSetOption').at(-1);
  assert.deepEqual([set.payload.option, set.payload.value], ['effort', 'high']);
});

test('Ultracode is a switch row when the agent offers it, flips on a click and is absent when it does not', async (context) => {
  const { calls, live } = await mount(context);
  await live(CLAUDE_OPTIONS);
  await click(byLabel('Model'));
  const toggle = rows('[role="menuitemcheckbox"]');
  assert.equal(toggle.length, 1);
  assert.match(toggle[0].textContent, /Ultracode/);
  assert.equal(toggle[0].getAttribute('aria-checked'), 'false');
  await click(toggle[0]);
  const set = callsNamed(calls, 'aiSetOption').at(-1);
  assert.deepEqual([set.payload.option, set.payload.value], ['ultracode', 'on']);
  await key(document.activeElement, { key: 'Escape' });
  await live(withoutUltracode);
  await click(byLabel('Model'));
  assert.equal(rows('[role="menuitemcheckbox"]').length, 0, 'no switch for an option the agent does not offer');
});

test('More models holds the rest, and Agent switches provider (a started chat says it opens a new one)', async (context) => {
  const { calls, live } = await mount(context);
  await live(CLAUDE_OPTIONS);
  await click(byLabel('Model'));
  await click(rowNamed('More models'));
  const more = [...document.querySelectorAll('[role="menu"]')].at(-1);
  assert.deepEqual(
    [...more.querySelectorAll('.menu-label')].map((label) => label.textContent),
    ['Sonnet 4.5'],
  );
  await click(rowNamed('Agent'));
  const agents = [...document.querySelectorAll('[role="menu"]')].at(-1);
  assert.deepEqual(
    [...agents.querySelectorAll('.menu-label')].map((label) => label.textContent),
    ['Claude', 'Codex'],
  );
  assert.equal(agents.querySelectorAll('.menu-check svg').length, 1, 'a check on the current provider');
  await click([...agents.querySelectorAll('button')].find((row) => row.textContent.startsWith('Codex')));
  assert.ok(
    callsNamed(calls, 'aiChatCreate').some((call) => call.payload.agent === 'codex'),
    'a new chat with the other provider',
  );
});

test('the account header above the box is the agent switcher: Claude and Codex with state badges, a check, and a new chat on Codex', async (context) => {
  const { calls, container } = await mount(context);
  const trigger = container.querySelector('.ai-account-switch');
  assert.ok(trigger, 'the logo and name above the box are a button');
  assert.equal(trigger.getAttribute('aria-haspopup'), 'menu');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.match(trigger.getAttribute('aria-label'), /Change agent/);
  assert.ok(trigger.querySelector('svg'), 'the agent mark');
  assert.ok(trigger.querySelector('.ai-account-name'), 'the name truncates (ellipsis in aiShell.css) instead of wrapping');
  await click(trigger);
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  const list = [...document.querySelectorAll('[role="menu"]')].at(-1);
  assert.deepEqual(
    [...list.querySelectorAll('.menu-label')].map((label) => label.textContent),
    ['Claude', 'Codex'],
  );
  assert.deepEqual(
    [...list.querySelectorAll('.menu-pill')].map((pill) => pill.textContent),
    ['Ready', 'Ready'],
    'each agent carries its state',
  );
  assert.equal(list.querySelectorAll('.menu-check svg').length, 1, 'a check on the current agent');
  assert.ok(list.querySelector('button').querySelector('.menu-check svg'), 'the check ends the Claude row');
  await click([...list.querySelectorAll('button')].find((row) => row.textContent.startsWith('Codex')));
  assert.ok(
    callsNamed(calls, 'aiChatCreate').some((call) => call.payload.agent === 'codex'),
    'a new chat with Codex',
  );
});

test('the agent badge says Ready, Sign in or Not installed from the setup state, and nothing while unknown', () => {
  const state = (setup, availability) => ({
    setups: new Map(setup === undefined ? [] : [['codex', { agent: 'codex', ...setup }]]),
    agents: availability === undefined ? [] : [{ agent: 'codex', ...availability }],
  });
  assert.equal(ai.agentBadge(state(undefined, undefined), 'codex'), undefined);
  assert.equal(ai.agentBadge(state({ step: 'missing' }), 'codex'), 'not-installed');
  assert.equal(ai.agentBadge(state({ step: 'signed-out' }), 'codex'), 'sign-in');
  assert.equal(ai.agentBadge(state({ step: 'ready', account: {} }), 'codex'), 'ready');
  assert.equal(ai.agentBadge(state(undefined, { state: 'sign-in' }), 'codex'), 'sign-in');
  assert.equal(ai.agentBadge(state(undefined, { state: 'missing-cli' }), 'codex'), 'not-installed');
  assert.equal(ai.agentBadge(state(undefined, { state: 'installing' }), 'codex'), 'installing');
  assert.equal(ai.agentBadge(state(undefined, { state: 'ready', adapterVersion: '1', running: false }), 'codex'), 'ready');
  assert.equal(ai.agentBadge(state(undefined, { state: 'failed', message: 'x' }), 'codex'), undefined);
});

test('the Mode menu: heading, the agent’s descriptions, numbers, Recommended on Auto, a check on the current mode', async (context) => {
  const { calls, live } = await mount(context);
  await live(CLAUDE_OPTIONS);
  const chip = byLabel('Mode');
  assert.equal(chip.textContent, 'Manual', 'a new chat starts in Manual');
  await click(chip);
  assert.equal(document.querySelector('.menu-heading').textContent, 'Mode');
  const modes = rows();
  assert.deepEqual(
    modes.map((row) => row.querySelector('.menu-label').textContent),
    ['Auto', 'Manual', 'Accept edits', 'Plan', 'Bypass permissions'],
  );
  assert.deepEqual(
    modes.map((row) => row.querySelector('.menu-key').textContent),
    ['1', '2', '3', '4', '5'],
  );
  assert.match(modes[0].textContent, /Recommended/);
  assert.match(modes[0].textContent, /Claude handles permission decisions/);
  assert.match(modes[1].textContent, /Always ask before making changes/);
  assert.match(modes[4].textContent, /Accepts all permissions/);
  assert.equal(modes[1].querySelectorAll('.menu-check svg').length, 1);
  assert.equal(modes.filter((row) => row.textContent.includes('Recommended')).length, 1);
  await key(document.activeElement, { key: '3' });
  const set = callsNamed(calls, 'aiSetOption').at(-1);
  assert.deepEqual([set.payload.option, set.payload.value], ['mode', 'acceptEdits'], 'a digit chooses the mode with that number');
});

test('Bypass permissions asks through the app’s dialog, once per chat; cancelling changes nothing', async (context) => {
  const { calls, live } = await mount(context);
  await live(CLAUDE_OPTIONS);
  const dialog = () => document.querySelector('dialog[open], [role="alertdialog"], [role="dialog"]');
  const choose = async () => {
    await click(byLabel('Mode'));
    await key(document.activeElement, { key: '5' });
  };
  await choose();
  assert.ok(dialog()?.textContent.includes('Bypass permissions'), 'the custom confirm dialog opens');
  assert.equal(callsNamed(calls, 'aiSetOption').length, 0, 'nothing changed before the answer');
  await click([...document.querySelectorAll('button')].find((element) => element.textContent === 'Keep asking'));
  assert.equal(callsNamed(calls, 'aiSetOption').length, 0, 'cancelled: still Manual');
  await choose();
  await click([...document.querySelectorAll('button')].find((element) => element.textContent === 'Use Bypass permissions'));
  const set = callsNamed(calls, 'aiSetOption').at(-1);
  assert.deepEqual([set.payload.option, set.payload.value], ['mode', 'bypassPermissions']);
  await live(CLAUDE_OPTIONS.map((option) => (option.id === 'mode' ? { ...option, currentValue: 'bypassPermissions' } : option)));
  assert.ok(byLabel('Mode').classList.contains('is-danger'), 'the chip warns while everything is allowed');
  await click(byLabel('Mode'));
  await key(document.activeElement, { key: '2' });
  await live(CLAUDE_OPTIONS);
  const before = callsNamed(calls, 'aiSetOption').length;
  await choose();
  assert.equal(callsNamed(calls, 'aiSetOption').length, before + 1, 'agreed once: the same chat is not asked again');
});

test('before the chat starts, the mode is stored with the chat and never remembered for the next new chat', async (context) => {
  const { calls } = await mount(context);
  assert.equal(byLabel('Mode').textContent, 'Manual', 'a new chat shows Manual before the agent has a session');
  await click(byLabel('Mode'));
  await key(document.activeElement, { key: '3' });
  let update = callsNamed(calls, 'aiChatUpdate').at(-1);
  assert.deepEqual(update.payload.settings, [{ option: 'mode', value: 'acceptEdits' }], 'the choice is stored with the chat, to apply when its session starts');
  assert.equal(byLabel('Mode').textContent, 'Accept edits');
  await click(byLabel('Model'));
  await key(document.activeElement, { key: '1' });
  update = callsNamed(calls, 'aiChatUpdate').at(-1);
  assert.deepEqual(
    update.payload.settings,
    [
      { option: 'model', value: 'opus' },
      { option: 'mode', value: 'acceptEdits' },
    ],
    'a model chosen later keeps the mode',
  );
  const remembered = JSON.parse(window.localStorage.getItem('stacki.ai.settings.claude') ?? '{}');
  assert.deepEqual(Object.keys(remembered), ['model'], 'the model is remembered for the next chat, the mode is not');
});

test('Codex: its own four modes, a Full access confirmation, no Compact', async (context) => {
  const { calls, live } = await mount(context, { agent: 'codex', options: CODEX_OPTIONS });
  await live(CODEX_OPTIONS);
  assert.equal(byLabel('Mode').textContent, 'Read-only');
  await click(byLabel('Mode'));
  assert.deepEqual(
    rows().map((row) => row.querySelector('.menu-label').textContent),
    ['Read-only', 'Workspace access', 'Auto review', 'Full access'],
  );
  assert.equal(rows().filter((row) => row.textContent.includes('Recommended')).length, 0, 'no mode is recommended for Codex');
  await key(document.activeElement, { key: '4' });
  assert.ok(document.body.textContent.includes('Use Full access?'), 'full access asks first');
  assert.equal(callsNamed(calls, 'aiSetOption').length, 0);
  await click([...document.querySelectorAll('button')].find((element) => element.textContent === 'Keep asking'));
});

test('the context ring: neutral, amber from 70%, red from 90%; the panel says N tokens of M', async (context) => {
  const { listeners, live } = await mount(context);
  await live(CLAUDE_OPTIONS);
  const ring = () => document.querySelector('.ai-ring .progress-ring');
  assert.equal(ring().getAttribute('data-tone'), 'neutral', 'unknown before the first report');
  const usage = (used) => push(listeners, [{ kind: 'usage', used, size: 1000 }]);
  await usage(690);
  assert.equal(ring().getAttribute('data-tone'), 'neutral');
  await usage(700);
  assert.equal(ring().getAttribute('data-tone'), 'amber');
  await usage(899);
  assert.equal(ring().getAttribute('data-tone'), 'amber');
  await usage(900);
  assert.equal(ring().getAttribute('data-tone'), 'red');
  await usage(41250);
  await push(listeners, [{ kind: 'usage', used: 41250, size: 1000000 }]);
  assert.equal(ring().getAttribute('data-tone'), 'neutral');
  await click(document.querySelector('.ai-ring'));
  assert.match(document.querySelector('.ai-ring-panel').textContent, /41,250 tokens of 1,000,000 · 4%/);
  assert.equal(ai.contextSentence(undefined), 'The agent has not reported its context window yet.');
});

test('Compact: offered to Claude when idle, calls compact, waits while a turn runs', async (context) => {
  const { calls, listeners, live } = await mount(context);
  await live(CLAUDE_OPTIONS);
  await push(listeners, [{ kind: 'usage', used: 800, size: 1000 }]);
  await click(document.querySelector('.ai-ring'));
  const compact = () => document.querySelector('.ai-ring-compact');
  assert.ok(compact(), 'Claude can compact');
  assert.equal(compact().disabled, false);
  await running(listeners);
  assert.equal(compact().disabled, true, 'disabled while a turn runs');
  await idle(listeners);
  await click(compact());
  assert.equal(callsNamed(calls, 'aiCompact').length, 1);
  assert.equal(callsNamed(calls, 'aiCompact')[0].payload.chat, CHAT);
});

test('Compact is not offered to an agent that cannot compact, though the ring still shows usage', async (context) => {
  const { listeners, live } = await mount(context, { agent: 'codex', options: CODEX_OPTIONS });
  await live(CODEX_OPTIONS);
  await push(listeners, [{ kind: 'usage', used: 500, size: 1000 }]);
  await click(document.querySelector('.ai-ring'));
  assert.match(document.querySelector('.ai-ring-panel').textContent, /500 tokens of 1,000 · 50%/);
  assert.ok(document.querySelector('.ai-ring-compact') === null);
});

test('the plus menu offers images and commands; choosing commands puts a slash in an empty box', async (context) => {
  const { container } = await mount(context);
  await click(byLabel('Add to message'));
  assert.ok(rowNamed('Add image'));
  await click(rowNamed('Commands and skills'));
  assert.equal(inputText(), '/');
  await click(byLabel('Add to message'));
  assert.equal(rowNamed('Commands and skills').disabled, true, 'a command can only start an empty box');
});
