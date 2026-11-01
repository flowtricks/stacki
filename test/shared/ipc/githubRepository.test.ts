// Goal: repository operations never accept command options, URLs, or traversal.
// Method: exercise valid owner/name and clone results, then malformed wire data.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseGitHubRepository, parseGitHubRepositories, parseCloneResult } from '#dist/shared/ipc/githubRepository.js';

test('GitHub repository boundaries', () => {
  assert.equal(parseGitHubRepository('owner/site-name.git'), 'owner/site-name.git');
  assert.deepEqual(parseGitHubRepositories(['owner/site']), ['owner/site']);
  for (const input of ['', '--help', 'https://github.com/owner/site', '../site', 'owner/..', 'a/b/c', 2]) {
    assert.throws(() => parseGitHubRepository(input));
  }
  assert.throws(() => parseGitHubRepositories(Array(101).fill('owner/site')));
  assert.deepEqual(parseCloneResult({ canceled: true }), { canceled: true });
  assert.deepEqual(parseCloneResult({ canceled: false, projectPath: '/site' }), {
    canceled: false,
    projectPath: '/site',
  });
  assert.throws(() => parseCloneResult({ canceled: false, projectPath: 2 }));
  assert.throws(() => parseCloneResult({ canceled: 'false' }));
});
