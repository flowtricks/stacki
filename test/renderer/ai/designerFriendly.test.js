// Goal: the AI panel's transcript is written for designers, not developers. Whatever a tool returns (JSON
// with ids, an error with its stack, a bare tool name such as `mcp__ccd_session__start_session`), the
// transcript says in plain words what happened, to what: "Started a session", "Follow-up to Audit the hero".
// Raw payloads stay out of the default view and sit behind a labelled "Show details" control that is closed
// until asked. The negative space is the point: no `{"`, no `resumedAgentId`, no `mcp__`, no run of 12 or
// more hex characters (an agent id or hash) may appear in the text of any card unless the person opened
// "Show details"; a follow-up whose reply is a failure, or is not what it should be, becomes a toast and
// never JSON in the DOM; a tool name nobody has seen still reads as words and never grows past its bound.
// Method: the pure wording (toolWords.ts, the follow-up verdict in subagents.ts) is tested as a table, the
// wire path (a SendMessage call's `message` and `to`) through the real wire parser, the host's event
// builder and the reducer, and the cards are bundled with esbuild and mounted in jsdom with views folded
// by the real reducer, every card opened, and the whole DOM text read back.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/designerFriendly.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export { Transcript } from './src/features/ai/transcript/TranscriptView';",
      "export * as words from './src/features/ai/transcript/toolWords';",
      "export * as subagents from './src/features/ai/subagents';",
      "export { ENGLISH_TRANSLATE } from './shared/properties/i18n/englishTranslator';",
      "export { expandAllItems, resetTranscriptUi } from './src/features/ai/transcript/transcriptUi';",
      "export { EMPTY_CHAT, reduceChat } from './src/features/ai/chatReducer';",
      "export { aiState, loadAiProject, resetAiStore } from './src/features/ai/aiStore';",
      "export { parseAcpLine, parseSessionNotification } from './shared/properties/ai/acpWire';",
      "export { eventsForUpdate } from './electron/handlers/ai/chatEvents';",
      "export { parseChatEvent } from './shared/properties/ai/chatModel';",
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
const english = ui.ENGLISH_TRANSLATE;

const CHAT = `c${'a'.repeat(24)}`;
const TURN = `t${'1'.padStart(16, '0')}`;
const AGENT_ID = 'a7a4cd56faec575c0';
const HEX_ID = /[0-9a-f]{12,}/iu;

const tool = (call, over = {}) => ({
  kind: 'tool',
  turn: TURN,
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
const fold = (...events) =>
  ui.reduceChat(ui.EMPTY_CHAT, [{ kind: 'turn-start', turn: TURN, at: 0 }, { kind: 'user', turn: TURN, text: 'go', attachments: [], at: 0 }, ...events.flat()]);
const done = (call, over) => [tool(call, { ...over, status: 'pending' }), tool(call, { status: over.status ?? 'completed', at: 3000, output: over.output })];

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
        onOpenSubagent: () => undefined,
      }),
    );
  });
  mounted.push({ root, container });
  await act(async () => ui.expandAllItems(CHAT));
  return container;
}
const click = (element) => act(async () => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
const byText = (container, selector, wanted) => [...container.querySelectorAll(selector)].find((element) => element.textContent.includes(wanted));

/** Nothing a developer would read: JSON, a protocol field, a tool's internal name, an id. */
function assertNoJargon(container, label) {
  const shown = container.textContent;
  assert.ok(!shown.includes('{"'), `${label}: no JSON in "${shown}"`);
  assert.ok(!/[{}]/u.test(shown), `${label}: no braces in "${shown}"`);
  assert.ok(!shown.includes('resumedAgentId'), `${label}: no protocol field`);
  assert.ok(!shown.includes('mcp__'), `${label}: no internal tool name`);
  assert.ok(!shown.includes('agentId'), `${label}: no agent id line`);
  assert.ok(!HEX_ID.test(shown), `${label}: no id or hash in "${shown}"`);
}

test.beforeEach(async () => {
  window.avb = {
    aiAgents: async () => ({ trusted: true, agents: [], options: [] }),
    aiChats: async () => ({ chats: [], sections: [] }),
    aiCancel: async () => ({ ok: true }),
    aiAck: () => undefined,
    onAiEvents: () => () => undefined,
    onAiAgentStatus: () => () => undefined,
    onAiSetup: () => () => undefined,
    platform: 'darwin',
  };
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

// ---------------------------------------------------------------------------
// Wording, as a table
// ---------------------------------------------------------------------------

const PHRASES = [
  ['Read', 'Read a file'],
  ['Edit', 'Edited a file'],
  ['Write', 'Wrote a file'],
  ['Bash', 'Ran a command'],
  ['Grep', 'Searched the project'],
  ['Glob', 'Looked for files'],
  ['WebSearch', 'Searched the web'],
  ['WebFetch', 'Read a web page'],
  ['Task', 'Started a helper'],
  ['TodoWrite', 'Updated the to-do list'],
  ['ToolSearch', 'Looked for a tool'],
  ['Skill', 'Used a skill'],
  ['Workflow', 'Ran a workflow'],
  ['SendMessage', 'Sent a follow-up message'],
  ['mcp__ccd_session__start_session', 'Started a session'],
  ['mcp__ccd_session__send_message', 'Sent a follow-up message'],
  ['web_search', 'Searched the web'],
  // Unknown tools read as words, with the `mcp__server__` prefix gone.
  ['mcp__figma__get_design_context', 'Used Get Design Context'],
  ['mcp__99f61507-110c-4418-9ad3-99aa7b504d15__data_pages_tool', 'Used Data Pages Tool'],
  ['getPageLayout', 'Used Get Page Layout'],
  ['frobnicate', 'Used Frobnicate'],
  // Empty, blank and prefix-only names still say something.
  ['', 'Used a tool'],
  ['   ', 'Used a tool'],
  ['mcp__', 'Used a tool'],
  ['mcp__server__', 'Used a tool'],
  ['___', 'Used a tool'],
];
for (const [name, expected] of PHRASES) {
  test(`toolPhrase(${JSON.stringify(name)}) reads "${expected}"`, () => {
    assert.equal(ui.words.toolPhrase(name, english), expected);
  });
}

test('a very long or hostile tool name is bounded and still words', () => {
  const long = ui.words.toolPhrase(`mcp__server__${'very_long_tool_name_'.repeat(500)}`, english);
  assert.ok(long.startsWith('Used '), long);
  assert.ok(long.length <= 'Used '.length + ui.words.TOOL_PHRASE_CHARS_MAX, `bounded: ${long.length}`);
  assert.ok(long.endsWith('…'), 'a cut name is marked');
  const noise = ui.words.toolPhrase('{"a":1}[]<script>', english);
  assert.ok(!/[{}<>[\]"]/u.test(noise), `no punctuation of a payload: ${noise}`);
});

test('only a bare tool name is replaced; a title the agent wrote as a sentence stays as it is', () => {
  const friendly = (title, toolName) => ui.words.friendlyToolTitle(title, toolName, english);
  assert.equal(friendly('Read src/index.astro', 'Read'), undefined);
  assert.equal(friendly('Edit Hero.astro', undefined), undefined);
  assert.equal(friendly('Searching the web for hero ideas', undefined), undefined);
  assert.equal(friendly('', undefined), undefined);
  assert.equal(friendly('mcp__ccd_session__start_session', undefined), 'Started a session');
  assert.equal(friendly('start_session', undefined), 'Started a session');
  assert.equal(friendly('ccd_session/start_session', undefined), 'Started a session');
  assert.equal(friendly('WebFetch', undefined), 'Read a web page');
  assert.equal(friendly('{"url":"https://example.com"}', 'WebFetch'), 'Read a web page', 'a title that is JSON never shows');
  assert.equal(friendly('[1,2]', undefined), 'Used a tool');
});

test('JSON is recognised as a payload, prose and a command log are not', () => {
  assert.equal(ui.words.looksLikeJson('{"success":true,"pin":{"id":"x"}}'), true);
  assert.equal(ui.words.looksLikeJson('  [1, 2, 3] '), true);
  assert.equal(ui.words.looksLikeJson('{"cut": "a payload that was cut to its bound'), true);
  assert.equal(ui.words.looksLikeJson('PASS all tests'), false);
  assert.equal(ui.words.looksLikeJson('{ not json at all'), false);
  assert.equal(ui.words.looksLikeJson(''), false);
  const call = (toolKind, status, text) => ({ toolKind, status, output: text });
  assert.equal(ui.words.isRawPayload(call('other', 'completed', '{"a":1}')), true);
  assert.equal(ui.words.isRawPayload(call('fetch', 'completed', '{"a":1}')), true);
  assert.equal(ui.words.isRawPayload(call('execute', 'completed', '{"a":1}')), false, 'a command that prints JSON printed it');
  assert.equal(ui.words.isRawPayload(call('read', 'completed', '{"a":1}')), false, 'a JSON file read is the file');
  assert.equal(ui.words.isRawPayload(call('other', 'failed', 'Error: boom\n    at x (y.js:1:1)')), true, 'an error with a stack waits behind details');
  assert.equal(ui.words.isRawPayload(call('execute', 'failed', 'npm ERR! code 1')), false, 'a command’s failure log is its output');
  assert.equal(ui.words.isRawPayload(call('other', 'completed', '')), false);
});

test('a follow-up’s verdict comes from success alone; anything else that opens as JSON is a failure', () => {
  const verdict = (status, reply) => ui.subagents.deliveryOf({ status }, reply);
  assert.equal(verdict('in_progress', undefined), 'pending');
  assert.equal(verdict('pending', '{"success":true}'), 'pending');
  assert.equal(verdict('failed', undefined), 'failed');
  assert.equal(verdict('completed', JSON.stringify({ success: true, message: 'Resuming agent a7a4cd5', resumedAgentId: AGENT_ID })), 'sent');
  assert.equal(verdict('completed', '{"success":false,"message":"No such agent"}'), 'failed');
  assert.equal(verdict('completed', '{"message":"no verdict"}'), 'failed');
  assert.equal(verdict('completed', '{"success":"true"}'), 'failed', 'only the boolean true counts');
  assert.equal(verdict('completed', '{"success":tru'), 'failed', 'malformed JSON');
  assert.equal(verdict('completed', `{"success":true,"pad":"${'x'.repeat(30_000)}"}`), 'failed', 'too long to be an acknowledgement');
  assert.equal(verdict('completed', undefined), 'sent');
  assert.equal(verdict('completed', 'Message queued'), 'sent', 'plain words say nothing against it');
});

test('an agent’s report loses the bookkeeping Claude appends to it', () => {
  assert.equal(ui.subagents.reportOf(`Audit done.\nagentId: ${AGENT_ID} (use SendMessage)\n<usage>total_tokens: 5\ntool_uses: 2</usage>`), 'Audit done.');
  assert.equal(ui.subagents.reportOf(`agentId: ${AGENT_ID}`), undefined);
  assert.equal(ui.subagents.reportOf(undefined), undefined);
});

// ---------------------------------------------------------------------------
// The wire: a SendMessage call's text and recipient reach the transcript
// ---------------------------------------------------------------------------

test('a SendMessage call’s message and recipient pass the wire parser, the host’s events and the reducer; its other input is dropped', () => {
  const line = JSON.stringify({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: 's',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'wire1',
        title: 'SendMessage',
        kind: 'other',
        status: 'pending',
        rawInput: { to: AGENT_ID, message: 'Also check the footer', secret: 'x'.repeat(10) },
        _meta: { claudeCode: { toolName: 'SendMessage' } },
      },
    },
  });
  const message = ui.parseAcpLine(line);
  assert.ok(message.ok && message.value.kind === 'notification');
  const notification = ui.parseSessionNotification(message.value.params);
  assert.ok(notification.ok);
  const events = ui.eventsForUpdate(notification.value.update, TURN, { at: 1 }).map((event) => ui.parseChatEvent(JSON.parse(JSON.stringify(event))));
  const view = ui.reduceChat(ui.EMPTY_CHAT, [{ kind: 'turn-start', turn: TURN, at: 0 }, ...events]);
  const item = view.items.find((candidate) => candidate.kind === 'tool');
  assert.equal(item.sentMessage, 'Also check the footer');
  assert.equal(item.sentTo, AGENT_ID);
  assert.ok(!JSON.stringify(item).includes('secret'));
});

// ---------------------------------------------------------------------------
// The follow-up card
// ---------------------------------------------------------------------------

const agentCall = [
  tool('agent1', { title: 'Audit the hero', toolName: 'Agent', toolKind: 'other', status: 'pending', at: 1000 }),
  tool('agent1', { status: 'completed', at: 2000, output: `The hero is fine.\nagentId: ${AGENT_ID} (for resuming)\n<usage>total_tokens: 99</usage>` }),
];
const REPLY = JSON.stringify({
  success: true,
  message: 'Resuming agent a7a4cd5',
  resumedAgentId: AGENT_ID,
  pin: { id: AGENT_ID, name: AGENT_ID, ref: '448bb3' },
});
const followUp = (call, over = {}) => [
  tool(call, {
    title: 'SendMessage',
    toolName: 'SendMessage',
    toolKind: 'other',
    status: 'pending',
    at: 3000,
    sentTo: AGENT_ID,
    sentMessage: 'Also check the footer on mobile',
    ...over,
  }),
  tool(call, { status: over.status ?? 'completed', at: 8100, output: over.output ?? REPLY }),
];

test('a follow-up shows what was said, to which agent, and its state in a word; never the tool’s reply', async () => {
  const container = await mount(fold(agentCall, followUp('msg1')));
  const card = byText(container, '.ai-subagent', 'Follow-up to Audit the hero');
  assert.ok(card, `the card names the agent it went to: ${container.textContent}`);
  assert.ok(card.textContent.includes('Also check the footer on mobile'), 'the message the coordinator sent, in prose');
  assert.ok(card.textContent.includes('Sent'), 'its state in a word');
  assert.equal(card.querySelector('.ai-agent-model').textContent, '', 'a message runs on no model of its own');
  assert.ok(!card.querySelector('.ai-subagent-open'), 'no transcript button for a message that woke no work');
  assertNoJargon(container, 'follow-up');
});

test('a follow-up whose agent is not in the transcript says "Follow-up message", and an old one without text still shows no JSON', async () => {
  const container = await mount(fold(followUp('msg2', { sentTo: 'someone-else', sentMessage: undefined })));
  assert.ok(byText(container, '.ai-subagent', 'Follow-up message'), container.textContent);
  assertNoJargon(container, 'unknown recipient');
});

test('a follow-up that woke work says Done once the work is done and offers the transcript', async () => {
  const child = tool('k1', { title: 'ls', toolKind: 'execute', command: 'ls', parent: 'msg3', status: 'completed', at: 4000, output: 'a\n' });
  const container = await mount(fold(agentCall, followUp('msg3'), child));
  const card = byText(container, '.ai-subagent', 'Follow-up to Audit the hero');
  assert.ok(card.textContent.includes('Done'), card.textContent);
  assert.ok(card.querySelector('.ai-subagent-open'), 'the transcript of the woken work is offered');
  assertNoJargon(container, 'follow-up with work');
});

for (const [name, over] of [
  ['the reply says success is false', { output: '{"success":false,"message":"No agent a7a4cd56faec575c0 is running"}' }],
  ['the reply is malformed JSON', { output: '{"success":true,"resumedAgentId":"a7a4cd56faec' }],
  ['the reply is a JSON array', { output: '[1,2]' }],
  ['the call failed', { status: 'failed', output: 'Error: boom\n    at Object.run (/x/y.js:1:1)' }],
]) {
  test(`a follow-up fails as a toast, with no JSON in the DOM, when ${name}`, async () => {
    const toasts = [];
    const stop = ui.subscribeErrorToasts(
      (notice) => toasts.push(notice),
      () => undefined,
    );
    try {
      const container = await mount(fold(agentCall, followUp(`bad-${name.length}`, over)));
      assert.equal(toasts.length, 1, 'one toast');
      assert.equal(toasts[0].kind, 'error');
      assert.equal(toasts[0].message, 'The follow-up message couldn’t be sent.'.replace('’', "'"));
      assert.ok(!/[{}]|a7a4cd|boom/u.test(toasts[0].message), 'the toast is words');
      assert.ok(byText(container, '.ai-subagent', 'Follow-up to Audit the hero').textContent.includes('Also check the footer on mobile'));
      assertNoJargon(container, name);
    } finally {
      stop();
    }
  });
}

test('a follow-up that went through raises no toast', async () => {
  const toasts = [];
  const stop = ui.subscribeErrorToasts(
    (notice) => toasts.push(notice),
    () => undefined,
  );
  try {
    await mount(fold(agentCall, followUp('msg-ok')));
    assert.equal(toasts.length, 0);
  } finally {
    stop();
  }
});

// ---------------------------------------------------------------------------
// Every other kind of card
// ---------------------------------------------------------------------------

const JSON_REPLY = JSON.stringify({ ok: true, session: { id: 'a7a4cd56faec575c0aa', ref: '448bb3f2c9d1e07a' }, items: [{ id: 1 }] });
const CASES = [
  {
    label: 'a bare MCP tool',
    expected: 'Started a session',
    call: { title: 'mcp__ccd_session__start_session', toolName: 'mcp__ccd_session__start_session', toolKind: 'other' },
  },
  { label: 'a web search', expected: 'Searched the web', call: { title: 'WebSearch', toolName: 'WebSearch', toolKind: 'search' } },
  { label: 'a web fetch', expected: 'Read a web page', call: { title: 'WebFetch', toolName: 'WebFetch', toolKind: 'fetch' } },
  { label: 'a to-do update', expected: 'Updated the to-do list', call: { title: 'TodoWrite', toolName: 'TodoWrite', toolKind: 'other' } },
  { label: 'a tool search', expected: 'Looked for a tool', call: { title: 'ToolSearch', toolName: 'ToolSearch', toolKind: 'other' } },
  { label: 'a skill', expected: 'Used a skill', call: { title: 'Skill', toolName: 'Skill', toolKind: 'other' } },
  { label: 'a workflow', expected: 'Ran a workflow', call: { title: 'Workflow', toolName: 'Workflow', toolKind: 'other' } },
  {
    label: 'an unknown MCP tool',
    expected: 'Used Get Page Layout',
    call: { title: 'mcp__figma__get_page_layout', toolName: 'mcp__figma__get_page_layout', toolKind: 'other' },
  },
  { label: 'a grep', expected: 'Searched the project', call: { title: 'Grep', toolName: 'Grep', toolKind: 'search' } },
  { label: 'a title that is itself JSON', expected: 'Used a tool', call: { title: '{"query":"a7a4cd56faec575c0"}', toolKind: 'other' } },
];
for (const { label, expected, call } of CASES) {
  test(`${label} reads "${expected}", keeps its JSON reply behind Show details, closed until asked`, async () => {
    const container = await mount(fold(done('c1', { ...call, output: JSON_REPLY })));
    const card = container.querySelector('.ai-tool');
    assert.ok(card, 'a card');
    assert.ok(card.querySelector('.ai-tool-title').textContent.includes(expected), card.textContent);
    assertNoJargon(container, label);
    const control = byText(card, 'button', 'Show details');
    assert.ok(control, 'a labelled control');
    assert.equal(control.getAttribute('aria-expanded'), 'false', 'closed by default');
    await click(control);
    assert.equal(control.getAttribute('aria-expanded'), 'true');
    assert.ok(card.textContent.includes('"ok"'), 'the raw payload is there once asked for');
    assert.ok(card.querySelector('.ai-tool-details-body'), 'in its own block');
    assert.ok(byText(card, 'button', 'Hide details'), 'and can be closed');
    await click(byText(card, 'button', 'Hide details'));
    assertNoJargon(container, `${label} closed again`);
  });
}

test('a failed call keeps its error and stack behind Show details', async () => {
  const stack = 'TypeError: x is not a function\n    at run (/Users/a/work/index.js:10:5)\n    at 0123456789abcdef0123';
  const container = await mount(fold(done('f1', { title: 'mcp__figma__get_page_layout', toolKind: 'other', status: 'failed', output: stack }), []));
  const card = container.querySelector('.ai-tool');
  assert.ok(card.querySelector('.ai-tool-title').textContent.includes('Used Get Page Layout'));
  assert.ok(!card.textContent.includes('TypeError') && !card.textContent.includes('0123456789abcdef'), card.textContent);
  await click(byText(card, 'button', 'Show details'));
  assert.ok(card.textContent.includes('TypeError'), 'the evidence is one click away');
});

test('what is the work itself stays as it was: a command and its log, a file’s text, an edit', async () => {
  const container = await mount(
    fold(
      done('b1', { title: 'npm test', toolName: 'Bash', toolKind: 'execute', command: 'npm test', output: '{"pass":true}\nPASS all\n' }),
      done('r1', { title: 'Read package.json', toolName: 'Read', toolKind: 'read', paths: ['/site/package.json'], output: '{"name":"site"}' }),
    ),
  );
  const cards = [...container.querySelectorAll('.ai-tool')];
  assert.equal(cards.length, 2);
  assert.ok(cards[0].querySelector('.ai-tool-title').textContent.includes('npm test'), 'a command row is the command itself');
  assert.ok(cards[0].textContent.includes('PASS all'), 'its log is shown');
  assert.ok(cards[1].querySelector('.ai-tool-title').textContent.includes('Read package.json'), 'a title the agent wrote is kept');
  assert.ok(cards[1].textContent.includes('"name"'), 'a file read shows the file');
  assert.equal(byText(container, 'button', 'Show details'), undefined, 'nothing here is a payload');
});

test('a subagent’s report shows what it said, without its id line or token counts; a report that is JSON waits behind Show details', async () => {
  const prose = await mount(fold(agentCall));
  const card = prose.querySelector('.ai-subagent');
  assert.ok(card.textContent.includes('The hero is fine.'));
  assertNoJargon(prose, 'agent report');
  const raw = await mount(
    fold([
      tool('agent2', { title: 'Collect data', toolName: 'Agent', toolKind: 'other', status: 'pending', at: 1000 }),
      tool('agent2', { status: 'completed', at: 2000, output: JSON_REPLY }),
    ]),
  );
  assertNoJargon(raw, 'agent JSON report');
  const control = byText(raw, 'button', 'Show details');
  assert.equal(control.getAttribute('aria-expanded'), 'false');
  await click(control);
  assert.ok(raw.textContent.includes('"ok"'));
});

test('the permission request and the background tray name a bare tool in words', async () => {
  const view = fold(
    tool('p1', {
      title: 'mcp__ccd_session__start_session',
      toolName: 'mcp__ccd_session__start_session',
      toolKind: 'other',
      status: 'pending',
      background: true,
    }),
    {
      kind: 'permission',
      turn: TURN,
      request: 'r1',
      call: 'p1',
      title: 'mcp__ccd_session__start_session',
      options: [{ id: 'allow', name: 'Allow', kind: 'allow_once' }],
    },
  );
  const container = await mount(view);
  assert.ok(container.textContent.includes('Started a session'), container.textContent);
  assert.ok(!container.textContent.includes('mcp__'), container.textContent);
});
