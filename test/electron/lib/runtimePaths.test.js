// Goal: every file the main process loads at run time is where it looks. The
// paths live in one module, electron/lib/runtimePaths.ts, written as the build
// output they name; a move that left one behind would break the packaged app
// only when that file was first needed.
// Method: load the built module and check that each path it returns exists
// in the build, and that the asar rewrite leaves an unpackaged path alone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { RUNTIME_PATHS, contentWorkerPath, resourcePath } = require('#dist/electron/lib/runtimePaths.js');

test('each runtime path names a file the build produced', () => {
  for (const [name, file] of Object.entries(RUNTIME_PATHS)) {
    assert.ok(fs.existsSync(file), `${name}: ${file}`);
    assert.ok(!file.includes('app.asar'), `${name}: an unpackaged build has no asar to unpack`);
  }
  assert.ok(fs.existsSync(resourcePath('icon.png')), 'the window icon');
  for (const worker of ['introspect.mjs', 'schemaTools.mjs']) {
    assert.ok(fs.existsSync(contentWorkerPath(worker)), worker);
  }
});
