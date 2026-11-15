// Goal: the release scripts can only make the writes a release needs (the bump commit, the tag,
// one atomic push of main and the tag, the named workflow dispatches and one rerun), and every
// dangerous variant is refused: hook skips, forces, deletions, extra refs, other workflows.
// Methodology: writeViolation is pure; each allowed request is checked once, then each forbidden
// variant of it, so a loosened rule fails here. The system runner's assertion is pinned too.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { systemWriteRunner, writeViolation, type WriteRequest } from '../../../scripts/release/releaseWrite.mts';

const SHA = 'c'.repeat(40);
const git = (...argumentsList: string[]): WriteRequest => ({ command: 'git', argumentsList, output: 'capture' });
const gh = (...argumentsList: string[]): WriteRequest => ({ command: 'gh', argumentsList, output: 'capture' });

test('the writes a release makes are allowed', () => {
  const allowed = [
    git('add', '--', 'package.json', 'docs/releases.md'),
    git('commit', '-m', 'chore(release): version 1.4.4', '-m', 'body'),
    git('tag', 'v1.4.4', SHA),
    git('push', '--atomic', 'origin', `${SHA}:refs/heads/main`, 'refs/tags/v1.4.4:refs/tags/v1.4.4'),
    git('-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'push', '--atomic', 'origin', 'refs/tags/v1.4.4:refs/tags/v1.4.4'),
    gh('workflow', 'run', 'publish-create-stacki.yml', '--repo', 'flowtricks/stacki', '--ref', 'v1.4.4'),
    gh('workflow', 'run', 'release-post.yml', '--repo', 'flowtricks/stacki', '--ref', 'main', '-f', 'release_run_id=12'),
    gh('workflow', 'run', 'deploy.yml', '--repo', 'flowtricks/stacki-marketing-site', '--ref', 'main'),
    gh('run', 'rerun', '123', '--failed', '--repo', 'flowtricks/stacki'),
  ];
  for (const request of allowed) {
    assert.equal(writeViolation(request), undefined, request.argumentsList.join(' '));
  }
});

test('hook skips, forces, deletions, history rewrites and stray paths are refused', () => {
  const refused = [
    git('push', '--atomic', 'origin', `${SHA}:refs/heads/main`, '--no-verify'),
    git('push', '--atomic', '--force', 'origin', `${SHA}:refs/heads/main`),
    git('push', '--atomic', 'origin', `+${SHA}:refs/heads/main`),
    git('push', '--atomic', 'origin', ':refs/tags/v1.4.3'),
    git('push', 'origin', `${SHA}:refs/heads/main`),
    git('push', '--atomic', 'origin', 'HEAD:refs/heads/other'),
    git('push', '--atomic', 'origin', 'refs/tags/v1.4.3:refs/tags/v1.4.4'),
    git('push', '--atomic', 'origin', 'refs/tags/v1.4.4:refs/tags/v1.4.4', 'refs/tags/v1.4.5:refs/tags/v1.4.5', `${SHA}:refs/heads/main`),
    git('push', '--atomic', 'origin', '--delete', 'refs/tags/v1.4.3'),
    git('commit', '-n', '-m', 's', '-m', 'b'),
    git('commit', '--amend', '-m', 's', '-m', 'b'),
    git('commit', '-a', '-m', 's', '-m', 'b'),
    git('commit', '-m', 's'),
    git('tag', '-f', 'v1.4.3', SHA),
    git('tag', '-d', 'v1.4.3'),
    git('tag', 'latest', SHA),
    git('tag', 'v1.4.4', 'HEAD'),
    git('add', '--', 'src/app.ts'),
    git('add', 'package.json'),
    git('add', '--'),
    git('reset', '--hard'),
    git(),
    gh('workflow', 'run', 'release.yml', '--repo', 'flowtricks/stacki'),
    gh('workflow', 'run', 'deploy.yml', '--repo', 'flowtricks/stacki'),
    gh('workflow', 'run', 'publish-create-stacki.yml'),
    gh('run', 'rerun', '123', '--repo', 'flowtricks/stacki'),
    gh('run', 'rerun', '123', '--failed', '--repo', 'someone/else'),
    gh('release', 'delete', 'v1.4.3'),
  ];
  for (const request of refused) {
    assert.notEqual(writeViolation(request), undefined, request.argumentsList.join(' '));
  }
});

test('the system runner crashes on a refused write instead of running it', () => {
  const runner = systemWriteRunner({});
  assert.throws(() => runner(git('push', '--atomic', '--force', 'origin', `${SHA}:refs/heads/main`)), /^Error: Assertion failed: release writes are allowlisted: git: --force is never allowed$/);
});
