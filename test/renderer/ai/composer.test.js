// Goal: the composer does what it draws. The box is slim and sends with Enter; while a turn runs Enter
// steers, Cmd+Enter queues (the queue shows above the box with Send now and remove, and sends when the turn
// ends), Stop and Escape cancel; the status line's model chip opens the model menu (numbers choose a model,
// "Effort" opens its rows with a check and a Recommended pill, Ultracode is a switch only when the agent
// offers it); the mode chip opens the Mode menu (descriptions, numbers, Recommended on Auto) and choosing
// Bypass permissions asks once per chat through the app's dialog; the context ring is neutral, amber and red
// at 70% and 90%, and its panel says "N tokens of M" and offers Compact only to agents that can, never while
// a turn runs. No native select is drawn anywhere in the composer. Voice input: a tap latches hands-free and a hold is push
// to talk; the waveform and the phrase being spoken show at once; finished phrases are cleaned, written with the project's
// names, and understood as commands (send, new line, scratch that); a refused microphone says so and opens nothing.
// On-device dictation (Whisper) with a fake engine host and a fake microphone: without the model, a press downloads it
// with no dialog, shows the bytes as a ring on the button, and listens by itself when it is ready; a second press cancels;
// a failed download says why and offers Retry; an installed model listens, and a phrase followed by a pause lands cleaned
// in the box; a computer too slow for the standard model is offered the small one; a runtime that cannot run says so.
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
const { waitFor, waitForSteady } = require('../../helpers/waitFor.js');

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
      "export { ENGLISH_TRANSLATE } from './shared/properties/i18n/englishTranslator';",
      "export { formattersFor } from './shared/core/i18n/format';",
      "export { agentBadge } from './src/features/ai/agentSwitch';",
      "export { VoiceEnvironmentContext } from './src/features/ai/voice/voiceEnvironment';",
      "export { createDictationStore } from './src/features/ai/voice/dictationStore';",
      "export { createWhisperRecognition } from './src/features/ai/voice/whisperEngine';",
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

const GRANTED = { status: 'granted', appName: 'Stacki', settingsAvailable: true };
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

function fakeMain({ agent = 'claude', options = CLAUDE_OPTIONS, remembered = { claude: [], codex: [] }, microphone = GRANTED } = {}) {
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
      remembered,
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
    aiAutoCompactGet: record('aiAutoCompactGet', { percent: undefined }),
    aiAutoCompactSet: record('aiAutoCompactSet', (payload) => ({ percent: payload.percent })),
    aiCancel: record('aiCancel', { ok: true }),
    aiSetOption: record('aiSetOption', { ok: true, value: { set: true } }),
    aiChatUpdate: record('aiChatUpdate', { ok: true, value: summary }),
    aiRemember: record('aiRemember', () => ({ ok: true, value: { claude: [], codex: [] } })),
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
    // The system's answer for the microphone, and the project's files for the dictionary.
    microphoneRequest: record('microphoneRequest', () => microphone),
    microphoneStatus: record('microphoneStatus', () => microphone),
    microphoneOpenSettings: record('microphoneOpenSettings', { ok: true }),
    aiMentions: record('aiMentions', () => ({ ok: true, value: [{ kind: 'file', path: 'src/components/HeroSection.astro', name: 'HeroSection.astro' }] })),
    // The panel reads the review preference and the project's agent definitions when it opens, and listens
    // for definition files changing; a project with no agents and the default preferences.
    settings: record('settings', () => ({
      sound: false,
      usageCountsEnabled: true,
      appsPersonHidden: false,
      aiAskBeforeTrust: false,
      aiTrackChanges: true,
      aiReviewChanges: false,
      codeChips: true,
    })),
    listAgents: record('listAgents', () => ({ agents: [], paired: [], truncated: false })),
    onInstructionsChanged: () => () => undefined,
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
  // Dictation's notices are toasts: the test is the toast owner and keeps what was shown.
  toasts.length = 0;
  context.after(
    ai.subscribeErrorToasts(
      (notice) => toasts.push(notice),
      () => undefined,
    ),
  );
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
        React.createElement(
          ai.VoiceEnvironmentContext.Provider,
          // Tests never open a real microphone or recognizer: the fake environment is the only one the composer sees.
          { value: over?.voice ?? fakeVoice().environment },
          React.createElement(ai.AiPanel, {
            projectPath: PROJECT,
            onOpenTerminal: () => undefined,
            onMerge: () => undefined,
            onOpenExternal: () => undefined,
            renderFrame: (header, body) => React.createElement('div', undefined, header, body),
          }),
        ),
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
// The microphone's tip is the app's own, drawn after a rest on the button: rest, read it, leave.
const tipOf = async (element) => {
  element.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, cancelable: true, relatedTarget: document.body }));
  // The tip appears after its rest; poll for it instead of guessing how long that takes.
  const text = await waitFor({
    what: 'the tooltip',
    read: async () => {
      await act(async () => undefined);
      return [...document.querySelectorAll('[role="tooltip"]')].at(-1)?.textContent;
    },
    until: (value) => value !== undefined && value !== '',
  });
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true, cancelable: true, relatedTarget: document.body }));
  });
  return text;
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
  assert.deepEqual(labels, ['Opus 5.5', 'Fable 5.2', 'Sonnet 5.5', 'Haiku 5.5', 'Effort', 'Ultracode', 'More models', 'Agent', 'Reset to defaults']);
  // A row's digit is told in a tooltip and to screen readers, never printed in the row.
  assert.equal(rowNamed('Opus 5.5').getAttribute('aria-keyshortcuts'), '1');
  assert.equal(rowNamed('Haiku 5.5').getAttribute('aria-keyshortcuts'), '4');
  assert.equal(rowNamed('Opus 5.5').querySelector('.menu-key') === null, true);
  assert.doesNotMatch(rowNamed('Opus 5.5').textContent, /1$/);
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

test('the footer ⋯ is the agent switcher and account menu: Claude and Codex with state badges, a check, then the account; a new chat on Codex', async (context) => {
  const { calls, container } = await mount(context);
  assert.equal(container.querySelector('.ai-account-switch') ?? undefined, undefined, 'no account row above the box any more');
  const trigger = container.querySelector('.ai-status-line button[aria-label="Account options"]');
  assert.ok(trigger, 'a ⋯ at the end of the line under the box');
  assert.equal(trigger.getAttribute('aria-haspopup'), 'menu');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.match(trigger.getAttribute('title'), /^Claude/, 'the tooltip names the active agent');
  await click(trigger);
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  const list = [...document.querySelectorAll('[role="menu"]')].at(-1);
  assert.deepEqual([...list.querySelectorAll('.menu-label')].map((label) => label.textContent).slice(0, 2), ['Claude', 'Codex']);
  assert.ok(
    [...list.querySelectorAll('.menu-label')].some((label) => label.textContent === 'Sign out'),
    'the account section follows',
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

test('the Mode menu: heading, numbers, Recommended on Auto, a check on the current mode', async (context) => {
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
    modes.map((row) => row.getAttribute('aria-keyshortcuts')),
    ['1', '2', '3', '4', '5'],
  );
  assert.match(modes[0].textContent, /Recommended/);
  assert.equal(document.querySelectorAll('[role="menu"] .menu-description').length, 0, 'the agent’s descriptions are tooltips, never paragraphs');
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

const chipText = (label) => byLabel(label).textContent;
const REMEMBERED_CLAUDE = {
  claude: [
    { option: 'mode', value: 'plan' },
    { option: 'model', value: 'opus' },
    { option: 'effort', value: 'high' },
  ],
  codex: [],
};

test('first run: nothing remembered, so a new chat shows the agent’s own mode and model', async (context) => {
  const { calls } = await mount(context);
  assert.equal(chipText('Mode'), 'Manual', 'the agent’s default, not a forced one');
  assert.match(chipText('Model'), /Sonnet 5\.5/);
  assert.equal(callsNamed(calls, 'aiChatCreate')[0].payload.settings, undefined, 'a new chat is created without settings');
});

test('the first frame shows the remembered mode, model and effort: no default that swaps later', async (context) => {
  const { calls } = await mount(context, { remembered: REMEMBERED_CLAUDE });
  assert.equal(callsNamed(calls, 'aiAgents').length, 1, 'one read carries the options and the remembered settings');
  assert.equal(chipText('Mode'), 'Plan', 'not Manual');
  assert.match(chipText('Model'), /Opus 5\.5/);
  assert.match(chipText('Model'), /High/);
  assert.equal(byLabel('Mode').classList.contains('is-danger'), false);
});

test('Bypass permissions remembered: the red chip is there at once and the first message is not blocked', async (context) => {
  const { calls } = await mount(context, { remembered: { claude: [{ option: 'mode', value: 'bypassPermissions' }], codex: [] } });
  assert.equal(chipText('Mode'), 'Bypass permissions');
  assert.ok(byLabel('Mode').classList.contains('is-danger'), 'warns in the very first frame, before any session');
  const box = await setText('Hello');
  await key(box, { key: 'Enter' });
  assert.equal(callsNamed(calls, 'aiPrompt').length, 1, 'the message went out');
  assert.equal(document.querySelector('dialog[open], [role="alertdialog"]') ?? undefined, undefined, 'no confirmation stands in the way');
});

test('a remembered value the agent no longer offers is dropped without a word', async (context) => {
  await mount(context, {
    remembered: {
      claude: [
        { option: 'mode', value: 'retired-mode' },
        { option: 'model', value: 'retired-model' },
        { option: 'effort', value: 'max' },
        { option: 'removed-option', value: 'x' },
      ],
      codex: [],
    },
  });
  assert.equal(chipText('Mode'), 'Manual', 'the unknown mode falls back to the agent’s own');
  assert.match(chipText('Model'), /Sonnet 5\.5/);
  assert.match(chipText('Model'), /Max/, 'the valid part still applies');
});

test('per agent: what Claude remembers does not show on Codex, and Codex keeps its own', async (context) => {
  const claudeOnly = { claude: [{ option: 'mode', value: 'plan' }], codex: [] };
  await mount(context, { agent: 'codex', options: CODEX_OPTIONS, remembered: claudeOnly });
  assert.equal(chipText('Mode'), 'Read-only', 'Claude’s plan mode does not leak');
  await mount(context, { agent: 'codex', options: CODEX_OPTIONS, remembered: { claude: [], codex: [{ option: 'mode', value: 'agent-full-access' }] } });
  assert.equal(chipText('Mode'), 'Full access');
  assert.ok(byLabel('Mode').classList.contains('is-danger'), 'Codex’s unrestricted mode shows red at once too');
});

test('before the chat starts, a pick is remembered (mode included), shown at once and never stored on the chat', async (context) => {
  const { calls } = await mount(context);
  await click(byLabel('Mode'));
  await key(document.activeElement, { key: '3' });
  let remember = callsNamed(calls, 'aiRemember').at(-1);
  assert.deepEqual(remember.payload.action, { kind: 'set', option: 'mode', value: 'acceptEdits' });
  assert.equal(remember.payload.agent, 'claude');
  assert.equal(chipText('Mode'), 'Accept edits');
  await click(byLabel('Model'));
  await key(document.activeElement, { key: '1' });
  remember = callsNamed(calls, 'aiRemember').at(-1);
  assert.deepEqual(remember.payload.action, { kind: 'set', option: 'model', value: 'opus' });
  assert.equal(callsNamed(calls, 'aiChatUpdate').length, 0, 'main applies the remembered set itself; nothing is stored per chat');
  assert.deepEqual(ai.aiState().remembered.claude, [
    { option: 'mode', value: 'acceptEdits' },
    { option: 'model', value: 'opus' },
  ]);
  assert.equal(callsNamed(calls, 'aiSetOption').length, 0, 'no session yet, so nothing was sent to an agent');
});

test('a change in a live chat updates what the next chat starts with', async (context) => {
  const { calls, live } = await mount(context);
  await live(CLAUDE_OPTIONS);
  await click(byLabel('Mode'));
  await key(document.activeElement, { key: '3' });
  assert.equal(callsNamed(calls, 'aiSetOption').at(-1).payload.value, 'acceptEdits');
  assert.deepEqual(ai.aiState().remembered.claude, [{ option: 'mode', value: 'acceptEdits' }], 'the mode counts, in any chat');
});

test('Reset to defaults is the last row of the model menu and forgets the remembered set', async (context) => {
  const { calls } = await mount(context, { remembered: REMEMBERED_CLAUDE });
  await click(byLabel('Model'));
  const all = rows();
  assert.equal(all.at(-1).querySelector('.menu-label').textContent, 'Reset to defaults', 'at the bottom');
  await click(all.at(-1));
  assert.deepEqual(callsNamed(calls, 'aiRemember').at(-1).payload.action, { kind: 'reset' });
  assert.equal(chipText('Mode'), 'Manual');
  assert.match(chipText('Model'), /Sonnet 5\.5/);
  await click(byLabel('Model'));
  assert.equal(rows().at(-1).disabled, true, 'nothing left to reset');
});

test('a damaged remembered reply does not stop the panel: the agent’s defaults show', async (context) => {
  await mount(context, { remembered: 'garbage' });
  assert.equal(chipText('Mode'), 'Manual');
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
  const panel = document.querySelector('.ai-ring-panel');
  assert.equal(panel.querySelector('.ai-ring-percent').textContent, '4%', 'the percentage is the big number');
  assert.match(panel.querySelector('.ai-ring-tokens').textContent, /of 1M tokens/, 'the muted line gives the tokens, compact');
  assert.equal(panel.querySelector('.ai-ring-bar').getAttribute('data-tone'), 'blue');
  assert.ok(panel.querySelector('.ai-ring-fill'), 'a bar with a fill');
  assert.ok(panel.querySelector('.ai-ring-auto button'), 'Claude offers the Auto-compact at picker');
  assert.equal(panel.querySelector('.ai-ring-compact').textContent, 'Compact');
  assert.equal(panel.querySelector('.ai-ring-auto button').textContent, 'Auto: default', 'one short line, never wrapping; the long words are its tooltip');
  assert.equal(panel.querySelector('.ai-ring-auto').textContent.includes('Auto-compact at'), false);
  assert.equal(ai.contextSentence(undefined, ai.ENGLISH_TRANSLATE, ai.formattersFor('en').formatNumber), 'The agent has not reported its context window yet.');
});

test('before the agent reports a window the panel is one clean card: title, an empty track, and a one-line caption', async (context) => {
  await mount(context);
  await click(document.querySelector('.ai-ring'));
  const panel = document.querySelector('.ai-ring-panel');
  assert.equal(panel.querySelector('.ai-ring-title').textContent, 'Context');
  assert.equal(panel.querySelector('.ai-ring-percent') ?? undefined, undefined, 'no percentage yet');
  assert.ok(panel.querySelector('.ai-ring-bar'), 'the track is there');
  assert.equal(panel.querySelector('.ai-ring-fill') ?? undefined, undefined, 'nothing filled');
  assert.equal(panel.querySelector('.ai-ring-tokens').textContent, 'Context fills as you chat');
  assert.equal(panel.querySelector('.ai-ring-empty') ?? undefined, undefined, 'no icon block or sentence of its own');
  assert.equal(panel.querySelector('.ai-ring-actions').children.length, 2, 'Compact and the picker share one row');
});

test('the context panel opens on click only: hover shows a tip, a second click closes, Escape closes and the ring gets focus back', async (context) => {
  const { listeners } = await mount(context);
  await push(listeners, [{ kind: 'usage', used: 420, size: 1000 }]);
  const ring = document.querySelector('.ai-ring');
  assert.equal(await tipOf(ring), 'Context 42% used', 'hover only tells the percentage');
  assert.equal(document.querySelector('.ai-ring-panel') ?? undefined, undefined, 'hover opens nothing');
  await click(ring);
  assert.ok(document.querySelector('.ai-ring-panel'), 'a click opens it');
  assert.equal(ring.getAttribute('aria-expanded'), 'true');
  assert.ok(document.querySelector('.ai-ring-panel').contains(document.activeElement), 'focus moved into the panel');
  await click(ring);
  assert.equal(document.querySelector('.ai-ring-panel') ?? undefined, undefined, 'a second click on the ring closes it');
  await click(ring);
  await key(document.activeElement, { key: 'Escape' });
  await settle();
  assert.equal(document.querySelector('.ai-ring-panel') ?? undefined, undefined, 'Escape closes it');
  assert.equal(document.activeElement, ring, 'the ring has the keyboard again');
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
  assert.equal(document.querySelector('.ai-ring-percent').textContent, '50%');
  assert.ok(document.querySelector('.ai-ring-compact') === null);
  assert.ok(document.querySelector('.ai-ring-auto') === null, 'Codex cannot take the setting, so the row is hidden');
});

test('the plus menu offers images and commands; choosing commands puts a slash in an empty box', async (context) => {
  const { container } = await mount(context);
  await click(byLabel('Add to message'));
  assert.ok(rowNamed('Add image'));
  await click(rowNamed('Commands and skills'));
  assert.equal(inputText(), '/');
  await click(byLabel('Add to message'));
  assert.equal(rowNamed('Commands and skills'), undefined, 'a command can only start an empty box, so the row is hidden otherwise');
  assert.equal(document.querySelector('[role="menu"] .menu-note') ?? undefined, undefined, 'no paragraph in the menu');
});

// ---------------------------------------------------------------------------------------------------------------
// Voice input. The recognizer, the audio meter and the clock are fakes; no test opens a microphone.

function fakeVoice() {
  const state = { recognizers: [], meters: [], nowMs: 1000 };
  const environment = {
    isSupported: () => true,
    detectEngine: async () => ({ kind: 'online' }),
    createRecognition: () => {
      const recognizer = {
        continuous: false,
        interimResults: false,
        lang: '',
        started: 0,
        stopped: 0,
        onresult: () => undefined,
        onerror: () => undefined,
        onend: () => undefined,
        start() {
          this.started += 1;
        },
        stop() {
          this.stopped += 1;
        },
        abort() {},
      };
      state.recognizers.push(recognizer);
      return recognizer;
    },
    audioLevels: {
      start: async (barCount, onBars) => {
        const meter = { barCount, onBars, stopped: false };
        state.meters.push(meter);
        return { ok: true, value: () => (meter.stopped = true) };
      },
    },
    nowMs: () => state.nowMs,
  };
  return { environment, state, current: () => state.recognizers.at(-1) };
}

const pointer = async (type) => {
  await act(async () => {
    (byLabelStartingWith('Dictate', 'Stop dictation') ?? micButton()).dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true }));
  });
  await settle();
};
const byLabelStartingWith = (...labels) => labels.map(byLabel).find(Boolean);
const speak = async (recognizer, results, resultIndex = 0) => {
  await act(async () => {
    recognizer.onresult({ resultIndex, results: results.map(([transcript, isFinal]) => ({ isFinal, 0: { transcript } })) });
  });
  await settle();
};
const voiceText = () => document.querySelector('.ai-voice-text')?.textContent;
const draftText = () => document.querySelector('.ai-dictation-draft')?.textContent;
const toasts = [];
const lastToast = () => toasts.at(-1)?.message ?? '';
const runToast = async (label) => {
  const action = toasts.at(-1)?.recovery?.find((recovery) => recovery.label === label);
  assert.ok(action, `the toast offers ${label}`);
  await act(async () => action.run());
  await settle();
};

test('a tap latches hands-free: the line and waveform show at once, spoken phrases are cleaned and land in the box', async (context) => {
  const voice = fakeVoice();
  await mount(context, { voice: voice.environment });
  await pointer('pointerdown');
  await pointer('pointerup');
  assert.ok(document.querySelector('.ai-voice-line'), 'the voice line is there');
  assert.equal(document.querySelectorAll('.ai-wave-bar').length, 28);
  assert.equal(voice.current().continuous, true, 'hands-free keeps listening across pauses');
  assert.equal(voice.current().interimResults, true);
  assert.equal(voice.current().lang, 'en-US', 'the recognizer listens for the interface language');
  assert.match(voiceText(), /Say “send”/, 'the hint names the commands');
  await speak(voice.current(), [['um hello there', false]]);
  assert.equal(draftText(), 'Hello there', 'the phrase being spoken shows cleaned, as a draft in the box');
  assert.equal(inputText(), '', 'the draft is not text');
  await speak(voice.current(), [['um fix the the header comma please', true]]);
  assert.equal(inputText(), 'Fix the header, please');
  await speak(
    voice.current(),
    [
      ['Fix the header comma please', true],
      ['new line. Add a test', true],
    ],
    1,
  );
  assert.equal(inputText(), 'Fix the header, please\n\nAdd a test');
  assert.equal(voice.state.meters.length, 1, 'one meter for the session');
  voice.state.meters[0].onBars(Array.from({ length: 28 }, () => 0.5));
  await settle();
  assert.equal(document.querySelector('.ai-wave-bar').style.transform, 'scaleY(0.5)', 'the waveform follows the meter');
  await pointer('pointerdown');
  assert.equal(voice.current().stopped, 1, 'the next press ends a hands-free session');
  await act(async () => voice.current().onend());
  await settle();
  assert.ok(document.querySelector('.ai-voice-line') === null, 'the line goes with the session');
  assert.equal(voice.state.meters[0].stopped, true, 'the meter closes with the session');
});

test('holding the button is push to talk: letting go stops, and the last phrase still lands', async (context) => {
  const voice = fakeVoice();
  await mount(context, { voice: voice.environment });
  await pointer('pointerdown');
  assert.ok(document.querySelector('.ai-voice-line'), 'instant: the line is there on the press');
  voice.state.nowMs += 800;
  await pointer('pointerup');
  assert.equal(voice.current().stopped, 1);
  await speak(voice.current(), [['ship it today', true]]);
  assert.equal(inputText(), 'Ship it today');
  await act(async () => voice.current().onend());
  await settle();
  assert.ok(document.querySelector('.ai-voice-line') === null);
  assert.equal(voice.state.recognizers.length, 1, 'a stopped session does not restart');
});

test('the recognizer ending by itself in a hands-free session listens again', async (context) => {
  const voice = fakeVoice();
  await mount(context, { voice: voice.environment });
  await pointer('pointerdown');
  await pointer('pointerup');
  await act(async () => voice.current().onend());
  await settle();
  assert.equal(voice.state.recognizers.length, 2, 'a second recognizer took over');
  assert.equal(voice.current().started, 1);
  assert.ok(document.querySelector('.ai-voice-line'), 'still listening');
});

test('"send" alone sends the box by voice and ends the session; the same word in a sentence is text', async (context) => {
  const voice = fakeVoice();
  const { calls } = await mount(context, { voice: voice.environment });
  await pointer('pointerdown');
  await pointer('pointerup');
  await speak(voice.current(), [['please send it to the server', true]]);
  assert.equal(inputText(), 'Please send it to the server');
  assert.equal(callsNamed(calls, 'aiPrompt').length, 0, 'a sentence with send in it sends nothing');
  await speak(
    voice.current(),
    [
      ['please send it to the server', true],
      ['send', true],
    ],
    1,
  );
  assert.equal(callsNamed(calls, 'aiPrompt').length, 1);
  assert.equal(callsNamed(calls, 'aiPrompt')[0].payload.text, 'Please send it to the server');
  assert.equal(voice.current().stopped, 1, 'sending ends the session');
});

test('"scratch that" takes back the last dictated piece and never what was typed', async (context) => {
  const voice = fakeVoice();
  await mount(context, { voice: voice.environment });
  await setText('Typed by hand.');
  await pointer('pointerdown');
  await pointer('pointerup');
  await speak(voice.current(), [['and this too', true]]);
  assert.equal(inputText(), 'Typed by hand. And this too');
  await speak(
    voice.current(),
    [
      ['and this too', true],
      ['scratch that', true],
    ],
    1,
  );
  assert.equal(inputText(), 'Typed by hand.');
  await speak(
    voice.current(),
    [
      ['and this too', true],
      ['scratch that', true],
      ['scratch that', true],
    ],
    2,
  );
  assert.equal(inputText(), 'Typed by hand.', 'nothing dictated is left to take back, so typing stays');
});

test("the dictionary writes the project's file names the way the project spells them", async (context) => {
  const voice = fakeVoice();
  await mount(context, { voice: voice.environment });
  await pointer('pointerdown');
  await pointer('pointerup');
  await settle();
  await speak(voice.current(), [['open the hero section dot astro file', true]]);
  assert.equal(inputText(), 'Open the HeroSection.astro file');
});

test('a microphone the system keeps off opens nothing and says what to switch on', async (context) => {
  const voice = fakeVoice();
  const { calls } = await mount(context, { voice: voice.environment, microphone: { status: 'denied', appName: 'Stacki', settingsAvailable: true } });
  await pointer('pointerdown');
  await pointer('pointerup');
  assert.equal(voice.state.recognizers.length, 0, 'no recognizer, no meter');
  assert.equal(voice.state.meters.length, 0);
  assert.match(lastToast(), /Microphone access is off/);
  assert.ok(document.querySelector('.ai-voice-line') === null);
  await runToast('Open System Settings');
  assert.equal(callsNamed(calls, 'microphoneOpenSettings').length, 1);
});

test('a network error while online says the build has no speech service, and the button then says so', async (context) => {
  const voice = fakeVoice();
  await mount(context, { voice: voice.environment });
  await pointer('pointerdown');
  await pointer('pointerup');
  await act(async () => voice.current().onerror({ error: 'network' }));
  await settle();
  const text = lastToast();
  assert.match(text, /isn’t available in this build of Stacki/);
  assert.doesNotMatch(text, /connection/, 'the connection is fine; never blame it');
  assert.equal(voice.current().stopped, 1);
  assert.equal(await tipOf(byLabel('Dictate')), 'Dictation isn’t available in this build');
  const opened = voice.state.recognizers.length;
  await pointer('pointerdown');
  await pointer('pointerup');
  assert.equal(voice.state.recognizers.length, opened, 'a second press opens nothing that would fail the same way');
});

test('a network error while offline asks to reconnect', async (context) => {
  const voice = fakeVoice();
  await mount(context, { voice: voice.environment });
  // An own property shadows jsdom's getter for this test only.
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => false });
  context.after(() => delete window.navigator.onLine);
  await pointer('pointerdown');
  await pointer('pointerup');
  await act(async () => voice.current().onerror({ error: 'network' }));
  await settle();
  assert.match(lastToast(), /this computer is offline/);
});

test('no microphone and an interruption each name their own cause', async (context) => {
  const voice = fakeVoice();
  await mount(context, { voice: voice.environment });
  await pointer('pointerdown');
  await pointer('pointerup');
  await act(async () => voice.current().onerror({ error: 'audio-capture' }));
  await settle();
  assert.match(lastToast(), /No microphone was found/);
  await act(async () => voice.current().onend());
  await pointer('pointerdown');
  await pointer('pointerup');
  await act(async () => voice.current().onerror({ error: 'aborted' }));
  await settle();
  assert.match(lastToast(), /was interrupted/);
});

test('an Electron build without an on-device model explains itself before any microphone opens', async (context) => {
  const voice = fakeVoice();
  await mount(context, { voice: { ...voice.environment, detectEngine: async () => ({ kind: 'none', reason: 'serviceMissing' }) } });
  await settle();
  assert.equal(await tipOf(byLabel('Dictate')), 'Dictation isn’t available in this build');
  await pointer('pointerdown');
  assert.equal(voice.state.recognizers.length, 0);
  assert.match(lastToast(), /isn’t available in this build of Stacki/);
});

test('an installed on-device model is used', async (context) => {
  const voice = fakeVoice();
  await mount(context, { voice: { ...voice.environment, detectEngine: async () => ({ kind: 'onDevice' }) } });
  await settle();
  await pointer('pointerdown');
  await pointer('pointerup');
  await settle();
  assert.equal(voice.current().processLocally, true);
});

test('the microphone has a custom tooltip of one short line, no native title and no privacy paragraph', async (context) => {
  const voice = fakeVoice();
  await mount(context, { voice: voice.environment });
  assert.equal(byLabel('Dictate').getAttribute('title') ?? undefined, undefined, 'no native tooltip');
  assert.equal(await tipOf(byLabel('Dictate')), 'Click to dictate or hold to talk');
});

test('a platform with no recognizer says voice input is unavailable', async (context) => {
  const none = { ...fakeVoice().environment, isSupported: () => false, createRecognition: () => undefined };
  await mount(context, { voice: none });
  assert.equal(await tipOf(byLabel('Dictate')), 'Voice input is not available');
  await pointer('pointerdown');
  assert.match(lastToast(), /not available here/);
});

// ---------------------------------------------------------------------------------------------------------------
// On-device dictation. The Whisper host, the model channels and the microphone are fakes; no worker, model or audio.

const BASE_TOTAL = 568_491_146; // The Best tier's download, the default model.

function fakeWhisper({
  install = { kind: 'installed', sizeBytes: BASE_TOTAL },
  transcripts = [],
  decodeMs = 500,
  load = { ok: true, value: undefined },
  outcomes = [],
  holdDecodes = false,
  // The last transcript answers every later decode, as a phrase decoded again reads the same.
  sticky = false,
} = {}) {
  // The store reads the chosen model when it is made, before mount clears storage: a test's choice must not leak into the next.
  window.localStorage.clear();
  const calls = { downloads: [], transcribes: [], loads: 0, cancels: 0, overlapping: 0 };
  let running = 0;
  const held = [];
  let finishDownload;
  let progressListener;
  let status = {
    directory: '/data/Stacki/models/whisper',
    models: [
      { id: 'turbo', install },
      { id: 'small', install: { kind: 'notInstalled' } },
      { id: 'base', install: { kind: 'notInstalled' } },
    ],
  };
  const store = ai.createDictationStore({
    status: async () => status,
    // Each download waits for the test to finish it (`finish`), with the next of `outcomes` or an install.
    download: (id) => {
      calls.downloads.push(id);
      setTimeout(() => progressListener?.({ id, receivedBytes: Math.floor(BASE_TOTAL / 2), totalBytes: BASE_TOTAL }), 0);
      return new Promise((resolve) => {
        finishDownload = (outcome) => {
          if (outcome.kind === 'installed') {
            status = {
              ...status,
              models: status.models.map((model) => (model.id === id ? { id, install: { kind: 'installed', sizeBytes: BASE_TOTAL } } : model)),
            };
          }
          resolve(outcome);
        };
      });
    },
    cancel: async () => {
      calls.cancels += 1;
      finishDownload?.({ kind: 'failed', failure: 'cancelled' });
    },
    remove: async () => undefined,
    onProgress: (listener) => {
      progressListener = listener;
      return () => undefined;
    },
  });
  let warm = false;
  let microphone;
  const host = {
    isWarm: () => warm,
    load: async () => {
      calls.loads += 1;
      warm = load.ok;
      return load;
    },
    transcribe: async (audio, language) => {
      running += 1;
      calls.overlapping = Math.max(calls.overlapping, running);
      calls.transcribes.push({ samples: audio.length, language });
      // A held decode waits for the test to release it; the others answer on the next task.
      if (holdDecodes) {
        await new Promise((resolve) => held.push(resolve));
      } else {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      running -= 1;
      const text = sticky && transcripts.length === 1 ? transcripts[0] : (transcripts.shift() ?? '');
      return { ok: true, value: { text, language: 'en', decodeMs } };
    },
    release: () => undefined,
  };
  const whisper = {
    store,
    createRecognition: () =>
      ai.createWhisperRecognition({
        host,
        store,
        listen: async (listener) => {
          microphone = listener;
          return { ok: true, value: () => (microphone = undefined) };
        },
        nowMs: () => Date.now(),
      }),
    audioLevels: { start: async () => ({ ok: true, value: () => undefined }) },
  };
  const voice = fakeVoice();
  return {
    environment: { ...voice.environment, detectEngine: async () => ({ kind: 'whisper' }), whisper },
    calls,
    microphoneOpen: () => microphone !== undefined,
    finish: async () => {
      await act(async () => finishDownload?.(outcomes.shift() ?? { kind: 'installed', sizeBytes: BASE_TOTAL }));
      await until('the download outcome reached the engine', () => store.snapshot().engine.kind !== 'downloading');
    },
    /** Releases every held decode. */
    releaseDecodes: async () => {
      await act(async () => held.splice(0).forEach((resolve) => resolve()));
      await settle();
    },
    /**
     * Speech (a 220 Hz tone) for `speechMs`, then silence for `pauseMs`, in the worklet's 100 ms chunks, then waits
     * until `done()` holds (by default: the box and the decode count stop changing). `paced` waits for a decode after
     * every second of speech, as a person still talking would see interim words.
     */
    say: async (speechMs, pauseMs, { paced = false, done } = {}) => {
      const total = Math.floor(((speechMs + pauseMs) * 16_000) / 1000);
      const speech = Math.floor((speechMs * 16_000) / 1000);
      for (let at = 0; at < total; at += 1_600) {
        const chunk = new Float32Array(1_600);
        for (let index = 0; index < chunk.length; index += 1) {
          chunk[index] = at + index < speech ? 0.2 * Math.sin((2 * Math.PI * 220 * (at + index)) / 16_000) : 0;
        }
        microphone?.(chunk, 0.1);
        if (paced && at > 0 && at % 16_000 === 0) {
          const count = calls.transcribes.length;
          await until('an interim decode while speaking', () => calls.transcribes.length > count);
        }
      }
      if (done === undefined) {
        await waitForSteady({
          what: 'the live loop went quiet',
          read: async () => {
            await act(async () => undefined);
            return [calls.transcribes.length, inputText(), draftText() ?? ''];
          },
          until: () => true,
        });
        await settle();
      } else {
        await until('the spoken words were handled', done);
      }
    },
  };
}

const tapMicrophone = async () => {
  await pointer('pointerdown');
  await pointer('pointerup');
};
const buttonNamed = (name) => [...document.querySelectorAll('button')].find((button) => button.textContent === name);
const micButton = () => document.querySelector('.ai-tool-button[aria-pressed]');
/** Waits, inside act, until `check()` holds (test/helpers/waitFor.js): never a guessed pause. */
const until = async (what, check) => {
  // Each poll flushes React in its own act, so a render the state caused is seen by the next read.
  await waitFor({
    what,
    read: async () => {
      await act(async () => undefined);
      return check();
    },
    until: Boolean,
  });
  await settle();
};

test('without the model, one press downloads it with no dialog, shows the bytes on the button, and listens when ready', async (context) => {
  const whisper = fakeWhisper({ install: { kind: 'notInstalled' } });
  await mount(context, { voice: whisper.environment });
  await settle();
  await tapMicrophone();
  await until('the download started', () => micButton().querySelector('.progress-ring') !== null);
  assert.deepEqual(whisper.calls.downloads, ['turbo'], 'the press started the Best tier download');
  assert.ok(document.querySelector('[role="dialog"]') === null, 'no dialog asks first');
  assert.equal(whisper.microphoneOpen(), false, 'nothing listens before the model is here');
  assert.ok(micButton().querySelector('.progress-ring'), 'the button draws the download as a ring');
  assert.equal(await tipOf(micButton()), 'Downloading the dictation model, 50%. Click to cancel.');
  await whisper.finish();
  await until('the same press listens', () => whisper.microphoneOpen());
  assert.equal(whisper.calls.loads, 1, 'the model loads as soon as it is downloaded');
  assert.equal(whisper.microphoneOpen(), true, 'and the same press is now listening');
  assert.ok(document.querySelector('.ai-voice-line'));
  assert.ok(micButton().querySelector('.progress-ring') === null, 'the ring gives way to the microphone');
});

test('a press during the download cancels it, and nothing listens afterwards', async (context) => {
  const whisper = fakeWhisper({ install: { kind: 'notInstalled' } });
  await mount(context, { voice: whisper.environment });
  await settle();
  await tapMicrophone();
  await until('the download started', () => whisper.calls.downloads.length === 1);
  await tapMicrophone();
  await until('the download is cancelled', () => whisper.calls.cancels === 1 && micButton().querySelector('.progress-ring') === null);
  assert.equal(whisper.calls.cancels, 1);
  assert.equal(whisper.microphoneOpen(), false);
  assert.ok(micButton().querySelector('.progress-ring') === null);
  assert.equal(toasts.length, 0, 'a cancel is the person’s choice: no notice');
});

test('a failed download says why, never blames speech, and Retry downloads again and then listens', async (context) => {
  const whisper = fakeWhisper({ install: { kind: 'notInstalled' }, outcomes: [{ kind: 'failed', failure: 'offline' }] });
  await mount(context, { voice: whisper.environment });
  await settle();
  await tapMicrophone();
  await until('the download started', () => whisper.calls.downloads.length === 1);
  await whisper.finish();
  await until('the failure toast', () => toasts.length > 0);
  assert.match(lastToast(), /Hugging Face could not be reached/);
  await runToast('Retry');
  await until('the retry started', () => whisper.calls.downloads.length === 2);
  assert.deepEqual(whisper.calls.downloads, ['turbo', 'turbo']);
  await whisper.finish();
  await until('the retried download listens', () => whisper.microphoneOpen());
  assert.equal(whisper.microphoneOpen(), true, 'the retried download ends in listening');
});

test('with the model, a phrase followed by a pause lands cleaned in the box, and the session ends cleanly', async (context) => {
  const whisper = fakeWhisper({ transcripts: [' Um, fix the the header, please.'] });
  await mount(context, { voice: whisper.environment });
  await settle();
  await tapMicrophone();
  assert.deepEqual(whisper.calls.downloads, [], 'nothing downloads when the model is there');
  assert.ok(document.querySelector('.ai-voice-line'), 'the line shows at once');
  await until('the microphone opened', () => whisper.microphoneOpen());
  assert.equal(whisper.microphoneOpen(), true);
  assert.equal(whisper.calls.loads, 1, 'the model loads on the first session');
  await whisper.say(1_200, 800);
  assert.equal(whisper.calls.transcribes.length, 1, 'the pause committed one segment');
  assert.equal(whisper.calls.transcribes[0].language, 'auto', 'auto-detect is the default');
  assert.equal(inputText(), 'Fix the header, please.');
  await tapMicrophone();
  await until('the session ended', () => !whisper.microphoneOpen() && document.querySelector('.ai-voice-line') === null);
  assert.equal(whisper.microphoneOpen(), false, 'stop closes the microphone');
  assert.ok(document.querySelector('.ai-voice-line') === null, 'the line goes with the session');
  assert.equal(toasts.length, 0, 'a normal session leaves no notice');
});

test('a computer too slow for the standard model says so and offers the small one', async (context) => {
  const whisper = fakeWhisper({ transcripts: [' Hello there.'], decodeMs: 9_000 });
  await mount(context, { voice: whisper.environment });
  await settle();
  await tapMicrophone();
  await until('the microphone opened', () => whisper.microphoneOpen());
  await whisper.say(1_200, 800);
  assert.equal(inputText(), 'Hello there.', 'the words still land');
  await tapMicrophone();
  await until('the session ended', () => !whisper.microphoneOpen() && document.querySelector('.ai-voice-line') === null);
  const notice = lastToast();
  assert.match(notice, /slower than you speak/);
  assert.doesNotMatch(notice, /connection/);
  await runToast('Use the faster model');
  await until('the small model download started', () => whisper.calls.downloads.length === 1);
  assert.deepEqual(whisper.calls.downloads, ['base'], 'the Fast tier downloads at once');
});

test('a runtime that cannot run the model names the cause, never the connection', async (context) => {
  const whisper = fakeWhisper({ load: { ok: false, error: 'backendUnavailable' } });
  await mount(context, { voice: whisper.environment });
  await settle();
  await tapMicrophone();
  await until('the failure toast', () => toasts.length > 0);
  const notice = lastToast();
  assert.match(notice, /neither WebGPU nor WebAssembly/);
  assert.equal(whisper.microphoneOpen(), false, 'the microphone closes with the failure');
});

test('a session that hears no speech writes nothing, even where Whisper would invent "Thank you."', async (context) => {
  const whisper = fakeWhisper({ transcripts: [' Thank you.', ' Thank you.'] });
  await mount(context, { voice: whisper.environment });
  await settle();
  await tapMicrophone();
  await until('the microphone opened', () => whisper.microphoneOpen());
  await whisper.say(0, 3_000);
  await tapMicrophone();
  await until('the session ended', () => !whisper.microphoneOpen() && document.querySelector('.ai-voice-line') === null);
  assert.equal(whisper.calls.transcribes.length, 0, 'silence is never decoded');
  assert.equal(inputText(), '');
});

test('while speaking, the words show as a draft that each decode replaces; only the final words become text', async (context) => {
  const whisper = fakeWhisper({ transcripts: [' Make the', ' Make the heading', ' Make the heading larger.'], sticky: true });
  await mount(context, { voice: whisper.environment });
  await settle();
  await tapMicrophone();
  await until('the microphone opened', () => whisper.microphoneOpen());
  await whisper.say(2_600, 0, { paced: true, done: () => (draftText() ?? '') !== '' });
  assert.ok(whisper.calls.transcribes.length >= 2, `interim decodes ran while speaking (${whisper.calls.transcribes.length})`);
  assert.equal(whisper.calls.overlapping, 1, 'never two decodes at once');
  assert.match(draftText() ?? '', /^Make the/, 'the draft shows the words so far');
  assert.equal(inputText(), '', 'nothing is text yet');
  assert.equal(document.querySelectorAll('.ai-dictation-draft').length, 1, 'one draft, replaced, never appended');
  await tapMicrophone();
  await until('the final words', () => inputText() !== '' && document.querySelector('.ai-dictation-draft') === null);
  assert.equal(inputText(), 'Make the heading larger.', 'stop writes the final words once');
  assert.ok(document.querySelector('.ai-dictation-draft') === null, 'the draft is gone');
});

test('a decode with no words yet takes no room: nothing is drawn in the box, the microphone pulses instead', async (context) => {
  const whisper = fakeWhisper({ transcripts: [''], holdDecodes: true, sticky: true });
  await mount(context, { voice: whisper.environment });
  await settle();
  await tapMicrophone();
  await until('the microphone opened', () => whisper.microphoneOpen());
  await whisper.say(1_200, 0, {
    done: () => (
      console.log('DBG', whisper.calls.transcribes.length, micButton().className),
      whisper.calls.transcribes.length >= 1 && micButton().classList.contains('is-decoding')
    ),
  });
  assert.ok(whisper.calls.transcribes.length >= 1, 'a decode is running');
  assert.ok(document.querySelector('.ai-dictation-draft') === null, 'no element is added to the editor while there are no words');
  assert.ok(micButton().classList.contains('is-decoding'), 'the microphone shows the work instead');
  await tapMicrophone();
  await whisper.releaseDecodes();
  await until('the session ended', () => !whisper.microphoneOpen());
  await whisper.releaseDecodes();
});

test('final words take the vocabulary and the snippets; the draft does not', async (context) => {
  const whisper = fakeWhisper({ transcripts: [' Open the lumus page and insert my signature.'] });
  whisper.environment.whisper.store.setWords({
    vocabulary: [{ word: 'Lumos' }],
    snippets: [{ trigger: 'my signature', expansion: 'Thanks, Tim' }],
  });
  await mount(context, { voice: whisper.environment });
  await settle();
  await tapMicrophone();
  await until('the microphone opened', () => whisper.microphoneOpen());
  await whisper.say(2_200, 800);
  assert.equal(inputText(), 'Open the Lumos page and Thanks, Tim');
});

test('a word fixed by hand right after dictation is offered for the vocabulary, once', async (context) => {
  const whisper = fakeWhisper({ transcripts: [' Open the carosel page.'] });
  await mount(context, { voice: whisper.environment });
  await settle();
  await tapMicrophone();
  await until('the microphone opened', () => whisper.microphoneOpen());
  await whisper.say(1_500, 800);
  assert.equal(inputText(), 'Open the carosel page.');
  await setText('Open the Carousel page.');
  assert.match(lastToast(), /Add “Carousel” to your vocabulary\?/);
  await runToast('Add to vocabulary');
  assert.deepEqual(whisper.environment.whisper.store.snapshot().words.vocabulary, [{ word: 'Carousel', misheard: 'carosel' }]);
  const shown = toasts.length;
  await setText('Open the Carousel pages.');
  assert.equal(toasts.length, shown, 'offered once');
});

test('dictation stands in the footer row instead of adding one: the footer is hidden in place, and comes back', async (context) => {
  const voice = fakeVoice();
  await mount(context, { voice: voice.environment });
  const footer = () => document.querySelector('.ai-compose-footer');
  const rows = () => document.querySelector('.ai-compose').children.length;
  const before = rows();
  assert.ok(footer().querySelector('.ai-compose-footer-status .ai-status, .ai-compose-footer-status > *'), 'the footer holds the status line');
  await pointer('pointerdown');
  await pointer('pointerup');
  assert.equal(rows(), before, 'no row is added while dictating');
  assert.ok(footer().classList.contains('is-dictating'));
  assert.ok(footer().querySelector('.ai-compose-footer-voice .ai-voice-line'), 'the voice line is in the footer cell');
  assert.equal(footer().querySelector('.ai-compose-footer-status').getAttribute('aria-hidden'), 'true', 'the replaced controls are hidden');
  await pointer('pointerdown');
  await act(async () => voice.current().onend());
  await settle();
  assert.equal(rows(), before);
  assert.ok(!footer().classList.contains('is-dictating'), 'the footer controls return');
  assert.ok(footer().querySelector('.ai-compose-footer-voice') === null);
});
