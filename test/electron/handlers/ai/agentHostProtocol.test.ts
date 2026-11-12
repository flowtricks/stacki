// Goal: the host speaks the protocol features the AI panel overhaul relies on, and
// fails as values where an agent cannot. Steering a running turn, compacting, forking
// a session, session modes, usage and the unread mark on the chat record, background
// commands that outlive their turn, terminal output that is not doubled, duplicate
// compaction and notice updates, a 401 that becomes the sign-in card, and the exact
// capabilities Stacki declares.
// Methodology: real modules from dist/ and the stand-in adapter process
// (test/fixtures/ai/fakeAdapter.mjs), whose scenarios are chosen by what a prompt says
// and by environment switches; temporary folders for the project and the store. Each
// test also drives the negative space: steering while idle or unsupported, compacting
// for an agent that cannot, a fork the agent does not offer, a mention outside the
// project, a cancelled turn that must not read as unread.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { AgentHost, CLIENT_CAPABILITIES } from '#dist/electron/handlers/ai/agentHost.js';
import { forkRecord } from '#dist/electron/handlers/ai/chatStore.js';
import { ChatStore } from '#dist/electron/handlers/ai/chatStore.js';
import { parseAiEventsPush } from '#dist/shared/ipc/aiChat.js';
import { toChatId, type ChatEvent, type ChatId } from '#dist/shared/properties/ai/chatModel.js';
import type { AgentId } from '#dist/shared/properties/ai/agentIds.js';

const FAKE_ADAPTER = path.resolve('test/fixtures/ai/fakeAdapter.mjs');

function temporary(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `stacki-ai-${name}-`));
}

const plainFiles = {
  read: (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined),
  write: (file: string, text: string, expected: string) => {
    assert.equal(fs.readFileSync(file, 'utf8'), expected, 'a witnessed write');
    fs.writeFileSync(file, text);
  },
  create: (file: string, text: string) => fs.writeFileSync(file, text, { flag: 'wx' }),
  trash: async (file: string) => fs.rmSync(file),
};

const noSnapshots = { snapshot: async () => undefined, changes: async () => [], blob: async () => undefined };

function fakeHost(adapterEnvironment: Record<string, string> = {}) {
  const root = fs.realpathSync(temporary('project'));
  const userData = temporary('user');
  const bin = temporary('bin');
  for (const cli of ['claude', 'codex']) {
    // Windows finds a CLI by its .cmd or .exe name, so the stand-in carries the extension there.
    fs.writeFileSync(path.join(bin, process.platform === 'win32' ? `${cli}.cmd` : cli), '#!/bin/sh\n', { mode: 0o755 });
  }
  fs.writeFileSync(path.join(root, 'notes.txt'), 'line one\nline two\n');
  const store = new ChatStore(path.join(userData, 'ai'));
  store.trust(root);
  const pushes: ChatEvent[] = [];
  const host = new AgentHost({
    userData,
    store,
    send: (channel: string, payload: unknown) => {
      if (channel === 'ai:events') {
        const push = parseAiEventsPush(payload);
        pushes.push(...push.events);
        host.acknowledge(push.chars);
      }
    },
    files: plainFiles,
    snapshots: noSnapshots,
    environment: () => ({ PATH: `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`, HOME: os.homedir(), ...adapterEnvironment }),
    now: () => 1_000,
    home: () => userData,
    version: 'test',
    askBeforeTrust: () => true,
    entryOf: () => FAKE_ADAPTER,
    spawnAdapter: (entry: string, cwd: string, environment: Record<string, string | undefined>) =>
      spawn(process.execPath, [entry], { cwd, env: { ...environment }, stdio: ['pipe', 'pipe', 'pipe'] }),
  });
  const chat = (agent: AgentId = 'claude'): ChatId => {
    const record = store.create(root, agent, 'New chat', 1);
    assert.ok(record !== undefined);
    return record.id;
  };
  return { root, store, host, chat, events: (): readonly ChatEvent[] => pushes };
}

function ofKind<K extends ChatEvent['kind']>(events: readonly ChatEvent[], kind: K): Extract<ChatEvent, { readonly kind: K }>[] {
  return events.filter((event): event is Extract<ChatEvent, { readonly kind: K }> => event.kind === kind);
}

function created<T>(value: T | undefined): T {
  assert.ok(value !== undefined, 'created');
  return value;
}

async function until(label: string, condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${label}`);
}

async function runTurn(setup: ReturnType<typeof fakeHost>, chat: ChatId, text: string): Promise<void> {
  const ended = ofKind(setup.events(), 'turn-end').length;
  const started = await setup.host.prompt(setup.root, chat, text, []);
  assert.ok(started.ok, started.ok ? '' : started.error.message);
  await until('the end of the turn', () => ofKind(setup.events(), 'turn-end').length === ended + 1);
}

test('the declared capabilities are exactly the open ones: no JetBrains AIR, no boolean options, no elicitation', async (context) => {
  const setup = fakeHost();
  context.after(() => setup.host.stopAll());
  await runTurn(setup, setup.chat(), 'tell me the capabilities');
  // The echoed object is followed by the stand-in's usual answer, joined into the same streamed text.
  const reply = created(ofKind(setup.events(), 'text')[0]).text;
  const echoed: unknown = JSON.parse(reply.slice(0, reply.indexOf('Done')));
  assert.deepEqual(echoed, JSON.parse(JSON.stringify(CLIENT_CAPABILITIES)), 'the adapter received exactly the constant');
  assert.deepEqual(echoed, {
    fs: { readTextFile: true, writeTextFile: true },
    terminal: false,
    session: { compaction: {}, notices: {} },
    _meta: { terminal_output_delta: true },
  });
  const source = JSON.stringify(echoed);
  for (const forbidden of ['jetbrains', 'air', 'configOptions', 'elicitation']) {
    assert.ok(!source.toLowerCase().includes(forbidden.toLowerCase()), `no ${forbidden} capability`);
  }
});

test('steering injects into the running turn, a second send stays busy, and an idle steer starts a turn', async (context) => {
  const setup = fakeHost();
  context.after(() => setup.host.stopAll());
  const chat = setup.chat();
  const started = await setup.host.prompt(setup.root, chat, 'please hold on', []);
  assert.ok(started.ok);
  await until('the held turn', () => ofKind(setup.events(), 'text').length > 0);
  const busy = await setup.host.prompt(setup.root, chat, 'a second send', []);
  assert.ok(!busy.ok);
  assert.equal(busy.error.code, 'busy', 'a send is never interleaved; queueing is the renderer');
  const refused = await setup.host.steer(setup.root, chat, 'refuse this one', [], undefined);
  assert.ok(!refused.ok);
  assert.equal(refused.error.code, 'agent-failed', 'an adapter that refuses is a failure value, nothing was sent');
  const steered = await setup.host.steer(setup.root, chat, 'go left instead', [], undefined);
  assert.ok(steered.ok, steered.ok ? '' : steered.error.message);
  assert.equal(steered.value.outcome, 'steered');
  assert.equal(steered.value.turn, started.value.turn, 'the steer belongs to the running turn');
  await until('the end of the turn', () => ofKind(setup.events(), 'turn-end').length === 1);
  const users = ofKind(setup.events(), 'user');
  assert.deepEqual(
    users.map((event) => [event.text, event.mode]),
    [
      ['please hold on', undefined],
      ['go left instead', 'steer'],
    ],
  );
  assert.ok(ofKind(setup.events(), 'text').some((event) => event.text.includes('Steered: go left instead')));
  const idle = await setup.host.steer(setup.root, chat, 'now it is idle', [], undefined);
  assert.ok(idle.ok, idle.ok ? '' : idle.error.message);
  assert.equal(idle.value.outcome, 'startedNewTurn', 'with no turn running there is nothing to steer: the message starts one');
  await until('the second turn', () => ofKind(setup.events(), 'turn-end').length === 2);
});

test('steering an agent that does not offer it is unsupported, and nothing is sent', async (context) => {
  const setup = fakeHost({ FAKE_PLAIN: '1' });
  context.after(() => setup.host.stopAll());
  const chat = setup.chat();
  assert.ok((await setup.host.prompt(setup.root, chat, 'please hold on', [])).ok);
  await until('the held turn', () => ofKind(setup.events(), 'text').length > 0);
  const steered = await setup.host.steer(setup.root, chat, 'anything', [], undefined);
  assert.ok(!steered.ok);
  assert.equal(steered.error.code, 'unsupported');
  assert.equal(ofKind(setup.events(), 'user').length, 1, 'no user event for a message that was not sent');
  setup.host.cancel(setup.root, chat);
  await until('the cancelled end', () => ofKind(setup.events(), 'turn-end').length === 1);
  assert.equal(created(ofKind(setup.events(), 'turn-end')[0]).stop, 'cancelled');
  assert.equal(setup.store.find(setup.root, chat)?.unread, false, 'a turn the person stopped is not news');
});

test('compaction: one row per status however often it repeats, the turn ends, the context is kept', async (context) => {
  const setup = fakeHost();
  context.after(() => setup.host.stopAll());
  const chat = setup.chat();
  const before = await setup.host.compact(setup.root, chat);
  assert.ok(!before.ok);
  assert.equal(before.error.code, 'invalid', 'nothing to compact before the first message');
  await runTurn(setup, chat, 'hello');
  const compacted = await setup.host.compact(setup.root, chat);
  assert.ok(compacted.ok, compacted.ok ? '' : compacted.error.message);
  await until('the compaction turn', () => ofKind(setup.events(), 'turn-end').length === 2);
  assert.deepEqual(
    ofKind(setup.events(), 'compaction').map((event) => [event.id, event.status, event.at]),
    [
      ['c1', 'in_progress', 1_000],
      ['c1', 'completed', 1_000],
    ],
    'duplicates of a status are dropped, and a compaction ends once',
  );
  assert.equal(ofKind(setup.events(), 'user').length, 1, 'compacting is not a message: no user row');
  assert.deepEqual(setup.store.find(setup.root, chat)?.context, { used: 5_000, size: 1_000_000 });
  // Cannot compact while a turn runs.
  assert.ok((await setup.host.prompt(setup.root, chat, 'hold on', [])).ok);
  await until('the held turn', () => ofKind(setup.events(), 'text').some((event) => event.text === 'Working'));
  const busy = await setup.host.compact(setup.root, chat);
  assert.ok(!busy.ok);
  assert.equal(busy.error.code, 'busy');
  setup.host.cancel(setup.root, chat);
  await until('the cancelled end', () => ofKind(setup.events(), 'turn-end').length === 3);
});

test('a failed compaction ends failed; the tool-call shape and a silent adapter still give one row', async (context) => {
  for (const [switches, prompt, expected] of [
    [
      {},
      '/compact fail',
      [
        ['c1', 'in_progress'],
        ['c1', 'failed'],
      ],
    ],
    [
      { FAKE_COMPACTION: 'tool' },
      '/compact',
      [
        ['compact1', 'in_progress'],
        ['compact1', 'completed'],
      ],
    ],
    [
      { FAKE_COMPACTION: 'tool' },
      '/compact fail',
      [
        ['compact1', 'in_progress'],
        ['compact1', 'failed'],
      ],
    ],
  ] as const) {
    const setup = fakeHost({ ...switches });
    context.after(() => setup.host.stopAll());
    const chat = setup.chat();
    await runTurn(setup, chat, 'hello');
    // The stand-in reads the command from the prompt, which Stacki fixes to /compact: drive the variants through the text switch.
    const raw = await setup.host.prompt(setup.root, chat, prompt, []);
    assert.ok(raw.ok);
    await until('the compaction turn', () => ofKind(setup.events(), 'turn-end').length === 2);
    assert.deepEqual(
      ofKind(setup.events(), 'compaction').map((event) => [event.id, event.status]),
      expected,
    );
    assert.equal(ofKind(setup.events(), 'tool').length, 0, 'a compaction call is never shown as a tool');
  }
});

test('a compaction the adapter never reports still answers the click with one finished row', async (context) => {
  const setup = fakeHost({ FAKE_COMPACTION: 'silent' });
  context.after(() => setup.host.stopAll());
  const chat = setup.chat();
  await runTurn(setup, chat, 'hello');
  assert.ok((await setup.host.compact(setup.root, chat)).ok);
  await until('the compaction turn', () => ofKind(setup.events(), 'turn-end').length === 2);
  const rows = ofKind(setup.events(), 'compaction');
  assert.deepEqual(
    rows.map((row) => row.status),
    ['completed'],
  );
  assert.match(created(rows[0]).id, /^compact-t/);
});

test('Codex cannot compact: unsupported, before anything is started', async (context) => {
  const setup = fakeHost();
  context.after(() => setup.host.stopAll());
  const chat = setup.chat('codex');
  const compacted = await setup.host.compact(setup.root, chat);
  assert.ok(!compacted.ok);
  assert.equal(compacted.error.code, 'unsupported');
  assert.equal(ofKind(setup.events(), 'turn-start').length, 0);
});

test('usage and the unread mark are kept on the chat record; a late background update reaches the transcript', async (context) => {
  const setup = fakeHost();
  context.after(() => setup.host.stopAll());
  const chat = setup.chat();
  assert.equal(setup.store.find(setup.root, chat)?.unread, false);
  await runTurn(setup, chat, 'show usage and run in the background');
  const record = created(setup.store.find(setup.root, chat));
  assert.deepEqual(record.context, { used: 41_250, size: 1_000_000 });
  assert.equal(record.unread, true, 'a turn ended while the person may be elsewhere');
  const started = created(ofKind(setup.events(), 'tool').find((event) => event.call === 'bg1'));
  assert.equal(started.background, true);
  assert.equal(started.command, 'npm run dev');
  assert.equal(started.toolName, 'Bash');
  assert.equal(started.at, 1_000);
  const turn = created(ofKind(setup.events(), 'turn-end')[0]).turn;
  await until('the late update', () => ofKind(setup.events(), 'tool').some((event) => event.call === 'bg1' && event.status === 'completed'));
  const finished = created(ofKind(setup.events(), 'tool').find((event) => event.call === 'bg1' && event.status === 'completed'));
  assert.equal(finished.turn, turn, 'a background task finishes under the turn that started it');
  setup.host.cancel(setup.root, chat); // Stop agent after the turn: reaches the adapter, never throws.
});

test('terminal deltas are not doubled by the result text, and a repeated notice shows once', async (context) => {
  const setup = fakeHost();
  context.after(() => setup.host.stopAll());
  await runTurn(setup, setup.chat(), 'stream the output and a notice');
  const outputs = ofKind(setup.events(), 'tool')
    .filter((event) => event.call === 'run1')
    .map((event) => event.output);
  assert.equal(outputs.filter((output) => output !== undefined).join(''), 'ab', 'a and b once each, not again in the completed result');
  assert.equal(created(ofKind(setup.events(), 'tool').find((event) => event.call === 'run1')).command, 'echo ab');
  assert.equal(ofKind(setup.events(), 'notice').length, 1, 'the same notice twice in a row is one');
});

test('text carries its time, and a 401 is the sign-in card, not a red error', async (context) => {
  const setup = fakeHost();
  context.after(() => setup.host.stopAll());
  const chat = setup.chat();
  await runTurn(setup, chat, 'hello');
  assert.deepEqual(
    ofKind(setup.events(), 'text').map((event) => [event.at, event.until]),
    [[1_000, 1_000]],
  );
  await runTurn(setup, chat, 'this is unauthorized');
  const end = created(ofKind(setup.events(), 'turn-end').at(-1));
  assert.equal(end.stop, 'sign-in');
  assert.equal(setup.host.availability('claude', setup.root).state, 'sign-in');
  assert.equal(ofKind(setup.events(), 'notice').length, 0);
});

test('a fork continues the original session, starts asking again when the original was unrestricted, and falls back with a notice', async (context) => {
  const setup = fakeHost({ FAKE_BYPASS: '1' });
  context.after(() => setup.host.stopAll());
  const source = setup.chat();
  await runTurn(setup, source, 'hello');
  const sourceSession = created(setup.store.find(setup.root, source)?.sessionId);
  const forkId = toChatId(`c${'f'.repeat(24)}`);
  const forked = setup.store.mutate(setup.root, (index) => {
    const result = forkRecord(index, source, forkId, 5);
    return result.ok ? { ok: true as const, value: result.value.index } : result;
  });
  assert.ok(forked.ok);
  await runTurn(setup, forkId, 'continue');
  assert.equal(setup.store.find(setup.root, forkId)?.sessionId, `fork-of-${sourceSession}`, 'the fork is a session/fork of the original');
  const options = created(ofKind(setup.events(), 'options').at(-1));
  assert.equal(options.options.find((option) => option.id === 'mode')?.currentValue, 'default', 'the fork asks again');
  assert.equal(ofKind(setup.events(), 'notice').length, 0);

  const plain = fakeHost({ FAKE_PLAIN: '1' });
  context.after(() => plain.host.stopAll());
  const origin = plain.chat();
  await runTurn(plain, origin, 'hello');
  const plainFork = toChatId(`c${'e'.repeat(24)}`);
  assert.ok(
    plain.store.mutate(plain.root, (index) => {
      const result = forkRecord(index, origin, plainFork, 5);
      return result.ok ? { ok: true as const, value: result.value.index } : result;
    }).ok,
  );
  await runTurn(plain, plainFork, 'continue');
  assert.match(created(ofKind(plain.events(), 'notice')[0]).text, /cannot carry the earlier conversation into a fork/);
  assert.notEqual(plain.store.find(plain.root, plainFork)?.sessionId, `fork-of-${plain.store.find(plain.root, origin)?.sessionId}`);
  assert.ok(plain.store.find(plain.root, plainFork)?.sessionId !== undefined, 'a fresh session instead');
});

test('modes offered only as session modes get a mode option, set through session/set_mode', async (context) => {
  const setup = fakeHost({ FAKE_LEGACY_MODES: '1' });
  context.after(() => setup.host.stopAll());
  const chat = setup.chat();
  await runTurn(setup, chat, 'hello');
  let mode = created(
    ofKind(setup.events(), 'options')
      .at(-1)
      ?.options.find((option) => option.id === 'mode'),
  );
  assert.equal(mode.currentValue, 'default', 'a new chat asks before it edits');
  assert.deepEqual(
    mode.choices.map((choice) => choice.value),
    ['default', 'auto', 'bypassPermissions'],
  );
  const set = await setup.host.setOption(setup.root, chat, 'mode', 'auto');
  assert.ok(set.ok, set.ok ? '' : set.error.message);
  await until(
    'the mode update',
    () =>
      ofKind(setup.events(), 'options')
        .at(-1)
        ?.options.find((option) => option.id === 'mode')?.currentValue === 'auto',
  );
  mode = created(
    ofKind(setup.events(), 'options')
      .at(-1)
      ?.options.find((option) => option.id === 'mode'),
  );
  assert.equal(mode.currentValue, 'auto');
  const unknown = await setup.host.setOption(setup.root, chat, 'mode', 'nope');
  assert.ok(!unknown.ok, 'a mode the agent does not offer is refused');
});

test('mentions: the parts reach the transcript, a path outside the project is refused and releases the turn', async (context) => {
  const setup = fakeHost();
  context.after(() => setup.host.stopAll());
  const chat = setup.chat();
  const started = await setup.host.prompt(setup.root, chat, 'look at @notes.txt', [], {
    parts: [
      { kind: 'text', text: 'look at ' },
      { kind: 'file', path: 'notes.txt' },
    ],
  });
  assert.ok(started.ok, started.ok ? '' : started.error.message);
  await until('the end', () => ofKind(setup.events(), 'turn-end').length === 1);
  assert.deepEqual(created(ofKind(setup.events(), 'user')[0]).parts, [
    { kind: 'text', text: 'look at ' },
    { kind: 'file', path: 'notes.txt', truncated: false, excerpt: 'line one\nline two\n' },
  ]);
  const escaped = await setup.host.prompt(setup.root, chat, 'look', [], { parts: [{ kind: 'file', path: '../outside.txt' }] });
  assert.ok(!escaped.ok);
  assert.equal(escaped.error.code, 'invalid');
  await runTurn(setup, chat, 'the chat is still usable');
});

test('the diff reads the live ledger, and is gone once the change is kept', async (context) => {
  const setup = fakeHost();
  context.after(() => setup.host.stopAll());
  const chat = setup.chat();
  const file = path.join(setup.root, 'notes.txt');
  assert.ok((await setup.host.prompt(setup.root, chat, `please edit ${file}`, [])).ok);
  await until('the permission request', () => ofKind(setup.events(), 'permission').length > 0);
  const permission = created(ofKind(setup.events(), 'permission')[0]);
  assert.ok(setup.host.answerPermission(setup.root, chat, permission.request, { kind: 'option', optionId: 'yes' }).ok);
  await until('the end', () => ofKind(setup.events(), 'turn-end').length === 1);
  const turn = created(ofKind(setup.events(), 'changes')[0]).turn;
  assert.deepEqual(setup.host.diff(setup.root, chat, turn, 'notes.txt'), { oldText: 'line one\nline two\n', newText: 'line one\nline 2\n' });
  assert.equal(setup.host.diff(setup.root, chat, turn, 'other.txt'), undefined);
  assert.deepEqual(await setup.host.review(setup.root, chat, turn, 'notes.txt', { kind: 'keep' }), { tag: 'done', review: 'kept' });
  assert.equal(setup.host.diff(setup.root, chat, turn, 'notes.txt'), undefined, 'a settled change keeps no content');
});
