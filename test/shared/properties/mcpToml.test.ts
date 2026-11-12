// Goal: the Codex TOML section editor lists the `[mcp_servers.<name>]` tables of a person's own
// `config.toml`, adds, replaces and removes one server, and changes nothing else: every byte outside
// the touched tables comes back as it went in (comments, other tools' tables, line endings, the
// byte-order mark, a missing final newline). Whenever the file or the server's definition is
// something the editor would have to guess at, it refuses with a code and a line and produces no text.
// Method: fixtures built here (never a real Codex file), shaped like a real one: quoted and dotted
// headers, a server with a sub-table, multi-line arrays and strings, comments. Each test changes the
// fixture and compares whole strings or the untouched slices before and after the change; refusal
// tests also check that a secret placed in the broken file never appears in the problem.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CODEX_TOML_LIMITS, changeCodexToml, codexServerEntries, scanCodexToml, type CodexChange, type CodexProblem } from '#dist/shared/properties/mcpToml.js';
import type { McpServerConfig } from '#dist/shared/properties/mcpConfig.js';

const SECRET = 'sk-never-in-a-problem';

const REAL = [
  '# Codex settings kept by hand.',
  'model = "gpt-5"',
  'notes = """',
  '[mcp_servers.fake]',
  'command = "not a server"',
  '"""',
  'matrix = [',
  '[1, 2],',
  '[3, 4], # rows',
  ']',
  '',
  '[desktop]',
  'sound = true',
  '',
  '[plugins."documents@openai-primary-runtime"]',
  'enabled = true',
  '',
  '[mcp_servers.node_repl]',
  'args = [',
  '  "--flag",',
  '  "two", # why two',
  ']',
  'command = "/usr/bin/node"',
  'env_vars = ["HOME"]',
  'startup_timeout_sec = 30',
  '',
  '[mcp_servers.node_repl.env]',
  'NODE_PATH = "/a path/with spaces"',
  'EMPTY = ""',
  '',
  '[mcp_servers.computer-use]',
  'command = "cu"',
  'cwd = "/tmp"',
  'enabled = false',
  '',
  '[projects."/Users/someone/My Projects/site"]',
  "trust_level = 'trusted'",
  '',
].join('\n');

const stdio = (command: string, args: readonly string[] = [], env: readonly { name: string; value: string }[] = []): McpServerConfig => ({
  transport: 'stdio',
  command,
  args,
  env,
});
const remote = (url: string, headers: readonly { name: string; value: string }[] = []): McpServerConfig => ({ transport: 'http', url, headers });

function changed(text: string, change: CodexChange): string {
  const result = changeCodexToml(text, change);
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}

function refused(text: string, change: CodexChange): CodexProblem {
  const result = changeCodexToml(text, change);
  assert.ok(!result.ok);
  return result.error;
}

function scanCode(text: string): string | undefined {
  const scanned = scanCodexToml(text);
  return scanned.ok ? undefined : scanned.error.code;
}

function servers(text: string) {
  const scanned = scanCodexToml(text);
  assert.ok(scanned.ok, JSON.stringify(scanned));
  return codexServerEntries(scanned.value);
}

function serverNamed(text: string, name: string): McpServerConfig | undefined {
  const found = servers(text).find((entry) => entry.name === name);
  assert.ok(found !== undefined, `${name} is listed`);
  return found.config;
}

// The slice of `text` from the first occurrence of `from` up to (not including) `until`, or to the end.
function between(text: string, from: string, until?: string): string {
  const start = text.indexOf(from);
  assert.ok(start >= 0, `${from} is in the text`);
  const end = until === undefined ? text.length : text.indexOf(until, start + from.length);
  return text.slice(start, end);
}

test('the servers are listed with their configs, and a header inside a string or array is not a table', () => {
  assert.deepEqual(
    servers(REAL).map((entry) => entry.name),
    ['node_repl', 'computer-use'],
  );
  assert.deepEqual(
    serverNamed(REAL, 'node_repl'),
    stdio(
      '/usr/bin/node',
      ['--flag', 'two'],
      [
        { name: 'NODE_PATH', value: '/a path/with spaces' },
        { name: 'EMPTY', value: '' },
        { name: 'HOME', value: '${HOME}' },
      ],
    ),
  );
  assert.deepEqual(serverNamed(REAL, 'computer-use'), stdio('cu'));
});

test('putting back what a server already says changes no byte, for every server in the corpus', () => {
  for (const text of [REAL, REAL.replace(/\n/g, '\r\n'), '﻿' + REAL, REAL.trimEnd()]) {
    for (const entry of servers(text)) {
      assert.ok(entry.config !== undefined);
      assert.equal(changed(text, { kind: 'put', name: entry.name, config: entry.config }), text);
    }
  }
});

test('a new stdio server is appended after one blank line and nothing before it moves', () => {
  const next = changed(REAL, { kind: 'put', name: 'sanity', config: stdio('npx', ['-y', 'pkg'], [{ name: 'TOKEN', value: 'literal' }]) });
  assert.ok(next.startsWith(REAL));
  assert.equal(
    next.slice(REAL.length),
    ['', '[mcp_servers.sanity]', 'command = "npx"', 'args = ["-y", "pkg"]', '', '[mcp_servers.sanity.env]', 'TOKEN = "literal"', ''].join('\n').slice(0),
  );
  assert.deepEqual(serverNamed(next, 'sanity'), stdio('npx', ['-y', 'pkg'], [{ name: 'TOKEN', value: 'literal' }]));
});

test('a new remote server maps its headers: bearer, environment and literal', () => {
  const config = remote('https://mcp.example.com/mcp', [
    { name: 'Authorization', value: 'Bearer ${EXAMPLE_TOKEN}' },
    { name: 'X-Team', value: 'blue' },
    { name: 'X-Key', value: '${EXAMPLE_KEY}' },
  ]);
  const next = changed(REAL, { kind: 'put', name: 'example', config });
  assert.equal(
    next.slice(REAL.length),
    [
      '',
      '[mcp_servers.example]',
      'url = "https://mcp.example.com/mcp"',
      'bearer_token_env_var = "EXAMPLE_TOKEN"',
      '',
      '[mcp_servers.example.http_headers]',
      'X-Team = "blue"',
      '',
      '[mcp_servers.example.env_http_headers]',
      'X-Key = "EXAMPLE_KEY"',
      '',
    ].join('\n'),
  );
  assert.deepEqual(serverNamed(next, 'example'), config);
});

test('a name with a dot is a quoted key segment and reads back as one name', () => {
  const next = changed(REAL, { kind: 'put', name: 'my.server', config: stdio('x') });
  assert.ok(next.includes('[mcp_servers."my.server"]'));
  assert.deepEqual(serverNamed(next, 'my.server'), stdio('x'));
  assert.equal(changed(next, { kind: 'remove', name: 'my.server' }), REAL);
});

test('replacing a server rewrites only its tables and keeps its other keys and comments', () => {
  const next = changed(REAL, { kind: 'put', name: 'node_repl', config: stdio('/usr/bin/node', ['--flag', 'three'], [{ name: 'NODE_PATH', value: '/b' }]) });
  assert.equal(next.slice(0, next.indexOf('[mcp_servers.node_repl]')), REAL.slice(0, REAL.indexOf('[mcp_servers.node_repl]')));
  assert.equal(next.slice(next.indexOf('[mcp_servers.computer-use]')), REAL.slice(REAL.indexOf('[mcp_servers.computer-use]')));
  const block = between(next, '[mcp_servers.node_repl]', '[mcp_servers.computer-use]');
  assert.ok(block.includes('startup_timeout_sec = 30'));
  assert.ok(block.includes('env_vars = ["HOME"]'), 'forwarded names are only added to');
  assert.ok(block.includes('args = ["--flag", "three"]'));
  assert.ok(block.includes('NODE_PATH = "/b"'));
  assert.ok(!block.includes('EMPTY'), 'an environment value no longer wanted is dropped');
  assert.ok(!block.includes('/a path'));
});

test('adding a reference and a literal to an existing server appends keys to the right tables', () => {
  const config = stdio(
    '/usr/bin/node',
    ['--flag', 'two'],
    [
      { name: 'NODE_PATH', value: '/a path/with spaces' },
      { name: 'EMPTY', value: '' },
      { name: 'NEW_ONE', value: 'x' },
      { name: 'HOME', value: '${HOME}' },
      { name: 'SECOND', value: '${SECOND}' },
    ],
  );
  const next = changed(REAL, { kind: 'put', name: 'node_repl', config });
  const block = between(next, '[mcp_servers.node_repl]', '[mcp_servers.computer-use]');
  assert.ok(block.includes('env_vars = ["HOME", "SECOND"]'));
  assert.ok(block.includes('NEW_ONE = "x"'));
  assert.ok(block.includes('  "two", # why two'), 'the array that already said the right thing is untouched');
});

test('switching a server from a command to a URL removes the command keys and keeps the others', () => {
  const next = changed(REAL, { kind: 'put', name: 'node_repl', config: remote('https://a.example.com/mcp') });
  const block = between(next, '[mcp_servers.node_repl]', '[mcp_servers.computer-use]');
  assert.ok(block.includes('url = "https://a.example.com/mcp"'));
  assert.ok(block.includes('startup_timeout_sec = 30'));
  assert.ok(!block.includes('command'));
  assert.ok(!block.includes('args'));
  assert.ok(!block.includes('[mcp_servers.node_repl.env]'));
  assert.deepEqual(serverNamed(next, 'node_repl'), remote('https://a.example.com/mcp'));
});

test('an inline table is rewritten in place', () => {
  const text = ['[mcp_servers.inline]', 'command = "a"', 'env = { A = "1", B = "2" }', 'enabled = true', ''].join('\n');
  const next = changed(text, {
    kind: 'put',
    name: 'inline',
    config: stdio(
      'a',
      [],
      [
        { name: 'A', value: '1' },
        { name: 'C', value: '3' },
      ],
    ),
  });
  assert.equal(next, ['[mcp_servers.inline]', 'command = "a"', 'env = { A = "1", C = "3" }', 'enabled = true', ''].join('\n'));
});

test('removing a server deletes its tables and sub-tables only, with the blank line before it', () => {
  const next = changed(REAL, { kind: 'remove', name: 'node_repl' });
  assert.equal(next, REAL.replace(between(REAL, '[mcp_servers.node_repl]', '[mcp_servers.computer-use]'), ''));
  assert.ok(!next.includes('node_repl'));
  assert.deepEqual(
    servers(next).map((entry) => entry.name),
    ['computer-use'],
  );
  const last = changed(REAL, { kind: 'remove', name: 'computer-use' });
  assert.equal(last, REAL.replace(between(REAL, '[mcp_servers.computer-use]', '[projects.'), ''));
});

test('removing the only server of a file leaves the rest as it was', () => {
  const text = ['# top', 'a = 1', '', '[mcp_servers.one]', 'command = "x"', ''].join('\n');
  assert.equal(changed(text, { kind: 'remove', name: 'one' }), ['# top', 'a = 1', ''].join('\n'));
});

test('a missing server and a bad name are refused', () => {
  assert.equal(refused(REAL, { kind: 'remove', name: 'absent' }).code, 'not-found');
  assert.equal(refused(REAL, { kind: 'remove', name: 'has space' }).code, 'bad-name');
  assert.equal(refused(REAL, { kind: 'put', name: '', config: stdio('x') }).code, 'bad-name');
});

test('line endings: CRLF files get CRLF lines, and nothing else changes', () => {
  const crlf = REAL.replace(/\n/g, '\r\n');
  const next = changed(crlf, { kind: 'put', name: 'sanity', config: stdio('npx') });
  assert.ok(next.startsWith(crlf));
  assert.ok(!/[^\r]\n/.test(next), 'no bare line feed anywhere');
  assert.equal(changed(next, { kind: 'remove', name: 'sanity' }), crlf);
});

test('a byte-order mark and a missing final newline are kept', () => {
  const bom = '﻿' + REAL;
  assert.ok(changed(bom, { kind: 'put', name: 'a', config: stdio('x') }).startsWith('﻿# Codex'));
  const bare = REAL.trimEnd();
  const next = changed(bare, { kind: 'put', name: 'a', config: stdio('x') });
  assert.ok(next.startsWith(bare + '\n\n[mcp_servers.a]'));
  const edited = changed(bare, { kind: 'put', name: 'computer-use', config: stdio('cu2') });
  assert.ok(edited.includes('command = "cu2"'));
  const empty = changed('', { kind: 'put', name: 'a', config: stdio('x') });
  assert.equal(empty, '[mcp_servers.a]\ncommand = "x"\n');
});

test('an unmappable server is refused and nothing is produced', () => {
  const problem = refused(REAL, { kind: 'put', name: 'a', config: { transport: 'sse', url: 'https://x.example.com/sse', headers: [] } });
  assert.equal(problem.code, 'unmappable');
  assert.equal(refused(REAL, { kind: 'put', name: 'a', config: stdio('x', ['--k=${INNER}']) }).code, 'unmappable');
});

test('the editor refuses a file or a definition it would have to guess at, and says on which line', () => {
  const cases: readonly (readonly [string, string, number])[] = [
    ['inline mcp_servers', `mcp_servers = { a = { command = "${SECRET}" } }\n`, 1],
    ['dotted keys at the root', `a = 1\nmcp_servers.a.command = "${SECRET}"\n`, 2],
    ['entries directly in [mcp_servers]', `[mcp_servers]\na = 1\ncommand = "${SECRET}"\n`, 1],
    ['an array of tables', `[[mcp_servers.a]]\ncommand = "${SECRET}"\n`, 1],
    ['a repeated table', `[mcp_servers.a]\ncommand = "${SECRET}"\n\n[mcp_servers.a]\ncommand = "b"\n`, 4],
    ['an unterminated string', `[mcp_servers.a]\ncommand = "${SECRET}\n`, 2],
    ['a stray line', `[x]\n${SECRET}\n`, 2],
    ['an unterminated array', `[x]\na = ["${SECRET}"\n`, 3],
    ['an unterminated multi-line string', `a = """\n${SECRET}\n`, 3],
    ['a repeated key', `a = 1\na = "${SECRET}"\n`, 2],
    ['a bad escape', `a = "${SECRET}\\q"\n`, 1],
    ['an unclosed header', `[mcp_servers.a\n`, 1],
    ['text after a value', `a = 1 ${SECRET}\n`, 1],
  ];
  for (const [label, text, line] of cases) {
    const scanned = scanCodexToml(text);
    assert.ok(!scanned.ok, label);
    assert.equal(scanned.error.line, line, label);
    assert.ok(!JSON.stringify(scanned.error).includes(SECRET), label);
    const problem = refused(text, { kind: 'put', name: 'b', config: stdio('x') });
    assert.equal(problem.code, scanned.error.code, label);
    assert.ok(!JSON.stringify(problem).includes(SECRET), label);
  }
  assert.equal(scanCode('mcp_servers = {}\n'), 'unsupported');
  assert.equal(scanCode('[[mcp_servers.a]]\n'), 'unsupported');
  assert.equal(scanCode('[mcp_servers.a]\n[mcp_servers.a]\n'), 'duplicate-table');
  assert.equal(scanCode('a = "x\n'), 'syntax');
});

test('a server written in a shape the editor does not rewrite is listed without a config and refused on put', () => {
  const dotted = ['[mcp_servers.a]', 'command = "x"', 'env.KEY = "v"', ''].join('\n');
  assert.equal(serverNamed(dotted, 'a'), undefined);
  assert.equal(refused(dotted, { kind: 'put', name: 'a', config: stdio('x') }).code, 'unsupported');
  assert.equal(changed(dotted, { kind: 'remove', name: 'a' }), '');
  const both = ['[mcp_servers.b]', 'command = "x"', 'url = "https://a.example.com"', ''].join('\n');
  assert.equal(serverNamed(both, 'b'), undefined);
  const wrongType = ['[mcp_servers.c]', 'command = 5', ''].join('\n');
  assert.equal(serverNamed(wrongType, 'c'), undefined);
  const inlineAndTable = ['[mcp_servers.d]', 'command = "x"', 'env = { A = "1" }', '', '[mcp_servers.d.env]', 'B = "2"', ''].join('\n');
  assert.equal(refused(inlineAndTable, { kind: 'put', name: 'd', config: stdio('x', [], [{ name: 'A', value: '1' }]) }).code, 'unsupported');
  const subOnly = ['[mcp_servers.e.env]', 'A = "1"', ''].join('\n');
  assert.equal(refused(subOnly, { kind: 'put', name: 'e', config: stdio('x') }).code, 'unsupported');
  assert.equal(changed(subOnly, { kind: 'remove', name: 'e' }), '');
});

test('values of every TOML type are read without error, and a server name that is not valid is not listed', () => {
  const text = [
    'a = 1_000',
    'b = -2.5e3',
    'c = 0xFF',
    'd = 1979-05-27T07:32:00Z',
    'e = true',
    "f = 'literal \\n'",
    "g = '''",
    "multi'''",
    'h = "tab\\t \\u00e9 \\U0001F600"',
    'i = [ 1, 2, ]',
    'j = { k = "v", l = [1] }',
    '"quoted key" = 1',
    'dotted.key = 2',
    '',
    '[mcp_servers."has space"]',
    'command = "x"',
    '',
    '[mcp_servers.ok]',
    'command = "y"',
    '',
  ].join('\n');
  assert.deepEqual(
    servers(text).map((entry) => entry.name),
    ['ok'],
  );
});

test('bounds: an oversize file, too many lines and too deep nesting are refused', () => {
  const huge = `# ${'x'.repeat(CODEX_TOML_LIMITS.fileBytesMax)}\n`;
  const tooLarge = scanCodexToml(huge);
  assert.ok(!tooLarge.ok);
  assert.equal(tooLarge.error.code, 'too-large');
  const manyLines = scanCodexToml('\n'.repeat(CODEX_TOML_LIMITS.linesMax + 1));
  assert.ok(!manyLines.ok);
  assert.equal(manyLines.error.code, 'too-many');
  const deep = scanCodexToml(`a = ${'['.repeat(CODEX_TOML_LIMITS.depthMax + 2)}${']'.repeat(CODEX_TOML_LIMITS.depthMax + 2)}\n`);
  assert.ok(!deep.ok);
  assert.equal(deep.error.code, 'too-many');
  const manyTables = scanCodexToml(Array.from({ length: CODEX_TOML_LIMITS.tablesMax + 1 }, (_, at) => `[t${at}]`).join('\n'));
  assert.ok(!manyTables.ok);
  assert.equal(manyTables.error.code, 'too-many');
  const lots = scanCodexToml(`a = [${Array.from({ length: CODEX_TOML_LIMITS.itemsMax + 1 }, () => '1').join(',')}]\n`);
  assert.ok(!lots.ok);
  assert.equal(lots.error.code, 'too-many');
});

test('a put into a file at its size limit is refused rather than written', () => {
  const nearly = `# ${'x'.repeat(CODEX_TOML_LIMITS.fileBytesMax - 10)}\n`;
  const result = changeCodexToml(nearly, { kind: 'put', name: 'a', config: stdio('x') });
  assert.ok(!result.ok);
  assert.equal(result.error.code, 'too-large');
});
