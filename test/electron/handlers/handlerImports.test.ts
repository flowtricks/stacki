// Goal: the modules main.ts hands its IPC to reach electron only through main.
// The main harness (test/helpers/mainHarness.ts) runs main.js with a stand-in
// electron, but every module main.js requires gets Node's own require, where
// `electron` is the path of its binary: a handler module that imported
// `shell` or `dialog` would hold undefined there, and in the app it would skip
// what main.ts decides about the window. So electron's values come in through
// the host (electron/handlers/mainHost.ts), and these modules import electron
// for its types alone.
// Method: read every module in electron/handlers and the auto-update module,
// and require each import of electron or electron-updater to be `import type`.
// One known-bad line is checked too, so the pattern cannot pass vacuously.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

const HANDLERS = path.resolve('electron/handlers');
const MODULES_MAX = 100;
const ELECTRON_VALUE_IMPORT = /^import(?!\s+type\b)[^;]*from\s+'electron(?:-updater)?';/gm;

function hostedModules(): readonly string[] {
  const names = fs.readdirSync(HANDLERS).filter((name) => name.endsWith('.ts'));
  assert.ok(names.length > 0, 'electron/handlers holds the handler modules');
  assert.ok(names.length < MODULES_MAX, 'electron/handlers is a bounded folder');
  return [...names.map((name) => path.join('electron/handlers', name)), 'electron/app/autoUpdate.ts'];
}

test('the pattern finds a value import and passes a type import', () => {
  assert.equal("import { shell } from 'electron';".match(ELECTRON_VALUE_IMPORT)?.length, 1);
  assert.deepEqual("import type { Shell } from 'electron';".match(ELECTRON_VALUE_IMPORT) ?? [], []);
});

test('handler modules import electron for its types alone', () => {
  for (const file of hostedModules()) {
    const text = fs.readFileSync(file, 'utf8');
    assert.deepEqual(text.match(ELECTRON_VALUE_IMPORT) ?? [], [], `${file} imports electron`);
  }
});
