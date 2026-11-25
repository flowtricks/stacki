// Goal: the MCP wire contract parses what the renderer and main send each other and refuses everything
// else: a change, a Codex change, file text, a listing, Codex's state, and a result, each with a
// known-good and each known-bad shape, with bounds and no value in an error.
// Method: one known-good per contract and a table of bad shapes per parser; the channels' payloads go
// through the real IPC payload parser as well, so a missing channel entry fails here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseIpcPayload } from '#dist/shared/ipc/ipcPayloads.js';
import {
  MCP_ERROR_CODES,
  parseMcpChange,
  parseMcpCodexChange,
  parseMcpCodexState,
  parseMcpListing,
  parseMcpResult,
  parseMcpServerName,
  parseMcpText,
  parseMcpTextInput,
} from '#dist/shared/properties/mcp.js';
import { MCP_LIMITS } from '#dist/shared/properties/mcpConfig.js';

const REVISION = 'a'.repeat(64);
const CONFIG = { transport: 'http', url: 'https://mcp.sanity.io', headers: [] };
const SECRET = 'secret-value-never-in-errors';

test('a change is an add, an update or a remove with a valid name and, for the first two, a valid server', () => {
  assert.deepEqual(parseMcpChange({ kind: 'add', name: 'Sanity', config: CONFIG }), { kind: 'add', name: 'Sanity', config: CONFIG });
  assert.deepEqual(parseMcpChange({ kind: 'update', name: 'a.b-c_1', config: CONFIG }).kind, 'update');
  assert.deepEqual(parseMcpChange({ kind: 'remove', name: 'Sanity' }), { kind: 'remove', name: 'Sanity' });
  const bad: readonly unknown[] = [
    undefined,
    { kind: 'add', name: 'Sanity' },
    { kind: 'add', name: 'bad name', config: CONFIG },
    { kind: 'add', name: 'x', config: { transport: 'http', url: 'ftp://x' } },
    { kind: 'add', name: 'x', config: { transport: 'stdio', command: '' } },
    { kind: 'remove' },
    { kind: 'remove', name: 'x'.repeat(MCP_LIMITS.nameCharsMax + 1) },
    { kind: 'rename', name: 'x' },
  ];
  for (const input of bad) {
    assert.throws(() => parseMcpChange(input));
  }
});

test('a Codex change names a server only; it can never carry a configuration or a path', () => {
  assert.deepEqual(parseMcpCodexChange({ kind: 'put', name: 'Sanity' }), { kind: 'put', name: 'Sanity' });
  assert.deepEqual(parseMcpCodexChange({ kind: 'remove', name: 'Sanity', config: CONFIG, path: '/etc/passwd' }), { kind: 'remove', name: 'Sanity' });
  for (const input of [{ kind: 'put' }, { kind: 'put', name: '../x' }, { kind: 'add', name: 'x' }, 'put']) {
    assert.throws(() => parseMcpCodexChange(input));
  }
});

test('server names and file text are bounded', () => {
  assert.equal(parseMcpServerName('ok'), 'ok');
  assert.throws(() => parseMcpServerName(7));
  assert.equal(parseMcpTextInput(''), '');
  assert.throws(() => parseMcpTextInput('x'.repeat(MCP_LIMITS.fileBytesMax + 1)));
  assert.throws(() => parseMcpTextInput(undefined));
});

test('a listing parses summaries and invalid entries and refuses anything else', () => {
  const summary = { transport: 'http', host: 'mcp.sanity.io', headers: [{ name: 'A', reference: undefined }], secretNames: [] };
  const good = {
    revision: REVISION,
    exists: true,
    servers: [
      { name: 'Sanity', status: 'server', summary },
      { name: 'x', status: 'invalid', problem: { code: 'bad-url', path: 'mcpServers.x.url' } },
    ],
  };
  assert.deepEqual(parseMcpListing(good).servers.length, 2);
  const many = { ...good, servers: Array.from({ length: MCP_LIMITS.serversMax + 1 }, () => good.servers[0]) };
  const bad: readonly unknown[] = [
    undefined,
    { ...good, exists: 'yes' },
    { ...good, revision: 7 },
    { ...good, servers: 'no' },
    many,
    { ...good, servers: [{ name: 'x', status: 'unknown' }] },
    { ...good, servers: [{ name: '', status: 'server', summary }] },
    { ...good, servers: [{ name: 'x', status: 'invalid', problem: { code: 'nope', path: '' } }] },
    { ...good, servers: [{ name: 'x', status: 'server', summary: { transport: 'ws' } }] },
    { ...good, servers: [{ name: 'x', status: 'server', summary: { ...summary, headers: 'no' } }] },
  ];
  for (const input of bad) {
    assert.throws(() => parseMcpListing(input));
  }
});

test('file text replies and Codex states parse and refuse', () => {
  assert.equal(parseMcpText({ revision: REVISION, exists: false, text: '' }).exists, false);
  assert.throws(() => parseMcpText({ revision: REVISION, exists: false }));
  assert.deepEqual(parseMcpCodexState({ state: 'missing' }), { state: 'missing' });
  assert.deepEqual(parseMcpCodexState({ state: 'unavailable', code: 'denied' }), { state: 'unavailable', code: 'denied' });
  assert.equal(parseMcpCodexState({ state: 'ready', revision: REVISION, servers: [] }).state, 'ready');
  for (const input of [{ state: 'unavailable', code: 'filesystem' }, { state: 'ready', revision: REVISION }, { state: 'other' }, undefined]) {
    assert.throws(() => parseMcpCodexState(input));
  }
});

test('a result is a value or a failure with a known code and a short fixed message', () => {
  assert.deepEqual(
    parseMcpResult({ ok: true, value: 'v' }, (value) => String(value)),
    { ok: true, value: 'v' },
  );
  for (const code of MCP_ERROR_CODES) {
    assert.deepEqual(parseMcpResult({ ok: false, error: { code, message: 'm' } }, String), { ok: false, error: { code, message: 'm' } });
  }
  assert.throws(() => parseMcpResult({ ok: false, error: { code: 'weird', message: 'm' } }, String));
  assert.throws(() => parseMcpResult({ ok: 'maybe' }, String));
  assert.throws(() => parseMcpResult({ ok: false, error: { code: 'changed', message: 'x'.repeat(201) } }, String));
});

test('the channels take only what the parsers allow, and no error carries a pasted value', () => {
  const project = { projectPath: '/site' };
  assert.deepEqual(parseIpcPayload('mcp:read', project), project);
  assert.throws(() => parseIpcPayload('mcp:reveal', { ...project, revision: REVISION }));
  assert.throws(() => parseIpcPayload('mcp:reveal', { ...project, revision: 'short', name: 'x' }));
  assert.throws(() => parseIpcPayload('mcp:saveText', { ...project, revision: REVISION, text: 5 }));
  assert.deepEqual(
    parseIpcPayload('mcp:applyCodex', { ...project, revision: REVISION, projectRevision: REVISION, change: { kind: 'put', name: 'x' } }).change,
    { kind: 'put', name: 'x' },
  );
  try {
    parseIpcPayload('mcp:apply', {
      ...project,
      revision: REVISION,
      change: { kind: 'add', name: 'x', config: { transport: 'stdio', command: 'x', env: { K: SECRET, 'bad name': SECRET } } },
    });
    assert.fail('should throw');
  } catch (error: unknown) {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes(SECRET));
  }
});
