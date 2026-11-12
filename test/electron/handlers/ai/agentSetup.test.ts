// Goal: the guided setup takes a designer from "not installed" to "ready" by
// buttons, driving only the agent's own CLI: install runs the official
// installer and re-detects; sign-in runs the CLI's login in a terminal, opens
// the first sign-in page it prints on the provider's own hosts (never another
// address), shows a code field when the CLI asks for one and types the code in,
// and ends ready, failed, cancelled or timed out; sign-out runs the CLI's
// logout. A sign-in is never an endless wait: every way it can stall (the CLI
// exits without signing in, prints no page, exits with an error while the CLI
// still reports an old sign-in, or is simply never finished) ends in a failed
// state that carries the CLI's words, with links and tokens left out. The status readers understand what each CLI prints.
// Methodology: AgentSetup from dist/ with an in-process fake CLI behind both
// process seams (pipe and terminal), a temporary PATH holding a fake `claude`
// and `codex`, and the pure readers on recorded-style outputs.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mock, test } from 'node:test';
import {
  AgentSetup,
  asksForCode,
  readClaudeStatus,
  readCodexStatus,
  redactSignInOutput,
  SETUP_LIMITS,
  signInStartFailure,
  signInStopped,
  signInURL,
  stripTerminalCodes,
} from '#dist/electron/handlers/ai/agentSetup.js';
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
  const lines: string[] = [];
  const setup = new AgentSetup({
    environment: () => ({ PATH: bin }),
    openExternal: (url: string) => opened.push(url),
    publish: (state: SetupState) => states.push(state),
    log: (line: string) => lines.push(line),
    spawnPipe: make,
    spawnTerminal: async (command: { command: string; args: readonly string[] }) => make(command),
    home: bin,
    platform: 'darwin',
  });
  const install = (name: string) => fs.writeFileSync(path.join(bin, process.platform === 'win32' ? `${name}.cmd` : name), '#!/bin/sh\n', { mode: 0o755 });
  return { bin, setup, started, states, opened, lines, install };
}

/** What `claude auth login` prints on macOS (CLI 2.1.x), recorded: the page as an OSC 8 link and as visible text, then the code prompt. */
const CLAUDE_LOGIN_OUTPUT = [
  "Opening browser to sign in…\r\nIf the browser didn't open, visit: ",
  '\x1b]8;;https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=SECRETSTATE\x07',
  '\x1b[94mhttps://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=SECRETSTATE\x1b[39m\x1b]8;;\x07',
  '\r\nPaste code here if prompted > ',
];
const CLAUDE_PAGE = 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=SECRETSTATE';

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

function claudeCli(onLogin: (process: FakeProcess) => void, status: () => { readonly signedIn: boolean; readonly exit: number }) {
  const cli = fakeCli((process) => {
    if (process.args.join(' ') === 'auth login --claudeai') {
      onLogin(process);
    } else if (process.args.join(' ') === 'auth status') {
      const answer = status();
      process.emit(JSON.stringify({ loggedIn: answer.signedIn }));
      process.exit(answer.exit);
    }
  });
  cli.install('claude');
  return cli;
}

test('the real CLI’s output: the page opens once, the code field appears, a code is typed in, no link or state is kept in the card or the log', async () => {
  let login: FakeProcess | undefined;
  const cli = fakeCli((process) => {
    if (process.args[1] === 'login') {
      login = process;
      // The chunks split inside an escape sequence, the way a terminal's reads can.
      const whole = CLAUDE_LOGIN_OUTPUT.join('');
      const cut = whole.indexOf('\x1b[39m') + 1;
      process.emit(whole.slice(0, cut));
      process.emit(whole.slice(cut));
    } else if (process.args.join(' ') === 'auth status') {
      process.emit('{"loggedIn":false}');
      process.exit(1);
    }
  });
  cli.install('claude');
  const states: SetupState[] = cli.states;
  const withLog = cli.setup;
  const lines = cli.lines;
  await withLog.act('claude', { kind: 'signIn' });
  await until('the code prompt', () => states.some((state) => state.step === 'signing-in' && state.needsCode));
  assert.deepEqual(cli.opened, [CLAUDE_PAGE], 'the page opens once, with the state intact (no escape code glued on)');
  const waiting = states.at(-1);
  assert.ok(waiting?.step === 'signing-in');
  assert.equal(waiting.url, CLAUDE_PAGE);
  assert.match(waiting.output, /Paste code here if prompted/);
  assert.doesNotMatch(waiting.output, /SECRETSTATE|https:/, 'the card’s Details never hold the link');
  assert.doesNotMatch(lines.join('\n'), /SECRETSTATE|https:/, 'the log never holds the link');
  assert.ok(
    lines.some((line) => /Paste code here/.test(line)),
    'the CLI’s words are logged',
  );
  await withLog.act('claude', { kind: 'code', code: 'CODE-FROM-PAGE' });
  assert.deepEqual(login?.written, ['CODE-FROM-PAGE\r']);
  assert.doesNotMatch(lines.join('\n'), /CODE-FROM-PAGE/, 'a pasted code is never logged');
  withLog.stopAll();
});

test('a sign-in whose CLI exits with an error is a failure even while the CLI still reports an old sign-in', async () => {
  const cli = claudeCli(
    (process) => {
      process.emit('Opening https://claude.ai/oauth/authorize?state=S\nLogin failed: access_denied\n');
      process.exit(1);
    },
    () => ({ signedIn: true, exit: 0 }), // An expired session still says "logged in".
  );
  await cli.setup.act('claude', { kind: 'signIn' });
  await until('the failure', () => cli.states.at(-1)?.step === 'failed');
  const failed = cli.states.at(-1);
  assert.ok(failed?.step === 'failed');
  assert.equal(failed.during, 'sign-in');
  assert.equal(failed.message, 'Sign-in stopped: Login failed: access_denied');
  assert.match(failed.details, /access_denied/);
  assert.doesNotMatch(failed.details, /claude\.ai/, 'details leave the link out');
  assert.ok(!cli.states.some((state) => state.step === 'ready'), 'never reported ready');
});

test('a CLI that exits cleanly without signing in, and one that prints no page at all, both end in the failed state', async () => {
  const cli = claudeCli(
    (process) => {
      process.exit(0);
    },
    () => ({ signedIn: false, exit: 1 }),
  );
  await cli.setup.act('claude', { kind: 'signIn' });
  await until('the failure', () => cli.states.at(-1)?.step === 'failed');
  const failed = cli.states.at(-1);
  assert.ok(failed?.step === 'failed');
  assert.equal(failed.message, 'Sign-in did not finish. Try again.');
  assert.equal(cli.opened.length, 0, 'no page was printed, none was opened');
  // The card can start again: the failed process is let go.
  assert.equal((await cli.setup.act('claude', { kind: 'signIn' })).step, 'signing-in');
  assert.equal(cli.started.filter((process) => process.args[1] === 'login').length, 2);
});

test('a sign-in nobody finishes ends by itself after the bound, kills the process, and keeps what the CLI said', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const cli = claudeCli(
      (process) => {
        process.emit(CLAUDE_LOGIN_OUTPUT.join(''));
      },
      () => ({ signedIn: false, exit: 1 }),
    );
    const settled = async (condition: () => boolean) => {
      for (let attempt = 0; attempt < 200 && !condition(); attempt++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.ok(condition(), 'settled');
    };
    await cli.setup.act('claude', { kind: 'signIn' });
    await settled(() => cli.opened.length === 1);
    assert.equal(SETUP_LIMITS.signInMsMax, 5 * 60 * 1000, 'five minutes');
    mock.timers.tick(SETUP_LIMITS.signInMsMax);
    await settled(() => cli.states.at(-1)?.step === 'failed');
    const failed = cli.states.at(-1);
    assert.ok(failed?.step === 'failed');
    assert.equal(failed.message, 'Sign-in didn’t finish in 5 minutes. Try again.');
    assert.match(failed.details, /Paste code here if prompted/);
    assert.doesNotMatch(failed.details, /SECRETSTATE/);
    assert.equal(cli.started.find((process) => process.args[1] === 'login')?.killed, true, 'no login process is left behind');
  } finally {
    mock.timers.reset();
  }
});

test('starting a sign-in twice runs one process; a terminal that cannot start says what to do', async () => {
  const cli = claudeCli(
    (process) => {
      process.emit('waiting\n');
    },
    () => ({ signedIn: false, exit: 1 }),
  );
  await cli.setup.act('claude', { kind: 'signIn' });
  await cli.setup.act('claude', { kind: 'signIn' });
  assert.equal(cli.started.filter((process) => process.args[1] === 'login').length, 1);
  cli.setup.stopAll();
  assert.match(signInStartFailure('Error: posix_spawnp failed.'), /npm run fix:pty/);
  assert.equal(signInStartFailure('something else'), 'The sign-in could not start.');
});

test('redaction keeps links, tokens and codes out; the stopped sentence prefers the CLI’s last plain line', () => {
  assert.equal(redactSignInOutput('visit https://claude.com/x?state=S now'), 'visit [sign-in link] now');
  assert.equal(redactSignInOutput('key sk-ant-oat01-ABCDEFGHIJKL end'), 'key [token] end');
  assert.equal(redactSignInOutput('Authorization: Bearer abcdefghijklmnop'), 'Authorization: Bearer [token]');
  assert.equal(redactSignInOutput('access_token=abcdefghijklmnop12'), 'access_token=[token]');
  assert.equal(redactSignInOutput('nothing secret here'), 'nothing secret here');
  assert.equal(signInStopped(1, 'Opening [sign-in link]\nLogin failed: denied\n'), 'Sign-in stopped: Login failed: denied');
  assert.equal(signInStopped(7, 'Opening [sign-in link]\n'), 'Sign-in stopped (code 7). Open Details for what the CLI said.');
  assert.equal(signInStopped(2, ''), 'Sign-in stopped (code 2). Open Details for what the CLI said.');
});

// Windows, driven through AgentSetup with a fake file system (the spawn EINVAL report: windowsCommand.ts).
function windowsSetup(files: ReadonlySet<string>) {
  const started: { command: string; args: readonly string[]; style: string | undefined; environment: Record<string, string | undefined> }[] = [];
  const states: SetupState[] = [];
  const lower = new Set([...files].map((file) => file.toLowerCase()));
  const setup = new AgentSetup({
    environment: () => ({ Path: 'C:\\Program Files\\nodejs' }),
    openExternal: () => undefined,
    publish: (state: SetupState) => states.push(state),
    log: () => undefined,
    spawnPipe: (command, environment) => {
      started.push({ command: command.command, args: command.args, style: command.argumentStyle, environment: { ...environment } });
      return {
        onData: (listener: (text: string) => void) => setImmediate(() => listener('')),
        onExit: (listener: (code: number) => void) => setImmediate(() => listener(0)),
        write: () => undefined,
        kill: () => undefined,
      };
    },
    home: 'C:\\Users\\Ada',
    platform: 'win32',
    execPath: 'C:\\Program Files\\Stacki\\Stacki.exe',
    fileSystem: { fileExists: (file) => lower.has(file.toLowerCase()), readText: () => undefined, listDirectory: () => [] },
  });
  return { setup, started, states };
}

test('on Windows the Codex install runs npm-cli.js under node.exe, never npm.cmd', async () => {
  const directory = 'C:\\Program Files\\nodejs';
  const cli = windowsSetup(new Set([`${directory}\\npm.cmd`, `${directory}\\node.exe`, `${directory}\\node_modules\\npm\\bin\\npm-cli.js`]));
  await cli.setup.act('codex', { kind: 'install' });
  const npm = cli.started[0];
  assert.equal(npm?.command, `${directory}\\node.exe`);
  assert.deepEqual(npm?.args, [`${directory}\\node_modules\\npm\\bin\\npm-cli.js`, 'install', '--global', '@openai/codex']);
  assert.equal(
    cli.started.some((process) => /\.(cmd|bat)$/i.test(process.command)),
    false,
  );
});

test('on Windows a missing npm ends in a sentence with the Node.js link, Details name the platform and command, and Try again can follow', async () => {
  const cli = windowsSetup(new Set());
  const failed = await cli.setup.act('codex', { kind: 'install' });
  assert.ok(failed.step === 'failed');
  assert.equal(failed.during, 'install');
  assert.match(failed.message, /Node\.js from nodejs\.org/);
  assert.match(failed.details, /^Platform: win32 /);
  assert.match(failed.details, /Tried: npm\.cmd install --global @openai\/codex/);
  assert.match(failed.details, /https:\/\/nodejs\.org/);
  assert.doesNotMatch(failed.details, /EINVAL/);
  assert.equal(cli.started.length, 0, 'nothing was started');
  assert.equal((await cli.setup.act('codex', { kind: 'install' })).step, 'failed', 'a second try is accepted, not stuck');
});

test('a spawn EINVAL from the system still gets a sentence and the last output in Details', async () => {
  const cli = fakeCli(() => undefined);
  const refusing = new AgentSetup({
    environment: () => ({ PATH: cli.bin }),
    openExternal: () => undefined,
    publish: () => undefined,
    log: () => undefined,
    spawnPipe: () => {
      throw new Error('spawn EINVAL');
    },
    home: cli.bin,
    platform: 'darwin',
  });
  const failed = await refusing.act('codex', { kind: 'install' });
  assert.ok(failed.step === 'failed');
  assert.match(failed.message, /could not start the Codex installer/);
  assert.doesNotMatch(failed.message, /EINVAL/);
  assert.match(failed.details, /spawn EINVAL/);
  assert.match(failed.details, /Tried: npm install --global --prefix/);
});
