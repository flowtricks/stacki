// Goal: the `.mcp.json` codec reads the servers a project declares, and an edit through it touches only
// the entry it names: every byte outside the changed region (indentation, key order, unknown top-level
// keys, unknown per-server fields, line endings, final newline, byte-order mark) is the same bytes, and
// a file that cannot be read safely is refused with a position and the text untouched.
// Method: scan a table of real-looking files; print them back unchanged; apply upsert and remove and
// compare the whole text (not just the parsed value); then feed invalid JSON, repeated keys, wrong
// shapes, oversize and over-deep files, and check each is refused with a line and column.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MCP_LIMITS, type McpServerConfig } from '#dist/shared/properties/mcpConfig.js';
import { changeMcpJson, mcpFileEntries, mcpJsonIssues, scanMcpJson } from '#dist/shared/properties/mcpJson.js';

const SANITY: McpServerConfig = { transport: 'http', url: 'https://mcp.sanity.io', headers: [] };
const LOCAL: McpServerConfig = { transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: [{ name: 'KEY', value: '${KEY}' }] };

function entries(text: string) {
  const scanned = scanMcpJson(text);
  assert.ok(scanned.ok, JSON.stringify(scanned));
  return mcpFileEntries(scanned.value);
}

function changed(text: string, change: Parameters<typeof changeMcpJson>[1]): string {
  const result = changeMcpJson(text, change);
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}

const USER_FILE = `{
  "mcpServers": {
    "Sanity": { "type": "http", "url": "https://mcp.sanity.io" }
  }
}
`;

test('the shown .mcp.json reads as one remote server', () => {
  assert.deepEqual(entries(USER_FILE), [{ name: 'Sanity', status: 'server', config: SANITY }]);
});

test('a file with no change prints back as the same bytes', () => {
  const files = [
    USER_FILE,
    '',
    '   \n',
    '{}',
    '{"mcpServers":{}}',
    '﻿{\r\n\t"mcpServers": {\r\n\t\t"a": {"command": "x"}\r\n\t}\r\n}',
    '{ "other": [1, 2.5e3, null, true, {"deep": "x"}], "mcpServers": { "a": { "command": "x", "timeout": 5000 } } }',
  ];
  for (const text of files) {
    const scanned = scanMcpJson(text);
    assert.ok(scanned.ok, text);
    assert.equal(scanned.value.text, text);
  }
  // An upsert that changes nothing returns the very same text.
  assert.equal(changed(USER_FILE, { kind: 'upsert', name: 'Sanity', config: SANITY }), USER_FILE);
});

test('a missing type with a command is stdio, with a url is http, and both is invalid', () => {
  const found = entries(
    '{"mcpServers":{"a":{"command":"x","args":["1"]},"b":{"url":"https://x.example/mcp"},"c":{"command":"x","url":"https://x.example"},"d":{"type":"ws","url":"wss://x"}}}',
  );
  assert.equal(found[0]?.status, 'server');
  assert.equal(found[1]?.status, 'server');
  assert.equal(found[2]?.status, 'invalid');
  assert.equal(found[3]?.status, 'invalid');
});

test('adding a server appends one entry in the file own indentation and leaves the rest alone', () => {
  const added = changed(USER_FILE, { kind: 'upsert', name: 'local', config: LOCAL });
  assert.ok(added.startsWith(USER_FILE.slice(0, USER_FILE.indexOf('\n  }\n}'))), 'everything before the insertion is untouched');
  assert.equal(
    added,
    `{
  "mcpServers": {
    "Sanity": { "type": "http", "url": "https://mcp.sanity.io" },
    "local": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "pkg"
      ],
      "env": {
        "KEY": "\${KEY}"
      }
    }
  }
}
`,
  );
  assert.deepEqual(
    entries(added).map((entry) => entry.name),
    ['Sanity', 'local'],
  );
});

test('indentation of four spaces, tabs and CRLF are followed', () => {
  const four = changed('{\n    "mcpServers": {\n        "a": {"command": "x"}\n    }\n}\n', { kind: 'upsert', name: 'b', config: SANITY });
  assert.ok(four.includes('\n        "b": {\n            "type": "http",'), four);
  const tabs = changed('{\n\t"mcpServers": {\n\t\t"a": {"command": "x"}\n\t}\n}', { kind: 'upsert', name: 'b', config: SANITY });
  assert.ok(tabs.includes('\n\t\t"b": {\n\t\t\t"type": "http",'), tabs);
  const crlf = changed('{\r\n  "mcpServers": {\r\n    "a": {"command": "x"}\r\n  }\r\n}\r\n', { kind: 'upsert', name: 'b', config: SANITY });
  assert.ok(!/[^\r]\n/.test(crlf), 'every line break stays CRLF');
});

test('an empty or missing file becomes the usual shape; a file without mcpServers gains the key', () => {
  assert.equal(
    changed('', { kind: 'upsert', name: 'Sanity', config: SANITY }),
    '{\n  "mcpServers": {\n    "Sanity": {\n      "type": "http",\n      "url": "https://mcp.sanity.io"\n    }\n  }\n}\n',
  );
  const without = changed('{\n  "name": "x"\n}\n', { kind: 'upsert', name: 'Sanity', config: SANITY });
  assert.ok(without.startsWith('{\n  "name": "x",\n  "mcpServers": {'), without);
  assert.deepEqual(
    entries(without).map((entry) => entry.name),
    ['Sanity'],
  );
  assert.equal(changed('﻿', { kind: 'upsert', name: 'a', config: SANITY }).charAt(0), '﻿');
});

test('adding into an empty servers object and a one-line object', () => {
  assert.deepEqual(
    entries(changed('{"mcpServers": {}}', { kind: 'upsert', name: 'a', config: SANITY })).map((entry) => entry.name),
    ['a'],
  );
  const inline = changed('{"mcpServers":{"a":{"command":"x"}}}', { kind: 'upsert', name: 'b', config: SANITY });
  assert.ok(inline.startsWith('{"mcpServers":{"a":{"command":"x"}, "b": '), inline);
});

test('editing a server rewrites only its managed fields and keeps unknown fields and other entries byte for byte', () => {
  const text = `{
  "$schema": "https://example.test/schema.json",
  "mcpServers": {
    "first": { "command": "keep", "weird":   [1,   2] },
    "Sanity": {
      "timeout": 30000,
      "type": "http",
      "url": "https://mcp.sanity.io",
      "oauth": { "scope": "a b", "nothing": null }
    },
    "last": { "url": "https://last.example" }
  },
  "trailing": true
}
`;
  const next = changed(text, {
    kind: 'upsert',
    name: 'Sanity',
    config: { transport: 'http', url: 'https://mcp.sanity.io/v2', headers: [{ name: 'X-Team', value: '${TEAM}' }] },
  });
  const before = text.slice(0, text.indexOf('"url": "https://mcp.sanity.io"'));
  assert.ok(next.startsWith(before), 'everything before the edited field is untouched');
  assert.ok(next.includes('"oauth": { "scope": "a b", "nothing": null }'), 'an unknown field is kept as written, null included');
  assert.ok(next.includes('"timeout": 30000'));
  assert.ok(next.includes('"first": { "command": "keep", "weird":   [1,   2] },'));
  assert.ok(next.endsWith('"last": { "url": "https://last.example" }\n  },\n  "trailing": true\n}\n'));
  const edited = entries(next).find((entry) => entry.name === 'Sanity');
  assert.deepEqual(edited, {
    name: 'Sanity',
    status: 'server',
    config: { transport: 'http', url: 'https://mcp.sanity.io/v2', headers: [{ name: 'X-Team', value: '${TEAM}' }] },
  });
});

test('changing the transport drops the fields that no longer apply', () => {
  const text = '{"mcpServers":{"a":{"type":"http","url":"https://x.example","headers":{"A":"b"},"timeout":1}}}';
  const next = changed(text, { kind: 'upsert', name: 'a', config: { transport: 'stdio', command: 'x', args: [], env: [] } });
  assert.ok(!next.includes('url') && !next.includes('headers'), next);
  assert.ok(next.includes('"timeout":1'));
  assert.equal(entries(next)[0]?.status, 'server');
});

test('removing the first, a middle, the last and the only server touches only that entry', () => {
  const text = '{\n  "mcpServers": {\n    "a": {"command": "1"},\n    "b": {"command": "2"},\n    "c": {"command": "3"}\n  }\n}\n';
  assert.equal(changed(text, { kind: 'remove', name: 'a' }), '{\n  "mcpServers": {\n    "b": {"command": "2"},\n    "c": {"command": "3"}\n  }\n}\n');
  assert.equal(changed(text, { kind: 'remove', name: 'b' }), '{\n  "mcpServers": {\n    "a": {"command": "1"},\n    "c": {"command": "3"}\n  }\n}\n');
  assert.equal(changed(text, { kind: 'remove', name: 'c' }), '{\n  "mcpServers": {\n    "a": {"command": "1"},\n    "b": {"command": "2"}\n  }\n}\n');
  assert.equal(changed('{"x":1,"mcpServers":{"a":{"command":"1"}}}', { kind: 'remove', name: 'a' }), '{"x":1,"mcpServers":{}}');
});

test('removing a name that is not there, or one that is not a valid name, is refused', () => {
  assert.deepEqual(changeMcpJson(USER_FILE, { kind: 'remove', name: 'nope' }), { ok: false, error: 'not-found' });
  for (const name of ['', 'a b', 'a/b', '__proto__!', 'x'.repeat(MCP_LIMITS.nameCharsMax + 1)]) {
    assert.deepEqual(changeMcpJson(USER_FILE, { kind: 'upsert', name, config: SANITY }), { ok: false, error: 'invalid-name' });
  }
});

test('a name that looks like a prototype key is an ordinary key', () => {
  const next = changed('{}', { kind: 'upsert', name: '__proto__', config: SANITY });
  assert.deepEqual(
    entries(next).map((entry) => entry.name),
    ['__proto__'],
  );
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
});

test('a text that cannot be read is refused and not rewritten', () => {
  for (const text of [
    '{',
    '{"mcpServers": ',
    '[]',
    '{"mcpServers": []}',
    '{"a": 1,}',
    '{"a" 1}',
    "{'a': 1}",
    '{"a": 01}',
    '{"a": "x\ny"}',
    '{"a": 1} x',
    '// c\n{}',
    '{"mcpServers": {"a": {"command": "x"}, "a": {"command": "y"}}}',
  ]) {
    assert.deepEqual(changeMcpJson(text, { kind: 'upsert', name: 'n', config: SANITY }), { ok: false, error: 'unreadable' }, text);
  }
});

test('every problem has a code, a path and a 1-based line and column, never file text', () => {
  const cases: readonly (readonly [string, string, number, number])[] = [
    ['{\n  "a": 1,\n}', 'trailing-comma', 3, 1],
    ['{\n  "mcpServers": {\n    "a": {"command": "x"},\n    "a": {}\n  }\n}', 'duplicate-key', 4, 5],
    ['{"mcpServers": []}', 'servers-not-object', 1, 16],
    ['[]', 'not-object', 1, 1],
    ['{"a": tru}', 'unexpected-token', 1, 7],
    ['{"a": "x', 'unterminated-string', 1, 9],
    ['{"a" 1}', 'expected-colon', 1, 6],
  ];
  for (const [text, code, line, column] of cases) {
    const issues = mcpJsonIssues(text);
    assert.equal(issues.length, 1, text);
    assert.deepEqual([issues[0]?.code, issues[0]?.line, issues[0]?.column], [code, line, column], text);
  }
});

test('schema problems are reported per server by path, one per server, at the offending field', () => {
  const text =
    '{\n  "mcpServers": {\n    "ok": {"command": "x"},\n    "bad": {\n      "type": "http",\n      "url": "ftp://x"\n    },\n    "bad name": {"command": "x"},\n    "args": {"command": "x", "args": "no"}\n  }\n}';
  const issues = mcpJsonIssues(text);
  assert.deepEqual(
    issues.map((issue) => [issue.code, issue.path, issue.line]),
    [
      ['bad-url', 'mcpServers.bad.url', 6],
      ['bad-server-name', 'mcpServers.bad name', 8],
      ['expected-array', 'mcpServers.args.args', 9],
    ],
  );
  assert.deepEqual(mcpJsonIssues(USER_FILE), []);
});

test('bounds: oversize, too deep, and too many servers are refused', () => {
  const big = `{"mcpServers":{"a":{"command":"${'x'.repeat(MCP_LIMITS.fileBytesMax)}"}}}`;
  assert.equal(mcpJsonIssues(big)[0]?.code, 'too-large');
  assert.deepEqual(changeMcpJson(big, { kind: 'remove', name: 'a' }), { ok: false, error: 'too-large' });
  const deep = `${'['.repeat(MCP_LIMITS.depthMax + 2)}${']'.repeat(MCP_LIMITS.depthMax + 2)}`;
  assert.equal(mcpJsonIssues(`{"x":${deep}}`)[0]?.code, 'too-deep');
  const many = Object.fromEntries(Array.from({ length: MCP_LIMITS.serversMax + 1 }, (_, at) => [`s${at}`, { command: 'x' }]));
  assert.equal(mcpJsonIssues(JSON.stringify({ mcpServers: many }))[0]?.code, 'too-many-servers');
  const full = JSON.stringify({ mcpServers: Object.fromEntries(Array.from({ length: MCP_LIMITS.serversMax }, (_, at) => [`s${at}`, { command: 'x' }])) });
  assert.deepEqual(changeMcpJson(full, { kind: 'upsert', name: 'extra', config: SANITY }), { ok: false, error: 'too-many-servers' });
  assert.ok(changeMcpJson(full, { kind: 'upsert', name: 's0', config: SANITY }).ok, 'editing one of a full set is allowed');
});

test('an edit that would push the file over its size limit is refused', () => {
  const near = `{"mcpServers":{"a":{"command":"x"}},"pad":"${'x'.repeat(MCP_LIMITS.fileBytesMax - 80)}"}`;
  const result = changeMcpJson(near, { kind: 'upsert', name: 'b', config: { transport: 'http', url: `https://x.example/${'p'.repeat(200)}`, headers: [] } });
  assert.deepEqual(result, { ok: false, error: 'too-large' });
});

test('values are never part of a problem', () => {
  const secret = 'sk-live-very-secret';
  const issues = mcpJsonIssues(`{"mcpServers":{"a":{"command":"x","env":{"K":"${secret}","K":"y"}}}}`);
  assert.ok(!JSON.stringify(issues).includes(secret));
});
