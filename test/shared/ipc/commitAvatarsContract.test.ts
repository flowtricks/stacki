// Goal: only bounded commit identities cross to main, and only GitHub avatar URLs come back;
// a GitHub noreply address names its picture with no request, and nothing else does.
// Methodology: feed both noreply forms, lookalike and ordinary addresses, then known-good and
// each known-bad request and reply shape to the shared parsers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COMMIT_AVATAR_LIMITS,
  githubNoreplyAvatar,
  parseAvatarURL,
  parseCommitAvatarRequest,
  parseCommitAvatarResult,
} from '#dist/shared/ipc/commitAvatars.js';

const hash = 'a'.repeat(40);

test('noreply addresses name a GitHub picture in both forms', () => {
  assert.equal(githubNoreplyAvatar('12345+octocat@users.noreply.github.com'), 'https://avatars.githubusercontent.com/u/12345?s=40');
  assert.equal(githubNoreplyAvatar('49699333+dependabot[bot]@users.noreply.github.com'), 'https://avatars.githubusercontent.com/u/49699333?s=40');
  assert.equal(githubNoreplyAvatar('octo-cat@users.noreply.github.com'), 'https://github.com/octo-cat.png?size=40');
  assert.equal(githubNoreplyAvatar('Octocat@Users.Noreply.GitHub.com'), 'https://github.com/Octocat.png?size=40');
});

test('other addresses name no picture', () => {
  for (const email of [
    'designer@example.com',
    'octocat@github.com',
    'octocat@noreply.github.com',
    'octocat@users.noreply.github.com.evil.example',
    'octocat@evil-users.noreply.github.com',
    '-octocat@users.noreply.github.com',
    'octo--cat@users.noreply.github.com',
    'octocat[bot]@users.noreply.github.com',
    `${'a'.repeat(40)}@users.noreply.github.com`,
    `${'a'.repeat(COMMIT_AVATAR_LIMITS.emailLengthMax)}@users.noreply.github.com`,
    '',
  ]) {
    assert.equal(githubNoreplyAvatar(email), undefined, email);
  }
});

test('requests carry full hashes and bounded emails', () => {
  const request = { projectPath: '/site', commits: [{ hash, email: 'a@example.com' }] };
  assert.deepEqual(parseCommitAvatarRequest(request), request);
  assert.equal(parseCommitAvatarRequest({ ...request, commits: [{ hash: 'b'.repeat(64), email: '' }] }).commits.length, 1);
  assert.throws(() => parseCommitAvatarRequest({ ...request, projectPath: '' }), /project path/);
  assert.throws(() => parseCommitAvatarRequest({ ...request, commits: [{ hash: 'main', email: '' }] }), /full commit hash/);
  assert.throws(() => parseCommitAvatarRequest({ ...request, commits: [{ hash: `${hash}") { x }`, email: '' }] }), /full commit hash/);
  assert.throws(() => parseCommitAvatarRequest({ ...request, commits: [{ hash, email: 'x'.repeat(321) }] }), /email exceeds/);
  const tooMany = Array.from({ length: COMMIT_AVATAR_LIMITS.commitsMax + 1 }, () => ({ hash, email: '' }));
  assert.throws(() => parseCommitAvatarRequest({ ...request, commits: tooMany }), /too many/);
});

test('replies name GitHub avatar hosts only', () => {
  const url = 'https://avatars.githubusercontent.com/u/1?v=4';
  assert.deepEqual(parseCommitAvatarResult([{ hash, url }]), [{ hash, url }]);
  assert.equal(parseAvatarURL('https://github.com/octocat.png'), 'https://github.com/octocat.png');
  for (const bad of [
    'http://avatars.githubusercontent.com/u/1',
    'https://www.gravatar.com/avatar/1',
    'https://avatars.githubusercontent.com.evil.example/u/1',
    'https://user:secret@avatars.githubusercontent.com/u/1',
    'https://avatars.githubusercontent.com:8443/u/1',
    'javascript:alert(1)',
    `https://github.com/${'a'.repeat(COMMIT_AVATAR_LIMITS.urlLengthMax)}`,
  ]) {
    assert.throws(() => parseCommitAvatarResult([{ hash, url: bad }]), /Commit avatars/, bad);
  }
  assert.throws(
    () =>
      parseCommitAvatarResult([
        { hash, url },
        { hash, url },
      ]),
    /duplicate/,
  );
  assert.throws(() => parseCommitAvatarResult({ hash, url }), /Expected array/);
});
