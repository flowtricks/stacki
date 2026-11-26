// Goal: sign-in settings set only in shell startup files reach the AI agents, and nothing more does. Only listed
// names are kept, each agent gets only its own, nothing that changes how Claude is billed, the app's own
// environment wins, startup-file chatter cannot be taken for a value, the shell is asked once, a hung, flooding,
// broken or missing shell falls back to the app's environment within its bounds, and no value is ever logged.
// Methodology: a fake shell (a /bin/sh script given as the shell) in a temporary HOME: it records how it was
// started, "runs" a fake startup file from that HOME, then runs the command it was given. The person's real
// shell and startup files are never run. Skipped on Windows, where nothing is read.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { CLAUDE_BLOCKED_VARIABLES } from '#dist/electron/lib/claudeSubscriptionOnly.js';
import { LoginShellSettings, parseShellEnvironment, readLoginShell, withSignInSettings } from '#dist/electron/lib/loginShellSettings.js';
import { adapterEnvironment } from '#dist/electron/handlers/ai/agentHost.js';

const posix = { skip: process.platform === 'win32' ? 'nothing is read on Windows' : false };

function fakeShell(context: { after: (run: () => void) => void }, startup: string, run = 'eval "$2"') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-login-shell-'));
  context.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const log = path.join(home, 'started');
  fs.writeFileSync(path.join(home, '.fakerc'), `${startup}\n`);
  const shell = path.join(home, 'fake-shell');
  fs.writeFileSync(shell, `#!/bin/sh\necho "$1" >> '${log}'\n. "$HOME/.fakerc"\n${run}\n`, { mode: 0o755 });
  const base = { HOME: home, PATH: '/usr/bin:/bin' };
  const lines: string[] = [];
  const settings = (extra: Readonly<Record<string, string>> = {}, timeoutMs = 8_000) =>
    new LoginShellSettings({
      environment: () => ({ ...base, ...extra }),
      shell: () => shell,
      platform: 'linux',
      log: (line: string) => lines.push(line),
      timeoutMs,
    });
  const starts = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
  return { home, shell, base, lines, settings, starts };
}

/** What Claude starts with when the shell adds nothing: `base`, and a profile folder with nothing in it. */
const claudeOf = (base: Readonly<Record<string, string>>) => ({ ...base, ANTHROPIC_CONFIG_DIR: os.devNull });

const STARTUP = [
  "echo 'Welcome! ANTHROPIC_API_KEY=not-this-one'",
  "printf '__STACKI_guess__ANTHROPIC_AUTH_TOKEN=nor-this\\000__STACKI_guess__\\n'",
  "echo 'a warning' >&2",
  "export ANTHROPIC_API_KEY='fake-claude-key'",
  'export ANTHROPIC_CUSTOM_HEADERS="X-One: 1\nX-Two: a=b"',
  'export CLAUDE_CODE_CERT_STORE="one\ntwo=three"',
  "export CLAUDE_CONFIG_DIR='/tmp/fake config'",
  "export OPENAI_API_KEY='fake-codex-key'",
  "export HTTPS_PROXY='http://proxy.example:8080'",
  "export AWS_SECRET_ACCESS_KEY='fake-aws'",
  "export DATABASE_URL='postgres://unrelated'",
  "export PATH='/somewhere/else:/usr/bin:/bin'",
  "ANTHROPIC_BASE_URL='not-exported'",
  "export ANTHROPIC_PROFILE=''",
].join('\n');

test('a noisy startup file: each agent gets only its own listed settings, whole, as a login and interactive shell sets them', posix, async (context) => {
  const fake = fakeShell(context, STARTUP);
  const settings = fake.settings();
  const claude = await settings.environmentFor('claude');
  assert.deepEqual(claude, {
    ...fake.base,
    CLAUDE_CODE_CERT_STORE: 'one\ntwo=three',
    CLAUDE_CONFIG_DIR: '/tmp/fake config',
    HTTPS_PROXY: 'http://proxy.example:8080',
    ANTHROPIC_CONFIG_DIR: os.devNull,
  });
  const codex = await settings.environmentFor('codex');
  assert.deepEqual(codex, { ...fake.base, OPENAI_API_KEY: 'fake-codex-key', HTTPS_PROXY: 'http://proxy.example:8080' });
  assert.deepEqual(fake.starts(), ['-ilc'], 'asked once for the whole run, as the terminal’s shell behaves');
  assert.deepEqual(fake.lines, [], 'a read that works says nothing, so no value is logged');
  assert.equal('ANTHROPIC_API_KEY' in adapterEnvironment(claude, 'CLAUDE_CODE_EXECUTABLE', '/bin/claude'), false, 'no key, from the shell either');
});

test('the app’s own environment wins, in either spelling of a proxy variable', posix, async (context) => {
  const fake = fakeShell(context, `${STARTUP}\nexport https_proxy='http://other.example'\nexport CLAUDE_CODE_OAUTH_TOKEN='from-shell'`);
  // The fake shell inherits the app's values and then overrides them, as a real startup file can.
  const app = { CLAUDE_CODE_OAUTH_TOKEN: 'from-app', ANTHROPIC_API_KEY: 'a-terminal-launch-key', https_proxy: 'http://app.example' };
  const claude = await fake.settings(app).environmentFor('claude');
  assert.equal(claude['CLAUDE_CODE_OAUTH_TOKEN'], 'from-app');
  assert.equal('ANTHROPIC_API_KEY' in claude, false, 'the app’s own key is taken off too');
  assert.equal(claude['https_proxy'], 'http://app.example');
  assert.equal(claude['HTTPS_PROXY'], undefined);
});

test('nothing that changes how Claude is billed is taken, whatever the startup file switches on', () => {
  const shell = new Map([
    ...CLAUDE_BLOCKED_VARIABLES.map((name) => [name, '1'] as const),
    ['AWS_PROFILE', 'work'],
    ['GOOGLE_APPLICATION_CREDENTIALS', '/fake.json'],
    ['CLAUDE_CODE_OAUTH_TOKEN', 'fake-subscription-token'],
  ]);
  assert.deepEqual(withSignInSettings('claude', {}, shell), { CLAUDE_CODE_OAUTH_TOKEN: 'fake-subscription-token' });
  assert.deepEqual(withSignInSettings('codex', {}, shell), {});
});

test('the parser keeps listed names between the two marks and nothing else', () => {
  const mark = '__STACKI_0123456789abcdef__';
  const block = ['CLAUDE_CODE_OAUTH_TOKEN=a=b', 'HOME=/h', 'NODE_OPTIONS=--require /x', 'CODEX_HOME=', '=odd', 'junk', ''].join('\0');
  assert.deepEqual([...(parseShellEnvironment(`noise${mark}${block}${mark}more`, mark) ?? [])], [['CLAUDE_CODE_OAUTH_TOKEN', 'a=b']]);
  assert.equal(parseShellEnvironment(`${mark}CLAUDE_CODE_OAUTH_TOKEN=a\0`, mark), undefined, 'a block that never closed');
  assert.equal(parseShellEnvironment('CLAUDE_CODE_OAUTH_TOKEN=a', mark), undefined);
  const long = `${mark}CLAUDE_CODE_OAUTH_TOKEN=${'a'.repeat(40_000)}\0${mark}`;
  assert.equal(parseShellEnvironment(long, mark)?.size, 0, 'an overlong value is dropped');
});

test('a startup file that never returns, floods, exits early or a missing shell: the app’s environment, within bounds', posix, async (context) => {
  const hung = fakeShell(context, 'exec /bin/sleep 30');
  // Long enough for the system to start a new script, short against the 30 s the startup file would take: the
  // "timed-out" line below is what shows the bound ended the wait.
  const settings = hung.settings({}, 3_000);
  assert.deepEqual(await settings.environmentFor('claude'), claudeOf(hung.base));
  assert.deepEqual(await settings.environmentFor('claude'), claudeOf(hung.base));
  assert.deepEqual(hung.starts(), ['-ilc'], 'not asked again');
  assert.match(hung.lines.join('\n'), /were not read \(timed-out\)/);

  const early = fakeShell(context, "export ANTHROPIC_API_KEY='fake'\nexit 1");
  assert.deepEqual(await early.settings().environmentFor('claude'), claudeOf(early.base));
  assert.match(early.lines.join('\n'), /unreadable/);
  assert.doesNotMatch(early.lines.join('\n'), /fake'/);

  const request = { shell: hung.shell, environment: hung.base, timeoutMs: 8_000, outputBytesMax: 4_096 };
  fs.writeFileSync(path.join(hung.home, '.fakerc'), 'while :; do echo flooding-the-startup-output; done\n');
  assert.deepEqual(await readLoginShell(request), { kind: 'failed', reason: 'too-large' });
  assert.deepEqual(await readLoginShell({ ...request, shell: path.join(hung.home, 'no-such-shell') }), { kind: 'failed', reason: 'not-started' });
});

test('a startup file that leaves something running does not hold the answer back', posix, async (context) => {
  const fake = fakeShell(context, "export CODEX_HOME='/fake/codex'", 'eval "$2"\nexec /bin/sleep 30');
  // Waiting for the shell to end would run into the bound and give the app's environment, without this value.
  const codex = await fake.settings().environmentFor('codex');
  assert.equal(codex['CODEX_HOME'], '/fake/codex');
  assert.deepEqual(fake.lines, []);
});

test('Windows reads nothing and starts no shell', async () => {
  const settings = new LoginShellSettings({
    environment: () => ({ Path: 'C:\\x' }),
    platform: 'win32',
    shell: () => assert.fail('no shell on Windows'),
  });
  assert.deepEqual(await settings.environmentFor('claude'), claudeOf({ Path: 'C:\\x' }));
});
