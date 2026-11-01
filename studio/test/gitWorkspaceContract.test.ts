// Goal: reject malformed durable Git metadata before it can select refs or storage keys.
// Method: mutate one field of a valid manifest, including bounds and namespace collisions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseGitWorkspaceManifest, gitBranchName } from '../src/features/history/gitWorkspaceContract';

const head = 'a'.repeat(40);
const valid = {
  version: 1,
  revision: randomUUID(),
  repository: 'owner/repository',
  branch: 'main',
  branches: [{ name: 'main', head, workspace: 'legacy' }],
  remote: [{ name: 'main', head }],
  parked: [],
  draft: undefined,
  bundle: undefined,
};
test('Git workspace metadata validates branches, hashes, identities and bounds', () => {
  assert.deepEqual(parseGitWorkspaceManifest(valid), valid);
  for (const input of [
    undefined,
    null,
    [],
    { ...valid, version: 2 },
    { ...valid, repository: '../repository' },
    { ...valid, branch: 'missing' },
    { ...valid, branches: [{ name: 'main', head: 'bad', workspace: 'legacy' }] },
    { ...valid, revision: '../outside' },
    { ...valid, bundle: '../bundle' },
    { ...valid, draft: 'not-a-commit' },
    { ...valid, remote: Array(65).fill(valid.remote[0]) },
    { ...valid, branches: [...valid.branches, { name: 'other', head, workspace: 'legacy' }] },
    { ...valid, branches: [...valid.branches, ...valid.branches] },
  ]) {
    assert.throws(() => parseGitWorkspaceManifest(input));
  }
  for (const name of ['HEAD', '-main', '../main', 'a..b', 'a.lock', 'a//b', 'a/.hidden', 'main\nbranch', 'a'.repeat(201)]) {
    assert.throws(() => gitBranchName(name));
  }
  assert.equal(gitBranchName('feature/component'), 'feature/component');
});
