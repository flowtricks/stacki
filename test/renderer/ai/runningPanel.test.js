// Goal: the Running chip and panel, and the inline subagent unit, show a designer what is going on and nothing a
// developer would read until it is asked for. The chip shows only while something runs or the current run just
// finished, and reads "1 agent working", "1 background command", "1 agent finished"; a click opens the panel, a
// second click, Escape or a press outside closes it. The panel counts its sections (Running with its rows, Finished
// folded with its count), an agent opens to "31 tasks, 1 running" and its steps; a step opens to its calls in words,
// and its "Show commands" stays closed (even after the chat's "Expand all") until clicked, which reveals the exact
// command highlighted, the paths and the error. The negative space: no raw JSON, no tool-call or agent id, no run of
// hex, no secret env value and no command line is in the default DOM; no row has a Stop of its own (the adapter
// cannot stop one subagent for Stacki); the panel's one "Stop agent" shows only while the turn can be stopped, and
// sends `ai:cancel`.
// Method: the real components are bundled with esbuild and mounted in jsdom; views are folded by the real wire
// parser, the host's event builder and the reducer from test/fixtures/ai/runningWork.jsonl; clicks are real DOM
// events and the DOM text is read back.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/runningPanel.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export { RunningChip } from './src/features/ai/transcript/RunningPanel';",
      "export { SubagentCard } from './src/features/ai/transcript/SubagentCard';",
      "export { deriveSubagentWork } from './src/features/ai/subagents';",
      "export { expandAllItems, resetTranscriptUi } from './src/features/ai/transcript/transcriptUi';",
      "export { EMPTY_CHAT, reduceChat } from './src/features/ai/chatReducer';",
      "export { loadAiProject, resetAiStore } from './src/features/ai/aiStore';",
      "export { parseAcpLine, parseSessionNotification } from './shared/properties/ai/acpWire';",
      "export { eventsForUpdate } from './electron/handlers/ai/chatEvents';",
      "export { parseChatEvent } from './shared/properties/ai/chatModel';",
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
// Reduced motion: a popup's exit finishes in a microtask instead of after its 160 ms motion, so a close is seen at once.
dom.window.matchMedia = (query) => ({
  matches: query.includes('reduce'),
  media: query,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
});
dom.window.HTMLElement.prototype.scrollTo = () => undefined;
dom.window.HTMLElement.prototype.scrollIntoView = () => undefined;

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const ui = require(output);

const CHAT = `c${'b'.repeat(24)}`;
const TURN = `t${'1'.padStart(16, '0')}`;
const HEX_RUN = /[0-9a-f]{12,}/iu;
const LINES = fs
  .readFileSync(repoPath('test/fixtures/ai/runningWork.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line !== '')
  .map((line) => JSON.parse(line));

function viewOf(scenarios, end) {
  const events = [
    { kind: 'turn-start', turn: TURN, at: 0 },
    { kind: 'user', turn: TURN, text: 'go', attachments: [], at: 0 },
  ];
  for (const entry of LINES.filter((line) => scenarios.includes(line.scenario))) {
    const message = ui.parseAcpLine(entry.line);
    const notification = ui.parseSessionNotification(message.value.params);
    events.push(...ui.eventsForUpdate(notification.value.update, TURN, { at: entry.at }).map((event) => ui.parseChatEvent(JSON.parse(JSON.stringify(event)))));
  }
  if (end !== undefined) {
    events.push({ kind: 'turn-end', turn: TURN, stop: end, message: undefined, at: 20_000 });
  }
  return ui.reduceChat(ui.EMPTY_CHAT, events);
}

const mounted = [];
async function mount(element) {
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  await act(async () => root.render(element));
  mounted.push({ root, container });
  return { container, root };
}
const chip = (view) => React.createElement(ui.RunningChip, { view, chatId: CHAT, projectPath: '/site' });
const click = (element) => act(async () => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
const press = (element) =>
  act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));
    element.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
  });
const byText = (container, selector, wanted) => [...container.querySelectorAll(selector)].find((element) => element.textContent.includes(wanted));

/** Nothing technical: no JSON, no ids, no hex, no command line, no secret. */
function assertDesignerFriendly(container, label) {
  const shown = container.textContent;
  assert.ok(!shown.includes('{"'), `${label}: no JSON in "${shown}"`);
  assert.ok(!/[{}]/u.test(shown), `${label}: no braces`);
  assert.ok(!shown.includes('toolu_'), `${label}: no tool call id`);
  assert.ok(!HEX_RUN.test(shown), `${label}: no id or hash in "${shown}"`);
  assert.ok(!shown.includes('mcp__'), `${label}: no internal tool name`);
  for (const raw of ['ghp_', 'GH_TOKEN', 'sk-live', 'OPENAI_API_KEY', 'ELECTRON_RUN_AS_NODE', 'npm run', 'git push', 'node scripts/', '/site/src/']) {
    assert.ok(!shown.includes(raw), `${label}: no "${raw}" in the default view: "${shown}"`);
  }
  assert.equal(container.querySelectorAll('.code-inline, .code-block, .log-block').length, 0, `${label}: no code or log drawn`);
}

test.beforeEach(async () => {
  window.avb = {
    aiAgents: async () => ({ trusted: true, agents: [], options: [] }),
    aiChats: async () => ({ chats: [], sections: [] }),
    aiCancel: async (payload) => {
      window.cancelled.push(payload);
      return { ok: true };
    },
    aiAck: () => undefined,
    onAiEvents: () => () => undefined,
    onAiAgentStatus: () => () => undefined,
    onAiSetup: () => () => undefined,
    platform: 'darwin',
  };
  window.cancelled = [];
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

test('the chip shows only while something runs or the current run just finished, in words', async () => {
  const quiet = ui.reduceChat(ui.EMPTY_CHAT, [{ kind: 'user', turn: TURN, text: 'hi', attachments: [], at: 0 }]);
  const hidden = await mount(chip(quiet));
  assert.equal(hidden.container.querySelector('.ai-running-chip') ?? undefined, undefined, 'nothing runs: no chip');
  assert.equal(hidden.container.textContent, '');

  const live = await mount(chip(viewOf(['long'])));
  assert.equal(live.container.querySelector('.ai-running-chip').textContent, '1 agent working');
  const both = await mount(chip(viewOf(['long', 'background'])));
  assert.equal(both.container.querySelector('.ai-running-chip').textContent, '1 agent working, 1 background command');
  const finished = await mount(chip(viewOf(['failed'], 'end_turn')));
  assert.equal(finished.container.querySelector('.ai-running-chip').textContent, '1 agent finished1 failed');
  assert.ok(finished.container.querySelector('.ai-running-chip .ai-agents-failed'), 'the failure is its own red part');
  for (const { container } of [live, both, finished]) {
    assertDesignerFriendly(container, 'the chip');
  }
});

test('the chip toggles the panel; Escape and a press outside close it; the sections are counted', async () => {
  const { container } = await mount(chip(viewOf(['long', 'background', 'failed'])));
  const button = container.querySelector('.ai-running-chip');
  assert.equal(container.querySelector('.ai-running-panel') ?? undefined, undefined, 'closed at first');
  await click(button);
  const panel = container.querySelector('.ai-running-panel');
  assert.ok(panel, 'a click opens the panel');
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  const sections = [...panel.querySelectorAll('.ai-running-section-head')].map((head) => head.textContent);
  assert.deepEqual(
    sections,
    ['Running2Stop agent', 'Finished2'],
    'Running with its two rows and Stop; Finished (the failed agent, the finished tests) folded with its count',
  );
  assert.equal(
    panel.querySelectorAll('.ai-running-section')[1].querySelector('.ai-running-list') ?? undefined,
    undefined,
    'Finished is folded while something runs',
  );
  const rows = [...panel.querySelectorAll('.ai-running-name')].map((name) => name.textContent);
  assert.deepEqual(rows, ['Release Stacki 1.4.14', 'Dev server'], 'the agent’s cleaned title, the command’s friendly name');
  assert.ok(byText(panel, '.ai-running-row', 'Release Stacki').textContent.includes('31 tasks, 1 running'));
  assert.ok(byText(panel, '.ai-running-row', 'Release Stacki').textContent.includes('Sonnet'), 'the model it runs on');
  assertDesignerFriendly(container, 'the opened panel');

  // Finished opens to its rows.
  await click(panel.querySelector('.ai-running-fold'));
  assert.ok(byText(panel, '.ai-running-row', 'Migrate the config'), 'the finished agent is listed');

  await click(button);
  assert.equal(container.querySelector('.ai-running-panel') ?? undefined, undefined, 'a second click closes it');
  await click(button);
  await act(async () => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(container.querySelector('.ai-running-panel') ?? undefined, undefined, 'Escape closes it');
  await click(button);
  const outside = document.body.appendChild(document.createElement('button'));
  await press(outside);
  assert.equal(container.querySelector('.ai-running-panel') ?? undefined, undefined, 'a press outside closes it');
  outside.remove();
});

test('nothing runs: Finished is all there is, so it starts open; Show more pages through it', async () => {
  const stopped = await mount(chip(viewOf(['stopped'], 'cancelled')));
  await click(stopped.container.querySelector('.ai-running-chip'));
  const panel = stopped.container.querySelector('.ai-running-panel');
  assert.equal(panel.querySelectorAll('.ai-running-section').length, 1, 'no Running section');
  assert.ok(panel.querySelector('.ai-running-list'), 'Finished starts open');
  assert.ok(byText(panel, '.ai-running-row', 'Survey the components').classList.contains('ai-running-stopped'));
  const failed = await mount(chip(viewOf(['failed'], 'end_turn')));
  await click(failed.container.querySelector('.ai-running-chip'));
  assert.ok(byText(failed.container, '.ai-running-row', 'Migrate the config').classList.contains('ai-running-failed'));
  assert.ok(byText(failed.container, '.ai-running-summary', '2 tasks'), 'a finished agent counts its tasks, none running');

  // Many finished agents: a page at a time, newest first.
  const events = [{ kind: 'user', turn: TURN, text: 'go', attachments: [], at: 0 }];
  for (let index = 0; index < 12; index += 1) {
    events.push({
      kind: 'tool',
      turn: TURN,
      call: `toolu_${index}`,
      title: `Task ${index}`,
      toolKind: 'think',
      toolName: 'Agent',
      status: 'completed',
      at: 1000 + index,
    });
  }
  const many = await mount(chip(ui.reduceChat(ui.EMPTY_CHAT, events)));
  await click(many.container.querySelector('.ai-running-chip'));
  const names = () => [...many.container.querySelectorAll('.ai-running-name')].map((name) => name.textContent);
  assert.deepEqual(names(), ['Task 11', 'Task 10', 'Task 9', 'Task 8', 'Task 7'], 'the first page, newest first');
  await click(byText(many.container, '.ai-steps-more', 'Show more'));
  assert.equal(names().length, 10, 'Show more adds a page');
});

test('an agent opens to its steps; a step opens to its calls; its commands stay hidden until asked, even after Expand all', async () => {
  const { container } = await mount(chip(viewOf(['long'])));
  await click(container.querySelector('.ai-running-chip'));
  const panel = container.querySelector('.ai-running-panel');
  await click(panel.querySelector('.ai-running-head'));
  const labels = [...panel.querySelectorAll('.ai-steps > li > .ai-step-unit .ai-step-label')].map((label) => label.textContent);
  assert.deepEqual(labels, ['Asked you a question', 'Used Get Page Layout (2 times)', 'Read 8 files', 'Started the dev server'], 'the newest steps');
  const fold = panel.querySelector('.ai-step-fold');
  assert.ok(fold.textContent.includes('earlier steps'), 'the older steps fold');
  await click(fold);
  assert.ok(byText(panel, '.ai-step', 'Edited 3 files (Button.astro, Hero.astro, …)'), 'the earlier steps open');
  assertDesignerFriendly(container, 'the opened agent and its earlier steps');

  // A step opens to its calls in words; the commands are still not drawn.
  await click(byText(panel, '.ai-step', 'Ran the tests (2 times)'));
  const tests = byText(panel, '.ai-step-unit', 'Ran the tests (2 times)');
  assert.deepEqual(
    [...tests.querySelectorAll('.ai-step-call .ai-step-label')].map((label) => label.textContent),
    ['Ran the tests', 'Ran the tests'],
  );
  assert.ok(tests.querySelector('.ai-step-call.ai-step-failed'), 'the failed run is marked failed');
  const reveal = tests.querySelector('.ai-step-reveal');
  assert.equal(reveal.textContent, 'Show commands');
  assert.equal(reveal.getAttribute('aria-expanded'), 'false');
  await act(async () => ui.expandAllItems(CHAT));
  assert.equal(tests.querySelector('.ai-step-technical') ?? undefined, undefined, 'Expand all opens steps, never the commands');
  assertDesignerFriendly(container, 'after Expand all');

  // Revealed: the exact commands, highlighted, and the failure's raw payload behind its own Show details.
  await click(reveal);
  const technical = tests.querySelector('.ai-step-technical');
  assert.ok(technical, 'Show commands reveals the technical rows');
  const commands = [...technical.querySelectorAll('.code-inline')].map((code) => code.textContent);
  assert.deepEqual(commands, ['env -u ELECTRON_RUN_AS_NODE npm test -- subagents', 'env -u ELECTRON_RUN_AS_NODE npm test -- subagents']);
  assert.ok(technical.querySelector('.ai-tool-details'), 'a JSON error sits behind Show details');
  assert.ok(!technical.textContent.includes('"stack"'), 'and stays closed');
  assert.equal(reveal.textContent, 'Hide commands');

  // A file step (opened by Expand all) reveals its paths, shortened, whole in the tooltip.
  assert.equal(byText(panel, '.ai-step', 'Edited 3 files').getAttribute('aria-expanded'), 'true');
  const edits = byText(panel, '.ai-step-unit', 'Edited 3 files');
  await click(edits.querySelector('.ai-step-reveal'));
  const paths = [...edits.querySelectorAll('.ai-step-path')];
  assert.deepEqual(
    paths.map((element) => element.getAttribute('title')),
    ['/site/src/components/Button.astro', '/site/src/components/Hero.astro', '/site/src/components/Nav.astro'],
  );
  assert.equal(paths[0].textContent, 'src/components/Button.astro', 'relative to the project');
});

test('no row has a Stop of its own; the one Stop shows only while the turn can be stopped, and stops it', async () => {
  const live = await mount(chip(viewOf(['long', 'background'])));
  await click(live.container.querySelector('.ai-running-chip'));
  const panel = live.container.querySelector('.ai-running-panel');
  for (const row of panel.querySelectorAll('.ai-running-row')) {
    assert.equal(byText(row, 'button', 'Stop'), undefined, 'a row has no Stop: the adapter cannot stop one subagent');
  }
  const stop = panel.querySelector('.ai-running-stop');
  assert.equal(stop.textContent, 'Stop agent');
  assert.ok(stop.getAttribute('title').includes('whole turn'), 'it says what it stops');
  await click(stop);
  assert.equal(window.cancelled.length, 1, 'ai:cancel was sent');
  assert.equal(window.cancelled[0].chat, CHAT);

  const ended = await mount(chip(viewOf(['failed'], 'end_turn')));
  await click(ended.container.querySelector('.ai-running-chip'));
  assert.equal(ended.container.querySelector('.ai-running-stop') ?? undefined, undefined, 'nothing to stop once the turn ended');
});

test('the inline unit draws the same steps, its commands behind the same disclosure', async () => {
  const view = viewOf(['long']);
  const unit = ui.deriveSubagentWork(view).units.get('toolu_long');
  const { container } = await mount(
    React.createElement(ui.SubagentCard, { unit, chatId: CHAT, projectPath: '/site', options: [], reveal: undefined, onOpenTranscript: () => undefined }),
  );
  assert.equal(container.querySelector('.ai-subagent-title').textContent, 'Release Stacki 1.4.14');
  await click(container.querySelector('.ai-subagent-head'));
  assert.ok(container.querySelector('.ai-steps'), 'the unit lists steps, not command cards');
  assert.equal(container.querySelectorAll('.ai-tool-head').length, 0, 'no raw tool cards by default');
  assert.ok(byText(container, '.ai-step', 'Started the dev server'));
  await act(async () => ui.expandAllItems(CHAT));
  assertDesignerFriendly(container, 'the expanded unit');
  const reveal = byText(container, '.ai-step-unit', 'Started the dev server').querySelector('.ai-step-reveal');
  await click(reveal);
  assert.ok(byText(container, '.code-inline', 'npm run dev -- --port 4321'), 'the command, revealed');
});
