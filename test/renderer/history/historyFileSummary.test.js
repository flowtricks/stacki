// Goal: commit summaries account for every changed file exactly once.
// Methodology: check mixed Git statuses, empty commits, and a large commit
// under the platform's array ceiling; copies add paths while renames and type changes update them.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { summarizeHistoryFiles } = load('src/features/history/historyFileSummary.ts');
const { BOUNDARY_LIMITS } = load('shared/core/boundary.ts');
const { PLATFORM_LIMITS } = load('shared/core/limits.ts');

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

test('file counts are bounded only by the platform array ceiling', () => {
  // A longer array than the platform holds cannot be built; Stacki has no product size limit.
  assert.equal(BOUNDARY_LIMITS.itemsMax, PLATFORM_LIMITS.arrayLengthMax);
  const files = Array(100_001).fill({ status: 'A' });
  assert.equal(summarizeHistoryFiles(files).added, files.length);
  assert.deepEqual(summarizeHistoryFiles([...files, { status: 'M' }]), { added: 100_001, deleted: 0, updated: 1 });
});
