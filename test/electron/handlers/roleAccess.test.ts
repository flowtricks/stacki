// Goal: Desktop never refuses a write because of a role. It previews roles ("View as") and Studio's
// server enforces them, so a person named in a non-admin role, a stranger and a signed-out
// person all reach every handler. Also: Desktop's GitHub identity is the signed-in publishing
// account, else gh's active one; it names the person but grants nothing.
// Method: register a write handler on the real IPC registrar (the one main uses, which takes no
// gate) over a project whose roles.json names the caller as a Client, invoke it, and check it
// ran; the `gh auth status` reader is checked directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createIpcRegistrar } from '#dist/electron/lib/ipcRegistrar.js';
import { identityFromStatus } from '#dist/electron/handlers/roleAccess.js';

// Electron's own listener type; the test calls it with a bare event, which these handlers never read.
type Listener = Parameters<Pick<Electron.IpcMain, 'handle'>['handle']>[1];

test('a person named in a non-admin role still reaches a write handler on Desktop', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-roles-desktop-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.stacki'));
  const roles = {
    version: 1,
    roles: [
      { id: 'admin', name: 'Admin', members: ['someone-else'] },
      { id: 'client', name: 'Client', members: ['owner'], access: ['panel:pages'] },
    ],
  };
  fs.writeFileSync(path.join(root, '.stacki/roles.json'), JSON.stringify(roles));
  const handlers = new Map<string, Listener>();
  const handle = createIpcRegistrar({
    handle: (channel: string, listener: Listener) => {
      handlers.set(channel, listener);
    },
  });
  const ran: string[] = [];
  handle('src:writeText', () => {
    ran.push('src:writeText');
    return { ok: true };
  });
  handle('project:writeMetadata', () => {
    ran.push('project:writeMetadata');
    return { ok: true, value: { source: '{}' } };
  });
  const write = handlers.get('src:writeText');
  assert.ok(write);
  await Reflect.apply(write, undefined, [{}, { projectPath: root, rel: 'src/pages/index.astro', text: 'x' }]);
  const metadata = handlers.get('project:writeMetadata');
  assert.ok(metadata);
  await Reflect.apply(metadata, undefined, [{}, { projectPath: root, write: { kind: 'roles', source: '{}' } }]);
  assert.deepEqual(ran, ['src:writeText', 'project:writeMetadata'], 'no role refuses a Desktop write, roles.json included');
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
