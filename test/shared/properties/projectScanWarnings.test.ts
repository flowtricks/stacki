// Goal: the scan's warnings cross the IPC boundary only when they are well formed: a known code,
// a sentence, and a project-relative file. A warning the UI cannot place (an unknown code, an
// absolute or escaping path) is refused at the boundary, not shown wrongly.
// Method: a scan with good warnings passes intact; each known-bad shape fails with its pinned
// message; the package manager field is checked the same way.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseScanResult, SCAN_WARNING_CODES } from '#dist/shared/properties/projectScan.js';

const base = { pages: [], pageFolders: [], layouts: [], components: [] };

test('every code, with and without a file and detail, passes intact', () => {
  const warnings = SCAN_WARNING_CODES.map((code, index) => ({
    code,
    message: `About ${code}.`,
    ...(index % 2 === 0 ? { file: 'src/pages' } : {}),
    detail: 'EACCES',
  }));
  const parsed = parseScanResult({ ...base, warnings, packageManager: 'pnpm' });
  assert.deepEqual(parsed.warnings, warnings);
  assert.equal(parsed.packageManager, 'pnpm');
});

test('a scan without warnings (an older host) still parses', () => {
  assert.equal(parseScanResult(base).warnings, undefined);
});

test('malformed warnings are refused with a message naming the field', () => {
  const bad = (warning: unknown) => () => parseScanResult({ ...base, warnings: [warning] });
  assert.throws(bad({ code: 'nope', message: 'x' }), /warnings\[0\]\.code: expected one of/);
  assert.throws(bad({ code: 'folder-unreadable', message: '' }), /message: expected a sentence/);
  assert.throws(bad({ code: 'folder-unreadable' }), /message: expected string/);
  assert.throws(bad({ code: 'folder-unreadable', message: 'x', file: '/etc' }), /file: expected a project-relative path/);
  assert.throws(bad({ code: 'folder-unreadable', message: 'x', file: '../up' }), /file: expected a project-relative path/);
  assert.throws(bad({ code: 'folder-unreadable', message: 'x', file: 'a/../b' }), /file: expected a project-relative path/);
  assert.throws(bad({ code: 'folder-unreadable', message: 'x', detail: 5 }), /detail: expected string/);
  assert.throws(bad('text'), /warnings\[0\]: expected object/);
  assert.throws(() => parseScanResult({ ...base, warnings: 'x' }), /warnings: expected array/);
  assert.throws(() => parseScanResult({ ...base, packageManager: 'cargo' }), /packageManager: expected npm, pnpm, yarn, bun/);
});
