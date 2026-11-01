/** Check metadata-only tree parsing with valid modes and adversarial Git output.
 * No blob contents should be requested while preparing status or commit selection. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gitWorkspaceTree } from '../src/features/history/gitWorkspaceTree';

const revision = 'a'.repeat(40);
test('workspace tree reads metadata and excludes links and submodules', async () => {
  const files = await gitWorkspaceTree(async (args) => {
    assert.deepEqual(args, ['ls-tree', '-r', '-z', revision]);
    return [
      `100644 blob ${revision}\tsrc/pages/index.astro`,
      `100755 blob ${revision}\tscript`,
      `120000 blob ${revision}\tlink`,
      `160000 commit ${revision}\tsubmodule`,
      '',
    ].join('\0');
  }, revision);
  assert.deepEqual(
    files.map((file) => file.path),
    ['src/pages/index.astro', 'script'],
  );
});

test('workspace tree rejects malformed, unsafe, duplicate and oversized metadata', async () => {
  const entry = `100644 blob ${revision}\tfile\0`;
  for (const output of ['invalid\0', `100644 blob ${revision}\t../outside\0`, `100600 blob ${revision}\tfile\0`, entry + entry, entry.repeat(20_001)]) {
    await assert.rejects(gitWorkspaceTree(async () => output, revision));
  }
});
