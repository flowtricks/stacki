// Goal: a status check that could not be made is never shown as signed out. Signed in, signed out (the CLI said
// so) and "couldn't check" (timed out, crashed, unreadable) are three answers; a failed check is retried a stated
// number of times and then left until asked again; Claude's answer is read from normal output only (warnings on
// the error stream cannot spoil it) while Codex, which answers on the error stream, is still read; and the key,
// token or cloud sign-in in use is told by its kind alone. The agent's own commands get the agent environment;
// installers do not.
// Methodology: AgentSetup from dist/ with real child processes: a fake `claude` and `codex` (small /bin/sh
// scripts in a temporary folder that is also HOME and the whole PATH), so the two streams, exit codes, signals
// and timeouts are the platform's own. Skipped on Windows, which has no /bin/sh. Nothing real is run.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  AgentSetup,
  claudeSignInSource,
  readClaudeStatus,
  readCodexStatus,
  STATUS_RETRY_DELAYS_MS,
  type SetupDeps,
} from '#dist/electron/handlers/ai/agentSetup.js';
import { parseSetupState, type SetupState } from '#dist/shared/ipc/aiChat.js';
import { waitFor } from '../../../helpers/waitFor.js';

/** What a test changes about the setup; the rest is the fake's. */
type Overrides = {
  readonly [Key in 'statusTimeoutMs' | 'statusRetryDelaysMs' | 'agentEnvironment' | 'signInCompleted' | 'spawnPipe' | 'spawnTerminal']?: SetupDeps[Key];
};

const posix = { skip: process.platform === 'win32' ? 'the fake CLIs are /bin/sh scripts' : false };

function fakeBin(context: { after: (run: () => void) => void }) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-sign-in-status-'));
  context.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  const calls = path.join(bin, 'calls');
  /** `body` is the script's own; every run first notes its arguments, so tries can be counted. */
  const cli = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "$*" >> '${calls}'\n${body}\n`, { mode: 0o755 });
  const runs = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').length : 0);
  const states: SetupState[] = [];
  const lines: string[] = [];
  const make = (extra: Overrides = {}) => {
    const setup = new AgentSetup({
      environment: () => ({ PATH: bin, HOME: bin }),
      openExternal: () => undefined,
      publish: (state: SetupState) => states.push(state),
      log: (line: string) => lines.push(line),
      home: bin,
      statusRetryDelaysMs: [],
      ...extra,
    });
    context.after(() => setup.stopAll());
    return setup;
  };
  return { bin, cli, runs, states, lines, make };
}

const answer = (json: string, exit = 0) => `printf '%s\\n' '${json}'\nexit ${exit}`;

test('Claude: warnings on the error stream and chatter before the object do not make a signed-in person signed out', posix, async (context) => {
  const fake = fakeBin(context);
  fake.cli(
    'claude',
    `echo '(node:1) Warning: {unrelated} deprecation' >&2\necho 'updating shims {ok}'\n${answer('{"loggedIn":true,"subscriptionType":"max"}')}`,
  );
  const state = await fake.make().act('claude', { kind: 'detect' });
  assert.deepEqual(state, { agent: 'claude', step: 'ready', account: { name: undefined, plan: 'Max', email: undefined, source: 'account' } });
  assert.deepEqual(parseSetupState(JSON.parse(JSON.stringify(state))).step, 'ready');
});

test('Claude: a real "not logged in" answer is signed out; a crash, nonsense, a kill and a timeout are "couldn’t check"', posix, async (context) => {
  const fake = fakeBin(context);
  const setup = fake.make({ statusTimeoutMs: 1_000 });
  fake.cli('claude', answer('{"loggedIn":false,"authMethod":"none"}', 1));
  assert.equal((await setup.act('claude', { kind: 'detect' })).step, 'signed-out');
  for (const [label, body] of [
    ['an error on the error stream', `echo 'TypeError: boom' >&2\nexit 1`],
    ['nothing at all', 'exit 0'],
    ['half an object', `printf '{"loggedIn":'\nexit 0`],
    ['an object without the answer', answer('{"version":"2"}')],
    ['signed in but a failing exit', answer('{"loggedIn":true}', 1)],
    ['an answer on the wrong stream', `echo '{"loggedIn":false}' >&2\nexit 1`],
    ['killed by a signal', 'kill -KILL $$'],
    ['never finishing', 'exec /bin/sleep 30'],
  ] as const) {
    fake.cli('claude', body);
    assert.deepEqual(await setup.act('claude', { kind: 'detect' }), { agent: 'claude', step: 'unchecked' }, label);
  }
  assert.doesNotMatch(fake.lines.join('\n'), /loggedIn|boom/, 'what an unreadable status printed is not logged');
});

test('Codex answers on the error stream, and each of its answers is read for its kind alone', posix, async (context) => {
  const fake = fakeBin(context);
  const setup = fake.make();
  const says = (text: string, exit = 0) => fake.cli('codex', `printf '%s\\n' '${text}' >&2\nexit ${exit}`);
  for (const [text, source] of [
    ['Logged in using ChatGPT', 'account'],
    ['API key configured - sk-proj-***ABCDE', 'api-key'],
    ['Logged in using an API key - sk-proj-***ABCDE', 'api-key'],
    ['Logged in using access token', 'token'],
    ['Logged in using Amazon Bedrock API key', 'cloud'],
  ] as const) {
    says(`WARNING: proceeding, even though we could not update PATH\n${text}`);
    const state = await setup.act('codex', { kind: 'detect' });
    assert.deepEqual(state, { agent: 'codex', step: 'ready', account: { name: undefined, plan: undefined, email: undefined, source } }, text);
    assert.doesNotMatch(JSON.stringify(state), /sk-proj/, 'no part of a key leaves the check');
  }
  says('Not logged in', 1);
  assert.equal((await setup.act('codex', { kind: 'detect' })).step, 'signed-out');
  says('Error checking login status: keyring unavailable', 1);
  assert.equal((await setup.act('codex', { kind: 'detect' })).step, 'unchecked');
});

test('a check that could not be made is retried a bounded number of times, then waits to be asked again', posix, async (context) => {
  const fake = fakeBin(context);
  fake.cli('claude', 'exit 3');
  const setup = fake.make({ statusRetryDelaysMs: [5, 5] });
  await setup.act('claude', { kind: 'detect' });
  await waitFor({ what: 'the first check and two retries', read: () => fake.states.length === 3, until: Boolean });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(fake.runs(), 3, 'no further try on its own');
  assert.equal(STATUS_RETRY_DELAYS_MS.length, 2, 'the bound the app ships with');
  // Asked again (a chat opens, the window is focused, the note is pressed): a new round.
  await setup.act('claude', { kind: 'detect' });
  await waitFor({ what: 'another bounded round', read: () => fake.runs() === 6, until: Boolean });
});

test('a retry that succeeds settles the state, and a newer answer is never overwritten by an older check', posix, async (context) => {
  const fake = fakeBin(context);
  const flag = path.join(fake.bin, 'ok');
  fake.cli('claude', `if [ -f '${flag}' ]; then ${answer('{"loggedIn":true}').replace('\n', '; ')}; fi\n: > '${flag}'\nexit 3`);
  const setup = fake.make({ statusRetryDelaysMs: [5] });
  assert.equal((await setup.act('claude', { kind: 'detect' })).step, 'unchecked');
  await waitFor({ what: 'the retry', read: () => fake.states.at(-1)?.step === 'ready', until: Boolean });
  // A slow check overtaken by a quick one answers with the newer result and publishes nothing stale.
  const slow = path.join(fake.bin, 'slow');
  fs.writeFileSync(slow, '');
  fake.cli(
    'claude',
    `if [ -f '${slow}' ]; then /bin/rm '${slow}'; /bin/sleep 0.4; ${answer('{"loggedIn":false}', 1).replace('\n', '; ')}; fi\n${answer('{"loggedIn":true}')}`,
  );
  const older = setup.act('claude', { kind: 'detect' });
  await waitFor({ what: 'the slow check to start', read: () => !fs.existsSync(slow), until: Boolean });
  const newer = setup.act('claude', { kind: 'detect' });
  assert.equal((await newer).step, 'ready');
  assert.equal((await older).step, 'ready');
  assert.notEqual(fake.states.at(-1)?.step, 'signed-out');
});

test('the agent’s own commands get the agent environment; the installer does not', posix, async (context) => {
  const fake = fakeBin(context);
  fake.cli(
    'claude',
    `if [ -n "$ANTHROPIC_API_KEY" ]; then ${answer('{"loggedIn":true,"authMethod":"api_key","orgName":"Saved Org"}').replace('\n', '; ')}; fi\n${answer('{"loggedIn":false}', 1)}`,
  );
  const installs: (string | undefined)[] = [];
  const secret = 'fake-key-for-this-test';
  const setup = fake.make({ agentEnvironment: async () => ({ PATH: fake.bin, HOME: fake.bin, ANTHROPIC_API_KEY: secret }) });
  assert.deepEqual(await setup.act('claude', { kind: 'detect' }), {
    agent: 'claude',
    step: 'ready',
    account: { name: undefined, plan: undefined, email: undefined, source: 'api-key' },
  });
  assert.doesNotMatch(JSON.stringify(fake.states) + fake.lines.join('\n'), new RegExp(secret));
  const installer = fake.make({
    agentEnvironment: async () => ({ ANTHROPIC_API_KEY: secret }),
    spawnPipe: (_command, environment) => {
      installs.push(environment['ANTHROPIC_API_KEY']);
      return {
        onData: () => undefined,
        onExit: (listener: (code: number) => void) => setImmediate(() => listener(1)),
        write: () => undefined,
        kill: () => undefined,
      };
    },
  });
  await installer.act('codex', { kind: 'install' });
  assert.deepEqual(installs, [undefined]);
});

test('a sign-in whose command succeeds but cannot be checked is not called failed', posix, async (context) => {
  const fake = fakeBin(context);
  fake.cli('claude', 'exit 3');
  const completed: string[] = [];
  const setup = fake.make({
    signInCompleted: (agent) => completed.push(agent),
    spawnTerminal: async () => ({
      onData: () => undefined,
      onExit: (listener: (code: number) => void) => setImmediate(() => listener(0)),
      write: () => undefined,
      kill: () => undefined,
    }),
  });
  await setup.act('claude', { kind: 'signIn' });
  await waitFor({ what: 'the finished sign-in', read: () => completed.length === 1, until: Boolean });
  assert.equal(fake.states.at(-1)?.step, 'unchecked');
  assert.ok(!fake.states.some((state) => state.step === 'failed'));
});

test('which sign-in Claude will use follows its documented order, from names alone; boundaries reject unknown kinds', () => {
  assert.equal(claudeSignInSource('claude.ai', {}), 'account');
  assert.equal(claudeSignInSource(undefined, {}), 'account');
  assert.equal(claudeSignInSource('claude.ai', { ANTHROPIC_API_KEY: 'x' }), 'api-key');
  assert.equal(claudeSignInSource('api_key', { ANTHROPIC_API_KEY: 'x', ANTHROPIC_AUTH_TOKEN: 'y' }), 'token');
  assert.equal(claudeSignInSource('api_key', { ANTHROPIC_AUTH_TOKEN: 'y', CLAUDE_CODE_USE_BEDROCK: '1' }), 'cloud');
  assert.equal(claudeSignInSource('claude.ai', { CLAUDE_CODE_USE_VERTEX: '0' }), 'account');
  assert.equal(claudeSignInSource('api_key_helper', {}), 'api-key');
  assert.equal(claudeSignInSource('oauth_token', {}), 'token');
  assert.equal(claudeSignInSource('third_party', {}), 'cloud');
  assert.deepEqual(readClaudeStatus({ stdout: '[]', stderr: '', exitCode: 0 }, {}), { kind: 'unreadable' });
  assert.deepEqual(readClaudeStatus({ stdout: '{"loggedIn":"yes"}', stderr: '', exitCode: 0 }, {}), { kind: 'unreadable' });
  assert.deepEqual(readCodexStatus({ stdout: '', stderr: '', exitCode: 0 }), { kind: 'unreadable' });
  assert.deepEqual(readCodexStatus({ stdout: '', stderr: 'Logged in using ChatGPT', exitCode: 2 }), { kind: 'unreadable' });
  assert.equal(parseSetupState({ agent: 'claude', step: 'unchecked' }).step, 'unchecked');
  assert.throws(() => parseSetupState({ agent: 'claude', step: 'ready', account: {} }), /source/);
  assert.throws(() => parseSetupState({ agent: 'claude', step: 'ready', account: { source: 'sk-secret' } }), /source/);
});
