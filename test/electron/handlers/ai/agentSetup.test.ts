// Goal: the guided setup takes a designer from "not installed" to "ready" by
// buttons, driving only the agent's own CLI: install runs the official
// installer and re-detects; sign-in runs the CLI's login in a terminal, opens
// the first sign-in page it prints on the provider's own hosts (never another
// address), shows a code field when the CLI asks for one and types the code in,
// and ends ready, failed, cancelled or timed out; sign-out runs the CLI's
// logout. The status readers understand what each CLI prints.
// Methodology: AgentSetup from dist/ with an in-process fake CLI behind both
// process seams (pipe and terminal), a temporary PATH holding a fake `claude`
// and `codex`, and the pure readers on recorded-style outputs.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { AgentSetup, asksForCode, readClaudeStatus, readCodexStatus, signInURL, stripTerminalCodes } from '#dist/electron/handlers/ai/agentSetup.js';
import type { SetupState } from '#dist/shared/ipc/aiChat.js';

interface FakeProcess {
  readonly command: string;
  readonly args: readonly string[];
  readonly written: string[];
  emit: (text: string) => void;
  exit: (code: number) => void;
  killed: boolean;
}

function fakeCli(script: (process: FakeProcess) => void) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-ai-setup-'));
  const started: FakeProcess[] = [];
  const make = (command: { command: string; args: readonly string[] }) => {
    let data: (text: string) => void = () => undefined;
    let done: (code: number) => void = () => undefined;
    const process: FakeProcess = {
      command: command.command,
      args: command.args,
      written: [],
      emit: (text) => data(text),
      exit: (code) => done(code),
      killed: false,
    };
    started.push(process);
    setImmediate(() => script(process));
    return {
      onData: (listener: (text: string) => void) => {
        data = listener;
      },
      onExit: (listener: (code: number) => void) => {
        done = listener;
      },
      write: (text: string) => process.written.push(text),
      kill: () => {
        process.killed = true;
      },
    };
  };
  const states: SetupState[] = [];
  const opened: string[] = [];
  const setup = new AgentSetup({
    environment: () => ({ PATH: bin }),
    openExternal: (url: string) => opened.push(url),
    publish: (state: SetupState) => states.push(state),
    spawnPipe: make,
    spawnTerminal: async (command: { command: string; args: readonly string[] }) => make(command),
    home: bin,
    platform: 'darwin',
  });
  const install = (name: string) => fs.writeFileSync(path.join(bin, process.platform === 'win32' ? `${name}.cmd` : name), '#!/bin/sh\n', { mode: 0o755 });
  return { bin, setup, started, states, opened, install };
}

const until = async (label: string, condition: () => boolean) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
};

test('not installed → installing → signed out, by the official installer', async () => {
  let signedIn = false;
  const cli = fakeCli((process) => {
    if (process.command === '/bin/bash') {
      cli.install('claude');
      process.emit('Installing Claude Code…\n');
      process.exit(0);
    } else if (process.args.join(' ') === 'auth status') {
      process.emit(JSON.stringify({ loggedIn: signedIn, email: 'designer@example.com', orgName: 'Acme Studio', subscriptionType: 'max' }));
      process.exit(signedIn ? 0 : 1);
    }
  });
  assert.equal((await cli.setup.act('claude', { kind: 'detect' })).step, 'missing');
  const installed = await cli.setup.act('claude', { kind: 'install' });
  assert.equal(installed.step, 'signed-out');
  assert.deepEqual(
    cli.states.map((state) => state.step),
    ['missing', 'installing', 'signed-out'],
  );
  assert.deepEqual(cli.started.find((process) => process.command === '/bin/bash')?.args, ['-c', 'curl -fsSL https://claude.ai/install.sh | bash']);
  signedIn = true;
  assert.deepEqual(await cli.setup.act('claude', { kind: 'detect' }), {
    agent: 'claude',
    step: 'ready',
    account: { name: 'Acme Studio', plan: 'Max', email: 'designer@example.com' },
  });
});

test('a failed install says why, keeps the details, and never asks for a password', async () => {
  const cli = fakeCli((process) => {
    process.emit('npm ERR! code EACCES\nnpm ERR! permission denied\n');
    process.exit(243);
  });
  const failed = await cli.setup.act('codex', { kind: 'install' });
  assert.ok(failed.step === 'failed');
  assert.equal(failed.during, 'install');
  assert.match(failed.message, /Copy details/);
  assert.match(failed.details, /EACCES/);
  const npm = cli.started[0];
  assert.deepEqual([npm?.command, ...(npm?.args ?? [])], ['npm', 'install', '--global', '--prefix', path.join(cli.bin, '.local'), '@openai/codex']);
});

test('sign-in opens the provider’s page, takes a pasted code, and ends ready', async () => {
  let signedIn = false;
  let login: FakeProcess | undefined;
  const cli = fakeCli((process) => {
    if (process.args[0] === 'login' && process.args.length === 1) {
      login = process;
      process.emit('\x1b[1mVisit https://evil.example.com/steal first\x1b[0m\n');
      process.emit('Open https://auth.openai.com/oauth/authorize?client_id=abc&state=1 to sign in.\n');
      process.emit('Paste the authorization code here: ');
    } else if (process.args.join(' ') === 'login status') {
      process.emit(signedIn ? 'Logged in using ChatGPT\n' : 'Not logged in\n');
      process.exit(signedIn ? 0 : 1);
    }
  });
  cli.install('codex');
  assert.equal((await cli.setup.act('codex', { kind: 'detect' })).step, 'signed-out');
  assert.equal((await cli.setup.act('codex', { kind: 'signIn' })).step, 'signing-in');
  await until('the code prompt', () => cli.states.some((state) => state.step === 'signing-in' && state.needsCode));
  assert.deepEqual(cli.opened, ['https://auth.openai.com/oauth/authorize?client_id=abc&state=1'], 'only the provider’s own page opens, once');
  const asked = cli.states.at(-1);
  assert.ok(asked?.step === 'signing-in');
  assert.equal(asked.url, 'https://auth.openai.com/oauth/authorize?client_id=abc&state=1');
  await cli.setup.act('codex', { kind: 'code', code: 'ABC-123' });
  assert.deepEqual(login?.written, ['ABC-123\r']);
  signedIn = true;
  login?.exit(0);
  await until('ready', () => cli.states.at(-1)?.step === 'ready');
  assert.deepEqual(cli.states.at(-1), { agent: 'codex', step: 'ready', account: { name: undefined, plan: undefined, email: undefined } });
});

test('cancel stops the sign-in; a sign-in that ends signed out is a failure with details; sign-out runs logout', async () => {
  let signedIn = false;
  const cli = fakeCli((process) => {
    if (process.args.join(' ') === 'auth login --claudeai') {
      process.emit('Opening https://claude.ai/oauth/authorize?code=true\n');
      if (process.written.length === 0 && cli.started.filter((other) => other.args[1] === 'login').length === 2) {
        process.emit('Login failed: denied\n');
        process.exit(1);
      }
    } else if (process.args.join(' ') === 'auth status') {
      process.emit(JSON.stringify({ loggedIn: signedIn }));
      process.exit(0);
    } else if (process.args.join(' ') === 'auth logout') {
      signedIn = false;
      process.exit(0);
    }
  });
  cli.install('claude');
  await cli.setup.act('claude', { kind: 'signIn' });
  await until('the page', () => cli.opened.length === 1);
  const cancelled = await cli.setup.act('claude', { kind: 'cancel' });
  assert.equal(cancelled.step, 'signed-out');
  assert.equal(cli.started.find((process) => process.args[1] === 'login')?.killed, true);
  await cli.setup.act('claude', { kind: 'signIn' });
  await until('the failure', () => cli.states.at(-1)?.step === 'failed');
  const failed = cli.states.at(-1);
  assert.ok(failed?.step === 'failed');
  assert.equal(failed.during, 'sign-in');
  assert.match(failed.details, /denied/);
  signedIn = true;
  assert.equal((await cli.setup.act('claude', { kind: 'signOut' })).step, 'signed-out');
});

test('the readers: sign-in addresses, code prompts, terminal codes and each CLI’s status', () => {
  const claudeHosts = ['claude.ai', 'claude.com', 'anthropic.com'];
  assert.equal(signInURL('go to https://claude.ai/oauth/authorize?x=1).', claudeHosts), 'https://claude.ai/oauth/authorize?x=1');
  assert.equal(signInURL('https://claude.ai.evil.com/x https://user:pass@claude.ai/x', claudeHosts), undefined);
  assert.equal(signInURL('http://claude.ai/x', claudeHosts), undefined, 'never plain http');
  assert.equal(signInURL('https://console.anthropic.com/oauth', claudeHosts), 'https://console.anthropic.com/oauth');
  assert.ok(asksForCode('Paste code here if prompted >'));
  assert.ok(asksForCode('Enter the authorization code:'));
  assert.ok(!asksForCode('Signing in… waiting for the browser'));
  assert.equal(stripTerminalCodes('\x1b[2K\x1b[1mBold\x1b[0m\x1b]0;title\x07'), 'Bold');
  const none = { name: undefined, plan: undefined, email: undefined };
  // A personal account's organisation is named after its email: that is no display name.
  assert.deepEqual(readClaudeStatus('{"loggedIn":true,"email":"a@b.c","orgName":"a@b.c\'s Organization","subscriptionType":"team_plus"}', 0), {
    signedIn: true,
    account: { name: undefined, plan: 'Team Plus', email: 'a@b.c' },
  });
  assert.deepEqual(readClaudeStatus('{"loggedIn":true,"orgName":"Timothy Ricks","subscriptionType":"max"}', 0).account, {
    name: 'Timothy Ricks',
    plan: 'Max',
    email: undefined,
  });
  assert.deepEqual(readClaudeStatus('{"loggedIn":false}', 1), { signedIn: false, account: none });
  assert.deepEqual(readClaudeStatus('not json', 0), { signedIn: false, account: none });
  assert.deepEqual(readCodexStatus('Logged in using ChatGPT', 0), { signedIn: true, account: none });
  assert.deepEqual(readCodexStatus('Not logged in', 1), { signedIn: false, account: none });
});
