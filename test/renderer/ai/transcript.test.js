// Goal: the transcript shows what the agent is doing and has done, truthfully and compactly. A
// running turn shows the four-dot loader, what it is doing now and a live timer driven by ONE shared
// ticker that stops when the turn ends; a finished turn folds its work into a one-line group
// ("Ran 1 command, read 3 files") that opens to tool cards, each one line that opens to its command
// and bounded, highlighted output; thoughts read "Thought for 12s"; the plan, the background-task tray
// ("Stop agent" is its only control) and the compaction row draw from the chat's state; long replies
// clamp behind "Show more"; the view follows the newest line, stops when the person scrolls up and
// offers "Jump to latest". What the person opens is remembered. Chats stored before timings show no
// duration, no timer and no "NaN".
// Method: the pure model (grouping, durations, headlines, the ticker with an injected clock, the UI
// memory) is tested directly; the components are bundled with esbuild and mounted in jsdom against a
// fake preload, with views folded by the real reducer from events shaped as the host writes them.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/transcript.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export { Transcript } from './src/features/ai/transcript/TranscriptView';",
      "export { PlanCard } from './src/features/ai/transcript/PlanCard';",
      "export * as rawModel from './src/features/ai/transcript/transcriptModel';",
      "export { ENGLISH_TRANSLATE } from './shared/properties/i18n/englishTranslator';",
      "export { formattersFor } from './shared/core/i18n/format';",
      "export { createTicker } from './src/features/ai/transcript/ticker';",
      "export { openState, setOpenState, expandAllItems, collapseAllItems, resetTranscriptUi } from './src/features/ai/transcript/transcriptUi';",
      "export { EMPTY_CHAT, reduceChat } from './src/features/ai/chatReducer';",
      "export { aiState, loadAiProject, resetAiStore } from './src/features/ai/aiStore';",
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
const scrolls = [];
dom.window.HTMLElement.prototype.scrollTo = function (options) {
  scrolls.push(options);
};

// Intervals the transcript asks the window for, so the test can fire them and count the live ones.
const intervals = new Map();
let nextInterval = 1;
dom.window.setInterval = (callback) => {
  const handle = nextInterval++;
  intervals.set(handle, callback);
  return handle;
};
dom.window.clearInterval = (handle) => {
  intervals.delete(handle);
};
const realNow = Date.now;
let clock = 1_000_000;
Date.now = () => clock;

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const ui = require(output);
// The English forms of the model's wording functions, which take the language's messages and number format.
const words = { translate: ui.ENGLISH_TRANSLATE, formatNumber: ui.formattersFor('en').formatNumber };
const model = {
  ...ui.rawModel,
  summarizeGroup: (items) => ui.rawModel.summarizeGroup(items, words),
  thoughtLabel: (item, options) => ui.rawModel.thoughtLabel(item, options, words),
  runningLabel: (view, now) => ui.rawModel.runningLabel(view, now, ui.ENGLISH_TRANSLATE),
  compactionLine: (item) => ui.rawModel.compactionLine(item, words),
};

const CHAT = `c${'a'.repeat(24)}`;
const turnId = (number) => `t${String(number).padStart(16, '0')}`;
const TURN = turnId(1);

// ---------------------------------------------------------------------------
// Events as the host writes them, and views folded by the real reducer
// ---------------------------------------------------------------------------

const turnStart = (turn, at) => ({ kind: 'turn-start', turn, at });
const turnEnd = (turn, at, stop = 'end_turn') => ({ kind: 'turn-end', turn, stop, message: undefined, at });
const user = (turn, text, at, extra = {}) => ({ kind: 'user', turn, text, attachments: [], at, ...extra });
const agentText = (turn, text, at) => ({ kind: 'text', turn, role: 'agent', text, at, until: at });
const thought = (turn, text, at, until) => ({ kind: 'text', turn, role: 'thought', text, at, until });
const tool = (turn, call, over = {}) => ({
  kind: 'tool',
  turn,
  call,
  title: undefined,
  toolKind: undefined,
  status: 'in_progress',
  paths: undefined,
  diffs: undefined,
  output: undefined,
  exitCode: undefined,
  parent: undefined,
  at: undefined,
  toolName: undefined,
  command: undefined,
  background: undefined,
  ...over,
});
const fold = (...events) => ui.reduceChat(ui.EMPTY_CHAT, events.flat());

/** A finished turn: four calls (three reads, one command), a reply, then the end. */
function finishedTurn(turn = TURN, base = 1000) {
  return [
    turnStart(turn, base),
    user(turn, 'Fix the build', base),
    ...[1, 2, 3].map((number) =>
      tool(turn, `r${number}`, {
        title: `Read file${number}.ts`,
        toolKind: 'read',
        status: 'completed',
        paths: [`/site/file${number}.ts`],
        at: base + 1000 + number * 100,
      }),
    ),
    tool(turn, 'c1', { title: 'npm test', toolKind: 'execute', command: 'npm test', at: base + 1000 }),
    tool(turn, 'c1', { status: 'completed', output: 'PASS all\n', exitCode: 0, at: base + 4000 }),
    agentText(turn, 'All done', base + 5000),
    turnEnd(turn, base + 133_000),
  ];
}

// ---------------------------------------------------------------------------
// Mounting
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
    aiPermission: record('aiPermission', { ok: true, value: { answered: true } }),
    aiAck: () => undefined,
    onAiEvents: () => () => undefined,
    onAiAgentStatus: () => () => undefined,
    onAiSetup: () => () => undefined,
    platform: 'darwin',
  };
}

const reading = { hidden: new Set(), details: undefined, interrupted: false };
const mounted = [];

async function mount(view, over = {}) {
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  const render = async (next) => {
    await act(async () => {
      root.render(
        React.createElement(ui.Transcript, {
          view: next,
          reading,
          retryHeldByCard: false,
          projectPath: '/site',
          chatId: CHAT,
          onReview: () => undefined,
          ...over,
        }),
      );
    });
  };
  await render(view);
  mounted.push({ root, container });
  return { container, render, root };
}

test.beforeEach(async () => {
  installPreload();
  calls.length = 0;
  scrolls.length = 0;
  intervals.clear();
  clock = 1_000_000;
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

test.after(() => {
  Date.now = realNow;
});

const click = (element) => act(async () => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
const text = (container, selector) => container.querySelector(selector)?.textContent;

// ---------------------------------------------------------------------------
// Pure model
// ---------------------------------------------------------------------------

test('a run of calls and thoughts is one group; messages and permissions end it; unchanged groups are reused', () => {
  const view = fold(
    turnStart(TURN, 1),
    user(TURN, 'go', 1),
    thought(TURN, 'hm', 2, 3),
    tool(TURN, 'a', { toolKind: 'read' }),
    agentText(TURN, 'half way', 4),
    tool(TURN, 'b', { toolKind: 'execute' }),
  );
  const positioned = view.items.map((item, index) => ({ item, index }));
  const rows = model.buildRows(positioned, []);
  assert.deepEqual(
    rows.map((row) => row.kind),
    ['item', 'group', 'item', 'group'],
  );
  assert.equal(rows[1].items.length, 2, 'the thought and the call are one group');
  assert.deepEqual([rows[1].last, rows[3].last], [false, true], 'only the newest group of a turn is the live one');
  const grown = fold(view.items.length === 0 ? [] : [], turnStart(TURN, 1));
  assert.equal(grown.items.length, 0);
  const again = model.buildRows(positioned, rows);
  assert.equal(again[1], rows[1], 'a group with the same items is the same object, so React can skip it');
  assert.equal(again[3], rows[3]);
  const more = ui.reduceChat(view, [tool(TURN, 'c', { toolKind: 'read' })]);
  const grownRows = model.buildRows(
    more.items.map((item, index) => ({ item, index })),
    rows,
  );
  assert.notEqual(grownRows[3], rows[3], 'a group that gained a call is a new object');
  assert.equal(grownRows[1], rows[1], 'the earlier group is untouched');
});

test('a group of two turns splits at the turn boundary; rows never outnumber items', () => {
  const view = fold(user(TURN, 'a', 1), tool(TURN, 'a', {}), tool(turnId(2), 'b', {}));
  const rows = model.buildRows(
    view.items.map((item, index) => ({ item, index })),
    [],
  );
  assert.equal(rows.filter((row) => row.kind === 'group').length, 2);
  assert.ok(rows.length <= view.items.length);
});

test('windowRows keeps the newest rows and says how many were left out', () => {
  const rows = Array.from({ length: 10 }, (_, key) => ({ kind: 'item', key, item: {}, index: key }));
  assert.equal(model.windowRows(rows, 20).hidden, 0);
  const windowed = model.windowRows(rows, 4);
  assert.equal(windowed.hidden, 6);
  assert.deepEqual(
    windowed.shown.map((row) => row.key),
    [6, 7, 8, 9],
  );
  assert.throws(() => model.windowRows(rows, 0), /positive limit/);
});

test('durations come from stamps; a missing or backwards stamp gives none, never a wrong one', () => {
  const stamped = fold(
    turnStart(TURN, 1),
    thought(TURN, 'x', 1000, 13_000),
    tool(TURN, 'a', { at: 2000 }),
    tool(TURN, 'a', { status: 'completed', at: 5000 }),
  ).items;
  const [thoughtItem, toolItem] = stamped;
  assert.equal(model.thoughtDurationMs(thoughtItem), 12_000);
  assert.equal(model.toolDurationMs(toolItem), 3000);
  assert.equal(model.groupDurationMs([thoughtItem, toolItem]), 12_000, 'first stamp to last, not the sum');
  const old = fold(thought(TURN, 'x', undefined, undefined), tool(TURN, 'b', { status: 'completed' })).items;
  assert.equal(model.thoughtDurationMs(old[0]), undefined);
  assert.equal(model.toolDurationMs(old[1]), undefined);
  assert.equal(model.groupDurationMs(old), undefined);
  assert.equal(model.thoughtDurationMs({ ...thoughtItem, at: 9, until: 3 }), undefined, 'backwards stamps are no duration');
  const running = fold(tool(TURN, 'r', { at: 100 })).items;
  assert.equal(model.groupDurationMs(running), undefined, 'a running call has no end yet');
});

test('the group line, the thought label and the running label say what is true', () => {
  const items = fold(finishedTurn()).items.filter((item) => item.kind === 'tool');
  assert.equal(model.summarizeGroup(items).text, 'Ran 1 command, read 3 files');
  const failed = fold(tool(TURN, 'f', { toolKind: 'execute', status: 'failed' })).items;
  assert.deepEqual(model.summarizeGroup(failed), { text: 'Ran 1 command', failed: 1, open: 0 });
  const thoughtOnly = fold(thought(TURN, 'x', 0, 12_000)).items;
  assert.equal(model.summarizeGroup(thoughtOnly).text, 'Thought for 12s');
  assert.equal(model.summarizeGroup(fold(thought(TURN, 'x', undefined, undefined)).items).text, 'Thought');
  assert.equal(model.thoughtLabel(thoughtOnly[0], { live: true }), 'Thinking…');

  const reading3 = fold(turnStart(TURN, 1000), ...[1, 2, 3].map((number) => tool(TURN, `r${number}`, { toolKind: 'read', at: 2000 })));
  assert.equal(model.runningLabel(reading3, 5000).label, 'Reading 3 files');
  const one = fold(turnStart(TURN, 1000), tool(TURN, 'r1', { toolKind: 'read' }));
  assert.equal(model.runningLabel(one, 5000).label, 'Reading files');
  const command = fold(turnStart(TURN, 1000), tool(TURN, 'c', { toolKind: 'execute' }));
  assert.deepEqual(model.runningLabel(command, 78_000), { label: 'Running a command', elapsedMs: 77_000 });
  assert.equal(model.runningLabel(ui.EMPTY_CHAT, 5), undefined, 'an idle chat has no running line');
  const unseen = fold(tool(TURN, 'c', { toolKind: 'execute' }), { kind: 'turn-start', turn: TURN, at: undefined });
  assert.ok(
    model.runningLabel(unseen, 5) === undefined ||
      model.runningLabel(unseen, 5).elapsedMs === undefined ||
      Number.isFinite(model.runningLabel(unseen, 5).elapsedMs),
  );
});

test('compaction rows: running, saved tokens from before and after, failed, stopped', () => {
  const base = { kind: 'compaction', id: 1, turn: undefined, compactionId: 'k', at: 1 };
  assert.deepEqual(model.compactionLine({ ...base, status: 'in_progress', before: undefined, after: undefined }), {
    tone: 'running',
    text: 'Compacting conversation…',
  });
  assert.equal(
    model.compactionLine({ ...base, status: 'completed', before: { used: 82_000, size: 200_000 }, after: { used: 40_000, size: 200_000 } }).text,
    'Conversation compacted · saved ~42K tokens',
  );
  assert.equal(
    model.compactionLine({ ...base, status: 'completed', before: undefined, after: undefined }).text,
    'Conversation compacted',
    'no saving is claimed without both readings',
  );
  assert.equal(
    model.compactionLine({ ...base, status: 'completed', before: { used: 10, size: 100 }, after: { used: 50, size: 100 } }).text,
    'Conversation compacted',
    'a saving that is not positive is not claimed',
  );
  assert.equal(model.compactionLine({ ...base, status: 'failed', before: undefined, after: undefined, error: undefined }).tone, 'failed');
  assert.deepEqual(model.compactionLine({ ...base, status: 'failed', before: undefined, after: undefined, error: 'OAuth expired' }), {
    tone: 'failed',
    text: 'Compaction failed',
    detail: 'OAuth expired',
  });
  assert.equal(model.compactionLine({ ...base, status: 'cancelled', before: undefined, after: undefined }).tone, 'stopped');
  assert.deepEqual(
    [850, 42_000, 1_234_000, -5].map((tokens) => model.formatTokens(tokens, words.formatNumber)),
    ['850', '42K', '1.2M', '0'],
  );
  assert.throws(() => model.formatTokens(Number.NaN, words.formatNumber), /finite/);
});

test('long text and tool output are cut at their bounds, from the end that matters', () => {
  assert.equal(model.isLongMessage('short'), false);
  assert.equal(model.isLongMessage('x'.repeat(model.LONG_MESSAGE_CHARS + 1)), true);
  assert.equal(model.isLongMessage('a\n'.repeat(model.LONG_MESSAGE_LINES)), true);
  assert.equal(model.isLongMessage('a\n'.repeat(model.LONG_MESSAGE_LINES - 2)), false);
  assert.deepEqual(model.clampOutput('abcdef', { from: 'end', limit: 10 }), { text: 'abcdef', hidden: 0 });
  assert.deepEqual(model.clampOutput('abcdef', { from: 'end', limit: 2 }), { text: 'ef', hidden: 4 });
  assert.deepEqual(model.clampOutput('abcdef', { from: 'start', limit: 2 }), { text: 'ab', hidden: 4 });
  assert.throws(() => model.clampOutput('a', { from: 'end', limit: 0 }), /positive limit/);
});

test('finished background work lists subagents and background commands, newest first, bounded', () => {
  const view = fold(
    turnStart(TURN, 1),
    tool(TURN, 'sub', { title: 'Explore', toolName: 'Task', at: 1000 }),
    tool(TURN, 'sub', { status: 'completed', output: 'found it\n', at: 9000 }),
    tool(TURN, 'bg', { title: 'dev server', toolKind: 'execute', background: true, at: 2000 }),
    tool(TURN, 'bg', { status: 'failed', at: 3000 }),
    tool(TURN, 'plain', { toolKind: 'execute', status: 'completed' }),
    tool(TURN, 'child', { toolName: 'Task', parent: 'sub', status: 'completed' }),
  );
  const finished = model.finishedTasks(view.items, { limit: 5, scanMax: 100 });
  assert.deepEqual(
    finished.map((task) => [task.call, task.status, task.kind]),
    [
      ['bg', 'failed', 'command'],
      ['sub', 'completed', 'subagent'],
    ],
  );
  assert.equal(finished[1].durationMs, 8000);
  assert.equal(finished[1].lastOutputLine, 'found it');
  assert.equal(model.finishedTasks(view.items, { limit: 1, scanMax: 100 }).length, 1);
  assert.equal(model.finishedTasks(view.items, { limit: 5, scanMax: 1 }).length, 0, 'the scan does not look back past its bound');
});

test('the shared ticker runs one interval while anyone listens, none otherwise, and its reading is stable between ticks', () => {
  let now = 5000;
  const started = [];
  const stopped = [];
  const fake = {
    now: () => now,
    setInterval: (callback, period) => {
      started.push({ callback, period });
      return started.length;
    },
    clearInterval: (handle) => stopped.push(handle),
  };
  const ticker = ui.createTicker(fake, 1000);
  assert.equal(started.length, 0, 'creating a ticker starts nothing');
  const heard = [];
  const first = ticker.subscribe(() => heard.push('a'));
  const second = ticker.subscribe(() => heard.push('b'));
  assert.equal(started.length, 1, 'two listeners share one interval');
  assert.equal(started[0].period, 1000);
  assert.equal(ticker.read(), ticker.read(), 'a snapshot is stable between ticks');
  now = 6000;
  started[0].callback();
  assert.deepEqual(heard, ['a', 'b']);
  assert.equal(ticker.read(), 6000);
  first();
  assert.deepEqual(stopped, [], 'one listener left: still running');
  second();
  assert.deepEqual(stopped, [1], 'the last listener stops the interval');
  assert.equal(ticker.listenerCount(), 0);
  now = 60_000;
  assert.equal(ticker.read(), 60_000, 'an idle ticker does not hand out a minute-old reading');
  assert.throws(() => ui.createTicker(fake, 0), /positive period/);
});

test('the memory of opened cards is per chat, bulk-settable, overridable and bounded', () => {
  assert.equal(ui.openState(CHAT, 'g1', { open: false }), false);
  assert.equal(ui.openState(CHAT, 'g1', { open: true }), true, 'with no choice the default holds');
  ui.setOpenState(CHAT, 'g1', { open: true });
  assert.equal(ui.openState(CHAT, 'g1', { open: false }), true);
  assert.equal(ui.openState('other', 'g1', { open: false }), false, 'another chat is not touched');
  ui.expandAllItems(CHAT);
  assert.equal(ui.openState(CHAT, 'anything', { open: false }), true);
  ui.setOpenState(CHAT, 'g2', { open: false });
  assert.equal(ui.openState(CHAT, 'g2', { open: true }), false, 'a click after Expand all still wins');
  ui.collapseAllItems(CHAT);
  assert.equal(ui.openState(CHAT, 'g1', { open: true }), false, 'Collapse all forgets earlier choices');
  assert.equal(ui.openState('other', 'x', { open: true }), true);
  for (let number = 0; number < 2500; number += 1) {
    ui.setOpenState(CHAT, `bulk${number}`, { open: true });
  }
  assert.equal(ui.openState(CHAT, 'bulk0', { open: false }), false, 'the oldest entries are evicted past the bound');
  assert.equal(ui.openState(CHAT, 'bulk2499', { open: false }), true, 'the newest are kept');
});

// ---------------------------------------------------------------------------
// The running line, the timer and the loader
// ---------------------------------------------------------------------------

test('a running turn shows the loader, what it is doing and a live timer from one shared interval, which stops at turn end', async () => {
  clock = 78_000;
  const running = fold(
    turnStart(TURN, 1000),
    user(TURN, 'Run the tests', 1000),
    tool(TURN, 'c1', { title: 'npm test', toolKind: 'execute', command: 'npm test', at: 2000 }),
  );
  const { container, render } = await mount(running);
  const line = container.querySelector('.ai-turn-status');
  assert.ok(line, 'the running line is drawn');
  assert.equal(line.querySelectorAll('.loader-dot').length, 4, 'the four-dot loader');
  assert.equal(text(container, '.ai-turn-label'), 'Running a command');
  assert.equal(text(container, '.ai-turn-time'), '1m 17s');
  assert.equal(text(container, '.ai-tool-time'), '1m 16s', 'the running call counts too');
  assert.equal(intervals.size, 1, 'the line and the call share one interval');

  clock = 79_000;
  await act(async () => [...intervals.values()].forEach((callback) => callback()));
  assert.equal(text(container, '.ai-turn-time'), '1m 18s', 'the timer ticks');

  const done = ui.reduceChat(running, [tool(TURN, 'c1', { status: 'completed', at: 79_000 }), agentText(TURN, 'done', 79_000), turnEnd(TURN, 79_000)]);
  await render(done);
  assert.equal(container.querySelector('.ai-turn-status') ?? undefined, undefined, 'the running line goes with the turn');
  assert.equal(intervals.size, 0, 'no interval is left running once the turn has ended');
  assert.equal(text(container, '.ai-worked'), 'Worked for 1m 18s');
});

test('a turn this view did not see begin shows its label and no timer', async () => {
  const unseen = fold(tool(TURN, 'c1', { toolKind: 'execute' }), { kind: 'turn-start', turn: TURN, at: undefined });
  const { container } = await mount(unseen);
  assert.equal(text(container, '.ai-turn-label'), 'Running a command');
  assert.equal(container.querySelector('.ai-turn-time') ?? undefined, undefined);
  assert.doesNotMatch(container.textContent, /NaN|undefined/);
});

test('the loader stops moving for people who ask for reduced motion', () => {
  const css = fs.readFileSync(repoPath('src/ui/loaderDots.css'), 'utf8');
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.loader-dot\s*{[^}]*animation:\s*none/);
  // The hover toolbar of a message fades in; it stops fading too.
  const chrome = fs.readFileSync(repoPath('src/features/ai/transcript/chrome.css'), 'utf8');
  assert.match(chrome, /prefers-reduced-motion: reduce\)\s*{[^}]*\.ai-msg-toolbar\s*{[^}]*transition:\s*none/);
});

// ---------------------------------------------------------------------------
// Groups and tool cards
// ---------------------------------------------------------------------------

test('a finished turn folds its work into one line that opens to one-line cards that open to their output', async () => {
  const { container } = await mount(fold(finishedTurn()));
  const head = container.querySelector('.ai-group-head');
  assert.equal(text(container, '.ai-group-title'), 'Ran 1 command, read 3 files');
  assert.equal(text(container, '.ai-group-time'), '3.0s');
  assert.equal(head.getAttribute('aria-expanded'), 'false');
  assert.equal(container.querySelectorAll('.ai-tool').length, 0, 'collapsed once finished');
  assert.equal(text(container, '.ai-worked'), 'Worked for 2m 13s');
  assert.match(text(container, '.ai-message-agent'), /All done/);

  await click(head);
  assert.equal(head.getAttribute('aria-expanded'), 'true');
  assert.equal(container.querySelectorAll('.ai-tool').length, 4);
  const command = [...container.querySelectorAll('.ai-tool')].find((card) => card.textContent.includes('npm test'));
  assert.ok(command.querySelector('.ai-tool-head code.code-inline'), 'a command is shown as highlighted code');
  assert.equal(command.querySelector('.ai-tool-body') ?? undefined, undefined, 'a card is one line until opened');
  const cardHead = command.querySelector('.ai-tool-head');
  assert.equal(cardHead.tagName, 'BUTTON', 'a real button: Enter and Space work');
  assert.equal(cardHead.getAttribute('aria-expanded'), 'false');
  assert.equal(text(command, '.ai-tool-time'), '3.0s');

  await click(cardHead);
  assert.equal(cardHead.getAttribute('aria-expanded'), 'true');
  assert.equal(cardHead.getAttribute('aria-controls'), command.querySelector('.ai-tool-body').id);
  const outputBlock = command.querySelector('pre.ai-tool-output');
  assert.equal(outputBlock.textContent, 'PASS all\n');
  assert.equal(outputBlock.getAttribute('tabindex'), '0', 'a scrollable block is reachable by keyboard');
  assert.equal(outputBlock.getAttribute('aria-label'), 'Tool output');
});

test('what the person opened stays open across a re-render and a remount, and Expand all / Collapse all reach every card', async () => {
  const view = fold(finishedTurn());
  const { container, render } = await mount(view);
  await click(container.querySelector('.ai-group-head'));
  assert.equal(container.querySelectorAll('.ai-tool').length, 4);
  await render(ui.reduceChat(view, [agentText(TURN, ' more', 200_000)]));
  assert.equal(container.querySelectorAll('.ai-tool').length, 4, 'a re-render does not fold it');
  const second = await mount(view);
  assert.equal(second.container.querySelectorAll('.ai-tool').length, 4, 'a remount (another visit to the chat) remembers');

  await act(async () => ui.collapseAllItems(CHAT));
  assert.equal(container.querySelectorAll('.ai-tool').length, 0);
  await act(async () => ui.expandAllItems(CHAT));
  assert.equal(container.querySelectorAll('.ai-tool').length, 4);
});

test('an edit with a diff in a running turn is open to be approved; the same edit later is one closed line', async () => {
  const diff = { path: '/site/a.txt', oldText: 'one\n', newText: 'two\n' };
  const running = fold(
    turnStart(TURN, 1),
    user(TURN, 'edit', 1),
    tool(TURN, 'e1', { title: 'Edit a.txt', toolKind: 'edit', paths: ['/site/a.txt'], diffs: [diff], at: 2 }),
  );
  const { container, render } = await mount(running);
  assert.ok(container.querySelector('.ai-tool .ai-tool-body'), 'live: the diff is in view');
  const ended = ui.reduceChat(running, [tool(TURN, 'e1', { status: 'completed', at: 3 }), turnEnd(TURN, 4)]);
  await render(ended);
  assert.equal(container.querySelectorAll('.ai-tool').length, 0, 'the finished turn is one line');
});

test('output is bounded: a huge log shows its end with a count of what is hidden and "Show all" on request', async () => {
  const huge = `${'x'.repeat(150_000)}\nTHE-END`;
  const view = fold(
    turnStart(TURN, 1),
    user(TURN, 'run', 1),
    tool(TURN, 'c1', { title: 'big', toolKind: 'execute', command: 'big', output: huge, status: 'completed', at: 2 }),
    turnEnd(TURN, 3),
  );
  const { container } = await mount(view);
  await click(container.querySelector('.ai-group-head'));
  await click(container.querySelector('.ai-tool-head'));
  const shown = container.querySelector('.ai-tool-output').textContent;
  assert.ok(shown.length <= model.OUTPUT_PREVIEW_CHARS, 'a preview, not 150 000 characters');
  assert.match(shown, /THE-END$/, 'a command is read from its end');
  assert.match(text(container, '.ai-tool-more'), /144,\d{3} earlier characters hidden/);
  await click(container.querySelector('.ai-tool-showall'));
  assert.equal(container.querySelector('.ai-tool-output').textContent.length, huge.length);
  assert.equal(container.querySelector('.ai-tool-showall') ?? undefined, undefined);
});

test('an unknown kind of call degrades to a generic card; a call with nothing to show has no chevron to open', async () => {
  const view = fold(
    turnStart(TURN, 1),
    user(TURN, 'x', 1),
    tool(TURN, 'o1', { title: 'Mystery tool', toolKind: 'other', status: 'completed', at: 2 }),
    tool(TURN, 'o2', { title: 'Another', toolKind: 'other', status: 'failed', at: 2 }),
    turnEnd(TURN, 3),
  );
  const { container } = await mount(view);
  assert.match(text(container, '.ai-group-title'), /Used 2 tools/);
  assert.equal(text(container, '.ai-group-failed'), '1 failed');
  await click(container.querySelector('.ai-group-head'));
  const heads = [...container.querySelectorAll('.ai-tool-head')];
  assert.deepEqual(
    heads.map((head) => head.disabled),
    [true, true],
  );
  assert.deepEqual(
    heads.map((head) => head.textContent.includes('Mystery tool') || head.textContent.includes('Another')),
    [true, true],
  );
  assert.ok(container.querySelector('.ai-status-failed[aria-label="Failed"]'), 'status is announced, not only coloured');
});

test('a subagent card counts the calls nested under it', async () => {
  const view = fold(
    turnStart(TURN, 1),
    tool(TURN, 'sub', { title: 'Explore the repo', toolName: 'Task', at: 2 }),
    tool(TURN, 'k1', { title: 'Read a', toolKind: 'read', parent: 'sub', status: 'completed', at: 3 }),
    tool(TURN, 'k2', { title: 'Read b', toolKind: 'read', parent: 'sub', status: 'completed', at: 4 }),
  );
  const { container } = await mount(view);
  assert.equal(text(container, '.ai-tool-count'), '2 calls');
  assert.equal(container.querySelectorAll('.ai-tool-nested').length, 2);
});

test('thinking reads "Thought for 12s", opens to the thought, and shows no duration without stamps', async () => {
  const stamped = fold(
    turnStart(TURN, 1),
    user(TURN, 'think', 1),
    thought(TURN, 'Weighing **options**', 1000, 13_000),
    agentText(TURN, 'ok', 14_000),
    turnEnd(TURN, 15_000),
  );
  const { container } = await mount(stamped);
  await click(container.querySelector('.ai-group-head'));
  const head = container.querySelector('.ai-thought-head');
  assert.equal(head.textContent, 'Thought for 12s');
  assert.equal(container.querySelector('.ai-thought-body') ?? undefined, undefined);
  await click(head);
  assert.equal(head.getAttribute('aria-expanded'), 'true');
  assert.equal(text(container, '.ai-thought-body strong'), 'options');

  const old = fold(user(TURN, 'think', 1), thought(TURN, 'older', undefined, undefined), turnEnd(TURN, 2));
  const second = await mount(old, { chatId: `c${'b'.repeat(24)}` });
  await click(second.container.querySelector('.ai-group-head'));
  assert.equal(second.container.querySelector('.ai-thought-head').textContent, 'Thought');
  assert.doesNotMatch(second.container.textContent, /NaN|undefined/);
});

test('a streaming thought says it is thinking, with the loader', async () => {
  const view = fold(turnStart(TURN, 1), user(TURN, 'x', 1), thought(TURN, 'hmm', 2, 3));
  const { container } = await mount(view);
  const head = container.querySelector('.ai-thought-head');
  assert.match(head.textContent, /Thinking…/);
  assert.ok(head.querySelector('.loader-dots'));
});

test('a chat stored before timings draws without a timer, a duration or NaN', async () => {
  const old = fold(
    user(TURN, 'old', undefined),
    tool(TURN, 'r1', { title: 'Read a.ts', toolKind: 'read', status: 'completed', paths: ['/site/a.ts'] }),
    agentText(TURN, 'fine', undefined),
    { kind: 'turn-end', turn: TURN, stop: 'end_turn', message: undefined, at: 5 },
  );
  const { container } = await mount(old);
  await click(container.querySelector('.ai-group-head'));
  assert.equal(container.querySelector('.ai-group-time') ?? undefined, undefined);
  assert.equal(container.querySelector('.ai-tool-time') ?? undefined, undefined);
  assert.equal(container.querySelector('.ai-worked') ?? undefined, undefined);
  assert.doesNotMatch(container.textContent, /NaN|undefined|Infinity/);
});

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

test('a long reply is cut behind "Show more" once it is finished, never while it streams', async () => {
  const long = Array.from({ length: 80 }, (_, line) => `line ${line}`).join('\n\n');
  const streaming = fold(turnStart(TURN, 1), user(TURN, 'x', 1), agentText(TURN, long, 2));
  const first = await mount(streaming);
  assert.equal(first.container.querySelector('.ai-msg-folded') ?? undefined, undefined, 'a reply still arriving is drawn whole');
  assert.equal(first.container.querySelector('.ai-msg-more') ?? undefined, undefined);

  const finished = ui.reduceChat(streaming, [turnEnd(TURN, 3)]);
  await first.render(finished);
  assert.ok(first.container.querySelector('.ai-msg-folded'));
  const more = first.container.querySelector('.ai-msg-more');
  assert.equal(more.textContent, 'Show more');
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  await click(more);
  assert.equal(first.container.querySelector('.ai-msg-folded') ?? undefined, undefined);
  assert.equal(first.container.querySelector('.ai-msg-more').textContent, 'Show less');
});

test('the person’s last message can be copied, put back in the composer, or sent again; chips draw from parts', async () => {
  const copied = [];
  Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText: async (value) => copied.push(value) }, configurable: true });
  const parts = [
    { kind: 'text', text: 'Look at ' },
    { kind: 'file', path: 'src/pages/index.astro', truncated: false, excerpt: undefined },
    { kind: 'text', text: ' please' },
  ];
  const view = fold(user(TURN, 'Look at @src/pages/index.astro please', 1, { parts }), agentText(TURN, 'ok', 2), turnEnd(TURN, 3));
  const { container } = await mount(view);
  assert.equal(text(container, '.mention-chip-view'), 'index.astro', 'a mention is a chip in the line');
  assert.equal(text(container, '.ai-user-text'), 'Look at index.astro please');

  await click(container.querySelector('.ai-message-user [aria-label="Copy message"]'));
  assert.deepEqual(copied, ['Look at @src/pages/index.astro please'], 'the plain text is what is copied');

  await click(container.querySelector('[aria-label="Edit message"]'));
  assert.equal(
    ui
      .aiState()
      .drafts.get(CHAT)
      .segments.map((segment) => segment.text)
      .join(''),
    'Look at @src/pages/index.astro please',
    'the words are back in the composer, nothing is sent',
  );
  assert.equal(calls.filter((call) => call.name === 'aiPrompt').length, 0);

  await click(container.querySelector('[aria-label="Send message again"]'));
  assert.equal(calls.find((call) => call.name === 'aiPrompt').payload.text, 'Look at @src/pages/index.astro please');
});

test('only the last message offers edit and resend, and not while a turn runs', async () => {
  const two = fold(finishedTurn(turnId(1)), finishedTurn(turnId(2), 500_000));
  const { container, render } = await mount(two);
  assert.equal(container.querySelectorAll('[aria-label="Edit message"]').length, 1);
  assert.equal(container.querySelectorAll('.ai-message-user').length, 2);
  await render(ui.reduceChat(two, [turnStart(turnId(3), 900_000), user(turnId(3), 'again', 900_000)]));
  assert.equal(container.querySelectorAll('[aria-label="Edit message"]').length, 0);
});

// ---------------------------------------------------------------------------
// Plan, background tasks, compaction
// ---------------------------------------------------------------------------

test('the plan card shows done of total and the step in hand, and opens to the checklist with live status', async () => {
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  mounted.push({ root, container });
  const plan = {
    turn: TURN,
    entries: [
      { content: 'Read the config', status: 'completed' },
      { content: 'Edit the layout', status: 'in_progress' },
      { content: 'Run the build', status: 'pending' },
    ],
  };
  await act(async () => root.render(React.createElement(ui.PlanCard, { plan, chat: CHAT })));
  assert.equal(text(container, '.ai-plan-count'), '1/3');
  assert.equal(text(container, '.ai-plan-current'), 'Edit the layout');
  assert.equal(container.querySelector('.ai-plan-entries') ?? undefined, undefined);
  await click(container.querySelector('.ai-plan-head'));
  const items = [...container.querySelectorAll('.ai-plan-entries li')];
  assert.deepEqual(
    items.map((item) => item.className),
    ['ai-plan-completed', 'ai-plan-in_progress', 'ai-plan-pending'],
  );
  assert.ok(items[1].querySelector('.loader-dots'), 'the step in hand shows the loader');
  assert.ok(items[0].querySelector('svg'), 'a done step shows a check');
  await act(async () =>
    root.render(
      React.createElement(ui.PlanCard, { plan: { turn: TURN, entries: plan.entries.map((entry) => ({ ...entry, status: 'completed' })) }, chat: CHAT }),
    ),
  );
  assert.equal(text(container, '.ai-plan-current'), 'Plan complete');
});

test('the background tray lists running work with its elapsed time and last output line; "Stop agent" cancels the turn', async () => {
  clock = 20_000;
  const view = fold(
    turnStart(TURN, 1000),
    user(TURN, 'serve', 1000),
    tool(TURN, 'bg', { title: 'npm run dev', toolKind: 'execute', command: 'npm run dev', background: true, output: 'ready on :4321\n', at: 2000 }),
    tool(TURN, 'sub', { title: 'Explore the repo', toolName: 'Task', at: 5000 }),
    agentText(TURN, 'started', 6000),
    turnEnd(TURN, 7000),
  );
  assert.equal(view.activeTasks.length, 2, 'the reducer reports both as open work');
  const { container } = await mount(view);
  const head = container.querySelector('.ai-tasks-head');
  assert.equal(head.textContent, '2 tasks running');
  assert.equal(container.querySelector('.ai-task') ?? undefined, undefined, 'a closed tray lists nothing');
  assert.equal(intervals.size, 0, 'and ticks nothing');
  await click(head);
  const rows = [...container.querySelectorAll('.ai-task')];
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /npm run dev/);
  assert.equal(text(rows[0], '.ai-task-time'), '18s', 'elapsed since the call began');
  assert.equal(text(rows[0], '.ai-task-peek'), 'ready on :4321');
  assert.equal(text(rows[1], '.ai-task-time'), '15s');
  assert.equal(intervals.size, 1, 'one shared interval for every row');
  const controls = [...container.querySelectorAll('.ai-tasks button')].map((control) => control.textContent);
  assert.deepEqual(controls, ['2 tasks running', 'Stop agent'], '"Stop agent" is the only control');
  await click(container.querySelector('.ai-tasks-stop'));
  assert.equal(calls.find((call) => call.name === 'aiCancel').payload.chat, CHAT);
});

test('a finished background task moves to the tray’s finished list and the tray clears when nothing is left to show', async () => {
  const running = fold(turnStart(TURN, 1000), user(TURN, 'x', 1000), tool(TURN, 'sub', { title: 'Explore', toolName: 'Task', at: 2000 }));
  const { container, render } = await mount(running);
  assert.match(text(container, '.ai-tasks-head'), /1 task running/);
  const done = ui.reduceChat(running, [tool(TURN, 'sub', { status: 'completed', at: 9000 }), turnEnd(TURN, 9500)]);
  await render(done);
  assert.equal(text(container, '.ai-tasks-head'), '1 task finished');
  assert.equal(container.querySelector('.ai-tasks-stop') ?? undefined, undefined, 'nothing is running, nothing to stop');
  await render(ui.EMPTY_CHAT);
  assert.equal(container.querySelector('.ai-tasks') ?? undefined, undefined, 'no tray without tasks');
});

test('the compaction row: in progress with the loader, then what it saved, or that it failed', async () => {
  const progress = fold(
    user(TURN, 'x', 1),
    { kind: 'usage', used: 82_000, size: 200_000 },
    { kind: 'compaction', turn: undefined, id: 'k1', status: 'in_progress', at: 5 },
  );
  const { container, render } = await mount(progress);
  assert.equal(text(container, '.ai-compaction'), 'Compacting conversation…');
  assert.ok(container.querySelector('.ai-compaction .loader-dots'));
  const completed = ui.reduceChat(progress, [
    { kind: 'compaction', turn: undefined, id: 'k1', status: 'completed', at: 6 },
    { kind: 'usage', used: 40_000, size: 200_000 },
  ]);
  await render(completed);
  assert.equal(container.querySelectorAll('.ai-compaction').length, 1, 'one row per compaction');
  assert.equal(text(container, '.ai-compaction'), 'Conversation compacted · saved ~42K tokens');
  await render(
    fold(
      user(TURN, 'x', 1),
      { kind: 'compaction', turn: undefined, id: 'k2', status: 'in_progress', at: 5 },
      { kind: 'compaction', turn: undefined, id: 'k2', status: 'failed', at: 6 },
    ),
  );
  assert.equal(text(container, '.ai-compaction'), 'Compaction failed');
  assert.ok(container.querySelector('.ai-compaction-failed'));
  await render(
    fold(
      user(TURN, 'x', 1),
      { kind: 'compaction', turn: undefined, id: 'k3', status: 'in_progress', at: 5 },
      { kind: 'compaction', turn: undefined, id: 'k3', status: 'failed', at: 6, error: 'OAuth access token has expired' },
    ),
  );
  assert.equal(text(container, '.ai-compaction'), 'Compaction failed · OAuth access token has expired', 'the reason the agent gave is on the row');
});

// ---------------------------------------------------------------------------
// Scrolling and size
// ---------------------------------------------------------------------------

function fakeLayout(element, layout) {
  Object.defineProperty(element, 'scrollHeight', { get: () => layout.scrollHeight, configurable: true });
  Object.defineProperty(element, 'clientHeight', { get: () => layout.clientHeight, configurable: true });
  let top = layout.scrollTop;
  Object.defineProperty(element, 'scrollTop', { get: () => top, set: (value) => (top = value), configurable: true });
  return {
    scrollTo(value) {
      top = value;
      element.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }));
    },
  };
}

test('the view follows the newest line, stops when the person scrolls up, and "Jump to latest" brings it back', async () => {
  const view = fold(turnStart(TURN, 1), user(TURN, 'x', 1), agentText(TURN, 'streaming', 2));
  const { container, render } = await mount(view);
  const scroller = container.querySelector('.ai-transcript');
  const layout = { scrollHeight: 2000, clientHeight: 400, scrollTop: 1600 };
  const control = fakeLayout(scroller, layout);
  await render(ui.reduceChat(view, [agentText(TURN, ' more', 3)]));
  assert.equal(scroller.scrollTop, 1600, 'at the bottom: the view stays with the newest line');

  layout.scrollHeight = 2400;
  await render(ui.reduceChat(view, [agentText(TURN, ' more words', 4)]));
  assert.equal(scroller.scrollTop, 2000, 'new content: followed to the end');

  // The person scrolls up.
  await act(async () => {
    scroller.dispatchEvent(new dom.window.Event('wheel', { bubbles: true }));
    control.scrollTo(300);
  });
  assert.ok(container.querySelector('.ai-latest'), 'scrolled away: the button appears');
  layout.scrollHeight = 2800;
  await render(ui.reduceChat(view, [agentText(TURN, ' still arriving', 5)]));
  assert.equal(scroller.scrollTop, 300, 'the person is not yanked back while they read');

  await click(container.querySelector('.ai-latest'));
  assert.equal(scrolls.at(-1).behavior, 'smooth');
  assert.equal(scrolls.at(-1).top, 2800);
});

test('2 000 tool calls fold into groups, and a streamed word re-renders the tail and not the thousand above it', async () => {
  const events = [turnStart(TURN, 1), user(TURN, 'big', 1)];
  for (let number = 0; number < 2000; number += 1) {
    events.push(tool(TURN, `k${number}`, { title: `Read ${number}`, toolKind: 'read', status: 'completed', paths: [`/site/f${number}.ts`], at: 2 + number }));
    if (number % 100 === 99) {
      events.push(agentText(TURN, `step ${number}`, 3 + number));
    }
  }
  const view = fold(events);
  const { container, render } = await mount(view);
  assert.equal(container.querySelectorAll('.ai-group').length, 20, 'twenty runs of a hundred calls');
  assert.equal(container.querySelectorAll('.ai-tool').length, 100, 'only the live group is open');
  const next = ui.reduceChat(view, [agentText(TURN, ' and one more word', 99_999)]);
  const started = performance.now();
  await render(next);
  const took = performance.now() - started;
  assert.ok(took < 300, `re-render after a text append took ${took.toFixed(0)}ms`);
});

test('a chat longer than the window draws the newest rows and offers the earlier ones', async () => {
  const events = [turnStart(TURN, 1)];
  for (let number = 0; number < 500; number += 1) {
    events.push(user(TURN, `message ${number}`, number), agentText(TURN, `reply ${number}`, number));
  }
  events.push(turnEnd(TURN, 9999));
  const { container } = await mount(fold(events));
  assert.ok(container.querySelectorAll('.ai-message').length <= 400, 'a bounded number of rows in the DOM');
  const earlier = container.querySelector('.ai-earlier');
  assert.match(earlier.textContent, /Show 400 earlier|Show \d+ earlier/);
  assert.match(container.textContent, /reply 499/);
  assert.doesNotMatch(container.textContent, /message 0\b/);
  await click(earlier);
  assert.ok(container.querySelectorAll('.ai-message').length > 400);
});
