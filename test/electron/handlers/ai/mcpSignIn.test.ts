// Goal: a designer signs an MCP server in from Stacki without a terminal, through the agent's own CLI. The
// browser opens only a secure page the CLI printed; the sign-in ends connected, cancelled, timed out or failed,
// and can be tried again; it lands where the agent's own sessions look and survives a restart; the page, its
// code and the CLI's listings never reach the window or a log; local commands, token servers and old CLIs never
// show a false sign-in state; nothing is contacted before the project is allowed.
// Methodology: McpSignIn from dist/ with its real process and pseudo-terminal seams, and a fake `claude` and
// `codex` (one Node script) in a temporary HOME that is also the CLIs' config folder. The fake behaves as the
// documented and shipped CLIs do where it matters: `login` gives up without a terminal, refuses a project server
// that no `--settings` approval names, listens on 127.0.0.1 for the OAuth callback with a state check, prints the
// page, and stores a token in its config folder. The test plays the browser: it requests the callback address the
// opened page names. Skipped on Windows (the fake is a script run by its #! line). Nothing real is run.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  authorizationPage,
  McpSignIn,
  parseClaudeServerStatus,
  parseCodexServers,
  parseLoginSupport,
  signInFailure,
} from '#dist/electron/handlers/ai/mcpSignIn.js';
import { signInServers } from '#dist/electron/handlers/ai/aiHandlers.js';
import { checkDesignFence, lowerDesignFence, raiseDesignFence } from '#dist/electron/lib/designMode/designFence.js';
import { parseMcpAuthPush, parseMcpAuthReply, parseMcpAuthRequest, type McpAuthEntry, type McpAuthNotice } from '#dist/shared/properties/mcp.js';
import { waitFor } from '../../../helpers/waitFor.js';

const posix = { skip: process.platform === 'win32' ? 'the fake CLI is a script run by its #! line' : false };

const FAKE_CLI = `
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const name = path.basename(process.argv[1]);
const home = process.env.FAKE_CONFIG_DIR;
const mode = (flag) => fs.existsSync(path.join(home, 'mode-' + flag));
let args = process.argv.slice(2);
let approved = [];
let flags;
if (args[0] === '--settings') {
  flags = JSON.parse(args[1]);
  approved = flags.enabledMcpjsonServers ?? [];
  args = args.slice(2);
}
// Every Claude command of the panel switches other billing routes off and starts with no key.
if (name === 'claude') {
  if (process.env.ANTHROPIC_API_KEY !== undefined) { process.stderr.write('a key reached claude'); process.exit(70); }
  if (flags?.apiKeyHelper !== '' || flags?.env?.ANTHROPIC_API_KEY !== '') { process.stderr.write('claude without the no-key settings'); process.exit(71); }
}
fs.appendFileSync(path.join(home, 'calls'), name + ' ' + process.argv.slice(2).join(' ') + ' @' + process.cwd() + '\\n');
const [, verb, server] = args;
const token = path.join(home, name + '-token-' + server);
const say = (text) => process.stdout.write(text + '\\n');
const fail = (text, code = 1) => { process.stderr.write(text + '\\n'); process.exit(code); };
if (verb === 'login' && server === '--help') {
  if (mode('old')) { say('Usage: ' + name + ' mcp [options] [command]'); process.exit(0); }
  say('Usage: ' + name + ' mcp login [options] <name>\\n' + (mode('no-flag') ? '' : '  --no-browser  Print the URL'));
  process.exit(0);
}
if (name === 'claude' && ['get', 'login', 'logout'].includes(verb) && !approved.includes(server)) {
  fail('"' + server + '" is from .mcp.json and awaiting approval. Run \`claude\` in this directory to review it first.');
}
if (verb === 'get') {
  say(server + ':\\n  URL: https://mcp.fake.example/mcp\\n  Headers: X-Team: secret-header-value');
  say('  Status: ' + (fs.existsSync(token) ? '\\u2714 Connected' : '! Needs authentication'));
  process.exit(0);
}
if (verb === 'list') {
  const entry = (n) => ({ name: n, transport: { type: 'streamable_http', http_headers: { 'X-Team': 'secret-header-value' } },
    auth_status: fs.existsSync(path.join(home, 'codex-token-' + n)) ? 'o_auth' : 'not_logged_in' });
  say(JSON.stringify([entry('figma'), { name: 'local', transport: { type: 'stdio' }, auth_status: 'unsupported' },
    { name: 'keyed', transport: { type: 'streamable_http' }, auth_status: 'bearer_token' }]));
  process.exit(0);
}
if (verb === 'logout') {
  fs.rmSync(token, { force: true });
  say('Removed OAuth credentials');
  process.exit(0);
}
if (verb === 'login') {
  if (name === 'claude' && !process.stdin.isTTY) fail("Couldn't complete authentication: this isn't an interactive terminal.");
  if (mode('refuses')) fail('"' + server + '" does not support OAuth');
  const listener = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.searchParams.get('state') !== 'fake-state') { response.writeHead(400); response.end(); return; }
    response.end('You can close this tab.');
    if (url.searchParams.get('error')) fail("Couldn't complete authentication: access_denied");
    fs.writeFileSync(token, 'token-for-' + url.searchParams.get('code'));
    say('Authenticated with "' + server + '".');
    listener.close(() => process.exit(0));
  });
  listener.listen(0, '127.0.0.1', () => {
    const callback = 'http://127.0.0.1:' + listener.address().port + '/callback';
    const scheme = mode('plain-http') ? 'http' : 'https';
    const page = scheme + '://auth.fake.example/authorize?state=fake-state&redirect_uri=' + encodeURIComponent(callback);
    const intro = name === 'claude' ? 'Visit this URL to authorize:' : 'Authorize the MCP server by opening this URL in your browser:';
    // A linked address, as a terminal gets it, cut in the middle of the line as output can be.
    const linked = '\\u001b]8;;' + page + '\\u0007' + page + '\\u001b]8;;\\u0007';
    if (mode('no-flag')) fs.writeFileSync(path.join(home, 'own-page'), page);
    process.stdout.write('Starting authentication\\n' + intro + '\\n  ' + linked.slice(0, 60));
    setTimeout(() => process.stdout.write(linked.slice(60) + '\\n\\nWaiting for authorization\\n'), 30);
  });
  return;
}
fail('unknown command');
`;

type Told = { readonly entry: McpAuthEntry; readonly notice: McpAuthNotice | undefined };

function world(context: { after: (run: () => void) => void }) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-mcp-sign-in-')));
  context.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = path.join(home, 'project');
  const config = path.join(home, 'config');
  fs.mkdirSync(project);
  fs.mkdirSync(config);
  fs.writeFileSync(
    path.join(project, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        figma: { type: 'http', url: 'https://mcp.fake.example/mcp' },
        token: { type: 'http', url: 'https://mcp.fake.example/mcp', headers: { authorization: 'Bearer ${TOKEN}' } },
        local: { command: 'run-me', args: [] },
      },
    }),
  );
  const clis = { claude: path.join(home, 'claude'), codex: path.join(home, 'codex') };
  for (const file of Object.values(clis)) {
    fs.writeFileSync(file, `#!${process.execPath}\n${FAKE_CLI}`, { mode: 0o755 });
  }
  const told: Told[] = [];
  const opened: string[] = [];
  const lines: string[] = [];
  const changed: string[] = [];
  let trusted = true;
  const make = (extra: { readonly signInMs?: number; readonly codex?: 'absent' } = {}) => {
    const service = new McpSignIn({
      findCli: (agent) => (agent === 'codex' && extra.codex === 'absent' ? undefined : clis[agent]),
      environment: async () => ({ HOME: home, PATH: '/usr/bin:/bin', FAKE_CONFIG_DIR: config, ANTHROPIC_API_KEY: 'sk-ant-fake-for-this-test' }),
      projectServers: signInServers,
      trusted: () => trusted,
      openExternal: (url) => opened.push(url),
      publish: (_root, entry, notice) => told.push({ entry, notice }),
      changed: (agent) => changed.push(agent),
      log: (line) => lines.push(line),
      ...(extra.signInMs === undefined ? {} : { signInMs: extra.signInMs }),
    });
    context.after(() => service.stopAll());
    return service;
  };
  const mode = (flag: string) => fs.writeFileSync(path.join(config, `mode-${flag}`), '');
  const calls = () => (fs.existsSync(path.join(config, 'calls')) ? fs.readFileSync(path.join(config, 'calls'), 'utf8').trim().split('\n') : []);
  /** The person's browser: opens the page, allows (or refuses) and is sent to the callback on this computer. */
  const browse = async (answer: 'code=fake-code' | 'error=access_denied') => {
    await waitFor({ what: 'the sign-in page', read: () => opened.length, until: (count: number) => count > 0 });
    const page = new URL(opened.at(-1) ?? '');
    const callback = page.searchParams.get('redirect_uri') ?? '';
    assert.match(callback, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    await fetch(`${callback}?state=${page.searchParams.get('state')}&${answer}`);
  };
  const ended = (notice: McpAuthNotice) => waitFor({ what: `the ${notice} notice`, read: () => told.some((item) => item.notice === notice), until: Boolean });
  const untrust = () => {
    trusted = false;
  };
  return { home, project, config, told, opened, lines, changed, make, mode, calls, browse, ended, untrust };
}

const claude = (kind: 'check' | 'signIn' | 'reopen' | 'cancel' | 'signOut', name = 'figma') => ({ kind, agent: 'claude' as const, name });

test('only a remote server without its own token has a sign-in; commands and token servers show none', posix, async (context) => {
  const it = world(context);
  assert.deepEqual(signInServers(it.project), [
    { name: 'figma', kind: 'oauth-capable' },
    { name: 'token', kind: 'other' },
    { name: 'local', kind: 'other' },
  ]);
  const service = it.make();
  const listed = await service.act(it.project, { kind: 'list', freshness: 'fresh' });
  assert.deepEqual(
    listed.servers,
    [
      { agent: 'claude', name: 'figma', state: 'needs-sign-in' },
      { agent: 'codex', name: 'figma', state: 'needs-sign-in' },
      { agent: 'codex', name: 'local', state: 'none' },
      { agent: 'codex', name: 'keyed', state: 'none' },
    ].filter((entry) => entry.name !== 'local'),
  );
  assert.equal(
    it.calls().some((line) => / get (token|local)/.test(line)),
    false,
    'neither is contacted, and no command is run',
  );
  assert.ok(
    it.calls().every((line) => line.endsWith(`@${it.project}`)),
    'every command runs in the project',
  );
  assert.deepEqual((await service.act(it.project, claude('signIn', 'token'))).notice, 'not-needed');
  assert.doesNotMatch(JSON.stringify(listed) + it.lines.join('\n'), /secret-header-value/);
});

test('Claude: sign in through the browser, connected without a restart, kept across a restart, then signed out', posix, async (context) => {
  const it = world(context);
  const service = it.make();
  const started = await service.act(it.project, claude('signIn'));
  assert.deepEqual(started, { servers: [{ agent: 'claude', name: 'figma', state: 'signing-in' }], notice: undefined });
  // A second press while one waits starts nothing more.
  assert.equal((await service.act(it.project, claude('signIn'))).servers[0]?.state, 'signing-in');
  await it.browse('code=fake-code');
  await it.ended('signed-in');
  assert.deepEqual(it.told.at(-1), { entry: { agent: 'claude', name: 'figma', state: 'connected' }, notice: 'signed-in' });
  assert.deepEqual(it.changed, ['claude'], 'idle agent sessions start again');
  assert.equal(it.opened.length, 1, 'the page opens once, whole');
  assert.equal(it.calls().filter((line) => / login figma --no-browser/.test(line)).length, 1);
  assert.ok(fs.existsSync(path.join(it.config, 'claude-token-figma')), 'stored by the CLI, in the folder its sessions read');
  assert.ok(it.calls().every((line) => !line.includes('enabledMcpjsonServers') || line.includes('"enabledMcpjsonServers":["figma"],')));
  assert.equal(fs.existsSync(path.join(it.project, '.claude')), false, 'no approval is written anywhere');
  const outside = JSON.stringify(it.told) + it.lines.join('\n');
  assert.doesNotMatch(outside, /auth\.fake\.example|fake-state|fake-code|redirect_uri|token-for/);
  const restarted = it.make();
  assert.equal((await restarted.act(it.project, claude('check'))).servers[0]?.state, 'connected');
  const out = await restarted.act(it.project, claude('signOut'));
  assert.deepEqual(out, { servers: [{ agent: 'claude', name: 'figma', state: 'needs-sign-in' }], notice: 'signed-out' });
});

test('Codex: its own login, status from its JSON list, in either way its CLI opens the page', posix, async (context) => {
  const it = world(context);
  const service = it.make();
  await service.act(it.project, { kind: 'signIn', agent: 'codex', name: 'figma' });
  await it.browse('code=fake-code');
  await it.ended('signed-in');
  assert.deepEqual(it.told.at(-1)?.entry, { agent: 'codex', name: 'figma', state: 'connected' });
  assert.ok(
    it.calls().some((line) => line.startsWith('codex mcp login figma --no-browser')),
    'no Claude approval for Codex',
  );
});

test('a CLI without --no-browser opens the page itself: Stacki opens nothing', posix, async (context) => {
  const it = world(context);
  it.mode('no-flag');
  const service = it.make();
  await service.act(it.project, claude('signIn'));
  // The fake plays the CLI opening the browser itself: it notes the page, and the test is that browser.
  const noted = path.join(it.config, 'own-page');
  await waitFor({ what: 'the page the CLI opened', read: () => fs.existsSync(noted), until: Boolean });
  const page = new URL(fs.readFileSync(noted, 'utf8'));
  await fetch(`${page.searchParams.get('redirect_uri')}?state=fake-state&code=fake-code`);
  await it.ended('signed-in');
  assert.deepEqual(it.opened, [], 'the whole sign-in ran and Stacki opened nothing');
});

test('cancel, a refusal in the browser, a time limit and a plain-http page each end with a notice and can be retried', posix, async (context) => {
  const it = world(context);
  const service = it.make();
  await service.act(it.project, claude('signIn'));
  await waitFor({ what: 'the page', read: () => it.opened.length === 1, until: Boolean });
  await service.act(it.project, claude('reopen'));
  assert.equal(it.opened.length, 2, '"open again" reopens the same page from main');
  assert.equal(it.opened[0], it.opened[1]);
  const cancelled = await service.act(it.project, claude('cancel'));
  assert.deepEqual(cancelled, { servers: [{ agent: 'claude', name: 'figma', state: 'needs-sign-in' }], notice: 'cancelled' });
  const callback = new URL(it.opened[0] ?? '').searchParams.get('redirect_uri') ?? '';
  await waitFor({
    what: 'the cancelled program to stop listening',
    read: () =>
      fetch(callback).then(
        () => 'listening',
        () => 'closed',
      ),
    until: (state: string) => state === 'closed',
  });
  await service.act(it.project, claude('signIn'));
  await waitFor({ what: 'the page again', read: () => it.opened.length === 3, until: Boolean });
  await it.browse('error=access_denied');
  await it.ended('failed');
  assert.equal(it.told.at(-1)?.entry.state, 'needs-sign-in');

  const hurried = it.make({ signInMs: 600 });
  await hurried.act(it.project, claude('signIn'));
  await it.ended('timed-out');

  it.mode('plain-http');
  const before = it.opened.length;
  await it.make().act(it.project, claude('signIn'));
  await it.ended('unsafe-page');
  assert.equal(it.opened.length, before, 'an insecure page is never opened');
});

test('an older CLI is told apart before anything is started; a server that takes no sign-in shows none', posix, async (context) => {
  const it = world(context);
  it.mode('old');
  const service = it.make({ codex: 'absent' });
  assert.deepEqual(await service.act(it.project, claude('signIn')), {
    servers: [{ agent: 'claude', name: 'figma', state: 'unsupported-cli' }],
    notice: 'unsupported-cli',
  });
  assert.equal(it.opened.length, 0);
  fs.rmSync(path.join(it.config, 'mode-old'));
  it.mode('refuses');
  await it.make({ codex: 'absent' }).act(it.project, claude('signIn'));
  await it.ended('not-needed');
  assert.equal(it.told.at(-1)?.entry.state, 'none');
});

test('before the project is allowed, no Claude server is contacted until the person asks', posix, async (context) => {
  const it = world(context);
  it.untrust();
  const service = it.make({ codex: 'absent' });
  const listed = await service.act(it.project, { kind: 'list', freshness: 'fresh' });
  assert.deepEqual(listed.servers, [{ agent: 'claude', name: 'figma', state: 'not-checked' }]);
  assert.deepEqual(it.calls(), []);
  assert.equal((await service.act(it.project, claude('check'))).servers[0]?.state, 'needs-sign-in');
});

test('the readers and boundaries: statuses, pages, help, failures and what the window may ask', () => {
  assert.equal(parseClaudeServerStatus('figma:\n  Status: ✔ Connected\n'), 'connected');
  assert.equal(parseClaudeServerStatus('  Status: ! Connected · tools fetch failed'), 'connected');
  assert.equal(parseClaudeServerStatus('  Status: ! Needs authentication'), 'needs-sign-in');
  assert.equal(parseClaudeServerStatus('  Status: ✘ Failed to connect'), 'unknown');
  assert.equal(parseClaudeServerStatus('  Status: ⏸ Pending approval (run `claude` to approve)'), 'blocked');
  assert.equal(parseClaudeServerStatus('  Headers: X-Note: Needs authentication'), 'unknown');
  assert.equal(parseCodexServers('not json'), undefined);
  assert.equal(parseCodexServers('[{"name":"a","transport":{"type":"streamable_http"}}]')?.get('a'), 'unsupported-cli');
  assert.equal(parseCodexServers('[{"name":"--help","transport":{"type":"streamable_http"}}]')?.size, 0);
  assert.equal(parseLoginSupport(0, 'Usage: claude mcp [options] [command]'), 'none');
  assert.equal(parseLoginSupport(1, "error: unknown command 'login'"), 'none');
  assert.equal(parseLoginSupport(0, 'Usage: claude mcp login [options] <name>\n  --no-browser'), 'prints-page');
  assert.deepEqual(authorizationPage('Visit this URL to authorize:\n  https://a.example/x'), { kind: 'none' }, 'not until the line is whole');
  assert.deepEqual(authorizationPage('Visit this URL to authorize:\n  https://a.example/x\n'), { kind: 'page', url: 'https://a.example/x' });
  for (const unsafe of ['http://a.example/x', 'file:///etc/passwd', 'https://user:pw@a.example/x', 'javascript:alert(1)']) {
    assert.deepEqual(authorizationPage(`Visit this URL to authorize:\n  ${unsafe}\n`), { kind: 'unsafe' }, unsafe);
  }
  assert.deepEqual(authorizationPage('See https://elsewhere.example/x\n'), { kind: 'none' }, 'only the page the CLI announces');
  assert.deepEqual(signInFailure('Authentication timeout'), { state: 'needs-sign-in', notice: 'timed-out' });
  assert.deepEqual(signInFailure('"x" is from .mcp.json and was rejected.'), { state: 'blocked', notice: 'blocked' });
  assert.deepEqual(parseMcpAuthRequest({ kind: 'signIn', agent: 'claude', name: 'figma' }), claude('signIn'));
  for (const bad of [
    { kind: 'signIn', agent: 'claude', name: '--settings' },
    { kind: 'signIn', agent: 'claude', name: 'a b' },
    { kind: 'signIn', agent: 'other', name: 'figma' },
    { kind: 'run', agent: 'claude', name: 'figma' },
    { kind: 'list', freshness: 'always' },
  ]) {
    assert.throws(() => parseMcpAuthRequest(bad), JSON.stringify(bad));
  }
  assert.throws(() => parseMcpAuthReply({ servers: [{ agent: 'claude', name: 'figma', state: 'https://a.example' }] }), /state/);
  assert.throws(() => parseMcpAuthPush({ projectPath: '/p', entry: { agent: 'claude', name: 'figma', state: 'none' }, notice: 'code=1' }), /notice/);
});

test('Design mode refuses the sign-in channel', (context) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-mcp-fence-')));
  context.after(() => fs.rmSync(base, { recursive: true, force: true }));
  for (const folder of ['sandbox', 'real', 'appdata']) {
    fs.mkdirSync(path.join(base, folder));
  }
  raiseDesignFence({
    sandboxRoot: path.join(base, 'sandbox'),
    realRoot: path.join(base, 'real'),
    refusal: 'Design mode',
    appDataRoot: path.join(base, 'appdata'),
  });
  context.after(() => lowerDesignFence());
  assert.throws(() => checkDesignFence('ai:mcpAuth', { projectPath: path.join(base, 'sandbox') }), /Design mode/);
});
