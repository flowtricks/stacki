// Goal: main refuses the write paths a project's role hides, before the handler
// runs, while admin, a missing file and a broken file keep every path open; and
// Desktop's GitHub identity is the signed-in publishing account, else gh's active one.
// Method: register real handlers' shape on the real IPC registrar with the real role
// gate over a temporary project holding `.stacki/roles.json`, inject the GitHub
// login instead of running `gh`, invoke gated and ungated channels, and check
// which handlers ran. The channel table and `gh auth status` reader are checked directly.
// The terminal's channels are registered the same way: starting a shell is code editing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createIpcRegistrar } from '#dist/electron/lib/ipcRegistrar.js';
import { createRoleGate, desktopRole, identityFromStatus } from '#dist/electron/handlers/roleAccess.js';
import { CHANNEL_ACCESS, channelAccess } from '#dist/electron/handlers/channelAccess.js';

// Electron's own listener type; the test calls it with a bare event, which these handlers never read.
type Listener = Parameters<Pick<Electron.IpcMain, 'handle'>['handle']>[1];

function project(roles: unknown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-roles-gate-'));
  if (roles !== undefined) {
    fs.mkdirSync(path.join(root, '.stacki'));
    fs.writeFileSync(path.join(root, '.stacki/roles.json'), typeof roles === 'string' ? roles : JSON.stringify(roles));
  }
  return root;
}

function harness(root: string, login: string | undefined) {
  const handlers = new Map<string, Listener>();
  const ran: string[] = [];
  const gate = createRoleGate({ openRoot: () => root, identity: async () => login });
  const handle = createIpcRegistrar(
    {
      handle: (channel: string, listener: Listener) => {
        handlers.set(channel, listener);
      },
    },
    () => gate,
  );
  handle('page:delete', () => {
    ran.push('page:delete');
    return { ok: true };
  });
  handle('src:writeText', () => {
    ran.push('src:writeText');
    return { ok: true };
  });
  handle('recents:remove', () => {
    ran.push('recents:remove');
    return { ok: true };
  });
  handle('terminal:start', (_event, payload) => {
    ran.push('terminal:start');
    return { ok: true, id: payload.id };
  });
  handle('terminal:close', () => {
    ran.push('terminal:close');
    return { ok: true };
  });
  const invoke = async (channel: string, input: unknown) => {
    const listener = handlers.get(channel);
    assert.ok(listener, channel);
    const result: unknown = await Reflect.apply(listener, undefined, [{}, input]);
    return result;
  };
  return { ran, invoke };
}

const roles = {
  version: 1,
  roles: [
    { id: 'admin', name: 'Admin', members: ['owner'] },
    { id: 'client', name: 'Client', members: ['Acme'] },
    { id: 'viewer', name: 'Viewer', members: ['sam'], access: ['panel:pages'] },
  ],
};

test('a client is refused a hidden write path in main, and its handler never runs', async (context) => {
  const root = project(roles);
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const client = harness(root, 'acme');
  await assert.rejects(client.invoke('src:writeText', { projectPath: root, rel: 'src/pages/index.astro', text: 'x' }), /Your role \(Client\) cannot do this/);
  assert.deepEqual(client.ran, []);
  // A client may delete pages by default, and reads are never gated.
  await client.invoke('page:delete', path.join(root, 'src/pages/about.astro'));
  await client.invoke('recents:remove', root);
  assert.deepEqual(client.ran, ['page:delete', 'recents:remove']);
});

test('a path-only payload is gated by the open project’s roles', async (context) => {
  const root = project(roles);
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const viewer = harness(root, 'Sam');
  await assert.rejects(viewer.invoke('page:delete', path.join(root, 'src/pages/about.astro')), /Your role \(Viewer\) cannot do this/);
  assert.deepEqual(viewer.ran, []);
});

test('admin, a missing file, nobody signed in and a broken file keep every path open', async (context) => {
  const cases = [
    { root: project(roles), login: 'OWNER' },
    { root: project(undefined), login: 'acme' },
    { root: project(roles), login: undefined },
    { root: project('{ broken'), login: 'acme' },
  ];
  context.after(() => {
    for (const item of cases) {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });
  for (const item of cases) {
    const main = harness(item.root, item.login);
    await main.invoke('src:writeText', { projectPath: item.root, rel: 'src/pages/index.astro', text: 'x' });
    assert.deepEqual(main.ran, ['src:writeText']);
  }
});

test('Desktop keeps a person named in no role admin; a named role applies', async (context) => {
  const root = project(roles);
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal((await desktopRole(root, async () => 'stranger')).isAdmin, true);
  assert.equal((await desktopRole(root, async () => 'ACME')).id, 'client');
});

test('roles writes are admin-only, and each settings file names its feature', () => {
  assert.deepEqual(channelAccess('project:writeMetadata', { projectPath: '/p', write: { kind: 'roles', source: '{}' } }), ['settings:roles']);
  assert.deepEqual(channelAccess('project:writeMetadata', { projectPath: '/p', write: { kind: 'folders', source: '{}' } }), ['settings:folders']);
  assert.equal(channelAccess('project:writeMetadata', { projectPath: '/p', write: { kind: 'guide', source: '{}' } }), undefined);
  assert.equal(channelAccess('page:read', {}), undefined, 'reads are open');
  for (const [channel, features] of Object.entries(CHANNEL_ACCESS)) {
    assert.ok(features !== undefined && features.length > 0, channel);
  }
});

test('the identity is the signed-in publishing account, else the active account, else nobody', () => {
  const status = {
    hosts: {
      'github.com': [
        { login: 'personal', state: 'success', active: true },
        { login: 'Work', state: 'success', active: false },
        { login: 'stale', state: 'error', active: false },
      ],
    },
  };
  assert.equal(identityFromStatus(status, 'work'), 'Work');
  assert.equal(identityFromStatus(status, 'stale'), 'personal', 'an account signed out here is not the identity');
  assert.equal(identityFromStatus(status, ''), 'personal');
  assert.equal(identityFromStatus({ hosts: {} }, ''), undefined);
});

test('the terminal is refused to a role without code editing, before any shell starts', async (context) => {
  const root = project(roles);
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const start = { id: 'shell', cwd: root, cols: 80, rows: 24 };
  const client = harness(root, 'acme');
  await assert.rejects(client.invoke('terminal:start', start), /Your role \(Client\) cannot do this/);
  const viewer = harness(root, 'sam');
  await assert.rejects(viewer.invoke('terminal:start', start), /Your role \(Viewer\) cannot do this/);
  assert.deepEqual([...client.ran, ...viewer.ran], []);
  // Closing reaches only a shell that was allowed to start, so it stays open to every role.
  await client.invoke('terminal:close', { id: 'shell' });
  assert.deepEqual(client.ran, ['terminal:close']);
});

test('admin, and on Desktop a person named in no role, may start the terminal', async (context) => {
  const coder = { ...roles, roles: [...roles.roles, { id: 'coder', name: 'Coder', members: ['dev'], access: ['code:edit'] }] };
  const root = project(coder);
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const start = { id: 'shell', cwd: root, cols: 80, rows: 24 };
  for (const login of ['owner', 'dev', 'stranger', undefined]) {
    const main = harness(root, login);
    assert.deepEqual(await main.invoke('terminal:start', start), { ok: true, id: 'shell' }, String(login));
    assert.deepEqual(main.ran, ['terminal:start']);
  }
  assert.deepEqual(channelAccess('terminal:start', start), ['code:edit']);
  assert.deepEqual(channelAccess('terminal:clipboardImage', { bytes: new Uint8Array(1), mime: 'image/png' }), ['code:edit']);
  assert.equal(channelAccess('terminal:resize', { id: 'shell', cols: 80, rows: 24 }), undefined);
});
