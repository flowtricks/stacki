// Exercise the desktop defaults canvas boundary through its registered IPC handlers.
// Real temporary files verify creation, cleanup, path restrictions, and symlink rejection.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerProjectMetadataHandlers } = require('#dist/electron/handlers/projectMetadataHandlers.js');
const { parseIpcPayload } = require('#dist/shared/ipc/ipcPayloads.js');
test('desktop creates and removes only bounded temporary defaults canvases', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-defaults-canvas-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handlers = new Map();
  registerProjectMetadataHandlers({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    assertInProject: (file) => assert.ok(file.startsWith(fs.realpathSync(root) + path.sep)),
  });
  const invoke = (channel, input) => handlers.get(channel)(undefined, parseIpcPayload(channel, input));
  const file = '.stacki/canvas/12345678-1234-1234-1234-123456789012.astro';
  const canvas = { file, source: '<main>Starting content</main>' };
  assert.deepEqual(invoke('project:createDefaultsCanvas', { projectPath: root, canvas }), { file });
  assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), canvas.source);
  assert.throws(() => invoke('project:createDefaultsCanvas', { projectPath: root, canvas }));
  invoke('project:removeDefaultsCanvas', { projectPath: root, file });
  assert.equal(fs.existsSync(path.join(root, file)), false);
  assert.throws(
    () =>
      invoke('project:removeDefaultsCanvas', {
        projectPath: root,
        file: 'src/components/Button.astro',
      }),
    /Invalid/,
  );
  fs.rmSync(path.join(root, '.stacki/canvas'), { recursive: true });
  fs.mkdirSync(path.join(root, 'outside'));
  fs.symlinkSync(path.join(root, 'outside'), path.join(root, '.stacki/canvas'));
  assert.throws(() => invoke('project:createDefaultsCanvas', { projectPath: root, canvas }), /symbolic/);
});
