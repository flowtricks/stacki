// Goal: starting the agent early (electron/handlers/ai/agentHost.ts `prewarm`, sessionPool.ts)
// is invisible, cheap, bounded and safe. A focus starts one process and one empty session and
// nothing else: no chat row, no transcript event, no file in the project, no change-ledger
// snapshot. Two rapid focuses are one start. The first message of a new chat adopts the parked
// session (no second `session/new`) and behaves exactly like a fresh one, remembered settings
// included. The session is discarded when the person moves on (another agent, another project,
// the panel closing), when its process leaves (idle expiry, 30 minutes; shorter under memory
// pressure or with more than two adapters alive), when the app is in the background, and the
// 4-process limit holds. A failed start falls back to the cold path, and the startup timing
// log carries durations and one of prewarmed/cold/resumed, never a prompt or a path.
// Methodology: the real AgentHost against the stand-in adapter process (fakeAdapter.mjs, which
// traces every method it is called with, so `session/new` calls are counted, not inferred);
// real timers where the 250 ms debounce is cheap to wait out, node:test mock timers where a
// test must jump 30 minutes; a clock that advances on every read so eviction order is defined.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import { AgentHost } from '#dist/electron/handlers/ai/agentHost.js';
import { ChatStore } from '#dist/electron/handlers/ai/chatStore.js';
import { AI_LIMITS } from '#dist/shared/properties/ai/aiLimits.js';
import { parseAiEventsPush } from '#dist/shared/ipc/aiChat.js';
import type { ChatEvent } from '#dist/shared/properties/ai/chatModel.js';

const FAKE_ADAPTER = path.resolve('test/fixtures/ai/fakeAdapter.mjs');

function temporary(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `stacki-prewarm-${name}-`));
}

const plainFiles = {
  read: (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined),
  write: (file: string, text: string) => fs.writeFileSync(file, text),
  create: (file: string, text: string) => fs.writeFileSync(file, text, { flag: 'wx' }),
  trash: async (file: string) => fs.rmSync(file),
};

interface Options {
  readonly foreground?: () => boolean;
  readonly freeMemoryRatio?: () => number;
  readonly adapterEnvironment?: Readonly<Record<string, string>>;
  readonly installed?: boolean;
}

function warmHost(options: Options = {}) {
  const userData = temporary('user');
  const bin = temporary('bin');
  const trace = path.join(temporary('trace'), 'methods.log');
  fs.writeFileSync(trace, '');
  for (const cli of ['codex', 'claude']) {
    fs.writeFileSync(path.join(bin, process.platform === 'win32' ? `${cli}.cmd` : cli), '#!/bin/sh\n', { mode: 0o755 });
  }
  const store = new ChatStore(path.join(userData, 'ai'));
  const pushes: ChatEvent[] = [];
  const snapshotCalls: string[] = [];
  const spawned: string[] = [];
  let clock = 1_000;
  const host: AgentHost = new AgentHost({
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
    snapshots: {
      snapshot: async (root: string) => {
        snapshotCalls.push(root);
        return undefined;
      },
      changes: async () => [],
      blob: async () => undefined,
    },
    environment: () => ({ PATH: `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`, HOME: os.homedir() }),
    // Every read moves the clock on, so "used longest ago" is always a strict order.
    now: () => (clock += 1_000),
    version: 'test',
    askBeforeTrust: () => true,
    entryOf: () => (options.installed === false ? undefined : FAKE_ADAPTER),
    ...(options.foreground === undefined ? {} : { isForeground: options.foreground }),
    freeMemoryRatio: options.freeMemoryRatio ?? (() => 0.5),
    spawnAdapter: (entry: string, cwd: string, environment: Record<string, string | undefined>) => {
      spawned.push(cwd);
      return spawn(process.execPath, [entry], {
        cwd,
        env: { ...environment, FAKE_TRACE_FILE: trace, ...options.adapterEnvironment },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    },
  });
  const project = (name: string): string => {
    const root = fs.realpathSync(temporary(name));
    fs.writeFileSync(path.join(root, 'notes.txt'), 'line one\nline two\n');
    store.trust(root);
    return root;
  };
  const methods = (): readonly string[] =>
    fs
      .readFileSync(trace, 'utf8')
      .split('\n')
      .filter((line) => line !== '');
  const count = (method: string): number => methods().filter((candidate) => candidate === method).length;
  return { host, store, project, methods, count, spawned, snapshotCalls, events: (): readonly ChatEvent[] => pushes, trace };
}

/** Whether the agent's adapter process is alive for this project. */
function alive(host: AgentHost, root: string): boolean {
  const availability = host.availability('codex', root);
  return availability.state === 'ready' && availability.running;
}

/** Lets real I/O and microtasks run until the condition holds; unlike `setTimeout` it is untouched by mock timers. */
async function settle(label: string, condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${label}`);
}

function debugLines(context: TestContext): () => string[] {
  const spy = context.mock.method(console, 'debug', () => undefined);
  return () => spy.mock.calls.map((call) => String(call.arguments[0]));
}

async function sendHello(host: AgentHost, store: ChatStore, root: string, agent: 'codex' | 'claude', text = 'hello') {
  const chat = store.create(root, agent, 'New chat', 1);
  assert.ok(chat !== undefined);
  const started = await host.prompt(root, chat.id, text, []);
  assert.ok(started.ok, 'the turn started');
  return chat;
}

test('a focus starts one process and one empty session, and nothing anyone can see', async (context) => {
  const { host, store, project, count, spawned, events, snapshotCalls } = warmHost();
  context.after(() => host.stopAll());
  const root = project('site');
  host.prewarm(root, 'codex', 'warm');
  assert.equal(host.prewarmPhase(), 'empty', 'nothing starts before the debounce');
  assert.equal(spawned.length, 0);
  await settle('the parked session', () => host.prewarmPhase() === 'parked');
  assert.equal(spawned.length, 1);
  assert.equal(count('initialize'), 1);
  assert.equal(count('session/new'), 1);
  assert.equal(count('session/prompt'), 0, 'no model call');
  assert.deepEqual(store.readIndex(root).chats, [], 'no new-chat row until a message is sent');
  assert.deepEqual(events(), [], 'no transcript event');
  assert.deepEqual(snapshotCalls, [], 'no change-ledger snapshot until a turn starts');
  assert.deepEqual(fs.readdirSync(root), ['notes.txt'], 'nothing is created in the project');
});

test('rapid focus changes are one start, and a focus on a parked session starts nothing', async (context) => {
  const { host, project, count, spawned } = warmHost();
  context.after(() => host.stopAll());
  const root = project('site');
  for (let focus = 0; focus < 5; focus++) {
    host.prewarm(root, 'codex', 'warm');
  }
  await settle('the parked session', () => host.prewarmPhase() === 'parked');
  host.prewarm(root, 'codex', 'warm');
  await new Promise((resolve) => setTimeout(resolve, AI_LIMITS.prewarmDebounceMs + 100));
  assert.equal(spawned.length, 1, 'one spawn');
  assert.equal(count('session/new'), 1, 'one session');
});

test('a message adopts the parked session: no second session/new, and the startup line says prewarmed', async (context) => {
  const lines = debugLines(context);
  const { host, store, project, count, events } = warmHost();
  context.after(() => host.stopAll());
  const root = project('site');
  host.prewarm(root, 'codex', 'warm');
  await settle('the parked session', () => host.prewarmPhase() === 'parked');
  await sendHello(host, store, root, 'codex', 'hello-secret-prompt');
  await settle('the end of the turn', () => events().some((event) => event.kind === 'turn-end'));
  assert.equal(count('session/new'), 1, 'the first message paid for no second session');
  assert.equal(host.prewarmPhase(), 'empty', 'adopted once');
  const startup = lines().filter((line) => line.startsWith('[ai] startup:'));
  assert.equal(startup.length, 1);
  assert.match(startup[0] ?? '', /^\[ai\] startup: session=prewarmed spawnMs=(\d+|none) initializeMs=\d+ sessionNewMs=\d+ firstTokenMs=\d+$/);
  const everything = lines().join('\n');
  assert.doesNotMatch(everything, /hello-secret-prompt/, 'no prompt text in the log');
  assert.ok(!everything.includes(root), 'no project path in the log');
});

test('a message sent while the start is still under way waits for it instead of starting a second session', async (context) => {
  const { host, store, project, count, events } = warmHost();
  context.after(() => host.stopAll());
  const root = project('site');
  host.prewarm(root, 'codex', 'warm');
  await settle('the start to begin', () => host.prewarmPhase() === 'starting');
  await sendHello(host, store, root, 'codex');
  await settle('the end of the turn', () => events().some((event) => event.kind === 'turn-end'));
  assert.equal(count('session/new'), 1);
});

test('without a pre-warm the first message starts the session itself, and the startup line says cold', async (context) => {
  const lines = debugLines(context);
  const { host, store, project, count, events } = warmHost();
  context.after(() => host.stopAll());
  const root = project('site');
  await sendHello(host, store, root, 'codex');
  await settle('the end of the turn', () => events().some((event) => event.kind === 'turn-end'));
  assert.equal(count('session/new'), 1);
  assert.match(
    lines().find((line) => line.startsWith('[ai] startup:')) ?? '',
    /session=cold spawnMs=(\d+|none) initializeMs=\d+ sessionNewMs=\d+ firstTokenMs=\d+/,
  );
  assert.ok(
    lines().some((line) => /^\[ai\] process: spawnMs=(\d+|none) initializeMs=\d+$/.test(line)),
    'the process line carries durations only',
  );
});

test('a pre-warmed session takes the remembered settings before the first prompt, like a fresh one', async (context) => {
  const { host, store, project, count, events, methods } = warmHost();
  context.after(() => host.stopAll());
  const root = project('site');
  host.prewarm(root, 'codex', 'warm');
  await settle('the parked session', () => host.prewarmPhase() === 'parked');
  // The person picks a model after the session was parked: the next new chat starts with it.
  const remembered = host.remember('codex', { kind: 'set', option: 'model', value: 'large' });
  assert.ok(remembered.ok);
  await sendHello(host, store, root, 'codex');
  await settle('the end of the turn', () => events().some((event) => event.kind === 'turn-end'));
  assert.equal(count('session/new'), 1);
  const order = methods();
  assert.ok(order.indexOf('session/set_config_option') < order.indexOf('session/prompt'), 'the setting is applied before the prompt');
  const options = events().filter((event) => event.kind === 'options');
  const last = options.at(-1);
  assert.ok(last !== undefined && last.kind === 'options');
  assert.equal(last.options.find((option) => option.id === 'model')?.currentValue, 'large');
});

test('another agent, another project and a release each discard what was parked', async (context) => {
  const { host, store, project, count } = warmHost();
  context.after(() => host.stopAll());
  const site = project('site');
  const other = project('other');
  host.prewarm(site, 'codex', 'warm');
  await settle('codex parked', () => host.prewarmPhase() === 'parked');
  // Agent switch: the claude start replaces the codex session, which is deleted.
  host.prewarm(site, 'claude', 'warm');
  await settle('the codex session to be deleted', () => count('session/delete') === 1);
  await settle('claude parked', () => host.prewarmPhase() === 'parked' && count('session/new') === 2);
  // Project switch: the start for the other project replaces it.
  host.prewarm(other, 'claude', 'warm');
  await settle('the claude session to be deleted', () => count('session/delete') === 2);
  await settle('the other project parked', () => host.prewarmPhase() === 'parked' && count('session/new') === 3);
  // Panel closed: released.
  host.prewarm(other, 'claude', 'release');
  assert.equal(host.prewarmPhase(), 'empty');
  await settle('the last session to be deleted', () => count('session/delete') === 3);
  // Nothing leaks between projects: a chat in the first project starts its own session.
  host.prewarm(other, 'claude', 'warm');
  await settle('parked again', () => host.prewarmPhase() === 'parked' && count('session/new') === 4);
  await sendHello(host, store, site, 'claude');
  await settle('a cold session for the other project', () => count('session/new') === 5);
  assert.equal(host.prewarmPhase(), 'parked', 'the other project’s session was not taken');
});

test('a failed start is silent and the first message starts the agent as usual', async (context) => {
  const marker = path.join(temporary('fail'), 'fail');
  fs.writeFileSync(marker, '');
  const lines = debugLines(context);
  const { host, store, project, count, events } = warmHost({ adapterEnvironment: { FAKE_NEW_FAILS_FILE: marker } });
  context.after(() => host.stopAll());
  const root = project('site');
  host.prewarm(root, 'codex', 'warm');
  await settle('the failed start', () => count('session/new') === 1);
  await settle('the slot to be free', () => host.prewarmPhase() === 'empty');
  assert.ok(lines().some((line) => line.includes('prewarm: the agent did not start a session')));
  assert.deepEqual(store.readIndex(root).chats, []);
  assert.deepEqual(events(), [], 'nothing reached the panel');
  fs.rmSync(marker);
  await sendHello(host, store, root, 'codex');
  await settle('the end of the turn', () => events().some((event) => event.kind === 'turn-end'));
  assert.equal(count('session/new'), 2, 'the cold path ran');
});

test('no start when the app is in the background, the agent is not installed, or the project is not trusted', async (context) => {
  const lines = debugLines(context);
  let foreground = false;
  const background = warmHost({ foreground: () => foreground });
  context.after(() => background.host.stopAll());
  const root = background.project('site');
  background.host.prewarm(root, 'codex', 'warm');
  await new Promise((resolve) => setTimeout(resolve, AI_LIMITS.prewarmDebounceMs + 100));
  assert.equal(background.spawned.length, 0, 'hidden app');
  foreground = true;
  const missing = warmHost({ installed: false });
  context.after(() => missing.host.stopAll());
  missing.host.prewarm(missing.project('site'), 'codex', 'warm');
  const untrusted = warmHost();
  context.after(() => untrusted.host.stopAll());
  untrusted.host.prewarm(fs.realpathSync(temporary('untrusted')), 'codex', 'warm');
  await new Promise((resolve) => setTimeout(resolve, AI_LIMITS.prewarmDebounceMs + 100));
  assert.equal(missing.spawned.length, 0, 'not installed');
  assert.equal(untrusted.spawned.length, 0, 'not trusted');
  const skips = lines().filter((line) => line.startsWith('[ai] prewarm skipped:'));
  assert.deepEqual(skips, ['[ai] prewarm skipped: background', '[ai] prewarm skipped: unavailable', '[ai] prewarm skipped: untrusted']);
});

test('the process limit holds: starting early never goes past four, and a new process evicts the one used longest ago', async (context) => {
  const { host, store, project, spawned, count, events } = warmHost();
  context.after(() => host.stopAll());
  const roots = ['a', 'b', 'c', 'd', 'e'].map((name) => project(name));
  for (const root of roots.slice(0, 4)) {
    host.prewarm(root, 'codex', 'warm');
    await settle('a start', () => host.prewarmPhase() === 'parked' && spawned.at(-1) === root);
  }
  const first = roots[0] ?? '';
  const last = roots[3] ?? '';
  const fifth = roots[4] ?? '';
  assert.equal(spawned.length, 4);
  assert.equal(alive(host, first), true);
  host.prewarm(fifth, 'codex', 'warm');
  await new Promise((resolve) => setTimeout(resolve, AI_LIMITS.prewarmDebounceMs + 100));
  assert.equal(spawned.length, 4, 'a speculative start never evicts and never exceeds the limit');
  assert.equal(host.prewarmPhase(), 'parked', 'the last start is still parked');
  // A real message does evict: the least recently used idle process goes first.
  await sendHello(host, store, fifth, 'codex');
  await settle('the end of the turn', () => events().some((event) => event.kind === 'turn-end'));
  assert.equal(spawned.length, 5);
  assert.equal(alive(host, first), false, 'the oldest idle process was evicted');
  assert.equal(alive(host, last), true);
  assert.equal(alive(host, fifth), true);
  assert.ok(count('initialize') === 5);
});

test('an idle adapter stays 30 minutes, and its parked session leaves with it', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { host, project, count } = warmHost();
  context.after(() => host.stopAll());
  const root = project('site');
  host.prewarm(root, 'codex', 'warm');
  context.mock.timers.tick(AI_LIMITS.prewarmDebounceMs);
  await settle('the parked session', () => host.prewarmPhase() === 'parked');
  assert.equal(AI_LIMITS.idleMsMax, 30 * 60 * 1000);
  context.mock.timers.tick(AI_LIMITS.idleMsMax - 1);
  assert.equal(host.prewarmPhase(), 'parked', 'one millisecond before the limit');
  assert.equal(alive(host, root), true);
  context.mock.timers.tick(1);
  assert.equal(host.prewarmPhase(), 'empty', 'discarded with its process');
  assert.equal(alive(host, root), false);
  assert.equal(count('session/new'), 1);
});

test('under memory pressure an idle adapter leaves after the shorter time', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { host, project } = warmHost({ freeMemoryRatio: () => AI_LIMITS.memoryFreeRatioMin / 2 });
  context.after(() => host.stopAll());
  const root = project('site');
  host.prewarm(root, 'codex', 'warm');
  context.mock.timers.tick(AI_LIMITS.prewarmDebounceMs);
  await settle('the parked session', () => host.prewarmPhase() === 'parked');
  context.mock.timers.tick(AI_LIMITS.idleMsCrowded - 1);
  assert.equal(host.prewarmPhase(), 'parked');
  context.mock.timers.tick(1);
  assert.equal(host.prewarmPhase(), 'empty');
});

test('with more than two adapters alive the idle ones leave after the shorter time', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { host, project, spawned } = warmHost();
  context.after(() => host.stopAll());
  const roots = ['a', 'b', 'c'].map((name) => project(name));
  for (const root of roots) {
    host.prewarm(root, 'codex', 'warm');
    context.mock.timers.tick(AI_LIMITS.prewarmDebounceMs);
    await settle('a start', () => host.prewarmPhase() === 'parked' && spawned.at(-1) === root);
  }
  const isAlive = (root: string): boolean => alive(host, root);
  assert.deepEqual(roots.map(isAlive), [true, true, true]);
  context.mock.timers.tick(AI_LIMITS.idleMsCrowded - 1);
  assert.equal(roots.some(isAlive), true, 'not yet');
  context.mock.timers.tick(AI_LIMITS.idleMsCrowded);
  assert.deepEqual(roots.map(isAlive), [false, false, false], 'well before thirty minutes');
});
