// Goal: the folder-open contract (shared/ipc/folderOpen.ts) lets through only what main means to say about a
// folder handed to Stacki: one of the dialog's own answers without `canceled`, or a known refusal.
// Method: each known-good shape passes and comes back equal, through the IPC inventory too; each malformed one
// (canceled, unknown kinds and reasons, relative paths, a list past the queue bound, no record) is refused.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FOLDER_OPEN_LIMITS, FOLDER_REJECTIONS, parseFolderOpenChoice, parseFolderOpenChoices, parseFolderRejection } from '#dist/shared/ipc/folderOpen.js';
import { parseIpcPayload } from '#dist/shared/ipc/ipcPayloads.js';

const astro = { kind: 'astro', projectPath: '/Users/me/Sites/blog' };
const plain = { kind: 'plainWebsite', sourcePath: '/Users/me/Sites/shop', parentPath: '/Users/me/Sites', name: 'shop-astro', homePath: '/Users/me' };
const neither = { kind: 'notWebsite', folderPath: '/Users/me/Documents', searched: 'all' };

test('every answer a folder can get passes and comes back equal', () => {
  assert.deepEqual(parseFolderOpenChoice(astro), astro);
  assert.deepEqual(parseFolderOpenChoice(plain), plain);
  assert.deepEqual(parseFolderOpenChoice(neither), neither);
  for (const reason of FOLDER_REJECTIONS) {
    assert.deepEqual(parseFolderOpenChoice({ kind: 'rejected', reason }), { kind: 'rejected', reason });
    assert.equal(parseFolderRejection(reason), reason);
  }
  assert.deepEqual(parseFolderOpenChoices([astro, { kind: 'rejected', reason: 'missing' }]), [astro, { kind: 'rejected', reason: 'missing' }]);
  assert.deepEqual(parseFolderOpenChoices([]), []);
});

test('the channels take a path and nothing', () => {
  assert.equal(parseIpcPayload('project:inspectFolder', '/Users/me/Sites/blog'), '/Users/me/Sites/blog');
  assert.equal(parseIpcPayload('project:takeOpenedFolders', undefined), undefined);
  assert.throws(() => parseIpcPayload('project:inspectFolder', 42), /Expected string/);
  assert.throws(() => parseIpcPayload('project:inspectFolder', '/a\0b'), /NUL/);
  assert.throws(() => parseIpcPayload('project:takeOpenedFolders', '/x'), /Expected no payload/);
});

test('a folder that arrived is never canceled, and unknown kinds and reasons are refused', () => {
  assert.throws(() => parseFolderOpenChoice({ kind: 'canceled' }), /never canceled/);
  assert.throws(() => parseFolderOpenChoice({ kind: 'opened', projectPath: '/x' }), /unknown value/);
  assert.throws(() => parseFolderOpenChoice({ kind: 'rejected', reason: 'tooBig' }), /FolderRejection: unknown value/);
  assert.throws(() => parseFolderOpenChoice({ kind: 'rejected' }), /FolderRejection: unknown value/);
  assert.throws(() => parseFolderRejection(undefined), /unknown value/);
  assert.throws(() => parseFolderOpenChoice('astro'), /Expected/);
});

test('paths in an answer are absolute and normalized', () => {
  assert.throws(() => parseFolderOpenChoice({ kind: 'astro', projectPath: 'Sites/blog' }), /absolute/);
  assert.throws(() => parseFolderOpenChoice({ kind: 'notWebsite', folderPath: '/Users/me/../me' }), /\.\./);
  assert.throws(() => parseFolderOpenChoice({ ...plain, name: 'a/b' }), /folder name/);
});

test('the list main hands over is bounded by the queue', () => {
  const full = Array.from({ length: FOLDER_OPEN_LIMITS.queueMax }, () => astro);
  assert.equal(parseFolderOpenChoices(full).length, FOLDER_OPEN_LIMITS.queueMax);
  assert.throws(() => parseFolderOpenChoices([...full, astro]), /exceeds limit/);
  assert.throws(() => parseFolderOpenChoices(astro), /Expected array/);
});
