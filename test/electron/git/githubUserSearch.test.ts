// Goal: the member picker's GitHub answers are parsed strictly (each bad shape fails, bounds
// hold), only the typed query reaches GitHub's search, the repository's collaborators and
// commit authors rank first, and a rate limit or a network failure is a quiet "unavailable"
// that still returns the local matches.
// Methodology: feed known-good and each known-bad `/search/users` and collaborator body to the
// parsers, then drive the real resolver with a fake fetch that records every request and
// answers with search pages, collaborator pages, 403 rate limits and thrown network errors,
// on a fake clock.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GITHUB_USER_SEARCH_RESOLVER_LIMITS,
  createGitHubUserSearch,
  githubNoreplyLogin,
  parseGitHubCollaboratorsResponse,
  parseGitHubUserSearchResponse,
} from '#dist/electron/git/githubUserSearch.js';

const item = (login: string, id = 1) => ({ login, id, type: 'User', avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4` });
const page = (...logins: readonly string[]) => ({
  total_count: logins.length,
  incomplete_results: false,
  items: logins.map((login, index) => item(login, index + 1)),
});
const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

test('a search page parses to users with sized GitHub pictures', () => {
  assert.deepEqual(parseGitHubUserSearchResponse(page('octocat')), [{ login: 'octocat', avatarURL: 'https://avatars.githubusercontent.com/u/1?v=4&s=40' }]);
  assert.deepEqual(parseGitHubUserSearchResponse({ total_count: 0, items: [] }), []);
  // Organizations cannot be role members; an item without a type is kept.
  assert.deepEqual(parseGitHubUserSearchResponse({ total_count: 2, items: [{ ...item('acme'), type: 'Organization' }, { login: 'sam' }] }), [
    { login: 'sam', avatarURL: undefined },
  ]);
});

test('each bad search shape fails', () => {
  const bad: readonly (readonly [unknown, RegExp])[] = [
    [undefined, /expected an object/],
    [[], /expected an object/],
    [{ items: [] }, /total count/],
    [{ total_count: -1, items: [] }, /total count/],
    [{ total_count: 1.5, items: [] }, /total count/],
    [{ total_count: 0 }, /expected items/],
    [{ total_count: 0, items: {} }, /expected items/],
    [{ total_count: 1, items: ['octocat'] }, /expected an object/],
    [{ total_count: 1, items: [{ login: 7 }] }, /Expected string/],
    [{ total_count: 1, items: [{ login: '-octocat' }] }, /not a GitHub username/],
    [{ total_count: 1, items: [{ login: 'octo--cat' }] }, /not a GitHub username/],
    [{ total_count: 1, items: [{ login: 'a'.repeat(40) }] }, /1 to 39/],
    [{ total_count: 1, items: [{ login: 'octocat', type: 3 }] }, /type name/],
    [{ total_count: 1, items: [{ ...item('octocat'), avatar_url: 'https://evil.example/a.png' }] }, /avatar host/],
    [{ total_count: 1, items: [{ ...item('octocat'), avatar_url: 'http://avatars.githubusercontent.com/u/1' }] }, /https/],
  ];
  for (const [input, message] of bad) {
    assert.throws(() => parseGitHubUserSearchResponse(input), message, JSON.stringify(input));
  }
});

test('search and collaborator pages are bounded', () => {
  const many = Array.from({ length: GITHUB_USER_SEARCH_RESOLVER_LIMITS.searchItemsMax + 1 }, (_, index) => item(`user${index}`, index + 1));
  assert.throws(() => parseGitHubUserSearchResponse({ total_count: many.length, items: many }), /too many items/);
  assert.equal(parseGitHubUserSearchResponse({ total_count: 100, items: many.slice(0, 100) }).length, 100);
  assert.deepEqual(parseGitHubCollaboratorsResponse([item('owner')]), [{ login: 'owner', avatarURL: 'https://avatars.githubusercontent.com/u/1?v=4&s=40' }]);
  assert.throws(() => parseGitHubCollaboratorsResponse({}), /expected a list/);
  assert.throws(() => parseGitHubCollaboratorsResponse(many), /too many items/);
});

test('noreply addresses name their login; bots and other addresses do not', () => {
  assert.equal(githubNoreplyLogin('12345+Octo-Cat@users.noreply.github.com'), 'Octo-Cat');
  assert.equal(githubNoreplyLogin('sam@users.noreply.github.com'), 'sam');
  assert.equal(githubNoreplyLogin('49699333+dependabot[bot]@users.noreply.github.com'), undefined);
  assert.equal(githubNoreplyLogin('sam@example.com'), undefined);
});

function harness(reply: (url: URL) => Response | Promise<Response>) {
  const calls: { readonly url: URL; readonly authorization: string | undefined }[] = [];
  let clock = 1_000_000;
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    calls.push({ url, authorization: new Headers(init?.headers).get('authorization') ?? undefined });
    return reply(url);
  };
  const users = createGitHubUserSearch({ fetch: fakeFetch, now: () => clock });
  const search = (query: string, extra?: { readonly repository?: string; readonly token?: string }) =>
    users.search({
      query,
      repository: async () => extra?.repository,
      token: async () => extra?.token,
      authors: async () => [
        { name: 'Sam Rivera', email: '1+samr@users.noreply.github.com' },
        { name: 'Someone', email: 'someone@example.com' },
      ],
    });
  return { calls, search, advance: (ms: number) => (clock += ms) };
}

test('only the typed query reaches the search, and local matches rank first', async () => {
  const { calls, search } = harness((url) => (url.pathname === '/search/users' ? json(page('samuel', 'samr', 'xsam')) : json([item('sam-owner', 9)])));
  const result = await search('sam', { repository: 'acme/site', token: 'secret-token-123' });
  assert.equal(result.github, 'searched');
  assert.deepEqual(
    result.users.map((user) => [user.login, user.source]),
    [
      ['sam-owner', 'collaborator'],
      ['samr', 'author'],
      ['samuel', 'search'],
      ['xsam', 'search'],
    ],
  );
  assert.equal(result.users[1]?.name, 'Sam Rivera', 'a commit author keeps their name');
  const searchCall = calls.find((call) => call.url.pathname === '/search/users');
  assert.ok(searchCall);
  assert.equal(searchCall.url.origin, 'https://api.github.com');
  assert.deepEqual([...searchCall.url.searchParams.keys()].sort(), ['per_page', 'q']);
  assert.equal(searchCall.url.searchParams.get('q'), 'sam in:login');
  assert.equal(searchCall.authorization, 'Bearer secret-token-123');
  const collaboratorCall = calls.find((call) => call.url.pathname === '/repos/acme/site/collaborators');
  assert.ok(collaboratorCall, 'collaborators are asked of the repository');
  assert.equal(collaboratorCall.url.search.includes('sam'), false, 'the collaborator list is asked for without the query');
});

test('answers are capped at eight and one row per login', async () => {
  const logins = Array.from({ length: 12 }, (_, index) => `sam${index}`);
  const { search } = harness(() => json(page(...logins, 'SAMR')));
  const result = await search('sam');
  assert.equal(result.users.length, 8);
  assert.equal(new Set(result.users.map((user) => user.login.toLowerCase())).size, 8);
});

test('a rate limit is quiet, keeps the local matches, and silences the search until the reset', async () => {
  let limited = true;
  const { calls, search, advance } = harness(() =>
    limited ? new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(1_000 + 30) } }) : json(page('samuel')),
  );
  const first = await search('sam');
  assert.equal(first.github, 'unavailable');
  assert.deepEqual(
    first.users.map((user) => user.login),
    ['samr'],
  );
  limited = false;
  const silenced = await search('sa');
  assert.equal(silenced.github, 'unavailable');
  assert.equal(calls.length, 1, 'no request while silenced');
  advance(31_000);
  const after = await search('sa');
  assert.equal(after.github, 'searched');
  assert.equal(calls.length, 2);
});

test('offline and malformed answers read as unavailable; answers are cached per query', async () => {
  let mode: 'offline' | 'malformed' | 'good' = 'offline';
  const { calls, search, advance } = harness(() => {
    if (mode === 'offline') {
      throw new TypeError('fetch failed');
    }
    return mode === 'malformed' ? json({ items: 'nope' }) : json(page('octocat'));
  });
  assert.equal((await search('octo')).github, 'unavailable');
  advance(GITHUB_USER_SEARCH_RESOLVER_LIMITS.backoffMsDefault);
  mode = 'malformed';
  assert.equal((await search('octo')).github, 'unavailable');
  advance(GITHUB_USER_SEARCH_RESOLVER_LIMITS.backoffMsDefault);
  mode = 'good';
  assert.equal((await search('octo')).users[0]?.login, 'octocat');
  const count = calls.length;
  assert.equal((await search('Octo')).users[0]?.login, 'octocat');
  assert.equal(calls.length, count, 'the same query, in any case, is answered from the cache');
});

test('a query that cannot start a login is refused before any request', async () => {
  const { calls, search } = harness(() => json(page()));
  for (const query of ['', '-sam', 'sam--x', 'sam x', 'sam@example.com', 'a'.repeat(40)]) {
    await assert.rejects(search(query), /GitHub username/, query);
  }
  assert.equal(calls.length, 0);
});
