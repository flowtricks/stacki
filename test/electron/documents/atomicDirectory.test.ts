// Goal: save staging must remain stable and on the target filesystem without
// following a foreign link. Method: real scratch directories, failed filesystem
// operations, and a simulated mount boundary; every refusal preserves the page.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { atomicDirectoryOf, prepareAtomicDirectory } from '#dist/electron/documents/atomicDirectory.js';
import { NodeDocumentDisk } from '#dist/electron/documents/documentDisk.js';
import { toFilePath } from '#dist/shared/core/brand.js';
import { replaceFileAtomic } from '#dist/electron/documents/atomicWrite.js';

function fixture(context: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-staging-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'page.astro');
  fs.writeFileSync(file, 'before');
  return file;
}

test('save staging survives successful saves without accumulating temporary files', (context) => {
  const file = fixture(context);
  assert.ok(prepareAtomicDirectory(file).ok);
  const directory = atomicDirectoryOf(file);
  const before = fs.statSync(directory);
  assert.ok(replaceFileAtomic(file, Buffer.from('after')).ok);
  const after = fs.statSync(directory);
  assert.equal(after.ino, before.ino);
  assert.equal(after.dev, before.dev);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('a file occupying the staging path refuses the save without changing it', (context) => {
  const file = fixture(context);
  const directory = atomicDirectoryOf(file);
  fs.mkdirSync(path.dirname(directory));
  fs.writeFileSync(directory, 'foreign');
  assert.equal(replaceFileAtomic(file, Buffer.from('after')).ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'before');
  assert.equal(fs.readFileSync(directory, 'utf8'), 'foreign');
});

test('a staging link cannot redirect temporary files elsewhere', (context) => {
  const file = fixture(context);
  const target = path.join(path.dirname(file), 'foreign');
  fs.mkdirSync(target);
  fs.mkdirSync(path.dirname(atomicDirectoryOf(file)));
  fs.symlinkSync(target, atomicDirectoryOf(file), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(replaceFileAtomic(file, Buffer.from('after')).ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'before');
  assert.deepEqual(fs.readdirSync(target), []);
});

test('a staging mount on another device refuses the save', (context) => {
  const file = fixture(context);
  assert.ok(prepareAtomicDirectory(file).ok);
  const directory = atomicDirectoryOf(file);
  const lstat = fs.lstatSync;
  context.mock.method(fs, 'lstatSync', (target: fs.PathLike) => {
    const metadata = lstat(target);
    if (target === directory) {
      Object.defineProperty(metadata, 'dev', { value: metadata.dev + 1 });
    }
    return metadata;
  });
  assert.equal(replaceFileAtomic(file, Buffer.from('after')).ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'before');
});

test('a permission failure preparing staging is returned as a filesystem failure', (context) => {
  const file = fixture(context);
  context.mock.method(fs, 'mkdirSync', () => {
    throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  });
  const result = replaceFileAtomic(file, Buffer.from('after'));
  assert.ok(!result.ok);
  assert.equal(result.error.code, 'filesystem');
  assert.match(result.error.message, /EACCES/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'before');
});

test('nested pages, components and metadata share project staging', (context) => {
  const file = fixture(context);
  const root = path.dirname(file);
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  for (const relative of ['src/pages/blog/index.astro', 'src/components/Card.astro', '.stacki/components.json']) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'before');
    assert.ok(replaceFileAtomic(target, Buffer.from('after')).ok);
    assert.equal(atomicDirectoryOf(target), path.join(root, '.stacki', 'io'));
    assert.equal(fs.existsSync(path.join(path.dirname(target), '.stacki-io')), false);
    assert.equal(fs.readFileSync(target, 'utf8'), 'after');
  }
  assert.deepEqual(fs.readdirSync(path.join(root, 'src/pages/blog')), ['index.astro']);
  assert.deepEqual(fs.readdirSync(path.join(root, '.stacki/io')), []);
});

test('a linked metadata directory cannot redirect staging', (context) => {
  const file = fixture(context);
  const target = path.join(path.dirname(file), 'foreign');
  fs.mkdirSync(target);
  fs.symlinkSync(target, path.join(path.dirname(file), '.stacki'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(replaceFileAtomic(file, Buffer.from('after')).ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'before');
  assert.deepEqual(fs.readdirSync(target), []);
});

test('shared staging distinguishes equal filenames and coordinates aliases', (context) => {
  const file = fixture(context);
  const root = path.dirname(file);
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  const disk = new NodeDocumentDisk();
  const other = toFilePath(path.join(root, 'nested', 'page.astro'));
  fs.mkdirSync(path.dirname(other));
  fs.writeFileSync(other, 'before');
  const first = disk.lock(toFilePath(file));
  assert.ok(first.ok);
  const second = disk.lock(other);
  assert.ok(second.ok, 'different directories have independent locks');
  const alias = path.join(root, 'alias.astro');
  fs.symlinkSync(file, alias);
  const repeated = disk.lock(toFilePath(alias));
  assert.ok(!repeated.ok);
  assert.equal(repeated.error.code, 'held');
  assert.equal(fs.readdirSync(atomicDirectoryOf(file)).length, 2);
  assert.ok(disk.unlock(first.value).ok);
  assert.ok(disk.unlock(second.value).ok);
  assert.deepEqual(fs.readdirSync(atomicDirectoryOf(file)), []);
});
