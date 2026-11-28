// Goal: a subscriber sees the models of today in the AI panel. A user on Pro saw only the previous generation
// (Sonnet 4.6, Opus 4.8). The list is whatever the person's own Claude Code reports, so these hold that: the newest
// installed copy is the one used when an older one comes first on Stacki's search path; the version is read from
// each way Claude Code installs; one too old to list today's models is said to be so, and `claude update` runs only
// when asked; a saved list is read again once a run and after an update, with the adapter replaced when the update
// moved the CLI; and the list shown before any report names only the CLI's own aliases, never a model or a version.
// Methodology: findCli with an in-memory disk; AgentHost against the stand-in adapter process (fakeAdapter.mjs)
// with real stand-in CLI files laid out as the native installer lays them; AgentSetup with fake processes. No real
// Claude Code runs and nothing is signed in.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { AgentHost } from '#dist/electron/handlers/ai/agentHost.js';
import { AgentSetup, type SetupCommand, type SetupProcess } from '#dist/electron/handlers/ai/agentSetup.js';
import { ADAPTERS, FALLBACK_OPTIONS, findCli, type CliFileSystem } from '#dist/electron/handlers/ai/agentRegistry.js';
import { claudeInstalledVersion, isOlderVersion } from '#dist/electron/handlers/ai/cliVersion.js';
import { ChatStore } from '#dist/electron/handlers/ai/chatStore.js';
import { parseAgentAvailability, parseSetupAction } from '#dist/shared/ipc/aiChat.js';

const FAKE_ADAPTER = path.resolve('test/fixtures/ai/fakeAdapter.mjs');
const REMOVE_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;

/** A disk where each key of `links` resolves to its value, and `texts` are the readable files. */
function disk(links: Readonly<Record<string, string>>, texts: Readonly<Record<string, string>> = {}): CliFileSystem {
  return { resolveFile: (candidate) => links[candidate], readText: (file) => texts[file] };
}

/** Lets real I/O and microtasks run until the condition holds, within a bound. */
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

test('a Claude Code version is read from every way it installs, and only from those', () => {
  const nothing = (): undefined => undefined;
  assert.equal(claudeInstalledVersion('/Users/a/.local/share/claude/versions/2.1.332', nothing), '2.1.332');
  assert.equal(claudeInstalledVersion('/opt/homebrew/Caskroom/claude-code/2.1.100/claude', nothing), '2.1.100');
  const manifest = '{"name":"@anthropic-ai/claude-code","version":"2.1.150"}';
  const npm = '/usr/local/lib/node_modules/@anthropic-ai/claude-code';
  assert.equal(
    claudeInstalledVersion(`${npm}/cli.js`, (file) => (file === `${npm}/package.json` ? manifest : undefined)),
    '2.1.150',
  );
  // A wrapper beside its node_modules: ~/.claude/local/claude, and npm's .cmd shim on Windows.
  const local = '/Users/a/.claude/local/node_modules/@anthropic-ai/claude-code/package.json';
  assert.equal(
    claudeInstalledVersion('/Users/a/.claude/local/claude', (file) => (file === local ? manifest : undefined)),
    '2.1.150',
  );
  const shim = 'C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\package.json';
  assert.equal(
    claudeInstalledVersion('C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd', (file) => (file === shim ? manifest : undefined)),
    '2.1.150',
  );
  assert.equal(claudeInstalledVersion('/Users/a/bin/claude', nothing), undefined);
  assert.equal(
    claudeInstalledVersion('/Users/a/bin/claude', () => 'not json'),
    undefined,
  );
  assert.equal(
    claudeInstalledVersion('/Users/a/bin/claude', () => '{"version":7}'),
    undefined,
  );
  assert.ok(isOlderVersion('2.1.99', '2.1.322'));
  assert.ok(!isOlderVersion('2.1.322', '2.1.322'));
  assert.ok(!isOlderVersion('3.0.0', '2.1.322'));
});

test('an older copy earlier on the search path no longer hides the up to date Claude Code', () => {
  // Stacki searches /usr/local/bin before ~/.local/bin, whatever the person's terminal does.
  const environment = { PATH: '/usr/local/bin:/home/a/.local/bin' };
  const old = '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js';
  const current = '/home/a/.local/share/claude/versions/2.1.332';
  const texts = { '/usr/local/lib/node_modules/@anthropic-ai/claude-code/package.json': '{"version":"2.1.150"}' };
  const links = { '/usr/local/bin/claude': old, '/home/a/.local/bin/claude': current };
  assert.equal(findCli('claude', { environment, platform: 'darwin', fileSystem: disk(links, texts) }), current);
  // The same or an older version later on the path changes nothing.
  const older = { '/usr/local/bin/claude': current, '/home/a/.local/bin/claude': old };
  assert.equal(findCli('claude', { environment, platform: 'darwin', fileSystem: disk(older, texts) }), current);
  // A first one whose version cannot be read (the person's own wrapper) is kept.
  const wrapped = { '/usr/local/bin/claude': '/usr/local/bin/claude', '/home/a/.local/bin/claude': current };
  assert.equal(findCli('claude', { environment, platform: 'darwin', fileSystem: disk(wrapped) }), '/usr/local/bin/claude');
  // Codex keeps the PATH's order.
  const codex = { '/usr/local/bin/codex': '/a/claude/versions/1.0.0', '/home/a/.local/bin/codex': '/b/claude/versions/2.0.0' };
  assert.equal(findCli('codex', { environment, platform: 'darwin', fileSystem: disk(codex) }), '/a/claude/versions/1.0.0');
});

test('before any report the list names only Claude Code’s aliases, and the version needed follows the pinned adapter', () => {
  const model = FALLBACK_OPTIONS.claude.find((option) => option.id === 'model');
  assert.deepEqual(
    model?.choices.map((choice) => choice.value),
    ['default', 'opus', 'fable', 'sonnet', 'haiku'],
  );
  for (const choice of model?.choices ?? []) {
    assert.doesNotMatch(`${choice.value} ${choice.name}`, /\d/, 'no version that could go stale or be one the CLI lacks');
  }
  const lock: unknown = JSON.parse(fs.readFileSync(path.resolve('resources/agents/claude-agent-acp.lock.json'), 'utf8'));
  const packages: unknown = Reflect.get(Object(lock), 'packages');
  const sdk: unknown = Reflect.get(Object(Reflect.get(Object(packages), 'node_modules/@anthropic-ai/claude-agent-sdk')), 'version');
  assert.ok(typeof sdk === 'string');
  // The SDK 0.3.N is made for Claude Code 2.1.N: bumping the adapter moves the minimum with it.
  assert.equal(ADAPTERS.claude.cliVersionMin, `2.1.${sdk.split('.')[2]}`);
  assert.equal(ADAPTERS.codex.cliVersionMin, undefined);
});

test('the wire carries an old CLI’s version and the update action', () => {
  const ready = { agent: 'claude', state: 'ready', adapterVersion: '0.105.0', running: false };
  assert.deepEqual(parseAgentAvailability(ready), ready);
  assert.deepEqual(parseAgentAvailability({ ...ready, outdatedCli: '2.1.150' }), { ...ready, outdatedCli: '2.1.150' });
  assert.throws(() => parseAgentAvailability({ ...ready, outdatedCli: 7 }));
  assert.throws(() => parseAgentAvailability({ ...ready, outdatedCli: 'x'.repeat(100_000) }));
  assert.deepEqual(parseSetupAction({ kind: 'update', command: 'rm' }), { kind: 'update' });
});

test('POSIX: a saved list is read again each run and after an update, which also replaces the running adapter', async (context) => {
  if (process.platform === 'win32') {
    context.skip('the native installer’s symlink layout is POSIX');
    return;
  }
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-models-')));
  const bin = path.join(home, 'bin');
  const versions = path.join(home, 'claude', 'versions');
  fs.mkdirSync(bin);
  fs.mkdirSync(versions, { recursive: true });
  const install = (version: string): string => {
    const file = path.join(versions, version);
    fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
    fs.rmSync(path.join(bin, 'claude'), { force: true });
    fs.symlinkSync(file, path.join(bin, 'claude'));
    return file;
  };
  install('2.1.150');
  const userData = path.join(home, 'user');
  const store = new ChatStore(path.join(userData, 'ai'));
  // What an earlier run saved: the list an old Claude Code reported.
  const saved = { id: 'model', name: 'Model', category: 'model', currentValue: 'default', choices: [{ value: 'default', name: 'Opus 4.8' }] };
  fs.mkdirSync(path.join(userData, 'ai'), { recursive: true });
  store.writeAgentOptions(JSON.stringify({ claude: [saved], codex: [saved] }));
  const started: (string | undefined)[] = [];
  const pushed: string[] = [];
  const host = new AgentHost({
    userData,
    store,
    send: (channel: string, payload: unknown) => {
      if (channel === 'ai:agentStatus') {
        pushed.push(JSON.stringify(payload));
      }
    },
    files: { read: () => undefined, write: () => undefined, create: () => undefined, trash: async () => undefined },
    snapshots: { snapshot: async () => undefined, changes: async () => [], blob: async () => undefined },
    environment: () => ({ PATH: bin, HOME: home }),
    now: Date.now,
    version: 'test',
    entryOf: (agent) => (agent === 'claude' ? FAKE_ADAPTER : undefined),
    spawnAdapter: (entry, cwd, environment) => {
      started.push(environment['CLAUDE_CODE_EXECUTABLE']);
      return spawn(process.execPath, [entry], { cwd, env: { ...environment }, stdio: ['pipe', 'pipe', 'pipe'] });
    },
  });
  context.after(() => {
    host.stopAll();
    fs.rmSync(home, REMOVE_OPTIONS);
  });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(home, 'site-')));
  const claude = () => host.agents(root);

  const first = claude();
  assert.match(JSON.stringify(first.options), /Opus 4\.8/, 'the saved list is shown at once');
  assert.deepEqual(first.agents[0], { agent: 'claude', state: 'ready', adapterVersion: ADAPTERS.claude.version, running: false, outdatedCli: '2.1.150' });
  await settle('the fresh list', () => pushed.some((push) => push.includes('"Small"')));
  assert.match(JSON.stringify(claude().options[0]), /"Small"/);
  assert.equal(started.length, 1, 'one adapter for the CLI in use');

  const updated = install(ADAPTERS.claude.cliVersionMin ?? '');
  const after = claude().agents[0];
  assert.ok(after?.state === 'ready');
  assert.equal(after.outdatedCli, undefined, 'up to date after the update');
  await settle('an adapter told to run the updated CLI', () => started.length === 2);
  assert.equal(started[1], updated);
});

test('`claude update` runs only when asked, once for presses made together, and the CLI is checked again', async () => {
  const commands: string[] = [];
  let finish: (() => void) | undefined;
  const spawnPipe = (command: SetupCommand): SetupProcess => {
    const words = command.args.filter((word, index) => word !== '--settings' && command.args[index - 1] !== '--settings').join(' ');
    commands.push(words);
    let exit: (code: number) => void = () => undefined;
    let data: (text: string) => void = () => undefined;
    queueMicrotask(() => {
      if (words === 'update') {
        finish = () => exit(0);
      } else {
        data(JSON.stringify({ loggedIn: true, apiProvider: 'firstParty', authMethod: 'claude.ai', subscriptionType: 'pro' }));
        exit(0);
      }
    });
    return {
      onData: (listener) => (data = listener),
      onExit: (listener) => (exit = listener),
      write: () => undefined,
      kill: () => undefined,
    };
  };
  const setup = new AgentSetup({
    environment: () => ({ PATH: '/tools' }),
    cliPlatform: 'darwin',
    platform: 'darwin',
    cliFileSystem: disk({ '/tools/claude': '/tools/claude', '/tools/codex': '/tools/codex' }),
    openExternal: () => undefined,
    publish: () => undefined,
    spawnPipe,
  });
  await setup.act('claude', { kind: 'detect' });
  assert.deepEqual(commands, ['auth status'], 'a status check never updates');
  const one = setup.act('claude', { kind: 'update' });
  const two = setup.act('claude', { kind: 'update' });
  await settle('the update running', () => finish !== undefined);
  finish?.();
  assert.equal((await one).step, 'ready');
  assert.equal((await two).step, 'ready');
  assert.deepEqual(commands, ['auth status', 'update', 'auth status']);
  await setup.act('codex', { kind: 'update' });
  assert.deepEqual(commands, ['auth status', 'update', 'auth status'], 'Codex has no update here');
});
