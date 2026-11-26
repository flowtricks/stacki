// Goal: the comment pins store keeps drafts and sends them only when asked. A board is read when a project opens
// (a pin left waiting in a run the app closed on is a draft again); changes are saved after a pause, with each
// image sent once; deleting, including and clearing change only what they say; nothing is ever sent by itself;
// "Send all" to Claude is one message whose plain words hold no path and whose pins brief names every pin, and the
// pins are then marked sent with their turn; to Codex it is one message per pin, the next sent only after the turn
// before ended well, held after one that did not, and continued by the person; a refused send keeps the drafts.
// Method: bundle the real stores with esbuild and drive them against a fake preload (window.avb) that records
// every call; push turn events through the chat store as main would; let the save timer run out on a fake clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/pinStore.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export * as pins from './src/features/ai/pins/pinStore';",
      "export * as ai from './src/features/ai/aiStore';",
      "export * as errorNotices from './src/ui/errorNotices';",
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
  getItem: (key) => (storage.has(key) ? storage.get(key) : JSON.parse('null')),
  setItem: (key, value) => void storage.set(key, String(value)),
  removeItem: (key) => void storage.delete(key),
  clear: () => storage.clear(),
};
global.requestAnimationFrame = (run) => setTimeout(run, 0);
const { pins, ai, errorNotices } = require(output);

const PROJECT = '/site';
const CHAT = `c${'a'.repeat(24)}`;
const turnId = (number) => `t${String(number).padStart(16, '0')}`;
const translate = (key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`);
const anchor = (path) => ({ path, occurrence: 0, at: { x: 0.5, y: 0.5 }, tag: 'h1', text: 'Welcome' });
const place = (file) => ({
  page: 'src/pages/index.astro',
  pageLabel: 'Home',
  scope: undefined,
  file,
  locator: '0.1',
  elementLabel: 'Heading',
  componentFile: undefined,
  breakpointPx: 768,
});
const summary = (agent) => ({ id: CHAT, agent, title: 'New chat', pinned: false, createdAt: 1, updatedAt: 1, rank: 0, unread: false });

function install({ agent = 'claude', board = { version: 1, pins: [] }, images = [], prompt } = {}) {
  const calls = [];
  let turns = 0;
  const record = (name, reply) => async (payload) => {
    calls.push({ name, payload });
    return typeof reply === 'function' ? reply(payload) : reply;
  };
  const ok = (value) => ({ ok: true, value });
  global.window = {
    avb: {
      aiAgents: record('aiAgents', () => ({
        trusted: true,
        agents: [{ agent, state: 'ready', adapterVersion: '1.0.0', running: false, downloadMegabytes: 1 }],
        options: [],
      })),
      aiChats: record('aiChats', () => ({ chats: [summary(agent)], sections: [] })),
      aiChatRead: record('aiChatRead', () => ok({ summary: summary(agent), events: [], full: false })),
      aiChatUpdate: record('aiChatUpdate', () => ok(summary(agent))),
      aiPrompt: record(
        'aiPrompt',
        prompt ??
          (() => {
            turns += 1;
            return ok({ turn: turnId(turns) });
          }),
      ),
      aiPinsRead: record('aiPinsRead', () => ok({ board, images })),
      aiPinsWrite: record('aiPinsWrite', () => ok({ saved: true })),
      aiScreenshot: record('aiScreenshot', () => ok({ mimeType: 'image/png', data: 'aGVsbG8=', width: 10, height: 10 })),
      aiAck: () => undefined,
      onAiEvents: () => () => undefined,
      onAiAgentStatus: () => () => undefined,
      onAiSetup: () => () => undefined,
    },
  };
  return { calls, named: (name) => calls.filter((call) => call.name === name) };
}

async function settle(rounds = 8) {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function start(options) {
  ai.resetAiStore();
  pins.resetPinStore();
  storage.clear();
  const fake = install(options);
  await ai.loadAiProject(PROJECT);
  await ai.openChat(CHAT);
  await pins.loadPins(PROJECT);
  return fake;
}

function drop(file = 'src/pages/index.astro', path = '0.1') {
  const id = pins.dropPin({ anchor: anchor(path), place: place(file) }, translate);
  assert.ok(id !== undefined);
  return id;
}

// A pin dropped, its words typed and saved, as the person does with Save.
function pinned(words, file = 'src/pages/index.astro', path = '0.1') {
  const id = drop(file, path);
  pins.setPinComment(id, words);
  pins.savePinBox();
  assert.equal(pins.pinState().open, undefined, 'Save closes the box');
  return id;
}

const pinOf = (id) => pins.pinState().board.pins.find((pin) => pin.id === id);

// The toasts the store raised, read as the app's toast host reads them.
function collectToasts() {
  const toasts = [];
  const unsubscribe = errorNotices.subscribeErrorToasts(
    (toast) => toasts.push(toast),
    () => undefined,
  );
  return { toasts, unsubscribe };
}

test('a board is read when the project opens; a pin left waiting in a closed run is a draft again', async () => {
  const waiting = {
    id: `p${'1'.repeat(16)}`,
    number: 1,
    createdAt: 1,
    updatedAt: 1,
    comment: 'Bigger',
    images: [],
    savedAt: 1,
    anchor: anchor('0.1'),
    place: { ...place('src/pages/index.astro'), scope: undefined },
    included: true,
    delivery: { kind: 'sent', chat: CHAT, mode: 'single', at: 1 },
  };
  const typed = {
    ...waiting,
    id: `p${'2'.repeat(16)}`,
    number: 2,
    comment: '',
    savedAt: undefined,
    delivery: { kind: 'draft' },
    edit: { comment: 'Typed before a crash', images: [] },
  };
  const empty = { ...typed, id: `p${'3'.repeat(16)}`, number: 3, edit: { comment: '', images: [] } };
  await start({ board: { version: 1, pins: [waiting, typed, empty] } });
  assert.deepEqual(pins.pinState().board.pins[0].delivery, { kind: 'draft' });
  assert.equal(pins.pinState().board.pins[1]?.edit?.comment, 'Typed before a crash', 'unsaved words survive a restart');
  assert.equal(pins.pinState().board.pins.length, 2, 'an empty pin never saved is let go');
});

test('changes are saved after a pause, each image once; nothing is sent by itself', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = await start();
  context.mock.timers.tick(0);
  const id = drop();
  pins.setPinComment(id, 'Make it bigger');
  pins.addImagesToPin(id, [{ kind: 'added', name: 'ref.png', mimeType: 'image/png', data: 'aGVsbG8=' }], translate);
  assert.equal(fake.named('aiPinsWrite').length, 0, 'typing does not save on every key');
  context.mock.timers.tick(400);
  await pins.flushPinSave();
  context.mock.timers.tick(0);
  const writes = fake.named('aiPinsWrite');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].payload.board.pins[0].edit.comment, 'Make it bigger', 'unsaved words are stored, so a crash loses nothing');
  assert.equal(writes[0].payload.board.pins[0].comment, '', 'they are not the comment until Save');
  assert.equal(writes[0].payload.images.length, 1);
  pins.setPinComment(id, 'Make it much bigger');
  context.mock.timers.tick(400);
  await pins.flushPinSave();
  assert.equal(fake.named('aiPinsWrite')[1].payload.images.length, 0, 'a stored image is not sent again');
  assert.equal(fake.named('aiPrompt').length, 0, 'no pin is ever sent without Send all');
});

test('include and delete do only what they say', async () => {
  await start();
  const first = pinned('First');
  const second = pinned('Second', 'src/pages/about.astro');
  pins.setPinIncluded(second, 'exclude');
  assert.equal(pins.pinState().board.pins.find((pin) => pin.id === second).included, false);
  pins.deletePin(first);
  assert.deepEqual(
    pins.pinState().board.pins.map((pin) => pin.id),
    [second],
  );
});

// A Claude run as main reports it: the turn, then one Agent call per pin, each finishing on its own.
const agentEvent = (turn, call, number, status) => ({
  kind: 'tool',
  turn,
  call,
  title: `Pin ${number}: Change`,
  toolKind: 'think',
  status,
  paths: undefined,
  diffs: undefined,
  output: undefined,
  exitCode: undefined,
  parent: undefined,
  toolName: 'Agent',
  at: 2,
});
const push = (events) => ai.receiveEvents({ projectPath: PROJECT, chat: CHAT, events });
const opened = (turn) => [
  { kind: 'turn-start', turn, at: 1 },
  { kind: 'user', turn, text: 'Pins', attachments: [], at: 1 },
];

test('Claude: each pin is deleted as its own subagent finishes well; the others stay with their status', async () => {
  await start({ agent: 'claude' });
  const stop = pins.followChats();
  const one = pinned('One', 'src/pages/index.astro', '0.1');
  const two = pinned('Two', 'src/pages/index.astro', '0.2');
  const three = pinned('Three', 'src/pages/index.astro', '0.3');
  pins.setPinListOpen('open');
  assert.equal(await pins.sendAllPins(translate), true);
  const turn = turnId(1);
  push([...opened(turn), agentEvent(turn, 'a1', 1, 'in_progress'), agentEvent(turn, 'a2', 2, 'in_progress'), agentEvent(turn, 'a3', 3, 'in_progress')]);
  assert.equal(pins.pinState().board.pins.length, 3, 'nothing goes while every subagent works');
  push([agentEvent(turn, 'a2', 2, 'completed')]);
  assert.equal(pinOf(two), undefined, 'pin 2 goes the moment its subagent finishes, mid-run');
  assert.ok(pinOf(one) !== undefined && pinOf(three) !== undefined, 'the others stay');
  assert.equal(pins.pinState().listOpen, true, 'the list stays open while pins remain');
  push([agentEvent(turn, 'a1', 1, 'failed')]);
  push([agentEvent(turn, 'a3', 3, 'completed'), { kind: 'turn-end', turn, stop: 'end_turn', message: undefined, at: 9 }]);
  assert.equal(pinOf(three), undefined);
  assert.equal(pins.progressOf(pinOf(one)).kind, 'attention', 'a failed pin stays with its status');
  pins.deletePin(one);
  assert.equal(pins.pinState().listOpen, false, 'the list closes once no pin is left');
  stop();
});

test('a turn that ends in an error deletes no pin; one finished but holding unsaved words becomes a draft with them', async () => {
  await start({ agent: 'claude' });
  const stop = pins.followChats();
  const one = pinned('One', 'src/pages/index.astro', '0.1');
  const two = pinned('Two', 'src/pages/index.astro', '0.2');
  assert.equal(await pins.sendAllPins(translate), true);
  // Dictation that lands after the send writes into the sent pin's box: words not saved.
  pins.setPinComment(two, 'Also make it blue');
  const turn = turnId(1);
  push([...opened(turn), { kind: 'turn-end', turn, stop: 'error', message: undefined, at: 9 }]);
  assert.equal(pins.pinState().board.pins.length, 2, 'an unclean end keeps every pin');
  await start({ agent: 'claude' });
  const again = pins.followChats();
  pinned('One');
  const typed = pinned('Two', 'src/pages/index.astro', '0.2');
  assert.equal(await pins.sendAllPins(translate), true);
  pins.setPinComment(typed, 'Also make it blue');
  push([...opened(turn), { kind: 'turn-end', turn, stop: 'end_turn', message: undefined, at: 9 }]);
  assert.equal(pins.pinState().board.pins.length, 1, 'the finished pin without typed words is deleted');
  assert.equal(pinOf(typed)?.delivery.kind, 'draft', 'the one holding typed words is kept as a draft');
  assert.equal(pinOf(typed)?.edit?.comment, 'Also make it blue', 'with its words');
  stop();
  again();
  assert.ok(one.length > 0);
});

test('Codex: each pin is deleted when its own turn ends well, and the run goes on', async () => {
  const fake = await start({ agent: 'codex' });
  const stop = pins.followChats();
  pinned('One', 'src/pages/index.astro', '0.1');
  pinned('Two', 'src/pages/index.astro', '0.2');
  assert.equal(await pins.sendAllPins(translate), true);
  push([...opened(turnId(1)), { kind: 'turn-end', turn: turnId(1), stop: 'end_turn', message: undefined, at: 9 }]);
  await settle();
  assert.deepEqual(
    pins.pinState().board.pins.map((pin) => pin.number),
    [2],
    'pin 1 went with its turn',
  );
  assert.equal(fake.named('aiPrompt').length, 2, 'and pin 2 was sent');
  push([...opened(turnId(2)), { kind: 'turn-end', turn: turnId(2), stop: 'end_turn', message: undefined, at: 9 }]);
  await settle();
  assert.equal(pins.pinState().board.pins.length, 0);
  assert.equal(pins.pinState().run, undefined, 'the run ended with its last pin');
  stop();
});

test('after a restart, pins whose work finished while the app was closed are deleted once their chat is read', async () => {
  const turn = turnId(1);
  const sentPin = (number, path) => ({
    id: `p${String(number).repeat(16)}`,
    number,
    createdAt: 1,
    updatedAt: 1,
    comment: `Pin ${number}`,
    images: [],
    savedAt: 1,
    edit: undefined,
    anchor: anchor(path),
    place: place('src/pages/index.astro'),
    included: true,
    delivery: { kind: 'sent', chat: CHAT, turn, mode: 'subagents', at: 1 },
  });
  const board = { version: 1, pins: [sentPin(1, '0.1'), sentPin(2, '0.2')] };
  const events = [
    ...opened(turn),
    agentEvent(turn, 'a1', 1, 'completed'),
    agentEvent(turn, 'a2', 2, 'failed'),
    { kind: 'turn-end', turn, stop: 'end_turn', message: undefined, at: 9 },
  ];
  ai.resetAiStore();
  pins.resetPinStore();
  install({ agent: 'claude', board });
  global.window.avb.aiChatRead = async () => ({ ok: true, value: { summary: summary('claude'), events, full: true } });
  await ai.loadAiProject(PROJECT);
  const stop = pins.followChats();
  await pins.loadPins(PROJECT);
  await settle();
  assert.deepEqual(
    pins.pinState().board.pins.map((pin) => pin.number),
    [2],
    'the finished pin was deleted on load; the failed one stays',
  );
  stop();
});

test('Send all to Claude: one message, the brief naming every included pin, then marked sent with the turn', async () => {
  const fake = await start({ agent: 'claude' });
  const first = pinned('Bigger heading', 'src/pages/index.astro', '0.1');
  pinned('Less space', 'src/pages/index.astro', '0.2');
  const third = pinned('Later', 'src/pages/about.astro', '0.3');
  pins.setPinIncluded(third, 'exclude');
  // A fourth, typed and never saved, is not sent.
  const fourth = drop('src/pages/about.astro', '0.4');
  pins.setPinComment(fourth, 'Not saved yet');
  assert.equal(pins.sendReadiness(pins.pinState(), ai.aiState()).kind, 'ready');
  assert.equal(await pins.sendAllPins(translate), true);
  const sent = fake.named('aiPrompt');
  assert.equal(sent.length, 1);
  const payload = sent[0].payload;
  assert.equal(payload.pins.mode, 'subagents');
  assert.deepEqual(
    payload.pins.pins.map((pin) => pin.number),
    [1, 2],
  );
  assert.ok(!payload.text.includes('src/'), 'the plain words hold no path');
  const board = pins.pinState().board.pins;
  assert.deepEqual(board.find((pin) => pin.id === first).delivery.turn, turnId(1));
  assert.equal(board.find((pin) => pin.id === third).delivery.kind, 'draft', 'the excluded pin stays a draft');
});

test('a refused send keeps the drafts', async () => {
  await start({ prompt: () => ({ ok: false, error: { code: 'busy', message: 'busy' } }) });
  pinned('Bigger');
  assert.equal(await pins.sendAllPins(translate), false);
  assert.equal(pins.pinState().board.pins[0].delivery.kind, 'draft');
});

test('Send all to Codex: one message per pin, the next after a turn that ended well, held after one that did not', async () => {
  const fake = await start({ agent: 'codex' });
  const stop = pins.followChats();
  pinned('One', 'src/pages/index.astro', '0.1');
  pinned('Two', 'src/pages/index.astro', '0.2');
  pinned('Three', 'src/pages/index.astro', '0.3');
  assert.equal(await pins.sendAllPins(translate), true);
  assert.equal(fake.named('aiPrompt').length, 1, 'one pin at a time');
  assert.equal(fake.named('aiPrompt')[0].payload.pins.mode, 'single');
  const end = (turn, stopReason) =>
    ai.receiveEvents({ projectPath: PROJECT, chat: CHAT, events: [{ kind: 'turn-end', turn, stop: stopReason, message: undefined, at: 9 }] });
  const begin = (turn) =>
    ai.receiveEvents({
      projectPath: PROJECT,
      chat: CHAT,
      events: [
        { kind: 'turn-start', turn, at: 1 },
        { kind: 'user', turn, text: 'Pin', attachments: [], at: 1 },
      ],
    });
  begin(turnId(1));
  end(turnId(1), 'end_turn');
  await settle();
  assert.equal(fake.named('aiPrompt').length, 2, 'the second pin went after the first turn ended well');
  begin(turnId(2));
  end(turnId(2), 'error');
  await settle();
  assert.equal(fake.named('aiPrompt').length, 2, 'held after a turn that did not end well');
  assert.equal(pins.pinState().run.held, 'paused');
  const third = pins.pinState().board.pins.find((pin) => pin.number === 3);
  assert.deepEqual(pins.progressOf(third), { kind: 'attention', reason: 'paused' });
  assert.equal(await pins.continueRun(translate), true);
  assert.equal(fake.named('aiPrompt').length, 3);
  stop();
});

test('the close button drops a pin never saved, with Undo; on a saved pin it drops only the changes', async () => {
  await start();
  const { toasts, unsubscribe } = collectToasts();
  const fresh = drop();
  pins.setPinComment(fresh, 'Typed, never saved');
  pins.closePinBox('discard', translate);
  assert.equal(pinOf(fresh), undefined, 'a pin never saved goes');
  const undo = toasts.at(-1)?.recovery?.[0];
  assert.ok(undo !== undefined, 'an Undo is offered for the words that went');
  await errorNotices.runToastRecovery(undo);
  assert.equal(pinOf(fresh)?.edit?.comment, 'Typed, never saved', 'Undo brings the pin and its words back');
  const saved = pinned('Saved words', 'src/pages/about.astro', '0.2');
  pins.openPin(saved, translate);
  pins.setPinComment(saved, 'Changed, not saved');
  pins.closePinBox('discard', translate);
  assert.equal(pinOf(saved)?.comment, 'Saved words', 'the saved comment stays');
  assert.equal(pinOf(saved)?.edit, undefined);
  unsubscribe();
});

test('a press elsewhere, another pin or leaving the mode keeps typed words: saved with content, let go when empty', async () => {
  await start();
  const typed = drop();
  pins.setPinComment(typed, 'Keep me');
  const empty = drop('src/pages/about.astro', '0.2');
  assert.equal(pinOf(typed)?.comment, 'Keep me', 'pinning another spot saved the open box');
  pins.setCommentMode('off');
  assert.equal(pinOf(empty), undefined, 'an empty pin never saved is let go when the mode ends');
  pins.setCommentMode('on');
  pins.openPin(typed, translate);
  pins.setPinComment(typed, 'Kept again');
  pins.closePinBox('keep', translate);
  assert.equal(pinOf(typed)?.comment, 'Kept again');
});

test('a moved pin keeps its words, unsaved changes and number; Undo puts it back', async () => {
  await start();
  const { toasts, unsubscribe } = collectToasts();
  const id = pinned('Bigger');
  pins.openPin(id, translate);
  pins.setPinComment(id, 'Bigger still');
  assert.equal(pins.movePin(id, { anchor: anchor('0.7'), place: place('src/pages/index.astro') }, translate), true);
  assert.equal(pinOf(id)?.anchor.path, '0.7');
  assert.equal(pinOf(id)?.edit?.comment, 'Bigger still', 'moving does not need Save and loses nothing');
  assert.equal(pins.pinState().open, id, 'its box stays open');
  await errorNotices.runToastRecovery(toasts.at(-1).recovery[0]);
  assert.equal(pinOf(id)?.anchor.path, '0.1', 'Undo puts it back');
  unsubscribe();
});
