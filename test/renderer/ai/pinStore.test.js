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
    contents: ["export * as pins from './src/features/ai/pins/pinStore';", "export * as ai from './src/features/ai/aiStore';"].join('\n'),
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
const { pins, ai } = require(output);

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

test('a board is read when the project opens; a pin left waiting in a closed run is a draft again', async () => {
  const waiting = {
    id: `p${'1'.repeat(16)}`,
    number: 1,
    createdAt: 1,
    updatedAt: 1,
    comment: 'Bigger',
    images: [],
    anchor: anchor('0.1'),
    place: { ...place('src/pages/index.astro'), scope: undefined },
    included: true,
    delivery: { kind: 'sent', chat: CHAT, mode: 'single', at: 1 },
  };
  await start({ board: { version: 1, pins: [waiting] } });
  assert.deepEqual(pins.pinState().board.pins[0].delivery, { kind: 'draft' });
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
  assert.equal(writes[0].payload.board.pins[0].comment, 'Make it bigger');
  assert.equal(writes[0].payload.images.length, 1);
  pins.setPinComment(id, 'Make it much bigger');
  context.mock.timers.tick(400);
  await pins.flushPinSave();
  assert.equal(fake.named('aiPinsWrite')[1].payload.images.length, 0, 'a stored image is not sent again');
  assert.equal(fake.named('aiPrompt').length, 0, 'no pin is ever sent without Send all');
});

test('include, delete and clear sent do only what they say', async () => {
  await start();
  const first = drop();
  const second = drop('src/pages/about.astro');
  pins.setPinIncluded(second, 'exclude');
  assert.equal(pins.pinState().board.pins.find((pin) => pin.id === second).included, false);
  pins.deletePin(first);
  assert.deepEqual(
    pins.pinState().board.pins.map((pin) => pin.id),
    [second],
  );
  pins.clearSent();
  assert.equal(pins.pinState().board.pins.length, 1, 'a draft is not cleared with the sent pins');
});

test('Send all to Claude: one message, the brief naming every included pin, then marked sent with the turn', async () => {
  const fake = await start({ agent: 'claude' });
  const first = drop('src/pages/index.astro', '0.1');
  pins.setPinComment(first, 'Bigger heading');
  const second = drop('src/pages/index.astro', '0.2');
  pins.setPinComment(second, 'Less space');
  const third = drop('src/pages/about.astro', '0.3');
  pins.setPinIncluded(third, 'exclude');
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
  drop();
  assert.equal(await pins.sendAllPins(translate), false);
  assert.equal(pins.pinState().board.pins[0].delivery.kind, 'draft');
});

test('Send all to Codex: one message per pin, the next after a turn that ended well, held after one that did not', async () => {
  const fake = await start({ agent: 'codex' });
  const stop = pins.followChats();
  drop('src/pages/index.astro', '0.1');
  drop('src/pages/index.astro', '0.2');
  drop('src/pages/index.astro', '0.3');
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
