// Goal: the main-process side of the AI panel keeps its promises. The host runs
// a whole turn against an adapter process — permission asked and answered, the
// edit recorded for review, streamed text joined, the turn's end stored — and
// fails as values (sign-in, crash, no trust) rather than throwing; the
// connection holds its line and pending bounds; the event pump batches and
// applies flow control; the chat store round-trips and skips what it cannot
// read; the change ledger keeps, undoes, and hands a drifted file to the merge
// editor; the adapter's environment carries no Stacki variable.
// Methodology: real modules from dist/, a stand-in adapter process speaking ACP
// (test/fixtures/ai/fakeAdapter.mjs), PassThrough streams for the connection,
// temporary folders for the store and project, and fake snapshots for the ledger.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { AgentHost, adapterEnvironment } from '#dist/electron/handlers/ai/agentHost.js';
import { AcpConnection } from '#dist/electron/handlers/ai/acpConnection.js';
import { ADAPTERS } from '#dist/electron/handlers/ai/agentRegistry.js';
import { ChangeLedger, parseLedgerTurns, serializeLedger } from '#dist/electron/handlers/ai/changeLedger.js';
import { ChatStore } from '#dist/electron/handlers/ai/chatStore.js';
import { EventPump } from '#dist/electron/handlers/ai/eventPump.js';
import { AI_LIMITS } from '#dist/shared/properties/ai/aiLimits.js';
import { toChatId, toTurnId, type ChatEvent } from '#dist/shared/properties/ai/chatModel.js';
import { parseAiEventsPush } from '#dist/shared/ipc/aiChat.js';

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

function fakeHost() {
  const root = fs.realpathSync(temporary('project'));
  const userData = temporary('user');
  const bin = temporary('bin');
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'notes.txt'), 'line one\nline two\n');
  const store = new ChatStore(path.join(userData, 'ai'));
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
    environment: () => ({ PATH: `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`, HOME: os.homedir(), STACKI_SECRET: 'x' }),
    now: () => 1_000,
    version: 'test',
    askBeforeTrust: () => true,
    entryOf: () => FAKE_ADAPTER,
    spawnAdapter: (entry: string, cwd: string, environment: Record<string, string | undefined>) =>
      spawn(process.execPath, [entry], { cwd, env: { ...environment }, stdio: ['pipe', 'pipe', 'pipe'] }),
  });
  const events = (): readonly ChatEvent[] => pushes;
  return { root, userData, store, host, events };
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

test('a whole turn: ask mode, permission, the edit recorded and undone, text joined', async (context) => {
  const { root, store, host, events } = fakeHost();
  context.after(() => host.stopAll());
  const refused = await host.prompt(root, created(store.create(root, 'codex', 'New chat', 1)).id, 'hello', []);
  assert.ok(!refused.ok);
  assert.equal(refused.error.code, 'not-trusted');
  store.trust(root);
  const chat = store.create(root, 'codex', 'New chat', 1);
  assert.ok(chat !== undefined);
  const started = await host.prompt(root, chat.id, `please edit ${path.join(root, 'notes.txt')}`, []);
  assert.ok(started.ok);
  const busy = await host.prompt(root, chat.id, 'again', []);
  assert.ok(!busy.ok);
  assert.equal(busy.error.code, 'busy');
  await until('the permission request', () => ofKind(events(), 'permission').length > 0);
  const permission = created(ofKind(events(), 'permission')[0]);
  const answer = host.answerPermission(root, chat.id, permission.request, { kind: 'option', optionId: 'yes' });
  assert.ok(answer.ok);
  await until('the end of the turn', () => ofKind(events(), 'turn-end').length > 0);
  assert.equal(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8'), 'line one\nline 2\n');
  const all = events();
  const options = created(ofKind(all, 'options').at(-1));
  assert.equal(options.options.find((option) => option.id === 'mode')?.currentValue, 'auto', 'the stand-in has no ask mode Stacki knows, so its own stays');
  const text = ofKind(all, 'text').map((event) => event.text);
  assert.deepEqual(text, ['Done and dusted.'], 'streamed chunks arrive joined');
  const changes = created(ofKind(all, 'changes')[0]);
  assert.deepEqual(changes.files, [{ path: 'notes.txt', change: 'modified', review: 'pending' }]);
  assert.equal(store.find(root, chat.id)?.title, 'please edit ' + path.join(root, 'notes.txt').slice(0, 48));
  const undo = await host.review(root, chat.id, changes.turn, 'notes.txt', { kind: 'undo' });
  assert.deepEqual(undo, { tag: 'done', review: 'undone' });
  assert.equal(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8'), 'line one\nline two\n');
  const again = await host.review(root, chat.id, changes.turn, 'notes.txt', { kind: 'keep' });
  assert.equal(again.tag, 'failed', 'a settled change is not settled twice');
  const stored = store.read(root, chat.id).events.map((event) => event.kind);
  assert.ok(stored.includes('user'));
  assert.ok(stored.includes('turn-end'));
  assert.ok(stored.includes('review'));
});

test('a sign-in failure and a crash end the turn as values', async (context) => {
  const { root, store, host, events } = fakeHost();
  context.after(() => host.stopAll());
  store.trust(root);
  const chat = store.create(root, 'codex', 'New chat', 1);
  assert.ok(chat !== undefined);
  assert.ok((await host.prompt(root, chat.id, 'please sign in', [])).ok);
  await until('the sign-in end', () => ofKind(events(), 'turn-end').length > 0);
  assert.ok(ofKind(events(), 'notice').some((event) => event.severity === 'sign-in'));
  assert.equal(host.availability('codex', root).state, 'sign-in');
  await host.install('codex', root); // "I've signed in" clears the state.
  assert.equal(host.availability('codex', root).state, 'ready');
  assert.ok((await host.prompt(root, chat.id, 'crash now', [])).ok);
  await until('the crash end', () => ofKind(events(), 'turn-end').length === 2);
  assert.equal(created(ofKind(events(), 'turn-end').at(-1)).stop, 'error');
});

test('the adapter environment carries no Stacki variable and names the CLI', () => {
  const environment = adapterEnvironment(
    { PATH: '/bin', STACKI_TOKEN: 'secret', ELECTRON_RUN_AS_NODE: '0', CLAUDECODE: '1', HOME: '/home' },
    'CODEX_PATH',
    '/bin/codex',
  );
  assert.equal(environment['STACKI_TOKEN'], undefined);
  assert.equal(environment['CLAUDECODE'], undefined);
  assert.equal(environment['ELECTRON_RUN_AS_NODE'], '1');
  assert.equal(environment['CODEX_PATH'], '/bin/codex');
  assert.equal(environment['HOME'], '/home');
});

test('the shipped lockfiles are the pinned ones', () => {
  for (const spec of Object.values(ADAPTERS)) {
    const bytes = fs.readFileSync(path.resolve('resources', spec.lockResource));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), spec.lockSha256, spec.agent);
    const lock: unknown = JSON.parse(bytes.toString('utf8'));
    assert.ok(typeof lock === 'object' && lock !== null && 'packages' in lock);
    assert.match(JSON.stringify(lock), new RegExp(`${spec.packageName}/-/[a-z-]+-${spec.version.replace(/\./g, '\\.')}\\.tgz`));
  }
});

test('the connection answers, times out, bounds its pending requests and its lines', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let closed = 0;
  const errors: string[] = [];
  const connection = new AcpConnection(
    { input, output },
    {
      onRequest: async () => ({ ok: true, value: { echoed: true } }),
      onNotification: () => undefined,
      onProtocolError: (message: string) => errors.push(message),
      onClose: () => {
        closed += 1;
      },
    },
  );
  const asked = connection.request('initialize', {}, 1_000);
  const sent: unknown = JSON.parse(String(output.read()));
  assert.ok(typeof sent === 'object' && sent !== null && 'id' in sent);
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: { fine: 1 } })}\n`);
  assert.deepEqual(await asked, { ok: true, value: { fine: 1 } });
  assert.deepEqual(await connection.request('slow', {}, 10), { ok: false, error: { kind: 'timeout' } });
  const pending = Array.from({ length: AI_LIMITS.pendingRequestsMax }, () => connection.request('wait', {}, 60_000));
  assert.deepEqual(await connection.request('one-more', {}, 60_000), { ok: false, error: { kind: 'busy' } });
  input.write('not json\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 1, 'a bad line is skipped, not fatal');
  input.write('x'.repeat(AI_LIMITS.lineBytesMax + 1));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, 1, 'a line past the bound closes the connection');
  for (const waiting of await Promise.all(pending)) {
    assert.deepEqual(waiting, { ok: false, error: { kind: 'closed' } });
  }
  assert.deepEqual(await connection.request('after', {}, 1_000), { ok: false, error: { kind: 'closed' } });
});

test('the pump joins text, stores once per chat run, and pauses above the watermark', () => {
  const stored: (readonly ChatEvent[])[] = [];
  const sent: number[] = [];
  let paused = 0;
  let resumed = 0;
  const pump = new EventPump({
    store: (_project: string, _chat: string, events: readonly ChatEvent[]) => {
      stored.push(events);
      return true;
    },
    send: (_channel: string, payload: unknown) => {
      sent.push(parseAiEventsPush(payload).chars);
    },
    pause: () => {
      paused += 1;
    },
    resume: () => {
      resumed += 1;
    },
  });
  const turn = toTurnId(`t${'1'.repeat(16)}`);
  const chat = toChatId(`c${'2'.repeat(24)}`);
  pump.push('/p', chat, [
    { kind: 'text', turn, role: 'agent', text: 'a' },
    { kind: 'text', turn, role: 'agent', text: 'b' },
  ]);
  pump.flush();
  assert.deepEqual(stored, [[{ kind: 'text', turn, role: 'agent', text: 'ab' }]]);
  pump.push('/p', chat, [{ kind: 'text', turn, role: 'agent', text: 'x'.repeat(AI_LIMITS.flowHighWatermark) }]);
  pump.flush();
  assert.equal(paused, 1);
  pump.acknowledge(sent.reduce((total, chars) => total + chars, 0));
  assert.equal(resumed, 1);
  assert.equal(pump.unacknowledged, 0);
});

test('the store round-trips chats, skips unreadable lines and holds its bounds', () => {
  const root = temporary('store-project');
  const store = new ChatStore(path.join(temporary('store'), 'ai'));
  const chat = store.create(root, 'claude', 'First', 5);
  assert.ok(chat !== undefined);
  assert.equal(store.list(root).length, 1);
  const turn = toTurnId(`t${'3'.repeat(16)}`);
  assert.ok(store.append(root, chat.id, [{ kind: 'turn-start', turn, at: 6 }]));
  const file = path.join(store.projectDirectory(root), 'chats', `${chat.id}.jsonl`);
  fs.appendFileSync(file, '{"kind":"hologram"}\n{"kind":"turn-end","turn":"');
  assert.deepEqual(
    store.read(root, chat.id).events.map((event) => event.kind),
    ['turn-start'],
  );
  const renamed = store.update(root, chat.id, (record) => ({ ...record, title: 'Renamed', pinned: true }));
  assert.equal(renamed?.title, 'Renamed');
  assert.equal(store.list(root)[0]?.pinned, true);
  assert.equal(store.readIndex(root).trusted, false);
  store.trust(root);
  assert.equal(store.readIndex(root).trusted, true);
  fs.writeFileSync(path.join(store.projectDirectory(root), 'index.json'), '{broken');
  assert.deepEqual(store.list(root), [], 'a broken index reads as empty');
  store.writeIndex(root, { version: 1, trusted: true, chats: [] });
  for (let index = 0; index < AI_LIMITS.chatsMax; index++) {
    assert.ok(store.create(root, 'codex', `Chat ${index}`, 1) !== undefined);
  }
  assert.equal(store.create(root, 'codex', 'One too many', 1), undefined);
  store.delete(root, created(store.list(root)[0]).id);
  assert.equal(store.list(root).length, AI_LIMITS.chatsMax - 1);
});

test('the ledger keeps, undoes, creates and deletes, and hands drift to the merge editor', async () => {
  const root = fs.realpathSync(temporary('ledger'));
  const file = path.join(root, 'page.astro');
  fs.writeFileSync(file, 'a\nb\nc\n');
  const ledger = new ChangeLedger(root, plainFiles, noSnapshots, []);
  const turn = toTurnId(`t${'4'.repeat(16)}`);
  await ledger.begin(turn);
  await assert.rejects(() => ledger.begin(turn), /one turn at a time per chat/);
  ledger.noteTouch(file);
  ledger.noteTouch(path.join(root, 'new.txt'));
  ledger.noteTouch('/etc/hosts');
  fs.writeFileSync(file, 'a\nB\nc\n');
  fs.writeFileSync(path.join(root, 'new.txt'), 'new\n');
  const finished = await ledger.finish(turn);
  assert.deepEqual(ChangeLedger.changesOf(finished), [
    { path: 'page.astro', change: 'modified', review: 'pending' },
    { path: 'new.txt', change: 'created', review: 'pending' },
  ]);
  // The person edits the file again after the agent: undo becomes a merge.
  fs.writeFileSync(file, 'a\nB\nc\nd\n');
  const drifted = await ledger.review(turn, 'page.astro', { kind: 'undo' });
  assert.equal(drifted.tag, 'drifted');
  assert.ok(drifted.tag === 'drifted');
  assert.equal(drifted.clash.theirs, 'a\nb\nc\n');
  const merged = await ledger.review(turn, 'page.astro', { kind: 'resolve', resolution: 'theirs' });
  assert.deepEqual(merged, { tag: 'done', review: 'undone' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'a\nb\nc\n');
  assert.deepEqual(await ledger.review(turn, 'new.txt', { kind: 'undo' }), { tag: 'done', review: 'undone' });
  assert.equal(fs.existsSync(path.join(root, 'new.txt')), false, 'undoing a created file removes it');
  const restored = parseLedgerTurns(JSON.parse(serializeLedger(ledger.stored())));
  assert.deepEqual(
    restored[0]?.entries.map((entry) => entry.review),
    ['undone', 'undone'],
  );
  assert.deepEqual(parseLedgerTurns({ turns: [{ turn: 'bad', entries: [] }] }), []);
});

test('a git snapshot catches a change no tool call named', async () => {
  const root = fs.realpathSync(temporary('snapshot'));
  fs.writeFileSync(path.join(root, 'shell.txt'), 'before\n');
  const trees = ['tree-a', 'tree-b'];
  const snapshots = {
    snapshot: async () => trees.shift(),
    changes: async () => [{ path: 'shell.txt', status: 'modified' as const }],
    blob: async () => 'before\n',
  };
  const ledger = new ChangeLedger(root, plainFiles, snapshots, []);
  const turn = toTurnId(`t${'5'.repeat(16)}`);
  await ledger.begin(turn);
  fs.writeFileSync(path.join(root, 'shell.txt'), 'after\n'); // A shell command, unannounced.
  const finished = await ledger.finish(turn);
  assert.deepEqual(finished.entries, [{ path: 'shell.txt', before: 'before\n', after: 'after\n', review: 'pending' }]);
});

test('opening the panel allows agents in the project, unless Settings asks first', () => {
  for (const ask of [false, true]) {
    const root = temporary('trust');
    const store = new ChatStore(path.join(temporary('trust-user'), 'ai'));
    const host = new AgentHost({
      userData: temporary('trust-data'),
      store,
      send: () => undefined,
      files: plainFiles,
      snapshots: noSnapshots,
      environment: () => ({ PATH: '' }),
      now: () => 1,
      version: 'test',
      askBeforeTrust: () => ask,
    });
    assert.equal(host.agents(root).trusted, !ask);
    assert.equal(store.readIndex(root).trusted, !ask, 'remembered');
  }
});
