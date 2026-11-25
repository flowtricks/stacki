// Goal: the Files panel's contract refuses every path spelling that could leave the project, every name a disk would
// refuse, and every malformed reply, and accepts the good shapes (one parse test per contract, negative space included).
// Method: table-driven cases against the shared parsers and the payload inventory.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareEntries,
  entryNameProblem,
  isProtectedPath,
  parseExplorerContent,
  parseExplorerError,
  parseExplorerListing,
  parseExplorerPath,
  parseFindAnswer,
  rebasePath,
  toExplorerPath,
  FILE_EXPLORER_LIMITS,
  type ExplorerEntry,
} from '#dist/shared/ipc/fileExplorer.js';
import { parseIpcPayload } from '#dist/shared/ipc/ipcPayloads.js';

test('explorer paths: good spellings pass, climbing or odd ones throw', () => {
  for (const good of ['', 'src', 'src/pages/index.astro', '.git/HEAD', '.env', 'a b/c#d?.txt']) {
    assert.equal(parseExplorerPath(good), good);
  }
  for (const bad of ['/etc', 'src/', '../x', 'a/../b', 'a/./b', 'a//b', 'a\\b', 'a\u0000b', 'a\nb', 'x'.repeat(256), 42, undefined]) {
    assert.throws(() => parseExplorerPath(bad), Error, String(bad));
  }
  assert.throws(() => parseExplorerPath('a/'.repeat(FILE_EXPLORER_LIMITS.pathSegmentsMax) + 'a'));
});

test('protected paths are .git and .stacki/io, in any case', () => {
  for (const path of ['.git', '.git/HEAD', '.GIT/config', '.stacki/io', '.stacki/io/lock']) {
    assert.ok(isProtectedPath(toExplorerPath(path)), path);
  }
  for (const path of ['', '.github', '.gitignore', '.stacki', '.stacki/components.json', 'src/.git']) {
    assert.ok(!isProtectedPath(toExplorerPath(path)), path);
  }
});

test('typed names: every problem has its code, and Windows adds its own', () => {
  assert.equal(entryNameProblem('index.astro', 'darwin'), undefined);
  assert.equal(entryNameProblem('.env.local', 'linux'), undefined);
  assert.equal(entryNameProblem('', 'darwin'), 'empty');
  assert.equal(entryNameProblem('..', 'darwin'), 'reserved');
  assert.equal(entryNameProblem('a/b', 'darwin'), 'separator');
  assert.equal(entryNameProblem('a\\b', 'linux'), 'separator');
  assert.equal(entryNameProblem('a\tb', 'linux'), 'control');
  assert.equal(entryNameProblem('x'.repeat(256), 'linux'), 'too-long');
  assert.equal(entryNameProblem(' lead', 'linux'), 'whitespace');
  assert.equal(entryNameProblem('a:b', 'darwin'), undefined);
  assert.equal(entryNameProblem('a:b', 'win32'), 'windows-character');
  assert.equal(entryNameProblem('nul.txt', 'win32'), 'windows-name');
  assert.equal(entryNameProblem('trailing.', 'win32'), 'windows-name');
});

test('payloads: the inventory parses each channel and refuses malformed requests before any handler', () => {
  const projectPath = '/tmp/site';
  assert.deepEqual(parseIpcPayload('files:list', { projectPath, path: 'src' }), { projectPath, path: 'src' });
  assert.throws(() => parseIpcPayload('files:list', { projectPath, path: '../x' }));
  assert.throws(() => parseIpcPayload('files:create', { projectPath, parent: '', name: 'a/b', kind: 'file' }));
  assert.throws(() => parseIpcPayload('files:create', { projectPath, parent: '', name: 'ok', kind: 'socket' }));
  assert.throws(() => parseIpcPayload('files:transfer', { projectPath, paths: [], target: '', mode: 'move', collision: 'refuse' }), /no path/);
  assert.throws(() => parseIpcPayload('files:transfer', { projectPath, paths: ['a', 'a'], target: '', mode: 'move', collision: 'refuse' }), /twice/);
  assert.throws(() => parseIpcPayload('files:transfer', { projectPath, paths: ['a'], target: '', mode: 'move', collision: 'overwrite' }));
  assert.throws(() => parseIpcPayload('files:write', { projectPath, path: 'a', text: '﻿x', byteOrderMark: false, base: 'f'.repeat(64) }), /byte-order/);
  assert.throws(() => parseIpcPayload('files:write', { projectPath, path: 'a', text: 'x', byteOrderMark: false, base: 'nope' }));
  assert.throws(() => parseIpcPayload('files:find', { projectPath, query: '   ' }), /empty/);
  assert.throws(() => parseIpcPayload('files:watch', { projectPath, directories: Array.from({ length: 513 }, (_, index) => `d${index}`) }));
  assert.throws(() => parseIpcPayload('files:import', { projectPath, sources: [], target: '', collision: 'refuse' }));
});

test('replies: listings, contents, errors and finds parse, and bad ones throw', () => {
  const listing = parseExplorerListing({ path: 'src', entries: [{ name: 'a', kind: 'file' }], totalCount: 3 });
  assert.equal(listing.totalCount, 3);
  assert.throws(() => parseExplorerListing({ path: 'src', entries: [{ name: 'a', kind: 'file' }], totalCount: 0 }), /total/);
  assert.throws(() => parseExplorerListing({ path: 'src', entries: [{ name: 'a/b', kind: 'file' }], totalCount: 1 }));
  assert.throws(() => parseExplorerListing({ path: 'src', entries: [{ name: 'a', kind: 'pipe' }], totalCount: 1 }));
  assert.deepEqual(parseExplorerContent({ kind: 'binary', sizeBytes: 4 }), { kind: 'binary', sizeBytes: 4 });
  assert.throws(() => parseExplorerContent({ kind: 'text', text: '﻿a', checksum: 'f'.repeat(64), byteOrderMark: true, sizeBytes: 4 }));
  assert.throws(() => parseExplorerContent({ kind: 'media', media: 'pdf', sizeBytes: 4 }));
  assert.deepEqual(parseExplorerError({ code: 'filesystem', names: [], detail: 'EACCES' }), { code: 'filesystem', names: [], detail: 'EACCES' });
  assert.throws(() => parseExplorerError({ code: 'filesystem', names: [], detail: '/Users/x/.env' }), /system error code/);
  assert.throws(() => parseExplorerError({ code: 'oops', names: [] }));
  assert.equal(parseFindAnswer({ matches: [{ path: '.github/ci.yml', folder: false }], complete: true }).matches.length, 1);
});

test('entries sort folders first, then naturally', () => {
  const entries: ExplorerEntry[] = [
    { name: 'file10.txt', kind: 'file' },
    { name: 'file2.txt', kind: 'file' },
    { name: 'zeta', kind: 'directory' },
    { name: '.git', kind: 'directory' },
    { name: 'Alpha', kind: 'link-directory' },
  ];
  const sorted = entries.sort(compareEntries).map((entry) => entry.name);
  assert.deepEqual(sorted, ['.git', 'Alpha', 'zeta', 'file2.txt', 'file10.txt']);
});

test('rebasePath carries a moved folder’s contents and asserts the rest', () => {
  assert.equal(rebasePath(toExplorerPath('a/b/c'), toExplorerPath('a/b'), toExplorerPath('x')), 'x/c');
  assert.throws(() => rebasePath(toExplorerPath('q'), toExplorerPath('a'), toExplorerPath('x')), /inside the moved entry/);
});
