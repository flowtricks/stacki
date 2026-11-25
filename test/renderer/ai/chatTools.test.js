// Goal: the chat tools Stacki adds beside the agent's own: copying a chat as Markdown, finding in a
// chat, Stacki's built-in `/` commands (`/clear`, `/export`, `/find`), the chat's keyboard shortcuts
// and "Retry" on the agent's last reply. Each holds its bounds and its negative space: a thought or a
// subagent's words are never exported or searched, a draft with more than the command is a message,
// a shortcut with the wrong modifier is nothing, and Retry appears only on a reply that ended normally.
// Method: the pure modules are bundled with esbuild and tested directly; the transcript is mounted in
// jsdom against a fake preload (as transcript.test.js does) to check that ⌘F opens the find bar,
// that the bar counts matches in the drawn text, and that Retry sends the prompt again.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/chatTools.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export * as exporting from './src/features/ai/transcript/chatExport';",
      "export * as finding from './src/features/ai/transcript/chatFind';",
      "export * as builtins from './src/features/ai/composer/builtinCommands';",
      "export * as shortcuts from './src/features/ai/chatShortcuts';",
      "export { Transcript } from './src/features/ai/transcript/TranscriptView';",
      "export { ENGLISH_TRANSLATE } from './shared/properties/i18n/englishTranslator';",
      "export { EMPTY_CHAT, reduceChat } from './src/features/ai/chatReducer';",
      "export { loadAiProject, resetAiStore } from './src/features/ai/aiStore';",
      "export { resetTranscriptUi } from './src/features/ai/transcript/transcriptUi';",
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
global.window = dom.window;
for (const name of [
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'NodeFilter',
  'Event',
  'KeyboardEvent',
  'MouseEvent',
  'getComputedStyle',
  'localStorage',
]) {
  Object.defineProperty(global, name, { value: dom.window[name], configurable: true, writable: true });
}
global.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0);
global.requestAnimationFrame = dom.window.requestAnimationFrame;
global.cancelAnimationFrame = (handle) => clearTimeout(handle);
dom.window.cancelAnimationFrame = global.cancelAnimationFrame;
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
const translate = ui.ENGLISH_TRANSLATE;

const CHAT = `c${'a'.repeat(24)}`;
const TURN = `t${'1'.padStart(16, '0')}`;
const turnStart = (at) => ({ kind: 'turn-start', turn: TURN, at });
const turnEnd = (at, stop = 'end_turn') => ({ kind: 'turn-end', turn: TURN, stop, message: undefined, at });
const user = (text, at, attachments = []) => ({ kind: 'user', turn: TURN, text, attachments, at });
const agentText = (text, at) => ({ kind: 'text', turn: TURN, role: 'agent', text, at, until: at });
const thought = (text, at) => ({ kind: 'text', turn: TURN, role: 'thought', text, at, until: at });
const fold = (...events) => ui.reduceChat(ui.EMPTY_CHAT, events.flat());
const labels = { title: 'Hero fix', you: 'You', agent: 'Claude', attachments: 'Attachments', truncated: 'Cut here.' };

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

test('a chat exports as Markdown: the title, then each message under who said it', () => {
  const view = fold(
    turnStart(1),
    user('Make the hero taller', 1, [{ name: 'shot.png' }]),
    thought('secret reasoning', 2),
    agentText('Done: **taller**.', 3),
    turnEnd(4),
  );
  const markdown = ui.exporting.transcriptMarkdown(view.items, labels);
  assert.equal(markdown, '# Hero fix\n\n## You\n\nMake the hero taller\n\nAttachments: shot.png\n\n## Claude\n\nDone: **taller**.\n');
  assert.ok(!markdown.includes('secret reasoning'), 'a thought is the agent’s process, not the conversation');
  assert.equal(ui.exporting.hasExportableMessages(view.items), true);
});

test('an export leaves out a subagent’s words and an untitled chat has no title heading', () => {
  const items = [
    ...fold(turnStart(1), user('Hi', 1)).items,
    { kind: 'text', id: 99, turn: TURN, role: 'agent', text: 'from a subagent', at: 2, until: 2, parent: 'call-1' },
  ];
  const markdown = ui.exporting.transcriptMarkdown(items, { ...labels, title: undefined });
  assert.equal(markdown, '## You\n\nHi\n');
  assert.equal(ui.exporting.hasExportableMessages(fold(turnStart(1), thought('only thinking', 1)).items), false);
});

test('an export past the bound is cut with a line that says so', () => {
  const big = 'x'.repeat(ui.exporting.EXPORT_LIMITS.charsMax - 20);
  const view = fold(turnStart(1), user(big, 1), agentText('the reply that does not fit', 2));
  const markdown = ui.exporting.transcriptMarkdown(view.items, labels);
  assert.ok(markdown.endsWith('_Cut here._\n'));
  assert.ok(!markdown.includes('the reply that does not fit'));
});

test('an export without headings is a programmer error', () => {
  assert.throws(() => ui.exporting.transcriptMarkdown([], { ...labels, you: '' }), /the person has a heading/);
});

// ---------------------------------------------------------------------------
// Find
// ---------------------------------------------------------------------------

test('matches are case folded, in order, without overlaps, and bounded', () => {
  assert.deepEqual(ui.finding.textMatches('Hero hero HERO', 'hero'), [
    { start: 0, length: 4 },
    { start: 5, length: 4 },
    { start: 10, length: 4 },
  ]);
  assert.deepEqual(ui.finding.textMatches('aaaa', 'aa'), [
    { start: 0, length: 2 },
    { start: 2, length: 2 },
  ]);
  assert.deepEqual(ui.finding.textMatches('abc', ''), []);
  assert.equal(ui.finding.textMatches('a'.repeat(5000), 'a').length, ui.finding.FIND_LIMITS.matchesMax);
  assert.equal(ui.finding.textMatches('aaaa', 'a', 2).length, 2);
  assert.throws(() => ui.finding.textMatches('a', 'a', -1), /a limit is a count/);
  // "İ" lower-cases to two code units: that text is searched as written, so the offsets stay true.
  assert.deepEqual(ui.finding.textMatches('İx x', 'x'), [
    { start: 1, length: 1 },
    { start: 3, length: 1 },
  ]);
  assert.equal(ui.finding.findQuery('q'.repeat(500)).length, ui.finding.FIND_LIMITS.queryCharsMax);
});

test('find searches the person’s messages and the agent’s replies, never a thought', () => {
  const view = fold(turnStart(1), user('About the footer', 1), thought('footer thoughts', 2), agentText('The footer is fixed', 3), turnEnd(4));
  const ids = ui.finding.matchingMessageIds(view.items, 'FOOTER');
  assert.deepEqual(
    ids,
    view.items.filter((item) => item.kind === 'user' || (item.kind === 'text' && item.role === 'agent')).map((item) => item.id),
  );
  assert.deepEqual(ui.finding.matchingMessageIds(view.items, ''), []);
  assert.deepEqual(ui.finding.matchingMessageIds(view.items, 'missing'), []);
});

test('stepping wraps at both ends and has nothing to step through when there is no match', () => {
  assert.equal(ui.finding.stepMatch(undefined, 3, 'next'), 0);
  assert.equal(ui.finding.stepMatch(undefined, 3, 'previous'), 2);
  assert.equal(ui.finding.stepMatch(2, 3, 'next'), 0);
  assert.equal(ui.finding.stepMatch(0, 3, 'previous'), 2);
  assert.equal(ui.finding.stepMatch(5, 3, 'next'), 0, 'a current past a shrunken count starts again');
  assert.equal(ui.finding.stepMatch(undefined, 0, 'next'), undefined);
  assert.throws(() => ui.finding.stepMatch(0, -1, 'next'), /never negative/);
  assert.throws(() => ui.finding.stepMatch(0, 1.5, 'next'), /an integer/);
});

// ---------------------------------------------------------------------------
// Built-in commands and shortcuts
// ---------------------------------------------------------------------------

test('Stacki’s commands head the menu and hide an agent command of the same name', () => {
  const builtins = ui.builtins.builtinCommands(translate);
  assert.deepEqual(
    builtins.map((command) => command.name),
    ['clear', 'export', 'find'],
  );
  assert.ok(
    builtins.every((command) => command.description.length > 0 && !command.description.startsWith('ai.')),
    'each is described in words',
  );
  const merged = ui.builtins.withBuiltinCommands(builtins, [
    { name: 'export', description: 'terminal export', hint: undefined },
    { name: 'review', description: 'Review code', hint: undefined },
  ]);
  assert.deepEqual(
    merged.map((command) => command.name),
    ['clear', 'export', 'find', 'review'],
  );
  assert.equal(merged.find((command) => command.name === 'export')?.description, builtins[1].description);
});

test('only a draft that is exactly a built-in command runs it', () => {
  assert.equal(ui.builtins.builtinCommandOfDraft('/clear'), 'clear');
  assert.equal(ui.builtins.builtinCommandOfDraft('  /export \n'), 'export');
  assert.equal(ui.builtins.builtinCommandOfDraft('/export these notes'), undefined);
  assert.equal(ui.builtins.builtinCommandOfDraft('clear'), undefined);
  assert.equal(ui.builtins.builtinCommandOfDraft('/review'), undefined);
  assert.equal(ui.builtins.builtinCommandNamed('find'), 'find');
  assert.equal(ui.builtins.builtinCommandNamed('compact'), undefined);
});

test('the chat’s shortcuts use ⌘ on a Mac and Ctrl elsewhere, and nothing else counts', () => {
  const key = (over) => ({ key: 'f', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over });
  assert.equal(ui.shortcuts.chatShortcut(key({ metaKey: true }), 'darwin'), 'find');
  assert.equal(ui.shortcuts.chatShortcut(key({ ctrlKey: true }), 'win32'), 'find');
  assert.equal(ui.shortcuts.chatShortcut(key({ ctrlKey: true }), 'darwin'), undefined);
  assert.equal(ui.shortcuts.chatShortcut(key({ metaKey: true, shiftKey: true }), 'darwin'), undefined);
  assert.equal(ui.shortcuts.chatShortcut(key({ metaKey: true, altKey: true }), 'darwin'), undefined);
  assert.equal(ui.shortcuts.chatShortcut(key({ key: 'O', metaKey: true, shiftKey: true }), 'darwin'), 'new-chat');
  assert.equal(ui.shortcuts.chatShortcut(key({ key: 'o', metaKey: true }), 'darwin'), undefined, '⌘O is the menu’s Open Project');
  assert.equal(ui.shortcuts.chatShortcut(key({}), 'darwin'), undefined);
  assert.equal(ui.shortcuts.chatShortcutLabel('find', 'darwin'), '⌘F');
  assert.equal(ui.shortcuts.chatShortcutLabel('new-chat', 'linux'), 'Ctrl+Shift+O');
});

// ---------------------------------------------------------------------------
// The mounted transcript
// ---------------------------------------------------------------------------

const calls = [];
function installPreload() {
  const record = (name, reply) => async (payload) => {
    calls.push({ name, payload });
    return reply;
  };
  window.avb = {
    aiAgents: record('aiAgents', { trusted: true, agents: [], options: [] }),
    aiChats: record('aiChats', { chats: [], sections: [] }),
    aiCancel: record('aiCancel', { ok: true }),
    aiPrompt: record('aiPrompt', { ok: true, value: { turn: TURN } }),
    aiAck: () => undefined,
    onAiEvents: () => () => undefined,
    onAiAgentStatus: () => () => undefined,
    onAiSetup: () => () => undefined,
    platform: 'darwin',
  };
}

const mounted = [];
async function mount(view) {
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
      }),
    );
  });
  mounted.push({ root, container });
  return container;
}
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

test.beforeEach(async () => {
  installPreload();
  calls.length = 0;
  ui.resetTranscriptUi();
  ui.resetAiStore();
  await ui.loadAiProject('/site');
});

test.afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('⌘F in the transcript opens the find bar, which counts the matches drawn, and Escape closes it', async () => {
  const container = await mount(fold(turnStart(1), user('Make the footer blue', 1), agentText('The footer is blue now', 2), turnEnd(3)));
  const log = container.querySelector('.ai-transcript');
  assert.equal(container.querySelector('.ai-find') ?? undefined, undefined, 'closed until asked for');
  await act(async () => log.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true })));
  const field = container.querySelector('.ai-find-field');
  assert.ok(field, 'the bar opened');
  assert.equal(document.activeElement, field, 'the field took the keyboard');
  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    setValue.call(field, 'footer');
    field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await settle();
  assert.equal(container.querySelector('.ai-find-count')?.textContent, '2 matches');
  await act(async () => field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  assert.equal(container.querySelector('.ai-find-count')?.textContent, '1 of 2');
  await act(async () => field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true })));
  assert.equal(container.querySelector('.ai-find-count')?.textContent, '2 of 2', 'Shift+Enter steps back, wrapping');
  await act(async () => {
    setValue.call(field, 'nowhere');
    field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await settle();
  assert.equal(container.querySelector('.ai-find-count')?.textContent, 'No matches');
  const buttons = [...container.querySelectorAll('.ai-find-button')];
  assert.deepEqual(
    buttons.map((button) => button.getAttribute('aria-label')),
    ['Previous match', 'Next match', 'Close find'],
  );
  assert.equal(
    buttons.some((button) => button.hasAttribute('title')),
    false,
    'tips are the app’s own, never native',
  );
  assert.deepEqual(
    buttons.map((button) => button.disabled),
    [true, true, false],
    'previous and next are disabled only while there is no result',
  );
  await act(async () => field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  assert.equal(container.querySelector('.ai-find') ?? undefined, undefined, 'Escape closed it');
});

test('the find bar is a 44px filled pill with 32px icon buttons and no border, and the current match outshines the others', () => {
  const css = fs.readFileSync(repoPath('src/features/ai/transcript/transcript.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const block = (selector) => css.slice(css.indexOf(`${selector} {`), css.indexOf('}', css.indexOf(`${selector} {`)));
  assert.match(block('.ai-find'), /block-size: 44px/);
  assert.match(block('.ai-find'), /box-shadow/);
  assert.doesNotMatch(block('.ai-find'), /border(?!-radius|-box)/, 'fills, never borders');
  assert.match(block('.ai-find-button'), /inline-size: 32px/);
  assert.match(block('.ai-find-field'), /font-size: 14.5px/);
  assert.match(block('.ai-find-count'), /tabular-nums/);
  assert.match(css, /\.ai-find:focus-within \{\s*background/, 'focus brightens the fill');
  assert.match(block('::highlight(ai-find-current)'), /#ffb020/);
});

test('the agent’s last reply offers Retry after a normal end, which sends the prompt again', async () => {
  const container = await mount(fold(turnStart(1), user('Tighten the nav', 1), agentText('Tightened.', 2), turnEnd(3)));
  const retry = container.querySelector('.ai-msg-agent .ai-msg-action[aria-label="Retry reply"]');
  assert.ok(retry, 'the reply has Retry');
  await act(async () => retry.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  await settle();
  const prompt = calls.find((call) => call.name === 'aiPrompt');
  assert.equal(prompt?.payload.text, 'Tighten the nav');
});

test('no Retry on a reply while the turn runs or after it was stopped', async () => {
  const running = await mount(fold(turnStart(1), user('Tighten the nav', 1), agentText('Working', 2)));
  assert.equal(running.querySelector('.ai-msg-action[aria-label="Retry reply"]') ?? undefined, undefined);
  const stopped = await mount(fold(turnStart(1), user('Tighten the nav', 1), agentText('Partly', 2), turnEnd(3, 'cancelled')));
  assert.equal(stopped.querySelector('.ai-msg-action[aria-label="Retry reply"]') ?? undefined, undefined);
});
