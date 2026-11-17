// Goal: the main-process half of the Secrets tab reads and writes the project's dev env files
// safely, one file at a time, and marks the names a later file sets again: a
// missing file is the ordinary empty state; a create makes a private empty file; every change is
// written atomically against the revision it was authored on and refused with `changed` when the
// file moved; the existing mode is kept; real failures are named by category; no failure text
// holds a secret.
// Method: run the real functions over a temporary project directory with a stub `git`, set the
// file up by hand, change it behind the module's back, and read the bytes back.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { digestOf } from '#dist/electron/documents/atomicWrite.js';
import { applySecretsChange, ignoreEnvFile, listSecrets, readSecret } from '#dist/electron/content/envSecrets.js';

const SECRET = 'hunter2-never-in-errors';
const noGit = async (): Promise<unknown> => {
  throw Object.assign(new Error('git'), { code: 128 });
};
const notIgnored = async (): Promise<unknown> => {
  throw Object.assign(new Error('git'), { code: 1 });
};

function project(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'stacki-env-'));
}

async function listed(root: string) {
  const result = await listSecrets(root, '.env', noGit);
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}

test('a project with no .env is an empty list, not an error', async () => {
  const root = project();
  const listing = await listed(root);
  assert.equal(listing.exists, false);
  assert.deepEqual(listing.entries, []);
  assert.equal(listing.revision, digestOf(''));
  assert.equal(listing.ignore, 'unknown');
});

test('create makes an empty private .env once, and leaves an existing one alone', async () => {
  const root = project();
  const first = await listed(root);
  const created = await applySecretsChange(root, '.env', first.revision, { kind: 'create' }, noGit);
  assert.ok(created.ok);
  assert.equal(created.value.exists, true);
  assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), '');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(root, '.env')).mode & 0o777, 0o600);
  }
  fs.writeFileSync(path.join(root, '.env'), 'A=1\n');
  const again = await applySecretsChange(root, '.env', digestOf('A=1\n'), { kind: 'create' }, noGit);
  assert.ok(again.ok);
  assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), 'A=1\n');
});

test('adding to a missing file creates it private; later edits keep an existing mode', async () => {
  const root = project();
  const file = path.join(root, '.env');
  const added = await applySecretsChange(root, '.env', digestOf(''), { kind: 'add', name: 'A', value: SECRET }, noGit);
  assert.ok(added.ok);
  assert.equal(fs.readFileSync(file, 'utf8'), `A=${SECRET}\n`);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.chmodSync(file, 0o640);
    const updated = await applySecretsChange(root, '.env', added.value.revision, { kind: 'update', index: 0, name: 'A', value: 'x' }, noGit);
    assert.ok(updated.ok);
    assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  }
});

test('a change authored on an old revision is refused and writes nothing', async () => {
  const root = project();
  const file = path.join(root, '.env');
  fs.writeFileSync(file, '# top\nA=1\n');
  const before = await listed(root);
  fs.writeFileSync(file, '# top\nA=1\nB=2\n');
  const refused = await applySecretsChange(root, '.env', before.revision, { kind: 'remove', index: 0 }, noGit);
  assert.ok(!refused.ok);
  assert.equal(refused.error.code, 'changed');
  assert.equal(fs.readFileSync(file, 'utf8'), '# top\nA=1\nB=2\n');
  const read = readSecret(root, '.env', before.revision, 0);
  assert.ok(!read.ok);
  assert.equal(read.error.code, 'changed');
});

test('edits change only their line, through BOM and CRLF', async () => {
  const root = project();
  const file = path.join(root, '.env');
  fs.writeFileSync(file, '﻿# c\r\nexport A = "1" # n\r\nB=2');
  const listing = await listed(root);
  const result = await applySecretsChange(root, '.env', listing.revision, { kind: 'update', index: 0, name: 'A', value: '9' }, noGit);
  assert.ok(result.ok);
  assert.equal(fs.readFileSync(file, 'utf8'), '﻿# c\r\nexport A = "9" # n\r\nB=2');
  const gone = await applySecretsChange(root, '.env', result.value.revision, { kind: 'remove', index: 1 }, noGit);
  assert.ok(gone.ok);
  assert.equal(fs.readFileSync(file, 'utf8'), '﻿# c\r\nexport A = "9" # n\r\n');
});

test('values come back only from readSecret', async () => {
  const root = project();
  fs.writeFileSync(path.join(root, '.env'), `A=${SECRET}\n`);
  const listing = await listed(root);
  assert.ok(!JSON.stringify(listing).includes(SECRET));
  const read = readSecret(root, '.env', listing.revision, 0);
  assert.ok(read.ok);
  assert.equal(read.value.value, SECRET);
  const missing = readSecret(root, '.env', listing.revision, 5);
  assert.ok(!missing.ok);
  assert.equal(missing.error.code, 'not-found');
});

test('real read failures are named, and none of them holds a secret', async () => {
  const directory = project();
  fs.mkdirSync(path.join(directory, '.env'));
  const asDirectory = await listSecrets(directory, '.env', noGit);
  assert.ok(!asDirectory.ok);
  assert.equal(asDirectory.error.code, 'unreadable');

  const binary = project();
  fs.writeFileSync(path.join(binary, '.env'), Buffer.from([0x41, 0x3d, 0xff, 0xfe, 0x0a]));
  const notText = await listSecrets(binary, '.env', noGit);
  assert.ok(!notText.ok);
  assert.equal(notText.error.code, 'not-text');

  const large = project();
  fs.writeFileSync(path.join(large, '.env'), `# ${SECRET}${'x'.repeat(300 * 1024)}`);
  const tooLarge = await listSecrets(large, '.env', noGit);
  assert.ok(!tooLarge.ok);
  assert.equal(tooLarge.error.code, 'too-large');
  assert.ok(!tooLarge.error.message.includes(SECRET));

  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const locked = project();
    fs.writeFileSync(path.join(locked, '.env'), `A=${SECRET}\n`, { mode: 0o000 });
    const denied = await listSecrets(locked, '.env', noGit);
    assert.ok(!denied.ok);
    assert.equal(denied.error.code, 'denied');
    assert.ok(!denied.error.message.includes(SECRET));
  }
});

test('invalid changes come back as codes without touching the file', async () => {
  const root = project();
  const file = path.join(root, '.env');
  fs.writeFileSync(file, 'A=1\n');
  const revision = digestOf('A=1\n');
  const taken = await applySecretsChange(root, '.env', revision, { kind: 'add', name: 'A', value: SECRET }, noGit);
  assert.ok(!taken.ok);
  assert.equal(taken.error.code, 'name-taken');
  assert.ok(!taken.error.message.includes(SECRET));
  const gone = await applySecretsChange(root, '.env', revision, { kind: 'remove', index: 4 }, noGit);
  assert.ok(!gone.ok);
  assert.equal(gone.error.code, 'not-found');
  assert.equal(fs.readFileSync(file, 'utf8'), 'A=1\n');
});

test('ignore state is reported and .env is appended to .gitignore without rewriting it', async () => {
  const root = project();
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n# mine');
  const listing = await listSecrets(root, '.env', notIgnored);
  assert.ok(listing.ok);
  assert.equal(listing.value.ignore, 'not-ignored');
  const result = await ignoreEnvFile(root, '.env', notIgnored);
  assert.ok(result.ok);
  assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), 'node_modules\n# mine\n.env\n');
  const tracked = await listSecrets(root, '.env', async () => undefined);
  assert.ok(tracked.ok);
  assert.equal(tracked.value.ignore, 'tracked');
});

test('each dev env file is listed and changed on its own, and the others are left as they were', async () => {
  const root = project();
  fs.writeFileSync(path.join(root, '.env'), 'A=1\n');
  const local = await listSecrets(root, '.env.local', noGit);
  assert.ok(local.ok);
  assert.equal(local.value.file, '.env.local');
  assert.equal(local.value.exists, false);
  const added = await applySecretsChange(root, '.env.local', local.value.revision, { kind: 'add', name: 'B', value: SECRET }, noGit);
  assert.ok(added.ok);
  assert.equal(fs.readFileSync(path.join(root, '.env.local'), 'utf8'), `B=${SECRET}\n`);
  assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), 'A=1\n');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(root, '.env.local')).mode & 0o777, 0o600);
  }
  const read = readSecret(root, '.env.local', added.value.revision, 0);
  assert.ok(read.ok);
  assert.equal(read.value.value, SECRET);
  // A revision names one file's bytes: the other file's revision is refused.
  const crossed = readSecret(root, '.env', added.value.revision, 0);
  assert.ok(!crossed.ok);
  assert.equal(crossed.error.code, 'changed');
});

test('a name a later file sets again is marked with the last such file, from names alone', async () => {
  const root = project();
  fs.writeFileSync(path.join(root, '.env'), 'A=1\nB=2\nC=3\n');
  fs.writeFileSync(path.join(root, '.env.local'), `A=${SECRET}\n`);
  fs.writeFileSync(path.join(root, '.env.development'), 'A=dev\nB=dev\n');
  const base = await listed(root);
  assert.deepEqual(
    base.entries.map((entry) => [entry.name, entry.overriddenBy]),
    [
      ['A', '.env.development'],
      ['B', '.env.development'],
      ['C', undefined],
    ],
  );
  assert.ok(!JSON.stringify(base).includes(SECRET));
  // The last file in load order overrides nothing, and an earlier file never overrides a later one.
  const local = await listSecrets(root, '.env.local', noGit);
  assert.ok(local.ok);
  assert.equal(local.value.entries[0]?.overriddenBy, '.env.development');
  const last = await listSecrets(root, '.env.development', noGit);
  assert.ok(last.ok);
  assert.ok(last.value.entries.every((entry) => entry.overriddenBy === undefined));
  // A later file that cannot be read adds no note and does not fail the listing.
  fs.rmSync(path.join(root, '.env.development'));
  fs.mkdirSync(path.join(root, '.env.development'));
  const unreadableLater = await listed(root);
  assert.equal(unreadableLater.entries[0]?.overriddenBy, '.env.local');
  assert.equal(unreadableLater.entries[1]?.overriddenBy, undefined);
});

test('the ignore rule names the file it is asked for', async () => {
  const root = project();
  fs.writeFileSync(path.join(root, '.gitignore'), '.env\n');
  const result = await ignoreEnvFile(root, '.env.local', notIgnored);
  assert.ok(result.ok);
  assert.equal(result.value.file, '.env.local');
  assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), '.env\n.env.local\n');
  const again = await ignoreEnvFile(root, '.env.local', notIgnored);
  assert.ok(again.ok);
  assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), '.env\n.env.local\n');
});
