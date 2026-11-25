// Exercise the desktop defaults canvas boundary through its registered IPC handlers.
// Real temporary files verify creation, retiring on close (an empty page, deleted when the next canvas opens), path
// restrictions, and symlink rejection.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RETIRED_CANVAS_SOURCE, registerProjectMetadataHandlers } = require('#dist/electron/handlers/projectMetadataHandlers.js');
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
  // Closing empties the page rather than deleting it: the dev server may still be asked for it (projectMetadataHandlers.ts).
  assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), RETIRED_CANVAS_SOURCE);
  invoke('project:removeDefaultsCanvas', { projectPath: root, file });
  assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), RETIRED_CANVAS_SOURCE, 'closing twice changes nothing');
  // The next canvas deletes the retired page and keeps any page still open.
  const open = '.stacki/canvas/22345678-1234-1234-1234-123456789012.astro';
  invoke('project:createDefaultsCanvas', { projectPath: root, canvas: { file: open, source: canvas.source } });
  const next = '.stacki/canvas/32345678-1234-1234-1234-123456789012.astro';
  invoke('project:createDefaultsCanvas', { projectPath: root, canvas: { file: next, source: canvas.source } });
  assert.equal(fs.existsSync(path.join(root, file)), false);
  assert.equal(fs.readFileSync(path.join(root, open), 'utf8'), canvas.source);
  invoke('project:removeDefaultsCanvas', { projectPath: root, file: open });
  invoke('project:removeDefaultsCanvas', { projectPath: root, file: next });
  // Removing a page that is already gone is not an error.
  fs.rmSync(path.join(root, next));
  invoke('project:removeDefaultsCanvas', { projectPath: root, file: next });
  assert.equal(fs.existsSync(path.join(root, next)), false);
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
