// Goal: filters and status sorting retain every relevant commit file without mutation.
// Method: frozen mixed-status fixtures cover copies, renames, unknown statuses, empty
// results, deterministic path ordering, and the shared collection boundary.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { selectHistoryFiles } = load('src/features/history/historyFileList.ts');
const { BOUNDARY_LIMITS } = load('shared/core/boundary.ts');

const files = Object.freeze([
  Object.freeze({ status: 'D', path: 'b-deleted' }),
  Object.freeze({ status: 'A', path: 'z-new' }),
  Object.freeze({ status: 'M', path: 'b-changed' }),
  Object.freeze({ status: 'C', path: 'a-copy' }),
  Object.freeze({ status: 'R', path: 'a-moved', from: 'old-name' }),
  Object.freeze({ status: 'T', path: 'c-type' }),
  Object.freeze({ status: '?', path: 'd-unknown' }),
]);
const paths = (values) => values.map((file) => file.path);

test('filters share the summary categories and retain original file objects', () => {
  assert.deepEqual(paths(selectHistoryFiles(files, { filter: 'added', sort: 'path' })), ['a-copy', 'z-new']);
  assert.deepEqual(paths(selectHistoryFiles(files, { filter: 'deleted', sort: 'path' })), ['b-deleted']);
  const changed = selectHistoryFiles(files, { filter: 'updated', sort: 'path' });
  assert.deepEqual(paths(changed), ['a-moved', 'b-changed', 'c-type', 'd-unknown']);
  assert.equal(changed[0], files[4]);
  assert.deepEqual(selectHistoryFiles([files[0]], { filter: 'added', sort: 'status' }), []);
  assert.deepEqual(selectHistoryFiles([], { filter: 'all', sort: 'path' }), []);
});

test('status sorting groups Changed, New and Deleted with paths sorted within each group', () => {
  const original = paths(files);
  assert.deepEqual(paths(selectHistoryFiles(files, { filter: 'all', sort: 'status' })), [
    'a-moved',
    'b-changed',
    'c-type',
    'd-unknown',
    'a-copy',
    'z-new',
    'b-deleted',
  ]);
  assert.deepEqual(paths(selectHistoryFiles(files, { filter: 'all', sort: 'path' })), [
    'a-copy',
    'a-moved',
    'b-changed',
    'b-deleted',
    'c-type',
    'd-unknown',
    'z-new',
  ]);
  assert.deepEqual(paths(files), original);
  assert.throws(
    () =>
      selectHistoryFiles(Array(BOUNDARY_LIMITS.itemsMax + 1).fill(files[0]), {
        filter: 'all',
        sort: 'path',
      }),
    /History files: file limit exceeded/,
  );
});
