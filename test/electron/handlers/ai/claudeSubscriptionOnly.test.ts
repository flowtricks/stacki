// Goal: the AI panel never signs Claude in with an Anthropic API key. No Claude process it starts gets the variable
// (status, sign-in, sign-out, install, the adapter, hence chats, pin subagents, resumed chats and model listing), each
// is told to switch the settings routes off, a status that still finds a key reads as signed out with its reason, and
// no session starts unless a recent status found another sign-in: not with a key alone, not while the sign-in cannot
// be checked, and not after signing out leaves only a key. Codex is left as it was.
// Methodology: AgentSetup and AgentHost from dist/ with real child processes. `claude` is a /bin/sh script that
// records each run's arguments and whether the variable reached it, and answers `auth status` from marker files the
// way Claude Code 2.1.332 was seen to answer (a saved key beside a sign-in lies unused: the sign-in's method is
// reported). The adapter is the stand-in ACP process; what the host writes to it is recorded. Every key is made up;
// nothing real is run, read or signed in to. Skipped on Windows, which has no /bin/sh.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { AgentHost } from '#dist/electron/handlers/ai/agentHost.js';
import { AgentSetup, SESSION_PERMIT_MS, type SessionPermit } from '#dist/electron/handlers/ai/agentSetup.js';
import { ChatStore } from '#dist/electron/handlers/ai/chatStore.js';
import { CLAUDE_NO_API_KEY_SETTINGS, withoutClaudeAPIKey } from '#dist/electron/lib/claudeSubscriptionOnly.js';
import { toRecord } from '#dist/shared/core/record.js';
import { parseSetupState, type SetupState } from '#dist/shared/ipc/aiChat.js';
import { waitFor } from '../../../helpers/waitFor.js';

const posix = { skip: process.platform === 'win32' ? 'the fake CLI is a /bin/sh script' : false };
const KEY = 'sk-ant-api03-made-up-for-this-test';
const FAKE_ADAPTER = path.resolve('test/fixtures/ai/fakeAdapter.mjs');
const SETTINGS = JSON.stringify(CLAUDE_NO_API_KEY_SETTINGS);

type Context = { after: (run: () => void) => void };

function world(context: Context) {
  const bin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-subscription-only-')));
  context.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  const calls = path.join(bin, 'calls');
  const marker = (name: string) => path.join(bin, name);
  const script = [
    '#!/bin/sh',
    `printf '%s|%s\\n' "\${ANTHROPIC_API_KEY+key}" "$*" >> '${calls}'`,
    `say() { printf '%s\\n' "$1"; exit "$2"; }`,
    `case "$*" in`,
    `*'auth logout') /bin/rm -f '${marker('subscription')}'; exit 0 ;;`,
    `*'auth status')`,
    `  [ -f '${marker('broken')}' ] && exit 3`,
    `  [ -f '${marker('subscription')}' ] && say '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}' 0`,
    `  [ -f '${marker('saved-key')}' ] && say '{"loggedIn":true,"authMethod":"api_key","apiKeySource":"/login managed key"}' 0`,
    `  [ -f '${marker('managed-helper')}' ] && say '{"loggedIn":true,"authMethod":"api_key_helper","apiKeySource":"apiKeyHelper"}' 0`,
    `  say '{"loggedIn":false,"authMethod":"none"}' 1 ;;`,
    'esac',
    'exit 0',
  ].join('\n');
  fs.writeFileSync(path.join(bin, 'claude'), `${script}\n`, { mode: 0o755 });
  // As the app would hand it over after a launch from a terminal that exports a key.
  const environment = () => ({ PATH: bin, HOME: bin, ANTHROPIC_API_KEY: KEY });
  const set = (...names: readonly string[]) => {
    for (const name of ['subscription', 'saved-key', 'managed-helper', 'broken']) {
      fs.rmSync(marker(name), { force: true });
    }
    for (const name of names) {
      fs.writeFileSync(marker(name), '');
    }
  };
  const runs = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : []);
  const states: SetupState[] = [];
  const clock = { nowMs: 1_000 };
  const terminals: Record<string, string | undefined>[] = [];
  const setup = new AgentSetup({
    environment,
    agentEnvironment: async () => environment(),
    openExternal: () => undefined,
    publish: (state: SetupState) => states.push(state),
    log: () => undefined,
    home: bin,
    now: () => clock.nowMs,
    statusRetryDelaysMs: [],
    spawnTerminal: async (command, given) => {
      assert.deepEqual(command.args, ['--settings', SETTINGS, 'auth', 'login', '--claudeai'], 'the subscription sign-in');
      terminals.push({ ...given });
      return {
        onData: () => undefined,
        onExit: (listener: (code: number) => void) => setImmediate(() => listener(1)),
        write: () => undefined,
        kill: () => undefined,
      };
    },
  });
  context.after(() => setup.stopAll());
  return { bin, set, runs, states, setup, clock, terminals, environment };
}

test('a subscription is used even with keys around; a key alone is signed out and says why', posix, async (context) => {
  const it = world(context);
  for (const [label, markers, expected] of [
    ['both a subscription and a saved key', ['subscription', 'saved-key'], 'allowed'],
    ['a subscription only', ['subscription'], 'allowed'],
    ['a saved Console key only', ['saved-key'], 'sign-in'],
    ['a managed key helper only', ['managed-helper'], 'sign-in'],
    ['only the environment’s key, which never reaches claude', [], 'sign-in'],
    ['a check that cannot be made', ['broken', 'saved-key'], 'unchecked'],
  ] as const) {
    it.set(...markers);
    it.clock.nowMs += SESSION_PERMIT_MS;
    assert.equal(await it.setup.permit('claude'), expected satisfies SessionPermit, label);
    const state = it.states.at(-1);
    assert.ok(state !== undefined, label);
    const keyed = markers.some((marker) => marker !== 'subscription') && expected === 'sign-in';
    if (expected === 'sign-in') {
      assert.deepEqual(state, keyed ? { agent: 'claude', step: 'signed-out', reason: 'api-key' } : { agent: 'claude', step: 'signed-out' }, label);
      assert.deepEqual(parseSetupState(JSON.parse(JSON.stringify(state))), state, 'the reason crosses to the window');
    }
  }
});

test('a permit is asked for again when it ages, is shared by sessions starting together, and ends with a sign-out', posix, async (context) => {
  const it = world(context);
  it.set('subscription', 'saved-key');
  const together = await Promise.all([it.setup.permit('claude'), it.setup.permit('claude'), it.setup.permit('claude')]);
  assert.deepEqual(together, ['allowed', 'allowed', 'allowed']);
  assert.equal(it.runs().length, 1, 'one status for all');
  it.clock.nowMs += SESSION_PERMIT_MS - 1;
  assert.equal(await it.setup.permit('claude'), 'allowed');
  assert.equal(it.runs().length, 1, 'no status per message');
  // The subscription expires or is signed out in a terminal, leaving the key: seen once the permit has aged.
  it.set('saved-key');
  it.clock.nowMs += 1;
  assert.equal(await it.setup.permit('claude'), 'sign-in');
  it.set('subscription', 'saved-key');
  assert.equal(await it.setup.permit('claude'), 'allowed', 'signed in again');
  // Signing out here ends the permit at once.
  fs.rmSync(path.join(it.bin, 'subscription'));
  fs.writeFileSync(path.join(it.bin, 'subscription'), '');
  await it.setup.act('claude', { kind: 'signOut' });
  assert.equal(await it.setup.permit('claude'), 'sign-in', 'after sign-out the key is not used');
  assert.equal(await it.setup.permit('codex'), 'allowed', 'Codex is not asked');
});

test('every setup command of Claude runs without the key and with the no-key settings', posix, async (context) => {
  const it = world(context);
  it.set('subscription');
  await it.setup.act('claude', { kind: 'detect' });
  await it.setup.act('claude', { kind: 'signOut' });
  await it.setup.act('claude', { kind: 'signIn' });
  await waitFor({ what: 'the sign-in to end', read: () => it.states.at(-1)?.step, until: (step) => step === 'failed' });
  assert.equal(it.terminals.length, 1);
  assert.equal(Object.values(it.terminals[0] ?? {}).includes(KEY), false, 'the sign-in terminal has no key');
  assert.ok(it.runs().length >= 3);
  for (const run of it.runs()) {
    assert.ok(run.startsWith(`|--settings ${SETTINGS} auth `), `no key, and the settings: ${run}`);
  }
  assert.deepEqual(withoutClaudeAPIKey('claude', { Anthropic_Api_Key: KEY, KEEP: '1' }), { KEEP: '1' }, 'Windows names have any case');
  assert.deepEqual(withoutClaudeAPIKey('codex', { ANTHROPIC_API_KEY: KEY }), { ANTHROPIC_API_KEY: KEY }, 'Codex is unchanged');
});

function hostWorld(context: Context, permit: () => Promise<SessionPermit>) {
  const it = world(context);
  const root = fs.mkdtempSync(path.join(it.bin, 'project-'));
  const store = new ChatStore(path.join(it.bin, 'user', 'ai'));
  store.trust(root);
  const environments: Record<string, string | undefined>[] = [];
  const requests: { readonly method: string; readonly params: Record<string, unknown> }[] = [];
  const make = () => {
    const host = new AgentHost({
      userData: path.join(it.bin, 'user'),
      store,
      send: () => undefined,
      files: { read: () => undefined, write: () => undefined, create: () => undefined, trash: async () => undefined },
      snapshots: { snapshot: async () => undefined, changes: async () => [], blob: async () => undefined },
      environment: () => ({ PATH: `${it.bin}${path.delimiter}${process.env['PATH'] ?? ''}`, HOME: it.bin, ANTHROPIC_API_KEY: KEY }),
      // Even an environment that still held a key would lose it at the spawn.
      agentEnvironment: async () => ({ PATH: process.env['PATH'], HOME: it.bin, ANTHROPIC_API_KEY: KEY }),
      permit,
      now: () => 1_000,
      version: 'test',
      askBeforeTrust: () => true,
      entryOf: () => FAKE_ADAPTER,
      spawnAdapter: (entry: string, cwd: string, environment: Record<string, string | undefined>) => {
        environments.push({ ...environment });
        const child = spawn(process.execPath, [entry], { cwd, env: { ...environment }, stdio: ['pipe', 'pipe', 'pipe'] });
        // What the host writes passes through a tap on its way to the adapter.
        const adapterInput = child.stdin;
        const tap = new PassThrough();
        tap.on('data', (chunk: Buffer) => {
          for (const line of chunk
            .toString('utf8')
            .split('\n')
            .filter((text) => text.trim() !== '')) {
            const message = toRecord(JSON.parse(line));
            const method = message?.['method'];
            if (typeof method === 'string') {
              requests.push({ method, params: toRecord(message?.['params']) ?? {} });
            }
          }
        });
        tap.pipe(adapterInput);
        Object.defineProperty(child, 'stdin', { value: tap });
        return child;
      },
    });
    context.after(() => host.stopAll());
    return host;
  };
  const chat = () => {
    const record = store.create(root, 'claude', 'New chat', 1);
    assert.ok(record !== undefined);
    return record.id;
  };
  const sessions = () => requests.filter((request) => /^session\/(new|resume|load|fork)$/.test(request.method));
  return { ...it, root, store, make, chat, environments, requests, sessions };
}

test('no permit, no Claude process: a key-only or unchecked sign-in starts nothing', posix, async (context) => {
  for (const [permit, code] of [
    ['sign-in', 'sign-in'],
    ['unchecked', 'agent-failed'],
  ] as const) {
    const it = hostWorld(context, async () => permit);
    const refused = await it.make().prompt(it.root, it.chat(), 'hello', []);
    assert.ok(!refused.ok, permit);
    assert.equal(refused.error.code, code, permit);
    assert.deepEqual(it.environments, [], 'no adapter started');
  }
});

test('the adapter has no key, and every session it opens or reopens carries the no-key settings', posix, async (context) => {
  const it = hostWorld(context, async () => 'allowed');
  const first = it.make();
  const chat = it.chat();
  const started = await first.prompt(it.root, chat, 'hello', []);
  assert.ok(started.ok, JSON.stringify(started));
  await waitFor({ what: 'the session', read: () => it.store.find(it.root, chat)?.sessionId, until: (id) => id !== undefined });
  first.stopAll();
  // A new run of the app: a fork continues the first chat's session (`session/fork`, built as resume and load are),
  // and the early session that lists the models.
  const again = it.make();
  const forked = it.store.fork(it.root, chat, 2);
  assert.ok(forked.ok, JSON.stringify(forked));
  const prompted = await again.prompt(it.root, forked.value.id, 'hello again', []);
  assert.ok(prompted.ok, JSON.stringify(prompted));
  await waitFor({ what: 'the forked session', read: () => it.sessions().some((request) => request.method === 'session/fork'), until: Boolean });
  const before = it.sessions().length;
  again.prewarm(it.root, 'claude', 'warm');
  await waitFor({ what: 'the early session', read: () => it.sessions().length, until: (count) => count > before });
  assert.ok(it.environments.length >= 2);
  for (const environment of it.environments) {
    assert.equal('ANTHROPIC_API_KEY' in environment, false);
    assert.equal(Object.values(environment).includes(KEY), false);
  }
  const methods = new Set(it.sessions().map((request) => request.method));
  assert.deepEqual([...methods].sort(), ['session/fork', 'session/new']);
  for (const request of it.sessions()) {
    assert.deepEqual(request.params['_meta'], { claudeCode: { options: { settings: CLAUDE_NO_API_KEY_SETTINGS } } }, request.method);
  }
});
