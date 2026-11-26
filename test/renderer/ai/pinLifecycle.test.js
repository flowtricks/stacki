// Goal: what the panel says about an agent and a pin is what is true. A pin reads "Needs you" only when something
// waits for the person (a permission card or the agent's question), never because a reply failed or a pin was not
// started; an agent sent to the background is never finished by its launch call, nor by a reply that ended badly;
// the strip's head never says finished while an agent works; pins agents restart in a later reply move with it;
// separate messages stay separate paragraphs; and a turn the app closed on does not tick for ever.
// Method: end to end for the background agent: the real host from dist/ drives the stand-in adapter
// (test/fixtures/ai/fakeAdapter.mjs, whose launch sends the prompt and then the launch note as Claude's adapter
// does), and every prefix of its events goes through the real reducer, subagent model and pin model. The other
// cases fold events shaped as the host writes them, after a stored chat in which four pins read "Needs you" with
// nothing to answer. Nothing reaches a real provider.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const loadRenderer = require('../../helpers/rendererModule.js');
const { repoPath } = require('../../helpers/sources.js');

const model = loadRenderer('src/features/ai/pins/pinModel.ts');
const subagents = loadRenderer('src/features/ai/subagents.ts');
const { EMPTY_CHAT, reduceChat } = loadRenderer('src/features/ai/chatReducer.ts');

const turnId = (number) => `t${String(number).padStart(16, '0')}`;
const FIRST = turnId(1);
const SECOND = turnId(2);
const CHAT = `c${'1'.repeat(24)}`;
const sent = (number, mode = 'subagents', turn = FIRST) => ({ number, delivery: { kind: 'sent', chat: CHAT, turn, mode, at: 1 } });
const sentPin = (number) => ({ number, comment: `Pin words ${number}`, pageLabel: 'Home', elementLabel: `Heading ${number}`, image: undefined });
const send = (numbers, mode = 'subagents', turn = FIRST) => [
  { kind: 'turn-start', turn, at: 1 },
  { kind: 'user', turn, text: 'Comments', attachments: [], at: 1, parts: [{ kind: 'pins', mode, pins: numbers.map(sentPin) }] },
];
const tool = (turn, call, title, status, over = {}) => ({
  kind: 'tool',
  turn,
  call,
  title,
  toolKind: 'think',
  status,
  paths: undefined,
  diffs: undefined,
  output: undefined,
  exitCode: undefined,
  parent: undefined,
  at: 2,
  ...over,
});
const agent = (turn, number, status, over = {}) => tool(turn, `a${number}`, `Pin ${number}: Change`, status, { toolName: 'Agent', ...over });
const launched = (turn, number) => [
  agent(turn, number, 'in_progress', { output: 'You are making one change.' }),
  agent(turn, number, 'completed', { output: 'Async agent launched successfully.\nagentId: a1b2c3d4e5f6a7b8' }),
];
const said = (turn, text, over = {}) => ({ kind: 'text', turn, role: 'agent', text, at: 3, ...over });
const user = (turn, text) => ({ kind: 'user', turn, text, attachments: [], at: 4 });
const ended = (turn, stop = 'end_turn') => ({ kind: 'turn-end', turn, stop, message: undefined, at: 9 });
const fold = (...events) => reduceChat(EMPTY_CHAT, events.flat());
const progressOf = (view, number, mode) => model.pinProgress(sent(number, mode), view, 'running');
const kinds = (view, numbers, mode) => numbers.map((number) => progressOf(view, number, mode).kind);

async function hostRun(comment) {
  const load = (file) => import(pathToFileURL(repoPath(file)).href);
  const { AgentHost } = await load('dist/electron/handlers/ai/agentHost.js');
  const { ChatStore } = await load('dist/electron/handlers/ai/chatStore.js');
  const { parseAiEventsPush } = await load('dist/shared/ipc/aiChat.js');
  const { parsePinBrief } = await load('dist/shared/properties/ai/commentPinBrief.js');
  const temporary = (name) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `stacki-lifecycle-${name}-`)));
  const root = temporary('project');
  const userData = temporary('user');
  const bin = temporary('bin');
  fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'claude.cmd' : 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  const store = new ChatStore(path.join(userData, 'ai'));
  const events = [];
  let done;
  const finished = new Promise((resolve) => (done = resolve));
  const host = new AgentHost({
    userData,
    store,
    send: (channel, payload) => {
      if (channel === 'ai:events') {
        const push = parseAiEventsPush(payload);
        events.push(...push.events);
        host.acknowledge(push.chars);
        if (push.events.some((event) => event.kind === 'turn-end')) {
          done();
        }
      }
    },
    files: { read: () => undefined, write: () => undefined, create: () => undefined, trash: async () => undefined },
    snapshots: { snapshot: async () => undefined, changes: async () => [], blob: async () => undefined },
    environment: () => ({ PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, HOME: os.homedir() }),
    now: () => 1_000,
    version: 'test',
    askBeforeTrust: () => true,
    entryOf: () => repoPath('test/fixtures/ai/fakeAdapter.mjs'),
    spawnAdapter: (entry, cwd, environment) => spawn(process.execPath, [entry], { cwd, env: { ...environment }, stdio: ['pipe', 'pipe', 'pipe'] }),
  });
  try {
    store.trust(root);
    const chat = store.create(root, 'claude', 'New chat', 1);
    const brief = parsePinBrief({
      mode: 'subagents',
      pins: [
        {
          number: 1,
          comment,
          pageLabel: 'Home',
          page: 'src/pages/index.astro',
          elementLabel: 'Heading',
          file: 'src/pages/index.astro',
          locator: '0.1',
          tag: 'h1',
          images: [],
        },
      ],
    });
    const started = await host.prompt(root, chat.id, 'Comments on 1 pin', [], { pins: brief });
    assert.ok(started.ok, JSON.stringify(started));
    await finished;
    return { events, turn: started.value.turn };
  } finally {
    host.stopAll();
  }
}

test('a background agent from a real host run outlives its launch call: working until the reply that holds it ends well', async () => {
  const { events, turn } = await hostRun('Change it in the background');
  const launchAt = events.findIndex((event) => event.kind === 'tool' && event.call === 'agent1' && event.status === 'completed');
  assert.ok(launchAt >= 0, 'the launch call returned');
  const endAt = events.findIndex((event) => event.kind === 'turn-end');
  for (let length = launchAt + 1; length <= endAt; length += 1) {
    const view = reduceChat(EMPTY_CHAT, events.slice(0, length));
    const status = subagents.deriveSubagentWork(view).units.get('agent1').agent.status;
    assert.deepEqual([status.kind, status.end], ['running', 'reply'], `after event ${length}: launched is not finished`);
    const strip = subagents.stripState(subagents.deriveSubagents(view), { open: false });
    assert.equal(strip.kind, 'live', 'the strip never folds to finished while it works');
    assert.deepEqual(model.pinProgress(sent(1, 'subagents', turn), view, 'running'), { kind: 'working', end: 'reply' });
    assert.equal(model.pinFinished(sent(1, 'subagents', turn), view), false, 'so its pin is not deleted');
  }
  const after = reduceChat(EMPTY_CHAT, events);
  assert.equal(subagents.deriveSubagentWork(after).units.get('agent1').agent.status.kind, 'done', 'the held reply ending well proves it');
  assert.deepEqual(model.pinProgress(sent(1, 'subagents', turn), after, 'running'), { kind: 'done' });
  const words = after.items.filter((item) => item.kind === 'text').map((item) => item.text);
  assert.deepEqual(words, ['Pin 1 is running.', 'Still going.'], 'two messages stay two paragraphs, though the agent’s work came between them');
});

test('a background agent whose parent reply dies did not finish', async () => {
  const { events, turn } = await hostRun('Change it in the background, then dies');
  const view = reduceChat(EMPTY_CHAT, events);
  assert.equal(subagents.deriveSubagentWork(view).units.get('agent1').agent.status.kind, 'failed');
  assert.deepEqual(model.pinProgress(sent(1, 'subagents', turn), view, 'running'), { kind: 'unfinished', reason: 'failed' });
});

test('the reported case: a reply that dies leaves the other pins not started, never needing the person; restarting them later moves them', () => {
  const died = fold(send([1, 2, 3, 4]), launched(FIRST, 1), ended(FIRST, 'error'));
  assert.deepEqual(progressOf(died, 1), { kind: 'unfinished', reason: 'failed' });
  for (const number of [2, 3, 4]) {
    assert.deepEqual(progressOf(died, number), { kind: 'unfinished', reason: 'not-started' }, `pin ${number}`);
  }
  const again = fold(
    send([1, 2, 3, 4]),
    launched(FIRST, 1),
    ended(FIRST, 'error'),
    { kind: 'turn-start', turn: SECOND, at: 10 },
    user(SECOND, 'Do them all at the same time'),
    tool(SECOND, 'follow', 'SendMessage', 'completed', { toolName: 'SendMessage', sentTo: 'a1b2c3d4e5f6a7b8', output: '{"success":true}' }),
    [2, 3, 4].map((number) => launched(SECOND, number)).flat(),
  );
  assert.deepEqual(kinds(again, [1, 2, 3, 4]), ['working', 'working', 'working', 'working']);
  const strip = subagents.stripState(subagents.deriveSubagents(again), { open: false });
  assert.equal(strip.tally.working, 4, 'the resumed agent is one of them');
  assert.equal(strip.list.agents.length, 4, 'a follow-up is a message, not a fifth agent');
  assert.deepEqual(kinds(reduceChat(again, [ended(SECOND)]), [1, 2, 3, 4]), ['done', 'done', 'done', 'done']);
});

const ASK =
  'Question for pin 2: How tall should the photo be?\n- About half as tall\n- Same height as the text\n\nQuestion for pin 3: Which logo file should I trace?';

test('two pins ask at once while others work: each needs the person until its own answer', () => {
  const view = fold(send([1, 2, 3]), [1, 2, 3].map((number) => launched(FIRST, number)).flat(), said(FIRST, ASK));
  assert.deepEqual(kinds(view, [1, 2, 3]), ['working', 'attention', 'attention'], 'a question never blocks another pin');
  assert.deepEqual(progressOf(view, 2).question, {
    number: 2,
    question: 'How tall should the photo be?',
    choices: ['About half as tall', 'Same height as the text'],
  });
  assert.deepEqual(progressOf(view, 3).question.choices, [], 'no choices: answered in the person’s words');
  assert.equal(model.pinFinished(sent(2), view), false);
  const endedAsking = reduceChat(view, [ended(FIRST)]);
  assert.deepEqual(kinds(endedAsking, [1, 2, 3]), ['done', 'attention', 'attention'], 'the question stands after the reply ends');
  assert.equal(model.pinFinished(sent(2), endedAsking), false, 'a pin with a question open is kept on the board');
  const lead = model.pinReplyLead(sentPin(2));
  const answered = reduceChat(endedAsking, [{ kind: 'turn-start', turn: SECOND, at: 10 }, user(SECOND, `${lead}About half as tall`)]);
  assert.deepEqual(kinds(answered, [2, 3]), ['working', 'attention'], 'an answer about one pin answers only that one');
  assert.deepEqual(kinds(reduceChat(answered, [ended(SECOND)]), [2, 3]), ['done', 'attention']);
  const plain = reduceChat(endedAsking, [{ kind: 'turn-start', turn: SECOND, at: 10 }, user(SECOND, 'Use your judgement on both')]);
  assert.deepEqual(kinds(plain, [2, 3]), ['working', 'working'], 'a message that names no pin answers what was asked');
  const again = reduceChat(answered, [said(SECOND, 'Question for pin 2: Half of the phone height too?')]);
  assert.equal(progressOf(again, 2).question.question, 'Half of the phone height too?', 'a new question asks again');
});

test('a question in a subagent’s report asks; the agent repeating it after a steered answer does not ask twice', () => {
  const report = agent(FIRST, 1, 'completed', { output: 'Question for pin 1: Which colour?\n- Blue\n- Black' });
  const view = fold(send([1]), agent(FIRST, 1, 'in_progress'), report);
  assert.deepEqual(progressOf(view, 1).question.choices, ['Blue', 'Black']);
  const steered = reduceChat(view, [user(FIRST, `${model.pinReplyLead(sentPin(1))}Blue`), said(FIRST, 'Question for pin 1: Which colour?'), ended(FIRST)]);
  assert.deepEqual(progressOf(steered, 1), { kind: 'done' });
});

test('words that merely ask, without the form, never claim to need the person', () => {
  const view = fold(send([1], 'single'), said(FIRST, 'Should I make it shorter?'), ended(FIRST));
  assert.deepEqual(progressOf(view, 1, 'single'), { kind: 'done' });
});

test('one message per pin: a question stays on its pin while the next pin runs', () => {
  const view = fold(send([1], 'single'), said(FIRST, 'Question for pin 1: Which size?\n- Small\n- Large'), ended(FIRST), send([2], 'single', SECOND));
  assert.equal(progressOf(view, 1, 'single').reason, 'question');
  assert.equal(model.pinProgress(sent(2, 'single', SECOND), view, 'running').kind, 'working');
});

test('two pins can wait on permissions at once, each naming its own card', () => {
  const ask = (request, call) => ({ kind: 'permission', turn: FIRST, request, call, title: 'Edit', options: [{ id: 'y', name: 'Allow', kind: 'allow_once' }] });
  const view = fold(
    send([1, 2]),
    agent(FIRST, 1, 'in_progress'),
    agent(FIRST, 2, 'in_progress'),
    tool(FIRST, 'e1', 'Edit', 'pending', { parent: 'a1' }),
    tool(FIRST, 'e2', 'Edit', 'pending', { parent: 'a2' }),
    ask('p1', 'e1'),
    ask('p2', 'e2'),
  );
  assert.deepEqual([progressOf(view, 1).request, progressOf(view, 2).request], ['p1', 'p2']);
  const over = reduceChat(view, [ended(FIRST, 'cancelled')]);
  assert.deepEqual(kinds(over, [1, 2]), ['unfinished', 'unfinished'], 'stopped: the cards are gone, nothing is asked');
});

test('Codex’s subagent call says only that it started: never counted finished', () => {
  const view = fold(send([1]), tool(FIRST, 's', 'Start subagent count_files', 'completed'), ended(FIRST));
  assert.deepEqual(subagents.deriveSubagentWork(view).units.get('s').agent.status, { kind: 'unreported' });
  const strip = subagents.stripState(subagents.deriveSubagents(view), { open: false });
  assert.deepEqual([strip.tally.done, strip.tally.unreported], [0, 1]);
});

test('older chats without message ids: a pause after a finished sentence starts a paragraph; streaming chunks stay joined', () => {
  const chunk = (text, at) => said(FIRST, text, { at, until: at });
  const view = fold(
    { kind: 'turn-start', turn: FIRST, at: 1 },
    chunk('Only pin 3 is still', 100),
    chunk(' running. It', 140),
    chunk(' is close.', 180),
    chunk('**Pin 4 is done:** the footer', 9_000),
    chunk(' changed.', 9_040),
  );
  assert.equal(view.items.at(-1).text, 'Only pin 3 is still running. It is close.\n\n**Pin 4 is done:** the footer changed.');
});

test('a turn the app closed on is ended when the chat is read back, so nothing in it keeps ticking', async () => {
  const { closeInterruptedTurns } = await import(pathToFileURL(repoPath('dist/electron/handlers/ai/chatEvents.js')).href);
  const stored = [...send([1, 2]), ...launched(FIRST, 1)];
  const read = closeInterruptedTurns(stored, undefined);
  assert.deepEqual(read.at(-1), { kind: 'turn-end', turn: FIRST, stop: 'error', message: undefined, at: 1 });
  assert.deepEqual(kinds(reduceChat(EMPTY_CHAT, read), [1, 2]), ['unfinished', 'unfinished']);
  assert.equal(closeInterruptedTurns(stored, FIRST).length, stored.length, 'the turn the host still runs stays open');
  const later = closeInterruptedTurns([...stored, ...send([3], 'subagents', SECOND), ended(SECOND)], undefined);
  assert.equal(later[stored.length].kind, 'turn-end', 'closed where its events stop, before the next turn');
  assert.equal(later.filter((event) => event.kind === 'turn-end').length, 2);
});
