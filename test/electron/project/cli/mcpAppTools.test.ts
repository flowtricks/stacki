// Goal: the MCP server serves an installed app's commands as tools exactly as the shell runs them, and follows the project as it changes: an enabled
// app adds tools and a schema resource, `apps disable` removes them on the very next call, and a role sees only what it may run.
// Method: a McpSession is driven message by message on a generated fixture project with a fixture app. tools/list is read before and after the app
// is disabled and enabled through the server itself (which owes a tools/list_changed notification); tools/call is a dry run, then an apply; a viewer's list and call are checked; resources/list
// and resources/read name the app's declared settings file.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { handleLine, McpSession } from '#dist/electron/project/cli/mcpServer.js';
import { dig, parseJson } from '../../../helpers/cliJson.ts';
import { APP_ROLES_FIXTURE, installApp, listOf, notesProject } from '../../../helpers/cliApp.ts';
import { readText, removeProjects } from '../../../helpers/cliProject.ts';

afterEach(removeProjects);

async function send(session: McpSession, id: number, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const reply: unknown = await handleLine(session, JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  return parseJson(JSON.stringify(reply));
}

const toolNames = async (session: McpSession): Promise<string[]> => {
  const reply = await send(session, 1, 'tools/list');
  return listOf(dig(reply, 'result', 'tools')).map((tool) => String(dig(tool, 'name')));
};

test('tools/list shows the app commands, drops them after apps disable, and brings them back after apps enable', async () => {
  const root = notesProject();
  const session = new McpSession({ project: root });
  const before = await toolNames(session);
  assert.ok(before.includes('stacki_notes_set-title'));
  assert.ok(before.includes('stacki_notes_shout'));
  const listed = await send(session, 2, 'tools/list');
  const tool = listOf(dig(listed, 'result', 'tools')).find((entry) => dig(entry, 'name') === 'stacki_notes_set-title');
  assert.match(String(dig(tool, 'description')), /DRY RUN/);
  assert.equal(dig(tool, 'inputSchema', 'properties', 'title', 'type'), 'string');
  assert.deepEqual(dig(tool, 'inputSchema', 'required'), ['title']);
  const disabled = await send(session, 3, 'tools/call', { name: 'stacki_apps_disable', arguments: { app: 'notes', apply: true } });
  assert.equal(dig(disabled, 'result', 'isError'), false);
  // The server said in initialize that it announces tool-list changes, so disabling the app owes exactly one notification.
  const owed = session.takeNotifications().map((message) => dig(message, 'method'));
  assert.deepEqual(
    owed.filter((method) => method === 'notifications/tools/list_changed'),
    ['notifications/tools/list_changed'],
  );
  assert.deepEqual(session.takeNotifications(), [], 'a notification is sent once');
  const after = await toolNames(session);
  assert.equal(
    after.some((name) => name.startsWith('stacki_notes_')),
    false,
    'the next call no longer lists the app',
  );
  const gone = await send(session, 4, 'tools/call', { name: 'stacki_notes_set-title', arguments: { title: 'x' } });
  assert.ok(dig(gone, 'error') !== undefined, 'a tool that is not listed is unknown');
  await send(session, 5, 'tools/call', { name: 'stacki_apps_enable', arguments: { app: 'notes', apply: true } });
  assert.ok((await toolNames(session)).includes('stacki_notes_set-title'));
});

test('tools/call plans first, then applies; a tool call cannot choose the role', async () => {
  const root = notesProject();
  const session = new McpSession({ project: root });
  const plan = await send(session, 6, 'tools/call', { name: 'stacki_notes_set-title', arguments: { title: 'From MCP' } });
  assert.equal(dig(plan, 'result', 'structuredContent', 'mode'), 'plan');
  assert.equal(readText(root, '.stacki/apps/notes/settings.json'), undefined);
  const applied = await send(session, 7, 'tools/call', { name: 'stacki_notes_set-title', arguments: { title: 'From MCP', apply: true } });
  assert.equal(dig(applied, 'result', 'structuredContent', 'applied'), true);
  assert.equal(dig(parseJson(readText(root, '.stacki/apps/notes/settings.json')), 'title'), 'From MCP');
  const module = await send(session, 8, 'tools/call', { name: 'stacki_notes_shout', arguments: { apply: true } });
  assert.equal(dig(module, 'result', 'isError'), false, JSON.stringify(module));
  assert.equal(dig(parseJson(readText(root, '.stacki/apps/notes/settings.json')), 'title'), 'FROM MCP');
  const unknownInput = await send(session, 9, 'tools/call', { name: 'stacki_notes_set-title', arguments: { title: 'x', role: 'admin' } });
  assert.equal(dig(unknownInput, 'result', 'structuredContent', 'ok'), false);
});

test('a role sees and may call only the app tools it is allowed', async () => {
  const root = notesProject({ extra: { '.stacki/roles.json': APP_ROLES_FIXTURE } });
  const viewer = new McpSession({ project: root, role: 'viewer' });
  assert.equal(
    (await toolNames(viewer)).some((name) => name.startsWith('stacki_notes_')),
    false,
  );
  const blocked = await send(viewer, 10, 'tools/call', { name: 'stacki_notes_set-title', arguments: { title: 'x', apply: true } });
  assert.ok(dig(blocked, 'error') !== undefined);
  assert.equal(readText(root, '.stacki/apps/notes/settings.json'), undefined);
  const editor = new McpSession({ project: root, role: 'editor' });
  const names = await toolNames(editor);
  assert.ok(names.includes('stacki_notes_set-title'));
  assert.ok(names.includes('stacki_notes_clear-title'), 'the permission switch is on for this role');
  const noswitch = new McpSession({ project: root, role: 'noswitch' });
  assert.equal((await toolNames(noswitch)).includes('stacki_notes_clear-title'), false);
});

test('the app settings file is a schema resource while the app is enabled, and follows an install', async () => {
  const root = notesProject();
  const session = new McpSession({ project: root });
  const listed = await send(session, 11, 'resources/list');
  const uris = listOf(dig(listed, 'result', 'resources')).map((entry) => String(dig(entry, 'uri')));
  assert.ok(uris.includes('stacki://schema/notes.settings'));
  const read = await send(session, 12, 'resources/read', { uri: 'stacki://schema/notes.settings' });
  const text = String(dig(read, 'result', 'contents', 0, 'text'));
  assert.equal(dig(parseJson(text), 'keys', 'pageSize', 'type'), 'integer 1..100');
  installApp(root, {
    id: 'other',
    manifest: {
      cli: {
        apiVersion: 1,
        files: [{ id: 'other.prefs', path: '.stacki/other.json', description: 'Prefs.', keys: { on: { type: { kind: 'boolean' }, description: 'On.' } } }],
      },
    },
  });
  await send(session, 13, 'tools/call', { name: 'stacki_apps_enable', arguments: { app: 'other', apply: true } });
  const again = await send(session, 14, 'resources/list');
  assert.ok(listOf(dig(again, 'result', 'resources')).some((entry) => dig(entry, 'uri') === 'stacki://schema/other.prefs'));
});
