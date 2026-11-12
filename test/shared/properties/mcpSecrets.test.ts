// Goal: literal variable and header values become `${NAME}` references plus secrets to store, with
// names that are valid variables, never collide with `.env` or each other, keep a header's scheme word
// outside the secret, and leave untouched whatever is already a reference, empty, or cannot live in `.env`.
// Method: run the real planner over small servers and compare the rewritten server and the secret list;
// then crowd the name space and the bounds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MCP_LIMITS, type McpServerConfig } from '#dist/shared/properties/mcpConfig.js';
import { ENV_LIMITS } from '#dist/shared/properties/envFile.js';
import { MCP_SECRETS_MAX, moveLiteralsToSecrets, secretNameFor } from '#dist/shared/properties/mcpSecrets.js';

const NONE: ReadonlySet<string> = new Set();

function remote(headers: readonly { name: string; value: string }[]): McpServerConfig {
  return { transport: 'http', url: 'https://x.example', headers };
}

test('environment values keep their own names', () => {
  const moved = moveLiteralsToSecrets(
    'db',
    {
      transport: 'stdio',
      command: 'x',
      args: ['--key', 'inline'],
      env: [
        { name: 'API_KEY', value: 'sk-1' },
        { name: 'MODE', value: '' },
      ],
    },
    NONE,
  );
  assert.deepEqual(moved.config, {
    transport: 'stdio',
    command: 'x',
    args: ['--key', 'inline'],
    env: [
      { name: 'API_KEY', value: '${API_KEY}' },
      { name: 'MODE', value: '' },
    ],
  });
  assert.deepEqual(moved.secrets, [{ name: 'API_KEY', value: 'sk-1' }]);
  assert.deepEqual(moved.leftLiteral, []);
});

test('a header splits its scheme from the secret and is named after server and header', () => {
  const moved = moveLiteralsToSecrets(
    'acme-tools',
    remote([
      { name: 'Authorization', value: 'Bearer tok-1' },
      { name: 'X-Api-Key', value: 'plain' },
      { name: 'Basic-Thing', value: 'basic abc' },
    ]),
    NONE,
  );
  assert.deepEqual(moved.secrets, [
    { name: 'ACME_TOOLS_AUTHORIZATION', value: 'tok-1' },
    { name: 'ACME_TOOLS_X_API_KEY', value: 'plain' },
    { name: 'ACME_TOOLS_BASIC_THING', value: 'abc' },
  ]);
  assert.deepEqual(moved.config, {
    transport: 'http',
    url: 'https://x.example',
    headers: [
      { name: 'Authorization', value: 'Bearer ${ACME_TOOLS_AUTHORIZATION}' },
      { name: 'X-Api-Key', value: '${ACME_TOOLS_X_API_KEY}' },
      { name: 'Basic-Thing', value: 'basic ${ACME_TOOLS_BASIC_THING}' },
    ],
  });
});

test('references, empty values and the URL are left alone', () => {
  const config = remote([
    { name: 'Authorization', value: 'Bearer ${ALREADY}' },
    { name: 'X-Empty', value: '' },
    { name: 'X-Default', value: '${A:-b}' },
  ]);
  const withQuery: McpServerConfig = {
    transport: 'http',
    url: 'https://x.example/?key=abc',
    headers: [...(config.transport === 'stdio' ? [] : config.headers)],
  };
  const moved = moveLiteralsToSecrets('s', withQuery, NONE);
  assert.deepEqual(moved.secrets, []);
  assert.deepEqual(moved.config, withQuery);
});

test('names already taken, or taken earlier in the same call, get a numeric suffix', () => {
  const moved = moveLiteralsToSecrets(
    's',
    remote([
      { name: 'Authorization', value: 'Bearer a' },
      { name: 'authorization-', value: 'b' },
    ]),
    new Set(['S_AUTHORIZATION']),
  );
  assert.deepEqual(
    moved.secrets.map((secret) => secret.name),
    ['S_AUTHORIZATION_2', 'S_AUTHORIZATION_3'],
  );
  const env = moveLiteralsToSecrets('s', { transport: 'stdio', command: 'x', args: [], env: [{ name: 'K', value: '1' }] }, new Set(['K']));
  assert.deepEqual(env.secrets, [{ name: 'K_2', value: '1' }]);
  assert.deepEqual(env.config, { transport: 'stdio', command: 'x', args: [], env: [{ name: 'K', value: '${K_2}' }] });
});

test('values .env cannot hold stay literal and are reported by pair name', () => {
  const moved = moveLiteralsToSecrets(
    's',
    {
      transport: 'stdio',
      command: 'x',
      args: [],
      env: [
        { name: 'MULTI', value: 'a\nb' },
        { name: 'HUGE', value: 'z'.repeat(ENV_LIMITS.valueBytesMax + 1) },
        { name: 'OK', value: 'fine' },
      ],
    },
    NONE,
  );
  assert.deepEqual(moved.leftLiteral, ['MULTI', 'HUGE']);
  assert.deepEqual(moved.secrets, [{ name: 'OK', value: 'fine' }]);
  const bearerOnly = moveLiteralsToSecrets('s', remote([{ name: 'Authorization', value: 'Bearer ' }]), NONE);
  assert.deepEqual(bearerOnly.secrets.length + bearerOnly.leftLiteral.length, 1);
});

test('derived names are valid variable names, and the count is bounded', () => {
  assert.equal(secretNameFor('9lives', 'X-1'), '_9LIVES_X_1');
  assert.equal(secretNameFor('a.b-c', 'Auth'), 'A_B_C_AUTH');
  assert.match(secretNameFor('日本', '語'), /^[A-Za-z_][A-Za-z0-9_]*$/);
  const many = Array.from({ length: MCP_LIMITS.pairsMax }, (_, at) => ({ name: `H${at}`, value: `v${at}` }));
  const moved = moveLiteralsToSecrets('s', remote(many), NONE);
  assert.equal(moved.secrets.length, MCP_LIMITS.pairsMax);
  assert.ok(MCP_SECRETS_MAX >= moved.secrets.length);
  assert.equal(new Set(moved.secrets.map((secret) => secret.name)).size, moved.secrets.length);
});

test('a crowded name space ends in a literal, not a loop', () => {
  const crowded = new Set<string>(['S_AUTHORIZATION']);
  for (let suffix = 2; suffix < MCP_SECRETS_MAX + 4; suffix += 1) {
    crowded.add(`S_AUTHORIZATION_${suffix}`);
  }
  const moved = moveLiteralsToSecrets('s', remote([{ name: 'Authorization', value: 'Bearer x' }]), crowded);
  assert.deepEqual(moved.secrets, []);
  assert.deepEqual(moved.leftLiteral, ['Authorization']);
});
