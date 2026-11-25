// Goal: the Astro copy's contract (shared/ipc/astroCopy.ts) lets through only what each side means to say:
// absolute, normalized paths; a name that is one folder name; replies whose every variant is checked.
// Method: known-good shapes pass and come back equal; each malformed shape (relative or unnormalized paths,
// names holding separators, unknown kinds and codes, report lists past their bound) is refused. The pure name
// rules, the default name and the shortened location are checked on exact strings, including names that
// become invalid at the byte limit.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ASTRO_COPY_LIMITS,
  astroCopyNameProblem,
  defaultAstroCopyName,
  parseAbsolutePath,
  parseAstroCopyCheck,
  parseAstroCopyReply,
  parseAstroCopyRequest,
  parseSiteFolderChoice,
  shortenLocation,
} from '#dist/shared/ipc/astroCopy.js';
import { parseIpcPayload } from '#dist/shared/ipc/ipcPayloads.js';

const request = { sourcePath: '/Users/me/Sites/shop', parentPath: '/Users/me/Sites', name: 'shop-astro' };

test('a request with absolute, normalized paths and a folder name passes, through the IPC inventory too', () => {
  assert.deepEqual(parseAstroCopyRequest(request), request);
  assert.deepEqual(parseIpcPayload('project:checkAstroCopy', request), request);
  assert.deepEqual(parseIpcPayload('project:createAstroCopy', request), request);
  assert.equal(parseIpcPayload('project:openSiteDialog', undefined), undefined);
  assert.deepEqual(parseAstroCopyRequest({ ...request, sourcePath: 'C:\\Sites\\shop', parentPath: 'C:\\Sites' }).parentPath, 'C:\\Sites');
  assert.equal(parseAbsolutePath('/'), '/');
  assert.equal(parseAbsolutePath('\\\\server\\share\\site'), '\\\\server\\share\\site');
});

test('relative, unnormalized and empty paths are refused', () => {
  for (const bad of ['Sites/shop', './shop', '/Sites/../shop', '/Sites/./shop', '/Sites//shop', '/Sites/shop/', '', 'C:', '\\\\', '/a\0b']) {
    assert.throws(() => parseAbsolutePath(bad), /Path/, bad);
  }
  assert.throws(() => parseAstroCopyRequest({ ...request, parentPath: 'Sites' }), /absolute/);
  assert.throws(() => parseAstroCopyRequest({ ...request, sourcePath: 7 }), /Expected string/);
  assert.throws(() => parseIpcPayload('project:createAstroCopy', { ...request, name: undefined }), /Expected string/);
});

test('a name with a separator is a path, refused at the boundary; a merely bad name passes to be judged', () => {
  for (const bad of ['a/b', 'a\\b', 'a\0b', 'x'.repeat(ASTRO_COPY_LIMITS.nameBytesMax * 4 + 1)]) {
    assert.throws(() => parseAstroCopyRequest({ ...request, name: bad }), /Name/);
  }
  assert.equal(parseAstroCopyRequest({ ...request, name: 'a:b' }).name, 'a:b');
});

test('the name rules: empty, invisible spaces, reserved characters and names, hidden and over-long names', () => {
  assert.equal(astroCopyNameProblem('shop-astro'), undefined);
  assert.equal(astroCopyNameProblem('My Shop — café'), undefined);
  assert.equal(astroCopyNameProblem(''), 'name-empty');
  assert.equal(astroCopyNameProblem('   '), 'name-empty');
  for (const bad of [' shop', 'shop ', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'a\tb', '.shop', 'shop.', 'CON', 'nul.txt', 'lpt1']) {
    assert.equal(astroCopyNameProblem(bad), 'name-invalid', bad);
  }
  // Valid data as it becomes invalid: 255 bytes pass, 256 do not, also when a character takes several bytes.
  assert.equal(astroCopyNameProblem('a'.repeat(255)), undefined);
  assert.equal(astroCopyNameProblem('a'.repeat(256)), 'name-invalid');
  assert.equal(astroCopyNameProblem('é'.repeat(127)), undefined);
  assert.equal(astroCopyNameProblem('é'.repeat(128)), 'name-invalid');
});

test('the default name adds -astro, and shortens a long name whole characters at a time', () => {
  assert.equal(defaultAstroCopyName('shop'), 'shop-astro');
  assert.equal(defaultAstroCopyName('My Site'), 'My Site-astro');
  const long = defaultAstroCopyName('é'.repeat(200));
  assert.ok(long.endsWith('-astro'));
  assert.equal(astroCopyNameProblem(long), undefined);
  assert.equal(new TextEncoder().encode(long).length <= 255, true);
  assert.throws(() => defaultAstroCopyName(''), /Assertion failed/);
});

test('a location is shown from home as ~, and a deep one by its last folders', () => {
  assert.equal(shortenLocation('/Users/me/Sites', '/Users/me'), '~/Sites');
  assert.equal(shortenLocation('/Users/me', '/Users/me'), '~');
  assert.equal(shortenLocation('/Users/meadow/Sites', '/Users/me'), '/Users/meadow/Sites');
  assert.equal(shortenLocation('/Volumes/Work/a/b/c/d', '/Users/me'), '…/b/c/d');
  assert.equal(shortenLocation('/Users/me/a/b/c/d', '/Users/me'), '…/b/c/d');
  assert.equal(shortenLocation('C:\\Users\\me\\Sites', 'C:\\Users\\me'), '~\\Sites');
  assert.throws(() => shortenLocation('/a', '/b', 0), /Assertion failed/);
});

test('every folder choice parses, and an unknown kind or a relative path is refused', () => {
  const plain = { kind: 'plainWebsite', sourcePath: '/s/shop', parentPath: '/s', name: 'shop-astro', homePath: '/Users/me' };
  assert.deepEqual(parseSiteFolderChoice({ kind: 'canceled' }), { kind: 'canceled' });
  assert.deepEqual(parseSiteFolderChoice({ kind: 'astro', projectPath: '/s/site' }), { kind: 'astro', projectPath: '/s/site' });
  assert.deepEqual(parseSiteFolderChoice(plain), plain);
  assert.deepEqual(parseSiteFolderChoice({ kind: 'notWebsite', folderPath: '/s/notes' }), { kind: 'notWebsite', folderPath: '/s/notes' });
  assert.throws(() => parseSiteFolderChoice({ kind: 'astro', projectPath: 'site' }), /absolute/);
  assert.throws(() => parseSiteFolderChoice({ ...plain, name: 'a/b' }), /Name/);
  assert.throws(() => parseSiteFolderChoice({ kind: 'error' }), /unknown value/);
});

test('a check reply is a target or a known problem', () => {
  assert.deepEqual(parseAstroCopyCheck({ ok: true, value: { targetPath: '/s/shop-astro' } }), { ok: true, value: { targetPath: '/s/shop-astro' } });
  assert.deepEqual(parseAstroCopyCheck({ ok: false, error: 'target-exists' }), { ok: false, error: 'target-exists' });
  assert.throws(() => parseAstroCopyCheck({ ok: false, error: 'disk-full' }), /unknown value/);
  assert.throws(() => parseAstroCopyCheck({ ok: 'yes' }), /boolean/);
  assert.throws(() => parseAstroCopyCheck({ ok: true, value: { targetPath: 'shop' } }), /absolute/);
});

test('a create reply carries the project and its report, or one of the failures with its own fields', () => {
  const created = {
    projectPath: '/s/shop-astro',
    pageCount: 3,
    assetCount: 9,
    keptAsFiles: ['_draft.html'],
    keptAsFilesCount: 1,
    skippedCount: 2,
    install: { kind: 'failed', detail: 'offline' },
  };
  assert.deepEqual(parseAstroCopyReply({ ok: true, value: created }), { ok: true, value: created });
  const failures = [
    { code: 'not-plain-website' },
    { code: 'too-many-files', limit: 20000 },
    { code: 'too-many-bytes', limit: 4294967296 },
    { code: 'file-too-large', limit: 10, file: 'video.mp4' },
    { code: 'package-manager-missing', manager: 'pnpm' },
    { code: 'copy-failed', detail: 'ENOSPC' },
    { code: 'inside-original' },
  ];
  for (const failure of failures) {
    assert.deepEqual(parseAstroCopyReply({ ok: false, error: failure }), { ok: false, error: failure });
  }
  assert.throws(() => parseAstroCopyReply({ ok: false, error: { code: 'too-many-files' } }), /Expected number/);
  assert.throws(() => parseAstroCopyReply({ ok: false, error: { code: 'package-manager-missing', manager: 'deno' } }), /unknown value/);
  assert.throws(() => parseAstroCopyReply({ ok: false, error: { code: 'exploded' } }), /unknown value/);
  assert.throws(() => parseAstroCopyReply({ ok: true, value: { ...created, keptAsFilesCount: 0 } }), /fewer than listed/);
  assert.throws(
    () =>
      parseAstroCopyReply({ ok: true, value: { ...created, keptAsFiles: Array.from({ length: 51 }, (_, index) => `${index}.html`), keptAsFilesCount: 51 } }),
    /too many listed paths/,
  );
  assert.throws(() => parseAstroCopyReply({ ok: true, value: { ...created, install: { kind: 'maybe' } } }), /unknown value/);
});
