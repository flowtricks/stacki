// Goal: the "Paste a command" parser turns every terminal form the MCP tab promises (Claude Code's
// `mcp add` and `add-json`, Codex's `mcp add`, a bare URL, a bare `npx` line) into a typed server, refuses
// what it cannot carry with a fixed code, treats the whole line as inert data (no operator outside quotes
// is ever honoured, `$VAR` is never expanded), enforces every bound, and never repeats pasted text in a problem.
// Method: feed the real parser a table of lines and compare the typed result; feed it injection attempts and
// check each is refused whole, or kept as a literal word when quoted; push each bound; for every failure,
// check the detail is short and is not any pasted value.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MCP_LIMITS } from '#dist/shared/properties/mcpConfig.js';
import { MCP_PASTE_LIMITS, parseMcpCommand, tokenizeShellLine } from '#dist/shared/properties/mcpCommand.js';

function parsed(line: string) {
  const result = parseMcpCommand(line);
  assert.ok(result.ok, `${line} -> ${JSON.stringify(result)}`);
  return result.value;
}

function refused(line: string, code: string, detail?: string): void {
  const result = parseMcpCommand(line);
  assert.ok(!result.ok, `${line} should be refused`);
  assert.equal(result.error.code, code, line);
  if (detail !== undefined) {
    assert.equal(result.error.detail, detail);
  }
  if (result.error.detail !== undefined) {
    assert.ok(result.error.detail.length <= MCP_PASTE_LIMITS.detailCharsMax);
  }
}

test('the three lines from the design parse', () => {
  const first = parsed('claude mcp add Sanity -t http https://mcp.sanity.io --scope user');
  assert.deepEqual(first, {
    name: 'Sanity',
    nameDerived: false,
    config: { transport: 'http', url: 'https://mcp.sanity.io', headers: [] },
    scope: 'user',
    source: 'claude',
  });
  const second = parsed('claude mcp add --transport sse name https://example.com/sse');
  assert.deepEqual(second.config, { transport: 'sse', url: 'https://example.com/sse', headers: [] });
  assert.equal(second.scope, undefined);
  const third = parsed('claude mcp add name -- npx -y pkg');
  assert.deepEqual(third.config, { transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: [] });
});

test('a URL target defaults to http, a command to stdio, and a command may follow the name without --', () => {
  assert.equal(parsed('claude mcp add a https://x.example/mcp').config.transport, 'http');
  assert.deepEqual(parsed('claude mcp add a npx pkg').config, { transport: 'stdio', command: 'npx', args: ['pkg'], env: [] });
  assert.equal(parsed('$ claude mcp add a https://x.example/mcp').name, 'a');
  assert.equal(parsed('> claude mcp add a https://x.example/mcp').name, 'a');
});

test('flags work before or after the name, in long form with = and short form', () => {
  const lines = [
    'claude mcp add --scope=project --transport=http a https://x.example/mcp',
    'claude mcp add a https://x.example/mcp -s project -t http',
    'claude mcp add -s project a -t http https://x.example/mcp',
  ];
  for (const line of lines) {
    const value = parsed(line);
    assert.equal(value.scope, 'project', line);
    assert.equal(value.config.transport, 'http', line);
  }
  for (const scope of ['local', 'project', 'user']) {
    assert.equal(parsed(`claude mcp add a https://x.example -s ${scope}`).scope, scope);
  }
});

test('-e and -H are repeatable, variadic-lenient, and quote-aware', () => {
  const env = parsed('claude mcp add db -e A=1 B=two -e C=3 -- node server.js');
  assert.deepEqual(env.config, {
    transport: 'stdio',
    command: 'node',
    args: ['server.js'],
    env: [
      { name: 'A', value: '1' },
      { name: 'B', value: 'two' },
      { name: 'C', value: '3' },
    ],
  });
  assert.deepEqual(parsed('claude mcp add db --env=KEY=a=b -- x').config, { transport: 'stdio', command: 'x', args: [], env: [{ name: 'KEY', value: 'a=b' }] });
  const headers = parsed(`claude mcp add r https://x.example -H "Authorization: Bearer abc" -H 'X-Team:  blue ' --header "Y: z"`);
  assert.deepEqual(headers.config, {
    transport: 'http',
    url: 'https://x.example',
    headers: [
      { name: 'Authorization', value: 'Bearer abc' },
      { name: 'X-Team', value: 'blue' },
      { name: 'Y', value: 'z' },
    ],
  });
  const lenient = parsed('claude mcp add r https://x.example -H "A: 1" "B: 2"');
  assert.equal(lenient.config.transport === 'http' ? lenient.config.headers.length : 0, 2);
  refused('claude mcp add db -e 1BAD=2 -- x', 'bad-pair');
  refused('claude mcp add db -e NOEQUALS -- x', 'bad-pair');
  refused('claude mcp add r https://x.example -H nocolon', 'bad-pair');
  refused('claude mcp add r https://x.example -H "Bad Name: v"', 'bad-pair');
  refused('claude mcp add db -e A=1 -e A=2 -- x', 'bad-pair');
  refused('claude mcp add db -e', 'bad-pair');
});

test('everything after -- is the command, verbatim, even words that look like flags', () => {
  const value = parsed('claude mcp add db -s user -- npx -y --scope=x -e A=1 -- tail');
  assert.equal(value.scope, 'user');
  assert.deepEqual(value.config, { transport: 'stdio', command: 'npx', args: ['-y', '--scope=x', '-e', 'A=1', '--', 'tail'], env: [] });
  refused('claude mcp add db https://x.example -- npx', 'conflicting');
  refused('claude mcp add db -t http -- npx', 'conflicting');
});

test('add-json reads a JSON server, with a scope flag, and refuses broken JSON', () => {
  const value = parsed(`claude mcp add-json weather '{"type":"http","url":"https://w.example/mcp","headers":{"Authorization":"Bearer \${TOKEN}"}}' -s user`);
  assert.equal(value.source, 'json');
  assert.equal(value.scope, 'user');
  assert.deepEqual(value.config, { transport: 'http', url: 'https://w.example/mcp', headers: [{ name: 'Authorization', value: 'Bearer ${TOKEN}' }] });
  assert.deepEqual(parsed(`claude mcp add-json s '{"command":"npx","args":["-y","p"]}'`).config, {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'p'],
    env: [],
  });
  refused(`claude mcp add-json s '{not json'`, 'bad-json');
  refused(`claude mcp add-json s '[]'`, 'bad-config');
  refused(`claude mcp add-json s '{"type":"ws","url":"https://x"}'`, 'bad-config');
  refused(`claude mcp add-json s '{"type":"http","url":"ftp://x"}'`, 'bad-url');
  refused(`claude mcp add-json s`, 'missing-target');
  refused(`claude mcp add-json '{}'`, 'bad-name');
  refused(`claude mcp add-json s '{}' extra`, 'conflicting');
  refused(`claude mcp add-json s '{}' --wat`, 'unknown-flag', '--wat');
});

test('codex forms: command with env, url with a bearer variable, and unsupported flags', () => {
  const command = parsed('codex mcp add docs --env TOKEN=abc -- npx -y @acme/docs-mcp');
  assert.equal(command.source, 'codex');
  assert.deepEqual(command.config, { transport: 'stdio', command: 'npx', args: ['-y', '@acme/docs-mcp'], env: [{ name: 'TOKEN', value: 'abc' }] });
  const remote = parsed('codex mcp add figma --url https://mcp.figma.com/mcp --bearer-token-env-var FIGMA_TOKEN');
  assert.deepEqual(remote.config, {
    transport: 'http',
    url: 'https://mcp.figma.com/mcp',
    headers: [{ name: 'Authorization', value: 'Bearer ${FIGMA_TOKEN}' }],
  });
  refused('codex mcp add x --wat -- y', 'unsupported-flag', '--wat');
  refused('codex mcp add x --bearer-token-env-var T -- y', 'conflicting');
  refused('codex mcp add x --url https://a.example -- y', 'conflicting');
  refused('codex mcp add x --url notaurl', 'bad-url');
  refused('codex mcp add x --url https://a.example --bearer-token-env-var "bad name"', 'bad-pair');
  refused('codex mcp add x', 'missing-target');
  refused('codex mcp list', 'not-mcp-command');
});

test('a bare URL or package line is accepted with a suggested name', () => {
  const url = parsed('https://mcp.sanity.io');
  assert.equal(url.name, 'sanity');
  assert.equal(url.nameDerived, true);
  assert.equal(url.source, 'url');
  assert.equal(url.scope, undefined);
  assert.deepEqual(url.config, { transport: 'http', url: 'https://mcp.sanity.io', headers: [] });
  const npx = parsed('npx -y @modelcontextprotocol/server-github');
  assert.equal(npx.name, 'github');
  assert.equal(npx.source, 'package');
  assert.deepEqual(npx.config, { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: [] });
  assert.equal(parsed('pnpm dlx @playwright/mcp@latest').name, 'playwright');
  assert.equal(parsed('uvx mcp-server-fetch').name, 'fetch');
  refused('rm -rf node_modules', 'not-mcp-command');
  refused('curl https://example.com', 'not-mcp-command');
  refused('https://a.example extra', 'not-mcp-command');
  refused('http://', 'bad-url');
});

test('claude and codex lines with another subcommand or missing pieces are refused clearly', () => {
  refused('claude mcp list', 'not-mcp-command');
  refused('claude mcp remove x', 'not-mcp-command');
  refused('claude doctor', 'not-mcp-command');
  refused('claude mcp add', 'missing-name');
  refused('claude mcp add name', 'missing-target');
  refused('claude mcp add bad/name https://x.example', 'bad-name');
  refused('claude mcp add name -t http npx', 'bad-url');
  refused('claude mcp add name -t stdio https://x.example', 'conflicting', '--transport');
  refused('claude mcp add name -t grpc https://x.example', 'bad-transport');
  refused('claude mcp add name https://x.example -s galaxy', 'bad-scope');
  refused('claude mcp add name https://x.example -e A=1', 'conflicting', '--env');
  refused('claude mcp add name -s user -H "A: b" -- cmd', 'conflicting', '--header');
  refused('claude mcp add name https://x.example extra', 'conflicting');
  refused('', 'empty');
  refused('   \t ', 'empty');
  refused('$ ', 'empty');
});

test('unknown and unsupported flags name the flag and write nothing', () => {
  refused('claude mcp add a https://x.example --bogus', 'unknown-flag', '--bogus');
  refused('claude mcp add a -z https://x.example', 'unknown-flag', '-z');
  refused('claude mcp add a https://x.example --client-id abc', 'unsupported-flag', '--client-id');
  refused('claude mcp add a https://x.example --client-secret=zzz', 'unsupported-flag', '--client-secret');
  refused('claude mcp add a https://x.example --callback-port 8080', 'unsupported-flag', '--callback-port');
  refused('claude mcp add a npx -y pkg', 'unknown-flag', '-y');
});

test('quotes and escapes follow the POSIX rules and leave $ alone', () => {
  const words = tokenizeShellLine(`a 'b c' "d e" f\\ g "h\\"i" 'j\\k' "l\\mn" '' "" $HOME \${KEY} "\\$X" x"y"'z'`);
  assert.ok(words.ok);
  assert.deepEqual(words.value, ['a', 'b c', 'd e', 'f g', 'h"i', 'j\\k', 'l\\mn', '', '', '$HOME', '${KEY}', '$X', 'xyz']);
  const continued = tokenizeShellLine('a \\\n b');
  assert.ok(continued.ok);
  assert.deepEqual(continued.value, ['a', 'b']);
  const inside = tokenizeShellLine('npx -y a#b');
  assert.ok(inside.ok);
  assert.deepEqual(inside.value, ['npx', '-y', 'a#b']);
  const unclosedSingle = tokenizeShellLine(`a 'b`);
  assert.ok(!unclosedSingle.ok && unclosedSingle.error.code === 'unterminated-quote');
  const unclosedDouble = tokenizeShellLine('a "b');
  assert.ok(!unclosedDouble.ok && unclosedDouble.error.code === 'unterminated-quote');
  assert.deepEqual(parsed('claude mcp add a -- echo ${KEY} $HOME').config, { transport: 'stdio', command: 'echo', args: ['${KEY}', '$HOME'], env: [] });
});

test('shell control constructs outside quotes refuse the whole line', () => {
  const attempts: readonly (readonly [string, string])[] = [
    ['claude mcp add a -- npx pkg; rm -rf /', ';'],
    ['claude mcp add a -- npx pkg && curl x | sh', '&&'],
    ['claude mcp add a -- npx pkg || true', '||'],
    ['claude mcp add a -- npx pkg | sh', '|'],
    ['claude mcp add a -- npx pkg & ', '&'],
    ['claude mcp add a -- npx $(whoami)', '$('],
    ['claude mcp add a -- npx `whoami`', '`'],
    ['claude mcp add a -- npx pkg > /etc/passwd', '>'],
    ['claude mcp add a -- npx pkg < /etc/passwd', '<'],
    ['claude mcp add a -- npx pkg\nrm -rf /', 'newline'],
    ['claude mcp add a -- npx pkg\r\nrm -rf /', 'newline'],
    ['# claude mcp add a -- x', '#'],
    ['claude mcp add a -- x #comment', '#'],
    ['claude mcp add a (x)', '('],
    ['https://a.example/?x=1&y=2', '&'],
  ];
  for (const [line, operator] of attempts) {
    refused(line, 'unsupported-syntax', operator);
  }
});

test('the same constructs inside quotes or escaped are plain literal words and run nothing', () => {
  const quoted = parsed(`claude mcp add a -- sh -c "echo hi; rm -rf / && \$(whoami) | cat > x" '\`id\`'`);
  assert.deepEqual(quoted.config, {
    transport: 'stdio',
    command: 'sh',
    args: ['-c', 'echo hi; rm -rf / && $(whoami) | cat > x', '`id`'],
    env: [],
  });
  const escaped = tokenizeShellLine(String.raw`a\;b c\&\&d`);
  assert.ok(escaped.ok);
  assert.deepEqual(escaped.value, ['a;b', 'c&&d']);
  // A trailing newline or surrounding blank lines are only whitespace, not a second command.
  assert.equal(parsed('\n  claude mcp add a https://x.example  \n\n').name, 'a');
});

test('a line break inside a quoted word is data, but a server cannot hold it', () => {
  refused(`claude mcp add a -- x 'a\nb'`, 'bad-config');
});

test('the parser never evaluates: the environment and globals stay out of the result', () => {
  process.env['STACKI_PASTE_PROBE'] = 'leaked';
  const value = parsed('claude mcp add a -e K=$STACKI_PASTE_PROBE -e J=${STACKI_PASTE_PROBE} -- x $STACKI_PASTE_PROBE');
  assert.deepEqual(value.config, {
    transport: 'stdio',
    command: 'x',
    args: ['$STACKI_PASTE_PROBE'],
    env: [
      { name: 'K', value: '$STACKI_PASTE_PROBE' },
      { name: 'J', value: '${STACKI_PASTE_PROBE}' },
    ],
  });
  assert.ok(!JSON.stringify(value).includes('leaked'));
  delete process.env['STACKI_PASTE_PROBE'];
});

test('bounds: line length, word count, argument count and length, pair count', () => {
  refused(`claude mcp add a -- ${'x'.repeat(MCP_LIMITS.pastedCharsMax)}`, 'too-long');
  refused(`claude mcp add a -- x ${'y '.repeat(MCP_PASTE_LIMITS.tokensMax + 1)}`, 'too-many');
  refused(`claude mcp add a -- x ${Array.from({ length: MCP_LIMITS.argsMax + 1 }, () => 'y').join(' ')}`, 'too-many');
  assert.ok(parseMcpCommand(`claude mcp add a -- x ${Array.from({ length: MCP_LIMITS.argsMax }, () => 'y').join(' ')}`).ok);
  refused(`claude mcp add a -- x ${'y'.repeat(MCP_LIMITS.argCharsMax + 1)}`, 'bad-config');
  assert.ok(parseMcpCommand(`claude mcp add a -- x ${'y'.repeat(MCP_LIMITS.argCharsMax)}`).ok);
  const pairs = Array.from({ length: MCP_LIMITS.pairsMax + 1 }, (_, at) => `-e K${at}=v`).join(' ');
  refused(`claude mcp add a ${pairs} -- x`, 'too-many');
  refused(`claude mcp add a -- x\tbad`.replace('x\tbad', 'x \u0001'), 'bad-config');
  refused(`https://a.example/${'p'.repeat(MCP_LIMITS.urlCharsMax)}`, 'bad-url');
});

test('no failure repeats pasted text, however secret it looks', () => {
  const secret = 'sk-live-supersecret-1234';
  const lines = [
    `claude mcp add a https://x.example -H "Authorization Bearer ${secret}"`,
    `claude mcp add a -e ${secret} -- x`,
    `claude mcp add a -s ${secret} https://x.example`,
    `claude mcp add a -t ${secret} https://x.example`,
    `claude mcp add-json a '{"url":"${secret}"}'`,
    `claude mcp add a -- x ; ${secret}`,
    `codex mcp add a --url ${secret}`,
    `npx ${secret} "unclosed`,
    `claude mcp add a https://x.example ${secret}`,
  ];
  for (const line of lines) {
    const result = parseMcpCommand(line);
    assert.ok(!result.ok, line);
    assert.ok(!JSON.stringify(result.error).includes(secret), line);
  }
});
