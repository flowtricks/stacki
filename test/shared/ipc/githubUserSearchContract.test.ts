// Goal: only the typed start of a GitHub username crosses to main, and only bounded, valid
// suggestions come back: at most eight, one per login, pictures on GitHub's hosts only.
// Methodology: feed known-good and each known-bad request, query and reply shape to the
// shared parsers, including values just inside and just past each bound.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GITHUB_USER_SEARCH_LIMITS, githubUserQuery, parseGitHubUserSearchRequest, parseGitHubUserSearchResult } from '#dist/shared/ipc/githubUserSearch.js';
import { parseGitHubLoginQuery } from '#dist/shared/properties/projectRoles.js';

const user = (login: string) => ({ login, name: 'Octo Cat', avatarURL: 'https://avatars.githubusercontent.com/u/1?s=40', source: 'search' });

test('queries follow the login rules, allowing a trailing hyphen', () => {
  for (const query of ['a', 'octo', 'octo-', 'Octo-Cat', ' sam ', 'a'.repeat(39)]) {
    assert.equal(parseGitHubLoginQuery(query), query.trim(), query);
  }
  for (const query of ['', '   ', '-octo', 'octo--cat', 'octo cat', 'octo_cat', 'sam@example.com', 'a'.repeat(40), 'ünï']) {
    assert.throws(() => parseGitHubLoginQuery(query), /GitHub username/, query);
    assert.equal(githubUserQuery(query), undefined, query);
  }
  assert.throws(() => parseGitHubLoginQuery(7), /Expected string/);
});

test('requests carry a project and a query only', () => {
  assert.deepEqual(parseGitHubUserSearchRequest({ projectPath: '/site', query: 'octo' }), { projectPath: '/site', query: 'octo' });
  assert.deepEqual(Object.keys(parseGitHubUserSearchRequest({ projectPath: '/site', query: 'octo', token: 'x' })), ['projectPath', 'query']);
  assert.throws(() => parseGitHubUserSearchRequest({ projectPath: '', query: 'octo' }), /project path/);
  assert.throws(() => parseGitHubUserSearchRequest({ projectPath: '/site' }), /Expected string/);
  assert.throws(() => parseGitHubUserSearchRequest({ projectPath: '/site', query: '-x' }), /GitHub username/);
});

test('replies parse to bounded suggestions', () => {
  const reply = { users: [user('octocat'), { login: 'sam', source: 'author' }], github: 'searched' };
  assert.deepEqual(parseGitHubUserSearchResult(reply), {
    users: [
      { login: 'octocat', name: 'Octo Cat', avatarURL: 'https://avatars.githubusercontent.com/u/1?s=40', source: 'search' },
      { login: 'sam', name: undefined, avatarURL: undefined, source: 'author' },
    ],
    github: 'searched',
  });
  assert.equal(parseGitHubUserSearchResult({ users: [{ ...user('octocat'), name: '  ' }], github: 'unavailable' }).users[0]?.name, undefined);
  const full = Array.from({ length: GITHUB_USER_SEARCH_LIMITS.usersMax }, (_, index) => user(`user${index}`));
  assert.equal(parseGitHubUserSearchResult({ users: full, github: 'searched' }).users.length, 8);
});

test('each bad reply shape fails', () => {
  const tooMany = Array.from({ length: GITHUB_USER_SEARCH_LIMITS.usersMax + 1 }, (_, index) => user(`user${index}`));
  const bad: readonly (readonly [unknown, RegExp])[] = [
    [undefined, /Expected object/],
    [{ users: {}, github: 'searched' }, /Expected array/],
    [{ users: [], github: 'maybe' }, /search state/],
    [{ users: [] }, /search state/],
    [{ users: tooMany, github: 'searched' }, /exceeds limit/],
    [{ users: [user('octocat'), user('OctoCat')], github: 'searched' }, /duplicate login/],
    [{ users: [{ ...user('octocat'), source: 'friend' }], github: 'searched' }, /unknown source/],
    [{ users: [{ ...user('octocat'), login: 'octo cat' }], github: 'searched' }, /not a GitHub username/],
    [{ users: [{ ...user('octocat'), name: 'n'.repeat(256) }], github: 'searched' }, /name exceeds/],
    [{ users: [{ ...user('octocat'), avatarURL: 'https://www.gravatar.com/avatar/1' }], github: 'searched' }, /avatar host/],
    [{ users: [{ ...user('octocat'), avatarURL: 'https://user:pw@github.com/a.png' }], github: 'searched' }, /credentials/],
  ];
  for (const [input, message] of bad) {
    assert.throws(() => parseGitHubUserSearchResult(input), message, JSON.stringify(input));
  }
});
