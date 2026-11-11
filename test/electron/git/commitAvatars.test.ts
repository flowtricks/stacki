// Goal: commit author lookups ask GitHub only when they must, only for a github.com remote,
// remember what they learned within a bound, and fall back quietly when GitHub refuses.
// Methodology: drive the real resolver with a fake fetch that records every request and
// replies with GraphQL shapes, rate-limit statuses and network failures, on a fake clock.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMMIT_AVATAR_RESOLVER_LIMITS, createCommitAvatarResolver, githubRepositoryFromRemote } from '#dist/electron/git/commitAvatars.js';

// GitHub writes JSON null for a commit with no GitHub user or a repository it will not show.
const jsonNull: unknown = JSON.parse('null');
const hashOf = (index: number) => index.toString(16).padStart(40, '0');
const avatar = (id: number) => `https://avatars.githubusercontent.com/u/${id}?v=4&s=40`;

interface Call {
  readonly url: string;
  readonly query: string;
  readonly authorization: string | undefined;
}

function harness(reply: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  let clock = 1_000_000;
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
    const query = typeof body === 'object' && body !== null && 'query' in body && typeof body.query === 'string' ? body.query : '';
    const call = { url: String(input), query, authorization: new Headers(init?.headers).get('authorization') ?? undefined };
    calls.push(call);
    return reply(call);
  };
  const resolver = createCommitAvatarResolver({ fetch: fakeFetch, now: () => clock });
  const lookup = (
    commits: ReadonlyArray<{ hash: string; email: string }>,
    remote: { readonly repository: string | undefined } = { repository: 'owner/site' },
  ) => {
    const repository = remote.repository;
    const asked = { repository: 0, token: 0 };
    return {
      asked,
      result: resolver.resolve({
        repository: async () => {
          asked.repository++;
          return repository;
        },
        token: async () => {
          asked.token++;
          return 'gho_testtoken123';
        },
        commits,
      }),
    };
  };
  return { calls, lookup, advance: (milliseconds: number) => (clock += milliseconds) };
}

/** A GraphQL answer giving commit `cN` the picture `ids[N]`, or no GitHub user. */
function authors(ids: ReadonlyArray<number | undefined>, headers: Record<string, string> = {}): Response {
  const repository = Object.fromEntries(ids.map((id, index) => [`c${index}`, { author: { user: id === undefined ? jsonNull : { avatarUrl: avatar(id) } } }]));
  return new Response(JSON.stringify({ data: { repository } }), { status: 200, headers });
}

test('github.com remotes are recognised and every other host is not', () => {
  assert.equal(githubRepositoryFromRemote('https://github.com/owner/site.git'), 'owner/site');
  assert.equal(githubRepositoryFromRemote('https://github.com/owner/site'), 'owner/site');
  assert.equal(githubRepositoryFromRemote('git@github.com:owner/my.site.git\n'), 'owner/my.site');
  assert.equal(githubRepositoryFromRemote('ssh://git@github.com/owner/site.git'), 'owner/site');
  assert.equal(githubRepositoryFromRemote('https://token@github.com/owner/site.git'), 'owner/site');
  for (const remote of [
    undefined,
    'https://gitlab.com/owner/site.git',
    'https://github.com.evil.example/owner/site.git',
    'git@bitbucket.org:owner/site.git',
    'https://github.com/owner',
    'https://github.com/owner/site/extra',
    'https://github.com/owner/..',
    '/local/path/site.git',
  ]) {
    assert.equal(githubRepositoryFromRemote(remote), undefined, String(remote));
  }
});

test('a non-GitHub remote makes no request and noreply needs none', async () => {
  const { calls, lookup } = harness(() => authors([1]));
  const nonGitHub = lookup([{ hash: hashOf(1), email: 'a@example.com' }], { repository: undefined });
  assert.deepEqual(await nonGitHub.result, []);
  assert.equal(nonGitHub.asked.token, 0, 'no credential is read for a non-GitHub remote');
  const noreply = lookup([{ hash: hashOf(2), email: '7+octocat@users.noreply.github.com' }]);
  assert.deepEqual(await noreply.result, [{ hash: hashOf(2), url: 'https://avatars.githubusercontent.com/u/7?s=40' }]);
  assert.equal(noreply.asked.repository, 0);
  assert.equal(calls.length, 0);
});

test('one query covers a page, and answers are cached by commit and by email', async () => {
  const { calls, lookup } = harness(() => authors([11, undefined]));
  const commits = [
    { hash: hashOf(1), email: 'Dev@Example.com' },
    { hash: hashOf(2), email: 'nobody@example.com' },
  ];
  assert.deepEqual(await lookup(commits).result, [{ hash: hashOf(1), url: avatar(11) }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://api.github.com/graphql');
  assert.equal(calls[0]?.authorization, 'Bearer gho_testtoken123');
  assert.match(calls[0]?.query ?? '', new RegExp(`c1: object\\(oid: "${hashOf(2)}"\\)`));
  // The same page again, and a new commit by a known email: no request.
  const again = lookup([...commits, { hash: hashOf(3), email: 'dev@example.com' }]);
  assert.deepEqual(await again.result, [
    { hash: hashOf(1), url: avatar(11) },
    { hash: hashOf(3), url: avatar(11) },
  ]);
  assert.equal(again.asked.token, 0);
  assert.equal(calls.length, 1, 'commits without a GitHub user are remembered too');
});

test('pictures on other hosts are dropped', async () => {
  const { lookup } = harness(
    () => new Response(JSON.stringify({ data: { repository: { c0: { author: { user: { avatarUrl: 'https://tracker.example/a.png' } } } } } }), { status: 200 }),
  );
  assert.deepEqual(await lookup([{ hash: hashOf(1), email: 'a@example.com' }]).result, []);
});

test('the cache forgets its oldest commits at the bound', async () => {
  const { calls, lookup } = harness((call) => authors(Array.from({ length: (call.query.match(/object\(/g) ?? []).length }, () => undefined)));
  const pageSize = 100;
  const pages = Math.ceil(COMMIT_AVATAR_RESOLVER_LIMITS.cacheEntriesMax / pageSize) + 1;
  for (let page = 0; page < pages; page++) {
    const commits = Array.from({ length: pageSize }, (_, index) => ({ hash: hashOf(page * pageSize + index + 1), email: '' }));
    await lookup(commits).result;
  }
  assert.equal(calls.length, pages);
  // The first page fell out of the cache, so it is asked about again.
  await lookup([{ hash: hashOf(1), email: '' }]).result;
  assert.equal(calls.length, pages + 1);
  // The newest page is still cached.
  await lookup([{ hash: hashOf(pages * pageSize), email: '' }]).result;
  assert.equal(calls.length, pages + 1);
});

test('403 and 429 silence the repository until the stated reset, then it is asked again', async () => {
  let status = 429;
  const { calls, lookup, advance } = harness(() =>
    status === 200 ? authors([5]) : new Response('{}', { status, headers: status === 429 ? { 'retry-after': '60' } : { 'x-ratelimit-remaining': '0' } }),
  );
  const commits = [{ hash: hashOf(1), email: 'a@example.com' }];
  assert.deepEqual(await lookup(commits).result, []);
  assert.deepEqual(await lookup(commits).result, [], 'quiet while limited');
  assert.equal(calls.length, 1);
  advance(61_000);
  status = 403;
  assert.deepEqual(await lookup(commits).result, []);
  assert.equal(calls.length, 2);
  advance(COMMIT_AVATAR_RESOLVER_LIMITS.backoffMsDefault - 1);
  await lookup(commits).result;
  assert.equal(calls.length, 2, 'a 403 without a reset time waits the default backoff');
  advance(2);
  status = 200;
  assert.deepEqual(await lookup(commits).result, [{ hash: hashOf(1), url: avatar(5) }]);
  assert.equal(calls.length, 3);
});

test('GraphQL rate limits, refusals and network failures fall back quietly', async () => {
  const replies: ReadonlyArray<() => Response> = [
    () => new Response(JSON.stringify({ errors: [{ type: 'RATE_LIMITED' }] }), { status: 200 }),
    () => new Response(JSON.stringify({ data: { repository: jsonNull } }), { status: 200 }),
    () => new Response('not json', { status: 200 }),
    () => {
      throw new TypeError('fetch failed');
    },
  ];
  for (const reply of replies) {
    const { calls, lookup } = harness(reply);
    const commits = [{ hash: hashOf(1), email: 'a@example.com' }];
    assert.deepEqual(await lookup(commits).result, []);
    assert.deepEqual(await lookup(commits).result, []);
    assert.equal(calls.length, 1, 'a failed repository is not asked again at once');
  }
});

test('a request beyond the page bound is a programmer error', async () => {
  const { lookup } = harness(() => authors([]));
  const commits = Array.from({ length: 101 }, (_, index) => ({ hash: hashOf(index + 1), email: '' }));
  await assert.rejects(lookup(commits).result, /Assertion failed: Commit avatars: request exceeds its bound/);
});
