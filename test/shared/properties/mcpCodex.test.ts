// Goal: the mapping between the panel's server model and Codex's `[mcp_servers]` keys is exact in both
// directions: a reference that stands for a whole value becomes a forwarded variable (Codex expands
// nothing), a literal stays a literal, and anything with no Codex spelling is refused instead of being
// written as text Codex would send as is. TOML text helpers quote what needs quoting.
// Method: table-driven cases through `toCodexFields` and `fromCodexFields`, the round trip of every
// mappable case, then each refusal (an SSE server, a reference inside longer text, a renamed variable)
// and the quoting helpers on awkward input.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CODEX_MANAGED_KEYS, codexTablePath, fromCodexFields, tomlKey, tomlString, toCodexFields, type CodexFields } from '#dist/shared/properties/mcpCodex.js';
import type { McpServerConfig } from '#dist/shared/properties/mcpConfig.js';

function mapped(config: McpServerConfig): CodexFields {
  const result = toCodexFields(config);
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}

test('a stdio server maps references to forwarded names and literals to env', () => {
  const fields = mapped({
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'pkg'],
    env: [
      { name: 'LITERAL', value: 'v' },
      { name: 'TOKEN', value: '${TOKEN}' },
    ],
  });
  assert.equal(fields.command, 'npx');
  assert.deepEqual(fields.args, ['-y', 'pkg']);
  assert.deepEqual(fields.envVars, ['TOKEN']);
  assert.deepEqual(fields.env, [{ name: 'LITERAL', value: 'v' }]);
  assert.equal(fields.url, undefined);
});

test('a remote server maps the bearer header, other references and literals', () => {
  const fields = mapped({
    transport: 'http',
    url: 'https://example.com/mcp',
    headers: [
      { name: 'authorization', value: 'Bearer ${TOKEN}' },
      { name: 'X-Key', value: '${KEY}' },
      { name: 'X-Team', value: 'blue' },
    ],
  });
  assert.equal(fields.bearerTokenEnvVar, 'TOKEN');
  assert.deepEqual(fields.envHttpHeaders, [{ name: 'X-Key', value: 'KEY' }]);
  assert.deepEqual(fields.httpHeaders, [{ name: 'X-Team', value: 'blue' }]);
  assert.equal(fields.command, undefined);
});

test('every mappable server survives the trip to Codex and back', () => {
  const cases: readonly McpServerConfig[] = [
    { transport: 'stdio', command: 'cu', args: [], env: [] },
    {
      transport: 'stdio',
      command: 'cu',
      args: ['a'],
      env: [
        { name: 'A', value: '1' },
        { name: 'B', value: '${B}' },
      ],
    },
    { transport: 'http', url: 'https://a.example.com/mcp', headers: [] },
    {
      transport: 'http',
      url: 'https://a.example.com/mcp',
      headers: [
        { name: 'Authorization', value: 'Bearer ${T}' },
        { name: 'X-One', value: '1' },
        { name: 'X-Two', value: '${TWO}' },
      ],
    },
  ];
  for (const config of cases) {
    assert.deepEqual(fromCodexFields(mapped(config)), config);
  }
});

test('what has no Codex spelling is refused', () => {
  const refusals: readonly McpServerConfig[] = [
    { transport: 'sse', url: 'https://a.example.com/sse', headers: [] },
    { transport: 'stdio', command: '${CMD}', args: [], env: [] },
    { transport: 'stdio', command: 'x', args: ['--key=${KEY}'], env: [] },
    { transport: 'stdio', command: 'x', args: [], env: [{ name: 'A', value: '${B}' }] },
    { transport: 'stdio', command: 'x', args: [], env: [{ name: 'A', value: 'pre-${A}' }] },
    { transport: 'stdio', command: 'x', args: [], env: [{ name: 'A', value: '${A:-fallback}' }] },
    { transport: 'http', url: 'https://a.example.com/${PATH_PART}', headers: [] },
    { transport: 'http', url: 'https://a.example.com', headers: [{ name: 'X', value: 'a ${B} c' }] },
    { transport: 'http', url: 'https://a.example.com', headers: [{ name: 'Authorization', value: 'Basic ${B}' }] },
  ];
  for (const config of refusals) {
    const result = toCodexFields(config);
    assert.ok(!result.ok, JSON.stringify(config));
    assert.deepEqual(result.error, { code: 'unmappable' });
  }
});

test('a second Authorization bearer header stays an ordinary environment header', () => {
  const fields = mapped({
    transport: 'http',
    url: 'https://a.example.com',
    headers: [
      { name: 'Authorization', value: 'Bearer ${ONE}' },
      { name: 'Authorization-2', value: '${TWO}' },
    ],
  });
  assert.equal(fields.bearerTokenEnvVar, 'ONE');
  assert.deepEqual(fields.envHttpHeaders, [{ name: 'Authorization-2', value: 'TWO' }]);
});

test('Codex keys that are not one server give no config', () => {
  const none: CodexFields = {
    command: undefined,
    args: [],
    envVars: [],
    env: [],
    url: undefined,
    bearerTokenEnvVar: undefined,
    httpHeaders: [],
    envHttpHeaders: [],
  };
  assert.equal(fromCodexFields(none), undefined);
  assert.equal(fromCodexFields({ ...none, command: 'x', url: 'https://a.example.com' }), undefined);
  assert.equal(fromCodexFields({ ...none, url: 'ftp://a.example.com' }), undefined);
  assert.equal(fromCodexFields({ ...none, command: 'x', envVars: ['bad name'] }), undefined);
  assert.equal(fromCodexFields({ ...none, command: 'x', env: [{ name: 'A', value: '1' }], envVars: ['A'] }), undefined);
  assert.equal(fromCodexFields({ ...none, url: 'https://a.example.com', httpHeaders: [{ name: 'bad header', value: '1' }] }), undefined);
  assert.equal(fromCodexFields({ ...none, url: 'https://a.example.com', bearerTokenEnvVar: '1x' }), undefined);
});

test('TOML text: keys are quoted when they must be and strings are escaped', () => {
  assert.equal(tomlKey('plain-name_1'), 'plain-name_1');
  assert.equal(tomlKey('my.server'), '"my.server"');
  assert.equal(tomlKey('has space'), '"has space"');
  assert.equal(tomlString('a "b" \\ c\n\t\u0001\u007f'), '"a \\"b\\" \\\\ c\\n\\t\\u0001\\u007f"');
  assert.equal(codexTablePath('my.server'), 'mcp_servers."my.server"');
  assert.equal(codexTablePath('node'), 'mcp_servers.node');
  assert.throws(() => tomlKey(''), /Assertion failed/);
});

test('the managed keys are the ones the mapping writes and nothing else', () => {
  assert.deepEqual([...CODEX_MANAGED_KEYS], ['command', 'args', 'env_vars', 'env', 'url', 'bearer_token_env_var', 'http_headers', 'env_http_headers']);
});
