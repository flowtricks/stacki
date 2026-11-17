// Goal: the MCP server is the CLI commands and nothing else: its tool list matches the command table for the pinned role, a write tool plans
// first and applies only on request, errors have the JSON-RPC shapes, and no tool input can change the role the server is pinned to.
// Method: a McpSession is driven message by message (no process, no stdio) on generated fixture projects, covering initialize, tools/list for the
// owner and for a read-only role, tools/call dry run then apply, a role-denied call, unknown tools, bad arguments, notifications and malformed JSON-RPC,
// a project with roles and no pinned role (no tool runs, never admin by default), the deletion confirmation in tool terms, and the list_changed
// notification a new settings file owes.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { handleLine, McpSession } from '#dist/electron/project/cli/mcpServer.js';
import { COMMANDS, toolNameOf } from '#dist/shared/properties/cli/stackiCommands.js';
import { makeProject, readText, removeProjects, ROLES_FIXTURE } from '../../../helpers/cliProject.ts';

afterEach(removeProjects);

interface Reply {
  readonly id?: number;
  readonly result?: {
    readonly tools?: ReadonlyArray<{
      readonly name: string;
      readonly description: string;
      readonly inputSchema: { readonly properties: Record<string, unknown> };
    }>;
    readonly structuredContent?: { readonly ok: boolean; readonly mode?: string; readonly error?: { readonly code: string } };
    readonly isError?: boolean;
    readonly resources?: ReadonlyArray<{ readonly uri: string }>;
    readonly protocolVersion?: string;
  };
  readonly error?: { readonly code: number; readonly message: string };
}

function parseReply(value: unknown): Reply | undefined {
  // The reply is JSON written by the server; the round trip through text makes it the plain data a client reads.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- a test reads the server's own JSON reply as the typed shape its assertions name
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

async function send(session: McpSession, message: unknown): Promise<Reply | undefined> {
  const reply: unknown = await handleLine(session, JSON.stringify(message));
  return reply === undefined ? undefined : parseReply(reply);
}

const call = (id: number, name: string, args: Record<string, unknown>) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

test('initialize answers a supported protocol version and notifications get no reply', async () => {
  const session = new McpSession({ project: makeProject() });
  const reply = await send(session, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  assert.equal(reply?.result?.protocolVersion, '2024-11-05');
  assert.equal(await send(session, { jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
});

test('tools/list is the command table for the owner, and every write tool tells the agent to plan first', async () => {
  const session = new McpSession({ project: makeProject() });
  const reply = await send(session, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = (reply?.result?.tools ?? []).map((tool) => tool.name);
  assert.deepEqual(names, COMMANDS.map(toolNameOf));
  for (const tool of reply?.result?.tools ?? []) {
    const spec = COMMANDS.find((entry) => toolNameOf(entry) === tool.name);
    if (spec?.access === 'write') {
      assert.match(tool.description, /DRY RUN/);
      assert.match(tool.description, /only after they approve/);
      assert.ok('apply' in tool.inputSchema.properties);
    } else {
      assert.ok(!('apply' in tool.inputSchema.properties));
    }
  }
});

test('a server pinned to a read-only role lists only the tools that role may run', async () => {
  const root = makeProject({ '.stacki/roles.json': ROLES_FIXTURE });
  const session = new McpSession({ project: root, role: 'viewer' });
  const names = ((await send(session, { jsonrpc: '2.0', id: 3, method: 'tools/list' }))?.result?.tools ?? []).map((tool) => tool.name);
  assert.ok(names.includes('stacki_schema') && names.includes('stacki_doctor'));
  assert.ok(!names.includes('stacki_guides_set') && !names.includes('stacki_roles_add') && !names.includes('stacki_config_set'));
});

test('tools/call plans by default, applies on request, and re-checks the role', async () => {
  const root = makeProject({ '.stacki/roles.json': ROLES_FIXTURE });
  const owner = new McpSession({ project: root, role: 'admin' });
  const plan = await send(owner, call(4, 'stacki_guides_set', { visible: true }));
  assert.equal(plan?.result?.structuredContent?.mode, 'plan');
  assert.equal(readText(root, '.stacki/guide.json'), undefined);
  const applied = await send(owner, call(5, 'stacki_guides_set', { visible: true, apply: true }));
  assert.equal(applied?.result?.structuredContent?.mode, 'apply');
  assert.ok(readText(root, '.stacki/guide.json') !== undefined);
  const viewer = new McpSession({ project: root, role: 'viewer' });
  const denied = await send(viewer, call(6, 'stacki_breakpoints_add', { name: 'X', value: 100, unit: 'rem', apply: true }));
  assert.equal(denied?.result?.isError, true);
  assert.equal(denied?.result?.structuredContent?.error?.code, 'role-denied');
  assert.equal(readText(root, '.stacki/breakpoints.json'), undefined);
});

test('a tool input cannot change the pinned role or smuggle an option', async () => {
  const root = makeProject({ '.stacki/roles.json': ROLES_FIXTURE });
  const viewer = new McpSession({ project: root, role: 'viewer' });
  const reply = await send(viewer, call(7, 'stacki_guides_set', { visible: true, role: 'admin', apply: true }));
  assert.equal(reply?.result?.structuredContent?.ok, false);
  assert.equal(readText(root, '.stacki/guide.json'), undefined);
  const bad = await send(new McpSession({ project: root, role: 'admin' }), call(8, 'stacki_guides_set', { opacity: 'loud' }));
  assert.equal(bad?.result?.structuredContent?.error?.code, 'usage');
});

test('error shapes: unknown tool, unknown method, invalid request and malformed JSON', async () => {
  const session = new McpSession({ project: makeProject() });
  assert.equal((await send(session, call(9, 'stacki_nothing', {})))?.error?.code, -32602);
  assert.equal((await send(session, { jsonrpc: '2.0', id: 10, method: 'nope' }))?.error?.code, -32601);
  assert.equal((await send(session, { id: 11, method: 'ping' }))?.error?.code, -32600);
  assert.equal(parseReply(await handleLine(session, '{not json'))?.error?.code, -32700);
  assert.equal((await send(session, { jsonrpc: '2.0', id: 12, method: 'ping' }))?.error, undefined);
});

test('resources list the key references and the current files', async () => {
  const root = makeProject({ '.stacki/styles.json': '{ "version": 1 }\n' });
  const session = new McpSession({ project: root });
  const uris = ((await send(session, { jsonrpc: '2.0', id: 13, method: 'resources/list' }))?.result?.resources ?? []).map((resource) => resource.uri);
  assert.ok(uris.includes('stacki://schema/guide'));
  assert.ok(uris.includes('stacki://state/styles'));
  assert.ok(!uris.includes('stacki://state/guide'), 'a file that does not exist has no state resource');
  const read = await send(session, { jsonrpc: '2.0', id: 14, method: 'resources/read', params: { uri: 'stacki://schema/guide' } });
  assert.ok(JSON.stringify(read).includes('settings'));
});

test('a project with roles.json and no pinned role runs no tool: the server never falls back to admin', async () => {
  const root = makeProject({ '.stacki/roles.json': ROLES_FIXTURE });
  const session = new McpSession({ project: root });
  const tools = (await send(session, { jsonrpc: '2.0', id: 15, method: 'tools/list' }))?.result?.tools ?? [];
  assert.equal(tools.length, 0);
  const refused = await send(session, call(16, 'stacki_guides_set', { visible: true, apply: true }));
  assert.equal(refused?.result?.isError, true);
  assert.equal(refused?.result?.structuredContent?.error?.code, 'usage');
  assert.match(JSON.stringify(refused), /needs a role: start it with --role/);
  assert.equal(readText(root, '.stacki/guide.json'), undefined);
});

test('a deletion without yes tells the agent the tool inputs, not the shell flags', async () => {
  const root = makeProject();
  const session = new McpSession({ project: root });
  await send(session, call(17, 'stacki_breakpoints_add', { name: 'Wide', value: 100, unit: 'rem', apply: true }));
  const refused = await send(session, call(18, 'stacki_breakpoints_remove', { id: 'bp-1', apply: true }));
  assert.equal(refused?.result?.structuredContent?.error?.code, 'confirmation-required');
  const text = JSON.stringify(refused);
  assert.match(text, /apply=true and yes=true/);
  assert.doesNotMatch(text, /--apply --yes/);
});

test('an apply that creates a settings file owes one resources/list_changed notification', async () => {
  const root = makeProject();
  const session = new McpSession({ project: root });
  await send(session, { jsonrpc: '2.0', id: 19, method: 'resources/list' });
  assert.deepEqual(session.takeNotifications(), []);
  await send(session, call(20, 'stacki_guides_set', { visible: true }));
  assert.deepEqual(session.takeNotifications(), [], 'a plan changes nothing, so nothing is announced');
  await send(session, call(21, 'stacki_guides_set', { visible: true, apply: true }));
  assert.deepEqual(session.takeNotifications(), [{ jsonrpc: '2.0', method: 'notifications/resources/list_changed' }]);
});
