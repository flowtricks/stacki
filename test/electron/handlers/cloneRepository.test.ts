// Goal: a failed clone does not block the next try. The folder a clone goes into is made first, so a clone that wrote
// nothing must take it away again, or every later try at the same repository fails because the folder exists.
// A folder that was already there, or one the failed clone wrote into, is never removed.
// Methodology: the real folder handling on a temporary folder, with the clone itself stood in for; no gh, no network.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { cloneIntoNewFolder } from '#dist/electron/handlers/gitRepositoryHandlers.js';

const offline = async () => {
  throw new Error('could not resolve host');
};

function parent(context: { readonly after: (fn: () => void) => void }): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-clone-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('a clone that wrote nothing leaves no folder, so the next try works', async (context) => {
  const target = path.join(parent(context), 'site');
  await assert.rejects(cloneIntoNewFolder(target, offline), /could not resolve host/);
  assert.ok(!fs.existsSync(target));
  await cloneIntoNewFolder(target, async () => fs.writeFileSync(path.join(target, 'package.json'), '{}'));
  assert.ok(fs.existsSync(path.join(target, 'package.json')));
});

test('what a failed clone wrote is kept', async (context) => {
  const target = path.join(parent(context), 'site');
  const partial = async () => {
    fs.writeFileSync(path.join(target, 'kept.txt'), 'partial');
    throw new Error('checkout failed');
  };
  await assert.rejects(cloneIntoNewFolder(target, partial), /checkout failed/);
  assert.equal(fs.readFileSync(path.join(target, 'kept.txt'), 'utf8'), 'partial');
});

test('a folder that already exists is refused and left alone, even when empty', async (context) => {
  const target = path.join(parent(context), 'site');
  fs.mkdirSync(target);
  let ran = false;
  await assert.rejects(
    cloneIntoNewFolder(target, async () => {
      ran = true;
    }),
    /EEXIST/,
  );
  assert.equal(ran, false);
  assert.ok(fs.existsSync(target));
});
