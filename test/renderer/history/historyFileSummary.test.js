// Goal: commit summaries account for every changed file exactly once.
// Methodology: check mixed Git statuses, empty commits, and the bounded
// collection limit; copies add paths while renames and type changes update them.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { summarizeHistoryFiles } = load('src/features/history/historyFileSummary.ts');
const { BOUNDARY_LIMITS } = load('shared/core/boundary.ts');

test('summaries count additions, deletions, and updates without losing renamed files', () => {
  const files = ['A', 'C', 'D', 'M', 'R', 'T', 'U', 'unknown'].map((status) => ({ status }));
  assert.deepEqual(summarizeHistoryFiles(files), { added: 2, deleted: 1, updated: 5 });
  assert.deepEqual(summarizeHistoryFiles([]), { added: 0, deleted: 0, updated: 0 });
  assert.deepEqual(summarizeHistoryFiles([{ status: 'D' }]), {
    added: 0,
    deleted: 1,
    updated: 0,
  });
});

test('file counts enforce the shared collection boundary', () => {
  const files = Array(BOUNDARY_LIMITS.itemsMax).fill({ status: 'A' });
  assert.equal(summarizeHistoryFiles(files).added, files.length);
  assert.throws(() => summarizeHistoryFiles([...files, { status: 'M' }]), /History files: file limit exceeded/);
});
