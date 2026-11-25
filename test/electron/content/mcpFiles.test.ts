// Goal: the main-process half of the MCP tab reads and writes the project's `.mcp.json` and the person's
// Codex file safely: a missing file is the ordinary empty state; every change is written atomically against
// the revision it was authored on and refused with `changed` when the file moved; unknown fields and other
// servers survive; Codex's file is reached only through the home folder it is given, changes only the one
// table, keeps its mode and leaves no temporary file; no failure text or listing holds a secret.
// Method: run the real functions over temporary project and home directories, set files up by hand, change
// them behind the module's back, and read the bytes back. The handlers are run over a fake host.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { digestOf } from '#dist/electron/documents/atomicWrite.js';
import {
  applyCodexChange,
  applyMcpChange,
  codexConfigPath,
  readCodexState,
  readMcpListing,
  readMcpText,
  revealCodexServer,
  revealMcpServer,
  saveMcpText,
} from '#dist/electron/content/mcpFiles.js';
import { registerMcpHandlers } from '#dist/electron/handlers/mcpHandlers.js';
import { MCP_LIMITS, type McpServerConfig } from '#dist/shared/properties/mcpConfig.js';

const SECRET = 'sk-never-in-a-listing-or-an-error';
const SANITY: McpServerConfig = { transport: 'http', url: 'https://mcp.sanity.io', headers: [] };
const LOCAL: McpServerConfig = { transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: [{ name: 'API_KEY', value: '${API_KEY}' }] };

function temporary(prefix: string): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

function project(file?: string): string {
  const root = temporary('stacki-mcp-project-');
  if (file !== undefined) {
    fs.writeFileSync(path.join(root, '.mcp.json'), file);
  }
  return root;
}

function home(codex?: string): string {
  const root = temporary('stacki-mcp-home-');
  if (codex !== undefined) {
    fs.mkdirSync(path.join(root, '.codex'));
    fs.writeFileSync(path.join(root, '.codex', 'config.toml'), codex, { mode: 0o600 });
  }
  return root;
}

function listing(root: string) {
  const result = readMcpListing(root);
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}

const textOf = (root: string): string => fs.readFileSync(path.join(root, '.mcp.json'), 'utf8');

test('a project with no .mcp.json is an empty list, not an error', () => {
  const root = project();
  const result = listing(root);
  assert.equal(result.exists, false);
  assert.deepEqual(result.servers, []);
  assert.equal(result.revision, digestOf(''));
  const text = readMcpText(root);
  assert.ok(text.ok);
  assert.deepEqual([text.value.exists, text.value.text], [false, '']);
});

test('adding creates the file, and the listing shows a summary and never a value', () => {
  const root = project();
  const first = listing(root);
  const added = applyMcpChange(root, first.revision, { kind: 'add', name: 'local', config: { ...LOCAL, env: [{ name: 'API_KEY', value: SECRET }] } });
  assert.ok(added.ok, JSON.stringify(added));
  assert.equal(added.value.exists, true);
  assert.ok(!JSON.stringify(added.value).includes(SECRET));
  assert.ok(textOf(root).includes(SECRET), 'the file itself holds what the person wrote');
  const next = applyMcpChange(root, added.value.revision, { kind: 'remove', name: 'local' });
  assert.ok(next.ok);
  assert.deepEqual(fs.readdirSync(path.join(root, '.stacki', 'io')), [], 'no temporary file is left behind');
});

test('a change authored against an old revision is refused and the file is untouched', () => {
  const root = project('{"mcpServers":{"a":{"command":"x"}}}');
  const seen = listing(root);
  const outside = '{"mcpServers":{"a":{"command":"y"}}}\n';
  fs.writeFileSync(path.join(root, '.mcp.json'), outside);
  for (const change of [
    { kind: 'add', name: 'b', config: SANITY },
    { kind: 'update', name: 'a', config: SANITY },
    { kind: 'remove', name: 'a' },
  ] as const) {
    const result = applyMcpChange(root, seen.revision, change);
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'changed');
  }
  assert.equal(textOf(root), outside);
  assert.equal(revealMcpServer(root, seen.revision, 'a').ok, false);
  assert.equal(saveMcpText(root, seen.revision, '{}').ok, false);
});

test('add refuses a taken name, update and remove refuse a missing one, and names are validated', () => {
  const root = project('{"mcpServers":{"a":{"command":"x"}}}');
  const { revision } = listing(root);
  const code = (change: Parameters<typeof applyMcpChange>[2]) => {
    const result = applyMcpChange(root, revision, change);
    assert.ok(!result.ok);
    return result.error.code;
  };
  assert.equal(code({ kind: 'add', name: 'a', config: SANITY }), 'name-taken');
  assert.equal(code({ kind: 'update', name: 'b', config: SANITY }), 'not-found');
  assert.equal(code({ kind: 'remove', name: 'b' }), 'not-found');
  assert.equal(code({ kind: 'add', name: 'bad name', config: SANITY }), 'invalid-name');
});

test('update and remove touch only their entry; unknown fields and other servers keep their bytes', () => {
  const original =
    '{\n  "x": 1,\n  "mcpServers": {\n    "a": { "command": "keep",  "weird": [1,   2] },\n    "b": { "type": "http", "url": "https://old.example", "timeout": 5 }\n  }\n}\n';
  const root = project(original);
  const first = listing(root);
  const updated = applyMcpChange(root, first.revision, { kind: 'update', name: 'b', config: { transport: 'http', url: 'https://new.example', headers: [] } });
  assert.ok(updated.ok);
  assert.equal(textOf(root), original.replace('https://old.example', 'https://new.example'));
  const removed = applyMcpChange(root, updated.value.revision, { kind: 'remove', name: 'b' });
  assert.ok(removed.ok);
  assert.equal(textOf(root), '{\n  "x": 1,\n  "mcpServers": {\n    "a": { "command": "keep",  "weird": [1,   2] }\n  }\n}\n');
});

test('a reveal returns the values of one server, for the revision it names', () => {
  const root = project(`{"mcpServers":{"a":{"command":"x","env":{"K":"${SECRET}"}}}}`);
  const { revision } = listing(root);
  const revealed = revealMcpServer(root, revision, 'a');
  assert.ok(revealed.ok);
  assert.deepEqual(revealed.value, { transport: 'stdio', command: 'x', args: [], env: [{ name: 'K', value: SECRET }] });
  const missing = revealMcpServer(root, revision, 'nope');
  assert.ok(!missing.ok);
  assert.equal(missing.error.code, 'not-found');
});

test('saving text checks it again in main: invalid text, oversize text and a changed file are refused', () => {
  const root = project('{"mcpServers":{}}');
  const { revision } = listing(root);
  for (const bad of ['{', '{"mcpServers":{"bad name":{"command":"x"}}}', '{"mcpServers":{"a":{"url":"ftp://x"}}}']) {
    const result = saveMcpText(root, revision, bad);
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'invalid');
  }
  const big = saveMcpText(root, revision, `{"pad":"${'x'.repeat(MCP_LIMITS.fileBytesMax)}"}`);
  assert.ok(!big.ok);
  assert.equal(big.error.code, 'too-large');
  assert.equal(textOf(root), '{"mcpServers":{}}');
  const good = '{\n    "mcpServers": { "a": { "command": "x" } }\n}';
  const saved = saveMcpText(root, revision, good);
  assert.ok(saved.ok);
  assert.equal(textOf(root), good);
  assert.deepEqual(
    saved.value.servers.map((server) => server.name),
    ['a'],
  );
});

test('a file that cannot be read is named by category and holds no content in its message', () => {
  const broken = project(`{"mcpServers": {"a": "${SECRET}"`);
  const result = readMcpListing(broken);
  assert.ok(!result.ok);
  assert.equal(result.error.code, 'unreadable');
  assert.ok(!JSON.stringify(result).includes(SECRET));
  const binary = project();
  fs.writeFileSync(path.join(binary, '.mcp.json'), Buffer.from([0xff, 0xfe, 0x00, 0x7b]));
  const notText = readMcpListing(binary);
  assert.ok(!notText.ok);
  assert.equal(notText.error.code, 'not-text');
  const huge = project();
  fs.writeFileSync(path.join(huge, '.mcp.json'), 'x'.repeat(MCP_LIMITS.fileBytesMax + 1));
  const tooLarge = readMcpListing(huge);
  assert.ok(!tooLarge.ok);
  assert.equal(tooLarge.error.code, 'too-large');
  const directory = project();
  fs.mkdirSync(path.join(directory, '.mcp.json'));
  const notFile = readMcpListing(directory);
  assert.ok(!notFile.ok);
  assert.equal(notFile.error.code, 'unreadable');
  assert.equal(readMcpText(broken).ok, true, 'the JSON view can still open a file that is not valid');
});

test('a malformed entry is listed as invalid, not dropped, and its file is not rewritten around it', () => {
  const root = project('{"mcpServers":{"bad":{"type":"ws","url":"wss://x"},"ok":{"command":"x"}}}');
  const first = listing(root);
  assert.deepEqual(
    first.servers.map((server) => [server.name, server.status]),
    [
      ['bad', 'invalid'],
      ['ok', 'server'],
    ],
  );
  const added = applyMcpChange(root, first.revision, { kind: 'add', name: 'c', config: SANITY });
  assert.ok(added.ok);
  assert.ok(textOf(root).startsWith('{"mcpServers":{"bad":{"type":"ws","url":"wss://x"},"ok":{"command":"x"}'));
});

// ---- Codex ----

const CODEX = `# My Codex settings
model = "gpt-5"

[projects."/Users/me/My Site"]
trust_level = "trusted"

[mcp_servers.node_repl]
command = "node"
args = [
  "a",
  "b",
]

[mcp_servers.node_repl.env]
NODE_PATH = "${SECRET}"

[features]
x = true
`;

test('Codex: a computer without the file is the ordinary missing state, and nothing is created', () => {
  const folder = home();
  assert.deepEqual(readCodexState(folder), { state: 'missing' });
  assert.equal(fs.existsSync(path.join(folder, '.codex')), false);
  const root = project('{"mcpServers":{"a":{"command":"x"}}}');
  const result = applyCodexChange(folder, root, digestOf(''), listing(root).revision, { kind: 'put', name: 'a' });
  assert.ok(!result.ok);
  assert.equal(result.error.code, 'codex-unavailable');
  assert.equal(fs.existsSync(path.join(folder, '.codex')), false);
});

test('Codex: the path is fixed under the given home folder', () => {
  const folder = home(CODEX);
  assert.equal(codexConfigPath(folder), path.join(folder, '.codex', 'config.toml'));
  assert.throws(() => codexConfigPath('relative/home'));
});

test('Codex: servers are listed as summaries, with no value, and unreadable files are named by category', () => {
  const state = readCodexState(home(CODEX));
  assert.equal(state.state, 'ready');
  assert.ok(state.state === 'ready');
  assert.deepEqual(
    state.servers.map((server) => [server.name, server.status]),
    [['node_repl', 'server']],
  );
  assert.ok(!JSON.stringify(state).includes(SECRET));
  assert.deepEqual(readCodexState(home('mcp_servers = { a = { command = "x" } }\n')), { state: 'unavailable', code: 'codex-unsupported' });
  assert.deepEqual(readCodexState(home('a = "unterminated\n')), { state: 'unavailable', code: 'codex-unsupported' });
  const binary = home();
  fs.mkdirSync(path.join(binary, '.codex'));
  fs.writeFileSync(path.join(binary, '.codex', 'config.toml'), Buffer.from([0xff, 0xfe]));
  assert.deepEqual(readCodexState(binary), { state: 'unavailable', code: 'not-text' });
});

test('Codex: putting a project server writes only its table, keeps the mode, and leaves no temporary file', () => {
  const folder = home(CODEX);
  const root = project(`{"mcpServers":{"local":{"command":"npx","args":["-y","pkg"],"env":{"API_KEY":"\${API_KEY}"}}}}`);
  const state = readCodexState(folder);
  assert.ok(state.state === 'ready');
  const result = applyCodexChange(folder, root, state.revision, listing(root).revision, { kind: 'put', name: 'local' });
  assert.ok(result.ok, JSON.stringify(result));
  const after = fs.readFileSync(codexConfigPath(folder), 'utf8');
  assert.ok(after.startsWith(CODEX), 'every byte of the old file is kept');
  assert.ok(after.slice(CODEX.length).includes('[mcp_servers.local]'));
  assert.ok(result.value.state === 'ready' && result.value.servers.some((server) => server.name === 'local'));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(codexConfigPath(folder)).mode & 0o777, 0o600);
  }
  assert.deepEqual(fs.readdirSync(path.join(folder, '.codex')), ['config.toml'], 'no temporary file and no .stacki folder');
  const next = applyCodexChange(folder, root, result.value.state === 'ready' ? result.value.revision : digestOf(''), listing(root).revision, {
    kind: 'remove',
    name: 'local',
  });
  assert.ok(next.ok);
  assert.equal(fs.readFileSync(codexConfigPath(folder), 'utf8'), CODEX);
});

test('Codex: a stale Codex revision, a stale project revision, a missing server and an unmappable one are refused with nothing written', () => {
  const folder = home(CODEX);
  const root = project('{"mcpServers":{"local":{"command":"x"},"events":{"type":"sse","url":"https://x.example/sse"}}}');
  const state = readCodexState(folder);
  assert.ok(state.state === 'ready');
  const projectRevision = listing(root).revision;
  const codeOf = (revision: typeof state.revision, projectAt: typeof projectRevision, change: Parameters<typeof applyCodexChange>[4]) => {
    const result = applyCodexChange(folder, root, revision, projectAt, change);
    assert.ok(!result.ok);
    return result.error.code;
  };
  assert.equal(codeOf(digestOf('other'), projectRevision, { kind: 'put', name: 'local' }), 'changed');
  assert.equal(codeOf(state.revision, digestOf('other'), { kind: 'put', name: 'local' }), 'changed');
  assert.equal(codeOf(state.revision, projectRevision, { kind: 'put', name: 'nope' }), 'not-found');
  assert.equal(codeOf(state.revision, projectRevision, { kind: 'put', name: 'events' }), 'unmappable');
  assert.equal(codeOf(state.revision, projectRevision, { kind: 'remove', name: 'nope' }), 'not-found');
  assert.equal(fs.readFileSync(codexConfigPath(folder), 'utf8'), CODEX);
});

test('Codex: a file that changes after it was read is not overwritten', () => {
  const folder = home(CODEX);
  const root = project('{"mcpServers":{"local":{"command":"x"}}}');
  const state = readCodexState(folder);
  assert.ok(state.state === 'ready');
  const outside = `${CODEX}# edited elsewhere\n`;
  fs.writeFileSync(codexConfigPath(folder), outside);
  const result = applyCodexChange(folder, root, state.revision, listing(root).revision, { kind: 'put', name: 'local' });
  assert.ok(!result.ok);
  assert.equal(result.error.code, 'changed');
  assert.equal(fs.readFileSync(codexConfigPath(folder), 'utf8'), outside);
});

test('Codex: a server is revealed only for the revision it names, and a table Stacki cannot show is refused', () => {
  const folder = home(`${CODEX}\n[mcp_servers.odd]\nenabled = true\n`);
  const state = readCodexState(folder);
  assert.ok(state.state === 'ready');
  const revealed = revealCodexServer(folder, state.revision, 'node_repl');
  assert.ok(revealed.ok);
  assert.equal(revealed.value.transport, 'stdio');
  const stale = revealCodexServer(folder, digestOf('x'), 'node_repl');
  assert.ok(!stale.ok && stale.error.code === 'changed');
  const odd = revealCodexServer(folder, state.revision, 'odd');
  assert.ok(!odd.ok && odd.error.code === 'unmappable');
});

test('Codex: a file that is a link to a missing target, or has other links, is not written', () => {
  if (process.platform === 'win32') {
    return;
  }
  const dangling = home();
  fs.mkdirSync(path.join(dangling, '.codex'));
  fs.symlinkSync(path.join(dangling, 'missing.toml'), codexConfigPath(dangling));
  assert.equal(readCodexState(dangling).state, 'missing');
  const linked = home(CODEX);
  fs.linkSync(codexConfigPath(linked), path.join(linked, 'other.toml'));
  const root = project('{"mcpServers":{"local":{"command":"x"}}}');
  const state = readCodexState(linked);
  assert.ok(state.state === 'ready');
  const result = applyCodexChange(linked, root, state.revision, listing(root).revision, { kind: 'put', name: 'local' });
  assert.ok(!result.ok);
  assert.equal(result.error.code, 'filesystem');
  assert.equal(fs.readFileSync(codexConfigPath(linked), 'utf8'), CODEX);
});

test('the handlers read Codex from the given home only, ignore any path in the input, and check the project', async () => {
  const folder = home(CODEX);
  const root = project('{"mcpServers":{"a":{"command":"x"}}}');
  const handlers = new Map<string, (event: unknown, input: Record<string, unknown>) => unknown>();
  const checked: string[] = [];
  registerMcpHandlers(
    // eslint-disable-next-line no-restricted-syntax -- a two-member fake of the host; the real type carries Electron's whole IpcMain
    {
      ipcMain: { handle: (channel: string, handler: (event: unknown, input: Record<string, unknown>) => unknown) => void handlers.set(channel, handler) },
      assertInProject: (file: string) => void checked.push(file),
    } as never,
    () => folder,
  );
  assert.deepEqual([...handlers.keys()].sort(), [
    'mcp:apply',
    'mcp:applyCodex',
    'mcp:read',
    'mcp:readCodex',
    'mcp:readText',
    'mcp:reveal',
    'mcp:revealCodex',
    'mcp:saveText',
  ]);
  const state = await handlers.get('mcp:readCodex')?.({}, { projectPath: root, path: '/etc/passwd', codexPath: '/etc/hosts' });
  assert.deepEqual(state, readCodexState(folder));
  const read = await handlers.get('mcp:read')?.({}, { projectPath: root });
  assert.ok(typeof read === 'object' && read !== null);
  assert.equal(checked.length, 2);
  assert.ok(checked.every((file) => file === path.join(fs.realpathSync(root), 'package.json')));
});
