// Goal: the AI panel's renderer store does what the panel relies on, without any React.
// The project's list is the main process's whole list (chats in order, sections), replaced in one
// update and never merged; sections, moves, archive, restore, fork and the unread mark go through the
// channels with the right payloads and leave the list as the reply says; a turn that ends marks the
// chat read when it is open on screen and unread otherwise; a message sent while the agent works is
// steered into the turn, or queued (at most 16), and the queue sends its next message only after a
// turn that ended normally — held, never auto-sent, after an error or a stop; drafts hold chips,
// are bounded, survive a reload through storage that may be bad, and build the parts a prompt carries.
// Method: bundle the real store with esbuild and drive it against a fake preload (window.avb) that
// records every call, with a Map-backed localStorage; push events through receiveEvents as main would.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/aiStore.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export * from './src/features/ai/aiStore';",
      "export { readStoredDrafts, writeStoredDrafts, hasDraftContent } from './src/features/ai/draftStorage';",
    ].join('\n'),
    resolveDir: repoPath('package.json').replace(/package\.json$/, ''),
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['react'],
  logLevel: 'silent',
});

const storage = new Map();
global.localStorage = {
  // Storage answers null for a missing key; the shim keeps that contract without writing the literal (AGENTS.md §6).
  getItem: (key) => (storage.has(key) ? storage.get(key) : JSON.parse('null')),
  setItem: (key, value) => void storage.set(key, String(value)),
  removeItem: (key) => void storage.delete(key),
  clear: () => storage.clear(),
};
const store = require(output);

const PROJECT = '/site';
const hex = (digit, length) => digit.repeat(length);
const chatId = (digit) => `c${hex(digit, 24)}`;
const sectionId = (digit) => `s${hex(digit, 16)}`;
const TURN = `t${'1'.repeat(16)}`;
const FIRST = chatId('a');
const SECOND = chatId('b');
const THIRD = chatId('c');

function summary(id, over = {}) {
  return { id, agent: 'claude', title: `Chat ${id.slice(1, 3)}`, pinned: false, createdAt: 1, updatedAt: 1, rank: 0, unread: false, ...over };
}
const list = (chats, sections = []) => ({ chats, sections });
const section = (digit, name, rank = 0) => ({ id: sectionId(digit), name, collapsed: false, rank });

// A fake preload. `replies` overrides a method's reply; `calls` records every call by name.
function install(initial, replies = {}) {
  const calls = [];
  let current = initial;
  const record = (name, fallback) => async (payload) => {
    calls.push({ name, payload });
    const reply = replies[name] ?? fallback;
    return typeof reply === 'function' ? reply(payload) : reply;
  };
  const ok = (value) => ({ ok: true, value });
  global.window = {
    avb: {
      aiAgents: record('aiAgents', () => ({
        trusted: true,
        agents: [{ agent: 'claude', state: 'ready', adapterVersion: '1.0.0', running: false, downloadMegabytes: 1 }],
        options: [],
      })),
      aiChats: record('aiChats', () => current),
      aiChatCreate: record('aiChatCreate', () => ok(summary(FIRST))),
      aiChatUpdate: record('aiChatUpdate', (payload) =>
        ok(summary(payload.chat, { unread: payload.unread ?? false, archivedAt: payload.archived ? 5 : undefined })),
      ),
      aiChatDelete: record('aiChatDelete', { ok: true }),
      aiChatRead: record('aiChatRead', (payload) => ok({ summary: summary(payload.chat), events: [], full: false })),
      aiChatFork: record('aiChatFork', () => ok(summary(THIRD, { forkOf: FIRST }))),
      aiChatMove: record('aiChatMove', () => ok(current)),
      aiSections: record('aiSections', () => ok(current)),
      aiPrompt: record('aiPrompt', () => ok({ turn: TURN })),
      aiSteer: record('aiSteer', () => ok({ turn: TURN, outcome: 'steered' })),
      aiCompact: record('aiCompact', () => ok({ started: true })),
      aiDiff: record('aiDiff', () => ok({ oldText: 'a', newText: 'b' })),
      aiMentions: record('aiMentions', () => ok([{ kind: 'file', path: 'src/a.ts', name: 'a.ts' }])),
      aiCancel: record('aiCancel', { ok: true }),
      aiAck: () => undefined,
      onAiEvents: () => () => undefined,
      onAiAgentStatus: () => () => undefined,
      onAiSetup: () => () => undefined,
    },
  };
  return {
    calls,
    named: (name) => calls.filter((call) => call.name === name),
    setList: (next) => {
      current = next;
    },
  };
}

async function settle() {
  for (let round = 0; round < 5; round++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function start(initial, replies) {
  store.resetAiStore();
  storage.clear();
  const fake = install(initial, replies);
  await store.loadAiProject(PROJECT);
  return fake;
}

const failure = (code, message = code) => ({ ok: false, error: { code, message } });
const turnEnd = (stop, turn = TURN) => ({ kind: 'turn-end', turn, stop, message: undefined, at: 9 });
const running = [{ kind: 'turn-start', turn: TURN, at: 1 }];

async function openRunning(initial, replies) {
  const fake = await start(initial, replies);
  await store.openChat(FIRST);
  store.setPanelVisibility('visible');
  store.receiveEvents({ projectPath: PROJECT, chat: FIRST, events: running });
  assert.equal(store.aiState().views.get(FIRST).running, TURN, 'the chat is running');
  return fake;
}

const type = (text) => store.setDraft(FIRST, () => store.draftFromText(text));

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

test('loading reads the whole list: chats in the order main gave and the sections', async () => {
  await start(list([summary(SECOND), summary(FIRST)], [section('1', 'Site work')]));
  const state = store.aiState();
  assert.deepEqual(
    state.chats.map((chat) => chat.id),
    [SECOND, FIRST],
  );
  assert.deepEqual(
    state.sections.map((entry) => entry.name),
    ['Site work'],
  );
  assert.equal(state.loaded, true);
});

test('the old bare array of chats is no longer a reply: it is refused, with the list left as it was', async () => {
  await start(list([summary(FIRST)]));
  const fake = install([summary(SECOND)]);
  await store.loadAiProject(PROJECT);
  assert.ok(fake.named('aiChats').length > 0);
  assert.deepEqual(
    store.aiState().chats.map((chat) => chat.id),
    [FIRST],
  );
});

test('sections: create returns the new id, and every change replaces the list from the reply', async () => {
  const fake = await start(list([summary(FIRST)]));
  fake.setList(list([summary(FIRST)], [section('1', 'Alpha')]));
  const created = await store.createSection('Alpha');
  assert.equal(created, sectionId('1'));
  assert.deepEqual(fake.named('aiSections')[0].payload.action, { kind: 'create', name: 'Alpha' });
  assert.equal(store.aiState().sections.length, 1);

  fake.setList(list([summary(FIRST)], [section('1', 'Beta')]));
  await store.renameSection(sectionId('1'), 'Beta');
  assert.deepEqual(fake.named('aiSections')[1].payload.action, { kind: 'rename', section: sectionId('1'), name: 'Beta' });
  assert.equal(store.aiState().sections[0].name, 'Beta');

  await store.collapseSection(sectionId('1'), { collapsed: true });
  assert.deepEqual(fake.named('aiSections')[2].payload.action, { kind: 'collapse', section: sectionId('1'), collapsed: true });
  await store.moveSection(sectionId('1'), { before: undefined });
  assert.deepEqual(fake.named('aiSections')[3].payload.action, { kind: 'move', section: sectionId('1'), before: undefined });

  fake.setList(list([summary(FIRST)], []));
  await store.deleteSection(sectionId('1'));
  assert.deepEqual(fake.named('aiSections')[4].payload.action, { kind: 'delete', section: sectionId('1') });
  assert.deepEqual(store.aiState().sections, []);
});

test('sections: a refused change shows why and leaves the list alone; a bad name never reaches main', async () => {
  const fake = await start(list([summary(FIRST)], [section('1', 'Alpha')]), { aiSections: failure('invalid', 'That name is taken.') });
  assert.equal(await store.createSection('Alpha'), undefined);
  assert.equal(store.aiState().error, 'That name is taken.');
  assert.equal(store.aiState().sections.length, 1);
  await assert.rejects(store.createSection('   '), /section\.name/);
  assert.equal(fake.named('aiSections').length, 1, 'the empty name was refused before it was sent');
});

test('moving a chat sends the section and the chat it goes before, and the reply replaces the list', async () => {
  const fake = await start(list([summary(FIRST), summary(SECOND)], [section('1', 'Alpha')]));
  fake.setList(list([summary(SECOND), summary(FIRST, { section: sectionId('1') })], [section('1', 'Alpha')]));
  await store.moveChat(FIRST, { section: sectionId('1'), before: undefined });
  assert.deepEqual(fake.named('aiChatMove')[0].payload, { projectPath: PROJECT, chat: FIRST, section: sectionId('1') });
  assert.deepEqual(
    store.aiState().chats.map((chat) => chat.id),
    [SECOND, FIRST],
  );
  await store.moveChat(SECOND, { section: undefined, before: FIRST });
  assert.deepEqual(fake.named('aiChatMove')[1].payload, { projectPath: PROJECT, chat: SECOND, before: FIRST });
  await assert.rejects(store.moveChat(FIRST, { section: undefined, before: FIRST }), /not placed before itself/);
});

test('archive takes the chat out and closes it, restore brings it back, both reading the list again', async () => {
  const fake = await start(list([summary(FIRST), summary(SECOND)]));
  await store.openChat(FIRST);
  fake.setList(list([summary(FIRST, { archivedAt: 5 }), summary(SECOND)]));
  await store.archiveChat(FIRST);
  assert.equal(fake.named('aiChatUpdate').at(-1).payload.archived, true);
  assert.equal(store.aiState().open, undefined, 'the archived chat is closed');
  assert.ok(fake.named('aiChats').length >= 2, 'the list is read again');
  assert.equal(store.aiState().chats.find((chat) => chat.id === FIRST).archivedAt, 5);
  fake.setList(list([summary(FIRST), summary(SECOND)]));
  await store.restoreChat(FIRST);
  assert.equal(fake.named('aiChatUpdate').at(-1).payload.archived, false);
  assert.equal(store.aiState().chats.find((chat) => chat.id === FIRST).archivedAt, undefined);
});

test('the panel never starts on an archived chat', async () => {
  await start(list([summary(FIRST, { archivedAt: 5, updatedAt: 99 }), summary(SECOND, { updatedAt: 2 })]));
  await store.openStartingChat();
  assert.equal(store.aiState().open, SECOND);
});

test('unread: marked and cleared through the channel, and opening an unread chat reads it', async () => {
  const fake = await start(list([summary(FIRST, { unread: true }), summary(SECOND)]));
  await store.markUnread(SECOND);
  assert.equal(fake.named('aiChatUpdate').at(-1).payload.unread, true);
  assert.equal(store.aiState().chats.find((chat) => chat.id === SECOND).unread, true);
  await store.openChat(FIRST);
  await settle();
  assert.equal(
    fake.named('aiChatUpdate').some((call) => call.payload.chat === FIRST && call.payload.unread === false),
    true,
  );
  assert.equal(store.aiState().chats.find((chat) => chat.id === FIRST).unread, false);
});

test('pin reads the list again because it moves other chats; rename does not', async () => {
  const fake = await start(list([summary(FIRST)]));
  await store.renameChat(FIRST, 'Hero');
  assert.equal(fake.named('aiChats').length, 1);
  await store.pinChat(FIRST, { pinned: true });
  assert.equal(fake.named('aiChats').length, 2);
});

test('fork opens the copy that main made, from the list read afterwards', async () => {
  const fake = await start(list([summary(FIRST)]));
  fake.setList(list([summary(FIRST), summary(THIRD, { forkOf: FIRST })]));
  assert.equal(await store.forkChat(FIRST), THIRD);
  assert.equal(store.aiState().open, THIRD);
  assert.ok(store.aiState().chats.some((chat) => chat.id === THIRD));
  assert.equal(fake.named('aiChatFork')[0].payload.chat, FIRST);
});

test('a fork that main refuses opens nothing and says why', async () => {
  await start(list([summary(FIRST)]), { aiChatFork: failure('unsupported', 'This agent cannot fork.') });
  assert.equal(await store.forkChat(FIRST), undefined);
  assert.equal(store.aiState().error, 'This agent cannot fork.');
});

test('compact, diff and mention lookups pass their payloads through; a refused compaction shows why', async () => {
  const fake = await start(list([summary(FIRST)]));
  await store.compactChat(FIRST);
  assert.deepEqual(fake.named('aiCompact')[0].payload, { projectPath: PROJECT, chat: FIRST });
  const diff = await store.loadChangeDiff(FIRST, TURN, '/site/a.txt');
  assert.deepEqual(diff.value, { oldText: 'a', newText: 'b' });
  const found = await store.mentionCandidates('a', ['file']);
  assert.equal(found.value.length, 1);
  assert.deepEqual(fake.named('aiMentions')[0].payload.kinds, ['file']);
  install(list([summary(FIRST)]), { aiCompact: failure('unsupported', 'Codex cannot compact.') });
  await store.compactChat(FIRST);
  assert.equal(store.aiState().error, 'Codex cannot compact.');
});

// ---------------------------------------------------------------------------
// Unread at the end of a turn
// ---------------------------------------------------------------------------

test('a turn that ends in the open chat on screen is read at once', async () => {
  const fake = await openRunning(list([summary(FIRST)]));
  store.receiveEvents({ projectPath: PROJECT, chat: FIRST, events: [turnEnd('end_turn')] });
  await settle();
  assert.equal(fake.named('aiChatUpdate').at(-1).payload.unread, false);
  assert.equal(store.aiState().chats.find((chat) => chat.id === FIRST).unread, false);
});

test('a turn that ends in a chat that is not open, or not on screen, leaves it unread', async () => {
  const fake = await start(list([summary(FIRST), summary(SECOND)]));
  await store.openChat(FIRST);
  store.setPanelVisibility('visible');
  await store.openChat(SECOND);
  store.receiveEvents({ projectPath: PROJECT, chat: FIRST, events: [turnEnd('end_turn')] });
  assert.equal(store.aiState().chats.find((chat) => chat.id === FIRST).unread, true);
  store.setPanelVisibility('hidden');
  store.receiveEvents({ projectPath: PROJECT, chat: SECOND, events: [turnEnd('end_turn')] });
  assert.equal(store.aiState().chats.find((chat) => chat.id === SECOND).unread, true, 'a hidden panel is not reading');
  assert.equal(fake.named('aiChatUpdate').filter((call) => call.payload.unread === false).length, 0);
  store.setPanelVisibility('visible');
  await settle();
  assert.equal(
    fake.named('aiChatUpdate').some((call) => call.payload.chat === SECOND && call.payload.unread === false),
    true,
    'showing the panel reads the open chat',
  );
});

test('usage and title events are mirrored onto the list row', async () => {
  await start(list([summary(FIRST)]));
  await store.openChat(FIRST);
  store.receiveEvents({
    projectPath: PROJECT,
    chat: FIRST,
    events: [
      { kind: 'usage', used: 410, size: 1000 },
      { kind: 'title', title: 'Hero work' },
    ],
  });
  const row = store.aiState().chats.find((chat) => chat.id === FIRST);
  assert.deepEqual(row.context, { used: 410, size: 1000 });
  assert.equal(row.title, 'Hero work');
});

// ---------------------------------------------------------------------------
// Sending, steering and the queue
// ---------------------------------------------------------------------------

test('a plain message sends plain text with no parts; the draft is emptied', async () => {
  const fake = await start(list([summary(FIRST)]));
  await store.openChat(FIRST);
  type('Fix the hero');
  assert.equal(await store.sendPrompt(FIRST), true);
  const payload = fake.named('aiPrompt')[0].payload;
  assert.equal(payload.text, 'Fix the hero');
  assert.equal('parts' in payload, false);
  assert.equal(store.draftText(store.aiState().drafts.get(FIRST)), '');
  assert.equal(await store.sendPrompt(FIRST), false, 'an empty draft sends nothing');
});

test('a message with chips sends its parts and the plain text fallback; a built-in chip needs its text registered', async () => {
  const fake = await start(list([summary(FIRST)]));
  await store.openChat(FIRST);
  store.registerBuiltinChipText((id) => `instructions of ${id}`);
  store.setDraft(FIRST, () => ({
    attachments: [],
    segments: [
      { kind: 'chip', chip: { kind: 'builtin', id: 'app-builder', title: 'App builder instructions' } },
      { kind: 'text', text: ' read ' },
      { kind: 'chip', chip: { kind: 'file', path: 'src/pages/index.astro', name: 'index.astro' } },
    ],
  }));
  assert.equal(await store.sendPrompt(FIRST), true);
  const payload = fake.named('aiPrompt')[0].payload;
  assert.equal(payload.text, 'App builder instructions read @src/pages/index.astro');
  assert.deepEqual(payload.parts, [
    { kind: 'builtin', id: 'app-builder', text: 'instructions of app-builder' },
    { kind: 'text', text: ' read ' },
    { kind: 'file', path: 'src/pages/index.astro' },
  ]);
});

test('a built-in chip with no registered text is a programmer error that loses nothing', async () => {
  // FIRST fresh bundle has no resolver; simulate by registering one that asserts the contract.
  const fake = await start(list([summary(FIRST)]));
  await store.openChat(FIRST);
  store.registerBuiltinChipText(() => {
    throw new Error('no text for this chip');
  });
  store.setDraft(FIRST, () => ({
    attachments: [],
    segments: [{ kind: 'chip', chip: { kind: 'builtin', id: 'app-builder', title: 'App builder instructions' } }],
  }));
  await assert.rejects(store.sendPrompt(FIRST), /no text for this chip/);
  assert.equal(fake.named('aiPrompt').length, 0);
  assert.equal(store.aiState().drafts.get(FIRST).segments.length, 1, 'the draft is still there');
});

test('a refused send puts the words back; a sign-in failure raises no toast; an untrusted project asks again', async () => {
  const fake = await start(list([summary(FIRST)]), { aiPrompt: failure('sign-in', 'Sign in.') });
  await store.openChat(FIRST);
  type('hello');
  assert.equal(await store.sendPrompt(FIRST), false);
  assert.equal(store.draftText(store.aiState().drafts.get(FIRST)), 'hello');
  assert.equal(store.aiState().error, undefined);
  install(list([summary(FIRST)]), { aiPrompt: failure('not-trusted', 'Not allowed.') });
  assert.equal(await store.sendPrompt(FIRST), false);
  assert.equal(store.aiState().trusted, false);
  assert.equal(store.aiState().error, 'Not allowed.');
  assert.equal(fake.named('aiPrompt').length, 1);
});

test('⏎ while the agent works steers: the draft goes into the turn through ai:steer', async () => {
  const fake = await openRunning(list([summary(FIRST)]));
  type('also the footer');
  assert.equal(await store.steerPrompt(FIRST), true);
  assert.equal(fake.named('aiSteer')[0].payload.text, 'also the footer');
  assert.equal(fake.named('aiPrompt').length, 0);
  assert.equal(store.draftText(store.aiState().drafts.get(FIRST)), '');
  assert.equal(await store.steerPrompt(FIRST), false, 'nothing to steer with an empty draft');
});

test('a steer the agent cannot take is queued instead, and a refusal that is not about the agent keeps the draft', async () => {
  await openRunning(list([summary(FIRST)]), { aiSteer: failure('unsupported', 'No steering.') });
  type('also the footer');
  assert.equal(await store.steerPrompt(FIRST), true);
  assert.deepEqual(
    store
      .aiState()
      .queue.get(FIRST)
      .map((entry) => entry.text),
    ['also the footer'],
  );
  assert.equal(store.draftText(store.aiState().drafts.get(FIRST)), '');
  install(list([summary(FIRST)]), { aiSteer: failure('not-trusted', 'Not allowed.') });
  type('again');
  assert.equal(await store.steerPrompt(FIRST), false);
  assert.equal(store.draftText(store.aiState().drafts.get(FIRST)), 'again');
  assert.equal(store.aiState().queue.get(FIRST).length, 1, 'only the first was queued');
});

test('⌘⏎ queues while a turn runs, and sends at once when none does', async () => {
  const fake = await openRunning(list([summary(FIRST)]));
  type('second thing');
  assert.equal(await store.queuePrompt(FIRST), true);
  assert.equal(store.aiState().queue.get(FIRST).length, 1);
  assert.equal(store.draftText(store.aiState().drafts.get(FIRST)), '', 'the box is free for the next message');
  assert.equal(fake.named('aiPrompt').length, 0);
  store.receiveEvents({ projectPath: PROJECT, chat: FIRST, events: [turnEnd('end_turn')] });
  await settle();
  assert.equal(fake.named('aiPrompt')[0].payload.text, 'second thing', 'sent when the turn ended');
  assert.equal(store.aiState().queue.get(FIRST), undefined);

  store.receiveEvents({ projectPath: PROJECT, chat: FIRST, events: [turnEnd('end_turn')] });
  type('idle send');
  assert.equal(await store.queuePrompt(FIRST), true);
  assert.equal(fake.named('aiPrompt').at(-1).payload.text, 'idle send');
  assert.equal(store.aiState().queue.get(FIRST), undefined);
});

test('the queue holds at most 16 messages; the 17th is refused and its words stay in the box', async () => {
  await openRunning(list([summary(FIRST)]));
  for (let index = 0; index < 16; index++) {
    type(`message ${index}`);
    assert.equal(await store.queuePrompt(FIRST), true);
  }
  type('one too many');
  assert.equal(await store.queuePrompt(FIRST), false);
  assert.equal(store.aiState().queue.get(FIRST).length, 16);
  assert.equal(store.draftText(store.aiState().drafts.get(FIRST)), 'one too many');
  assert.match(store.aiState().error, /16 messages/);
});

test('the queue sends one message per normal end, in order', async () => {
  const fake = await openRunning(list([summary(FIRST)]));
  for (const text of ['one', 'two', 'three']) {
    type(text);
    await store.queuePrompt(FIRST);
  }
  store.receiveEvents({ projectPath: PROJECT, chat: FIRST, events: [turnEnd('end_turn')] });
  await settle();
  assert.deepEqual(
    fake.named('aiPrompt').map((call) => call.payload.text),
    ['one'],
  );
  assert.deepEqual(
    store
      .aiState()
      .queue.get(FIRST)
      .map((entry) => entry.text),
    ['two', 'three'],
  );
  // The agent started the sent message's turn; its end sends the next.
  store.receiveEvents({ projectPath: PROJECT, chat: FIRST, events: [...running, turnEnd('end_turn')] });
  await settle();
  assert.deepEqual(
    fake.named('aiPrompt').map((call) => call.payload.text),
    ['one', 'two'],
  );
});

test('after an error or a stop the queue is held, never sent; Resume sends the next', async () => {
  for (const stop of ['error', 'cancelled', 'refusal', 'max_tokens']) {
    const fake = await openRunning(list([summary(FIRST)]));
    type('later');
    await store.queuePrompt(FIRST);
    store.receiveEvents({ projectPath: PROJECT, chat: FIRST, events: [turnEnd(stop)] });
    await settle();
    assert.equal(fake.named('aiPrompt').length, 0, `${stop}: nothing sent on its own`);
    assert.equal(store.aiState().queue.get(FIRST).length, 1);
    assert.equal(store.aiState().queuePaused.has(FIRST), true, `${stop}: shown as paused`);
    await store.resumeQueue(FIRST);
    assert.equal(fake.named('aiPrompt')[0].payload.text, 'later', `${stop}: resumed`);
    assert.equal(store.aiState().queuePaused.has(FIRST), false);
  }
});

test('a queued message the agent refuses returns to the front and pauses the queue', async () => {
  const fake = await openRunning(list([summary(FIRST)]), { aiPrompt: failure('agent-failed', 'It crashed.') });
  type('one');
  await store.queuePrompt(FIRST);
  type('two');
  await store.queuePrompt(FIRST);
  store.receiveEvents({ projectPath: PROJECT, chat: FIRST, events: [turnEnd('end_turn')] });
  await settle();
  assert.deepEqual(
    store
      .aiState()
      .queue.get(FIRST)
      .map((entry) => entry.text),
    ['one', 'two'],
  );
  assert.equal(store.aiState().queuePaused.has(FIRST), true);
  assert.equal(store.aiState().error, 'It crashed.');
  assert.equal(fake.named('aiPrompt').length, 1, 'no second attempt on its own');
});

test('"Send now" steers a queued message into the running turn; removing drops it', async () => {
  const fake = await openRunning(list([summary(FIRST)]));
  type('one');
  await store.queuePrompt(FIRST);
  type('two');
  await store.queuePrompt(FIRST);
  const [first, second] = store.aiState().queue.get(FIRST);
  assert.equal(await store.sendQueuedNow(FIRST, first.id), true);
  assert.equal(fake.named('aiSteer')[0].payload.text, 'one');
  store.removeQueued(FIRST, second.id);
  assert.equal(store.aiState().queue.get(FIRST), undefined);
  assert.equal(await store.sendQueuedNow(FIRST, 'missing'), false);
});

test('a queue is dropped with its chat', async () => {
  await openRunning(list([summary(FIRST)]));
  type('later');
  await store.queuePrompt(FIRST);
  await store.deleteChat(FIRST);
  assert.equal(store.aiState().queue.get(FIRST), undefined);
  assert.equal(store.aiState().drafts.get(FIRST), undefined);
});

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

const fileChip = (name) => ({ kind: 'chip', chip: { kind: 'file', path: `src/${name}`, name } });
const textRun = (text) => ({ kind: 'text', text });

test('boundSegments keeps what a prompt can carry: 256 segments, 16 chips, the character limit', () => {
  const many = Array.from({ length: 300 }, () => textRun('a'));
  assert.equal(store.boundSegments(many).length, 256);
  const chips = Array.from({ length: 20 }, (_, index) => fileChip(`f${index}.ts`));
  assert.equal(store.boundSegments(chips).length, 16);
  const long = store.boundSegments([textRun('x'.repeat(120_000)), fileChip('a.ts'), textRun('tail')]);
  const characters = long.filter((segment) => segment.kind === 'text').reduce((total, segment) => total + segment.text.length, 0);
  assert.ok(characters <= 100_000, 'text is cut at the prompt limit');
  assert.equal(
    long.some((segment) => segment.kind === 'chip'),
    true,
    'a chip after the cut text is kept',
  );
  const small = [textRun('hi'), fileChip('a.ts')];
  assert.equal(store.boundSegments(small).length, 2);
  assert.equal(store.boundSegments(small)[0], small[0], 'what fits is returned as it is');
});

test('draft helpers: text, emptiness, replacing text and appending dictation', () => {
  const draft = { attachments: [], segments: [textRun('look at '), fileChip('a.ts')] };
  assert.equal(store.draftText(draft), 'look at @src/a.ts');
  assert.equal(store.isDraftEmpty(draft), false);
  assert.equal(store.isDraftEmpty(store.draftFromText('   ')), true, 'only space is nothing');
  assert.equal(store.isDraftEmpty({ attachments: [], segments: [fileChip('a.ts')] }), false, 'a chip alone is a message');
  assert.equal(store.isDraftEmpty({ attachments: [{ id: '1', attachment: { kind: 'file', path: 'a' }, preview: undefined }], segments: [] }), false);
  assert.deepEqual(store.draftWithText(draft, 'plain').segments, [textRun('plain')]);
  assert.deepEqual(store.draftWithText(draft, '').segments, []);
  assert.deepEqual(store.draftWithAppendedText(store.draftFromText('hello'), 'world').segments, [textRun('hello world')]);
  assert.deepEqual(store.draftWithAppendedText(draft, 'more').segments.at(-1), textRun('more'), 'after a chip it is a new run');
  assert.deepEqual(store.draftWithAppendedText(store.draftFromText(''), 'first').segments, [textRun('first')]);
});

test('drafts are written after typing pauses and restored for chats that exist', async () => {
  await start(list([summary(FIRST), summary(SECOND)]));
  store.setDraft(FIRST, () => ({ attachments: [], segments: [textRun('half a thought '), fileChip('a.ts')] }));
  store.setDraft(SECOND, () => store.draftFromText('   '));
  await new Promise((resolve) => setTimeout(resolve, 500));
  const stored = JSON.parse(storage.get(`stacki.ai.drafts.${PROJECT}`));
  assert.equal(stored.version, 1);
  assert.deepEqual(
    stored.drafts.map((entry) => entry.chat),
    [FIRST],
    'a draft of only space is not kept',
  );
  // FIRST reload: the same project, new store, the list still has FIRST (and not the deleted chat THIRD).
  store.resetAiStore();
  install(list([summary(FIRST)]));
  await store.loadAiProject(PROJECT);
  assert.equal(store.draftText(store.aiState().drafts.get(FIRST)), 'half a thought @src/a.ts');
  assert.equal(store.aiState().drafts.get(FIRST).segments.length, 2);
  assert.equal(store.aiState().drafts.has(SECOND), false);
});

test('an emptied draft leaves no key behind', async () => {
  await start(list([summary(FIRST)]));
  type('something');
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(storage.has(`stacki.ai.drafts.${PROJECT}`), true);
  type('');
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(storage.has(`stacki.ai.drafts.${PROJECT}`), false);
});

test('stored drafts are another program’s data: bad entries are skipped one by one, never throw', () => {
  const key = `stacki.ai.drafts.${PROJECT}`;
  const good = { chat: FIRST, segments: [textRun('ok')] };
  const entry = (segments, chat = SECOND) => ({ chat, segments });
  const read = (value) => {
    storage.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    return store.readStoredDrafts(PROJECT);
  };
  assert.equal(read('{not json').size, 0, 'not JSON');
  assert.equal(read({ version: 2, drafts: [good] }).size, 0, 'another version');
  assert.equal(read({ version: 1, drafts: 'x' }).size, 0, 'drafts not a list');
  assert.equal(read([good]).size, 0, 'not an object');
  const bad = [
    entry([{ kind: 'chip', chip: { kind: 'folder', path: 'src', name: 'src' } }]),
    entry([{ kind: 'chip', chip: { kind: 'file', path: '../secret', name: 'secret' } }]),
    entry([{ kind: 'chip', chip: { kind: 'file', path: '/etc/passwd', name: 'passwd' } }]),
    entry([{ kind: 'chip', chip: { kind: 'file', path: 'a\\b', name: 'b' } }]),
    entry([{ kind: 'text', text: 'x'.repeat(100_001) }]),
    entry(Array.from({ length: 257 }, () => textRun('a'))),
    entry(Array.from({ length: 17 }, () => fileChip('a.ts'))),
    entry([{ kind: 'text' }]),
    entry('x'),
    entry([textRun('x')], 'not-a-chat'),
    entry([textRun('x')], 7),
    entry([textRun('   ')]),
    'garbage',
    JSON.parse('null'),
  ];
  const drafts = read({ version: 1, drafts: [...bad, good] });
  assert.deepEqual([...drafts.keys()], [FIRST], 'only the good entry survives');
  // More than the bound is cut, not refused.
  const many = Array.from({ length: 60 }, (_, index) => ({ chat: chatId(index.toString(16).padStart(1, '0')[0]), segments: [textRun('x')] }));
  assert.ok(read({ version: 1, drafts: many }).size <= 50);
});

test('writing keeps only the newest 50 drafts that have content, and a full or missing storage is not an error', () => {
  const drafts = new Map();
  for (let index = 0; index < 60; index++) {
    drafts.set(`c${index.toString(16).padStart(24, '0')}`, [textRun(`draft ${index}`)]);
  }
  drafts.set(`c${'f'.repeat(24)}`, [textRun('  ')]);
  store.writeStoredDrafts(PROJECT, drafts);
  const stored = JSON.parse(storage.get(`stacki.ai.drafts.${PROJECT}`));
  assert.equal(stored.drafts.length, 50);
  assert.equal(stored.drafts.at(-1).segments[0].text, 'draft 59', 'the newest survive');
  const original = global.localStorage;
  global.localStorage = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('quota');
    },
    removeItem: () => {
      throw new Error('blocked');
    },
  };
  try {
    store.writeStoredDrafts(PROJECT, drafts);
    store.writeStoredDrafts(PROJECT, new Map());
    assert.equal(store.readStoredDrafts(PROJECT).size, 0);
  } finally {
    global.localStorage = original;
  }
});

test('switching provider carries the draft, chips and all, to the new chat', async () => {
  const fake = await start(list([summary(FIRST)]));
  await store.openChat(FIRST);
  const draft = { attachments: [], segments: [textRun('look '), fileChip('a.ts')] };
  store.setDraft(FIRST, () => draft);
  fake.setList(list([summary(FIRST)]));
  const next = await store.switchProvider(FIRST, 'codex', { started: false });
  assert.equal(next, FIRST, 'the fake main hands out the same id');
  assert.deepEqual(store.aiState().drafts.get(next).segments, draft.segments);
});

test('a stored mode never applies to a new chat: remembered settings leave modes out, old values included', () => {
  storage.clear();
  // A value an older build stored: Claude's mode and Codex's plan switch beside an ordinary choice.
  storage.set('stacki.ai.settings.claude', JSON.stringify({ mode: 'bypassPermissions', model: 'opus', effort: 'high' }));
  storage.set('stacki.ai.settings.codex', JSON.stringify({ mode: 'agent-full-access', collaboration_mode: 'plan', model: 'gpt-5' }));
  assert.deepEqual(store.rememberedSettings('claude'), [
    { option: 'model', value: 'opus' },
    { option: 'effort', value: 'high' },
  ]);
  assert.deepEqual(store.rememberedSettings('codex'), [{ option: 'model', value: 'gpt-5' }]);
  // Choosing a mode is not remembered either, so it cannot come back later.
  store.rememberSetting('claude', 'mode', 'bypassPermissions');
  store.rememberSetting('claude', 'model', 'sonnet');
  assert.deepEqual(JSON.parse(storage.get('stacki.ai.settings.claude')), { model: 'sonnet', effort: 'high' }, 'the stale mode is dropped on the next write');
  store.rememberSetting('codex', 'collaboration_mode', 'plan');
  assert.equal(
    store.rememberedSettings('codex').some((setting) => setting.option === 'collaboration_mode'),
    false,
  );
  storage.clear();
});
