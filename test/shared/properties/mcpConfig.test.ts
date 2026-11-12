// Goal: the MCP server model reads only what Claude Code and Codex can use, bounds everything, never
// puts a literal value into a summary, and suggests names from addresses and packages sensibly.
// Method: parse known-good servers and push each invalid shape through the boundary parser; summarize
// servers that hold literal secrets and search the result for them; check the reference helpers and the
// name suggestions on a table; exercise every bound at, and one past, its limit.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MCP_LIMITS,
  isMcpReference,
  isMcpServerName,
  isMcpUrl,
  mcpConfigFromFileEntry,
  mcpConfigPlaceholders,
  mcpFileFields,
  mcpPlaceholders,
  mcpRequiredSecrets,
  parseMcpServerConfig,
  redactMcpConfig,
  suggestMcpServerName,
  summarizeMcpServer,
  type McpServerConfig,
} from '#dist/shared/properties/mcpConfig.js';

const SECRET = 'sk-live-do-not-show';
const REMOTE: McpServerConfig = {
  transport: 'http',
  url: `https://user:pw@mcp.example.com/path?key=${SECRET}`,
  headers: [
    { name: 'Authorization', value: 'Bearer ${TOKEN}' },
    { name: 'X-Plain', value: SECRET },
  ],
};
const COMMAND: McpServerConfig = {
  transport: 'stdio',
  command: '/Users/someone/bin/npx',
  args: ['-y', 'pkg', `--key=${SECRET}`],
  env: [{ name: 'API_KEY', value: SECRET }],
};

test('server names are 1 to 64 of letters, digits, dot, dash and underscore', () => {
  for (const good of ['a', 'Sanity', 'my.server-1_x', 'x'.repeat(MCP_LIMITS.nameCharsMax)]) {
    assert.equal(isMcpServerName(good), true, good);
  }
  for (const bad of ['', 'a b', 'a/b', 'é', 'a\nb', 'x'.repeat(MCP_LIMITS.nameCharsMax + 1)]) {
    assert.equal(isMcpServerName(bad), false, JSON.stringify(bad));
  }
});

test('the boundary parser accepts both shapes and reads pairs from arrays or objects', () => {
  const fromObject = parseMcpServerConfig({ transport: 'stdio', command: 'npx', args: ['-y'], env: { A: '1' } }, 'server');
  const fromArray = parseMcpServerConfig({ transport: 'stdio', command: 'npx', args: ['-y'], env: [{ name: 'A', value: '1' }] }, 'server');
  assert.deepEqual(fromObject, fromArray);
  assert.ok(fromObject.ok);
  assert.deepEqual(parseMcpServerConfig({ transport: 'sse', url: 'https://x.example/sse' }, 'server'), {
    ok: true,
    value: { transport: 'sse', url: 'https://x.example/sse', headers: [] },
  });
});

test('every invalid shape is refused with a code and a path, and no value', () => {
  const cases: readonly (readonly [unknown, string, string])[] = [
    [undefined, 'expected-object', 'p'],
    [[], 'expected-object', 'p'],
    [{ transport: 'ws', url: 'wss://x' }, 'unknown-transport', 'p.transport'],
    [{ transport: 'stdio' }, 'expected-string', 'p.command'],
    [{ transport: 'stdio', command: '  ' }, 'missing-target', 'p.command'],
    [{ transport: 'stdio', command: 'a\nb' }, 'control-characters', 'p.command'],
    [{ transport: 'stdio', command: 'x', args: 'no' }, 'expected-array', 'p.args'],
    [{ transport: 'stdio', command: 'x', args: [1] }, 'expected-string', 'p.args.0'],
    [{ transport: 'stdio', command: 'x', env: { 'bad name': '1' } }, 'bad-name', 'p.env.bad name'],
    [{ transport: 'stdio', command: 'x', env: { A: 1 } }, 'bad-pair', 'p.env.A'],
    [
      {
        transport: 'stdio',
        command: 'x',
        env: [
          { name: 'A', value: '1' },
          { name: 'A', value: '2' },
        ],
      },
      'duplicate-pair',
      'p.env.A',
    ],
    [{ transport: 'http', url: 'ftp://x.example' }, 'bad-url', 'p.url'],
    [{ transport: 'http', url: 'not a url' }, 'bad-url', 'p.url'],
    [{ transport: 'http', url: 1 }, 'expected-string', 'p.url'],
    [{ transport: 'http', url: 'https://x.example', headers: { 'Bad Header': 'x' } }, 'bad-name', 'p.headers.Bad Header'],
  ];
  for (const [input, code, path] of cases) {
    const result = parseMcpServerConfig(input, 'p');
    assert.ok(!result.ok, JSON.stringify(input));
    assert.deepEqual(result.error, { code, path });
  }
});

test('every bound is held at its limit and refused one past it', () => {
  const ok = (input: unknown) => parseMcpServerConfig(input, 'p').ok;
  const args = (count: number) => Array.from({ length: count }, () => 'a');
  assert.equal(ok({ transport: 'stdio', command: 'x', args: args(MCP_LIMITS.argsMax) }), true);
  assert.equal(ok({ transport: 'stdio', command: 'x', args: args(MCP_LIMITS.argsMax + 1) }), false);
  assert.equal(ok({ transport: 'stdio', command: 'x', args: ['a'.repeat(MCP_LIMITS.argCharsMax)] }), true);
  assert.equal(ok({ transport: 'stdio', command: 'x', args: ['a'.repeat(MCP_LIMITS.argCharsMax + 1)] }), false);
  const pairs = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, at) => [`V${at}`, 'x']));
  assert.equal(ok({ transport: 'stdio', command: 'x', env: pairs(MCP_LIMITS.pairsMax) }), true);
  assert.equal(ok({ transport: 'stdio', command: 'x', env: pairs(MCP_LIMITS.pairsMax + 1) }), false);
  assert.equal(isMcpUrl(`https://x.example/${'a'.repeat(MCP_LIMITS.urlCharsMax)}`), false);
});

test('a missing type reads as stdio for a command and http for a url, both together is refused', () => {
  const read = (entry: unknown) => mcpConfigFromFileEntry(entry, 'e');
  assert.deepEqual(read({ command: 'x' }), { ok: true, value: { transport: 'stdio', command: 'x', args: [], env: [] } });
  assert.deepEqual(read({ url: 'https://x.example' }), { ok: true, value: { transport: 'http', url: 'https://x.example', headers: [] } });
  assert.deepEqual(read({ type: 'streamable-http', url: 'https://x.example' }), {
    ok: true,
    value: { transport: 'http', url: 'https://x.example', headers: [] },
  });
  assert.deepEqual(read({ command: 'x', url: 'https://x.example' }), { ok: false, error: { code: 'both-targets', path: 'e' } });
  assert.deepEqual(read({}), { ok: false, error: { code: 'missing-target', path: 'e' } });
  assert.deepEqual(read({ type: 7, command: 'x' }), { ok: false, error: { code: 'expected-string', path: 'e.type' } });
});

test('references are found with and without defaults; required ones exclude defaults', () => {
  assert.deepEqual(mcpPlaceholders('a ${ONE} b ${TWO:-x} ${ONE}'), ['ONE', 'TWO']);
  assert.deepEqual(mcpConfigPlaceholders({ transport: 'stdio', command: 'x', args: ['${A}', '${B:-d}'], env: [{ name: 'K', value: '${C}' }] }), [
    'A',
    'B',
    'C',
  ]);
  assert.deepEqual(mcpRequiredSecrets({ transport: 'stdio', command: 'x', args: ['${A}', '${B:-d}'], env: [{ name: 'K', value: '${C}' }] }), ['A', 'C']);
  assert.equal(isMcpReference('${KEY}'), true);
  assert.equal(isMcpReference('${KEY:-x}'), true);
  assert.equal(isMcpReference('Bearer ${KEY}'), false);
  assert.equal(isMcpReference('plain'), false);
  assert.deepEqual(mcpPlaceholders('$NOT_A_REFERENCE ${1BAD} ${}'), []);
});

test('a summary shows the host and the program only, and hides every literal value', () => {
  const remote = summarizeMcpServer(REMOTE);
  const command = summarizeMcpServer(COMMAND);
  assert.equal(remote.transport === 'http' && remote.host, 'mcp.example.com');
  assert.equal(command.transport === 'stdio' && command.command, 'npx');
  assert.ok(remote.transport !== 'stdio');
  assert.deepEqual(remote.headers, [
    { name: 'Authorization', reference: 'Bearer ${TOKEN}' },
    { name: 'X-Plain', reference: undefined },
  ]);
  for (const summary of [remote, command]) {
    assert.ok(!JSON.stringify(summary).includes(SECRET), JSON.stringify(summary));
    assert.ok(!JSON.stringify(summary).includes('pw@'));
  }
  assert.deepEqual(remote.secretNames, ['TOKEN']);
});

test('a redacted copy keeps references and replaces literals', () => {
  const redacted = redactMcpConfig(REMOTE);
  assert.ok(redacted.transport !== 'stdio');
  assert.deepEqual(redacted.headers, [
    { name: 'Authorization', value: 'Bearer ${TOKEN}' },
    { name: 'X-Plain', value: '***' },
  ]);
  const env = redactMcpConfig(COMMAND);
  assert.ok(env.transport === 'stdio');
  assert.deepEqual(env.env, [{ name: 'API_KEY', value: '***' }]);
});

test('file fields follow the order Claude Code writes and omit empty pairs', () => {
  assert.deepEqual(Object.keys(mcpFileFields({ transport: 'stdio', command: 'x', args: [], env: [] })), ['type', 'command', 'args']);
  assert.deepEqual(Object.keys(mcpFileFields({ transport: 'sse', url: 'https://x.example', headers: [{ name: 'A', value: 'b' }] })), [
    'type',
    'url',
    'headers',
  ]);
});

test('names are suggested from the address or the package', () => {
  const remote = (url: string): McpServerConfig => ({ transport: 'http', url, headers: [] });
  const stdio = (args: string[]): McpServerConfig => ({ transport: 'stdio', command: 'npx', args, env: [] });
  assert.equal(suggestMcpServerName(remote('https://mcp.sanity.io')), 'sanity');
  assert.equal(suggestMcpServerName(remote('https://api.githubcopilot.com/mcp/')), 'githubcopilot');
  assert.equal(suggestMcpServerName(stdio(['-y', '@modelcontextprotocol/server-github'])), 'github');
  assert.equal(suggestMcpServerName(stdio(['-y', 'airtable-mcp-server@1.2.3'])), 'airtable');
  assert.equal(suggestMcpServerName(stdio(['-y', '@playwright/mcp@latest'])) === undefined, false);
});
