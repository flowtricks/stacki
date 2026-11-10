// Goal: `.stacki/styles.json` reads locked stylesheets and folders only when
// they are project-relative, bounded and unambiguous, writes them back in a
// stable shape, and answers "is this stylesheet locked?" the same way for a
// file, a folder, a file added under a folder later, and after an unlock.
// Method: parse known-good shapes, then each known-bad shape and each bound
// just past its limit, pinning the error; round-trip through the serializer;
// and query the matchers with paths on both sides of every lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_KEEP_LIST,
  STYLE_KEEP_LIMITS,
  folderLock,
  parseStyleKeepList,
  serializeStyleKeepList,
  stylesheetLock,
  stylesheetLockMatcher,
} from '#dist/shared/properties/styleKeepList.js';

test('locked stylesheets and folders parse, and a file without the key locks nothing', () => {
  assert.deepEqual(parseStyleKeepList({ version: 1, keep: ['a'] }), { version: 1, keep: ['a'], lockedStylesheets: [] });
  assert.deepEqual(EMPTY_KEEP_LIST.lockedStylesheets, []);
  const parsed = parseStyleKeepList({ version: 1, keep: [], lockedStylesheets: ['src/styles/patterns.css', 'src/styles/lumos/', 'global.css'] });
  assert.deepEqual(parsed.lockedStylesheets, ['src/styles/patterns.css', 'src/styles/lumos/', 'global.css']);
});

test('every malformed locked path is refused with its reason', () => {
  const bad = (lockedStylesheets: unknown) => () => parseStyleKeepList({ version: 1, keep: [], lockedStylesheets });
  assert.throws(bad('src/styles/'), /Expected array/);
  assert.throws(bad([7]), /Expected string/);
  assert.throws(bad(['']), /1 to 512 characters/);
  assert.throws(bad(['/src/styles/a.css']), /relative to the project/);
  assert.throws(bad(['src\\styles\\a.css']), /relative to the project/);
  assert.throws(bad(['C:/site/a.css']), /relative to the project/);
  assert.throws(bad(['src/../a.css']), /\.\. step/);
  assert.throws(bad(['./src/a.css']), /\.\. step/);
  assert.throws(bad(['src//a.css']), /empty/);
  assert.throws(bad(['/']), /relative to the project/);
});

test('locked paths are bounded in count, length and depth', () => {
  const many = Array.from({ length: STYLE_KEEP_LIMITS.lockedStylesheetsMax }, (_, index) => `src/styles/s${index}.css`);
  assert.equal(parseStyleKeepList({ version: 1, keep: [], lockedStylesheets: many }).lockedStylesheets.length, many.length);
  assert.throws(() => parseStyleKeepList({ version: 1, keep: [], lockedStylesheets: [...many, 'x.css'] }), /exceed 500 paths/);
  const long = `${'a'.repeat(STYLE_KEEP_LIMITS.lockedPathCharsMax - 4)}.css`;
  assert.equal(parseStyleKeepList({ version: 1, keep: [], lockedStylesheets: [long] }).lockedStylesheets[0], long);
  assert.throws(() => parseStyleKeepList({ version: 1, keep: [], lockedStylesheets: [`a${long}`] }), /1 to 512 characters/);
  const deep = Array.from({ length: STYLE_KEEP_LIMITS.lockedPathSegmentsMax }, () => 'd').join('/');
  assert.equal(parseStyleKeepList({ version: 1, keep: [], lockedStylesheets: [`${deep}/`] }).lockedStylesheets.length, 1);
  assert.throws(() => parseStyleKeepList({ version: 1, keep: [], lockedStylesheets: [`${deep}/x.css`] }), /more than 32 folders/);
});

test('the file is written sorted and without the key when nothing is locked', () => {
  assert.equal(serializeStyleKeepList({ version: 1, keep: ['b'], lockedStylesheets: [] }), '{\n  "version": 1,\n  "keep": [\n    "b"\n  ]\n}\n');
  const source = serializeStyleKeepList({ version: 1, keep: [], lockedStylesheets: ['src/styles/z.css', 'src/lib/', 'src/styles/z.css'] });
  assert.equal(source, '{\n  "version": 1,\n  "keep": [],\n  "lockedStylesheets": [\n    "src/lib/",\n    "src/styles/z.css"\n  ]\n}\n');
  const reread: unknown = JSON.parse(source);
  assert.deepEqual(parseStyleKeepList(reread).lockedStylesheets, ['src/lib/', 'src/styles/z.css']);
});

test('a folder lock covers files added under it later; a file lock covers only itself', () => {
  const keepList = parseStyleKeepList({ version: 1, keep: [], lockedStylesheets: ['src/styles/patterns.css', 'src/lumos/'] });
  const locked = stylesheetLockMatcher(keepList);
  assert.equal(locked('src/styles/patterns.css'), true);
  assert.equal(locked('src/styles/global.css'), false);
  assert.equal(locked('src/styles/patterns.css.bak'), false, 'a file lock is not a prefix');
  assert.equal(locked('src/lumos/utilities.css'), true);
  assert.equal(locked('src/lumos/added/later.css'), true, 'files added under a locked folder are locked');
  assert.equal(locked('src/lumos-extra/x.css'), false, 'a folder lock stops at its slash');
  assert.equal(stylesheetLock(keepList, 'src/lumos/utilities.css'), 'src/lumos/');
  assert.equal(stylesheetLock(keepList, 'src/styles/patterns.css'), 'src/styles/patterns.css');
  assert.equal(stylesheetLock(keepList, 'src/styles/global.css'), undefined);
  assert.equal(folderLock(keepList, 'src/lumos/inner/'), 'src/lumos/');
  assert.equal(folderLock(keepList, 'src/styles/'), undefined);
  assert.throws(() => folderLock(keepList, 'src/styles'), /ends in \//);
  assert.throws(() => stylesheetLock(keepList, 'src/styles/'), /a stylesheet is a file/);
  // Unlocking is removing the entry: the same paths are free again.
  const unlocked = stylesheetLockMatcher(parseStyleKeepList({ version: 1, keep: [] }));
  assert.equal(unlocked('src/lumos/utilities.css'), false);
  assert.equal(unlocked('src/styles/patterns.css'), false);
});
