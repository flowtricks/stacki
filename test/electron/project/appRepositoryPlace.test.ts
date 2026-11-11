// Goal: a GitHub app's repository visibility (electron/project/appRepositoryPlace.ts)
// is asked of GitHub once and reused for ten minutes, per repository and account;
// concurrent asks share one request; a failure (an error status, no network, a
// reply without `private`) answers no visibility, never an error, and is asked
// again sooner than an answer; the cache never holds more than its bound. The
// install's account lends its token, and a sign-in that fails falls back to an
// anonymous read. For an installed app, `place` answers its repository: a GitHub
// install's own, a marketplace install's from the index, none for an uploaded
// app; an app that is not installed is an expected failure. The channel is
// gated on `panel:apps` in main.
// Method: a fake GitHub that counts requests and answers per repository, a fake
// clock, and a temporary project with one app installed from a file whose lock
// source is then switched to GitHub or the marketplace.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeStoredZip } from '#dist/shared/properties/appBundle.js';
import { APP_PLACE_LIMITS } from '#dist/shared/properties/appPlace.js';
import { parseMarketplaceIndex } from '#dist/shared/properties/appMarketplace.js';
import { createAppRepositoryPlaces } from '#dist/electron/project/appRepositoryPlace.js';
import { createAppService } from '#dist/electron/project/appService.js';
import { updateLockEntry } from '#dist/electron/project/appStore.js';
import { CHANNEL_ACCESS } from '#dist/electron/handlers/channelAccess.js';
// The running Stacki these tests stand in for: new enough for every fixture bundle.
const STACKI_VERSION = '1.1.0';

interface Call {
  readonly url: string;
  readonly authorization: string | undefined;
}

function github(answers: Readonly<Record<string, () => Response>>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    calls.push({ url, authorization: headers.get('Authorization') ?? undefined });
    const repository = url.replace('https://api.github.com/repos/', '');
    const answer = answers[repository];
    if (answer === undefined) {
      return new Response('{"message":"Not Found"}', { status: 404 });
    }
    return answer();
  };
  return { calls, fetch };
}

const json = (value: unknown) => () => new Response(JSON.stringify(value), { status: 200 });

function places(options: {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly clock: { now: number };
  readonly tokenFor?: (account: string) => Promise<string>;
}) {
  return createAppRepositoryPlaces({ fetch: options.fetch, now: () => options.clock.now, tokenFor: options.tokenFor, marketplace: async () => undefined });
}

const location = (owner: string, repository: string, account?: string) => ({ owner, repository, account });

test('an answer is cached for ten minutes per repository and account; concurrent asks share one request', async () => {
  const world = github({ 'octocat/heat-map': json({ private: true }), 'octocat/open': json({ private: false }) });
  const clock = { now: 0 };
  const lookup = places({ fetch: world.fetch, clock, tokenFor: async () => 'token-1' });
  const [first, second] = await Promise.all([
    lookup.visibility(location('octocat', 'heat-map', 'octocat')),
    lookup.visibility(location('octocat', 'heat-map', 'octocat')),
  ]);
  assert.equal(first, 'private');
  assert.equal(second, 'private');
  assert.equal(world.calls.length, 1, 'one request for two concurrent asks');
  assert.equal(world.calls[0]?.authorization, 'Bearer token-1', 'the install’s account lends its token');
  assert.equal(world.calls[0]?.url, 'https://api.github.com/repos/octocat/heat-map');
  assert.equal(await lookup.visibility(location('OctoCat', 'Heat-Map', 'octocat')), 'private');
  assert.equal(world.calls.length, 1, 'names ignore case');
  assert.equal(await lookup.visibility(location('octocat', 'open')), 'public');
  assert.equal(world.calls[1]?.authorization, undefined, 'a repository without an account is read anonymously');
  clock.now = APP_PLACE_LIMITS.visibilityCacheMsMax - 1;
  await lookup.visibility(location('octocat', 'heat-map', 'octocat'));
  assert.equal(world.calls.length, 2, 'still fresh just before ten minutes');
  clock.now = APP_PLACE_LIMITS.visibilityCacheMsMax;
  await lookup.visibility(location('octocat', 'heat-map', 'octocat'));
  assert.equal(world.calls.length, 3, 'asked again once stale');
});

test('a failure answers no visibility, and is asked again sooner', async () => {
  const failures: Readonly<Record<string, () => Response>> = {
    'octocat/server-error': () => new Response('', { status: 500 }),
    'octocat/rate-limited': () => new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
    'octocat/no-flag': json({ name: 'no-flag' }),
    'octocat/not-json': () => new Response('<html>', { status: 200 }),
  };
  const world = github(failures);
  const clock = { now: 0 };
  const lookup = places({ fetch: world.fetch, clock });
  for (const repository of [...Object.keys(failures).map((key) => key.split('/')[1] ?? ''), 'missing']) {
    assert.equal(await lookup.visibility(location('octocat', repository)), undefined, `${repository} says nothing`);
  }
  const offline = places({
    fetch: async () => {
      throw new TypeError('fetch failed');
    },
    clock,
  });
  assert.equal(await offline.visibility(location('octocat', 'heat-map')), undefined, 'no network says nothing');

  const before = world.calls.length;
  await lookup.visibility(location('octocat', 'server-error'));
  assert.equal(world.calls.length, before, 'a failure is remembered for a while');
  clock.now = APP_PLACE_LIMITS.visibilityFailureMsMax;
  await lookup.visibility(location('octocat', 'server-error'));
  assert.equal(world.calls.length, before + 1, 'and asked again after the shorter wait');
});

test('a sign-in that fails falls back to an anonymous read', async () => {
  const world = github({ 'octocat/heat-map': json({ private: false }) });
  const lookup = places({
    fetch: world.fetch,
    clock: { now: 0 },
    tokenFor: async () => {
      throw new Error('Sign in with GitHub as octocat to read its repositories.');
    },
  });
  assert.equal(await lookup.visibility(location('octocat', 'heat-map', 'octocat')), 'public');
  assert.equal(world.calls[0]?.authorization, undefined);
});

test('the cache holds at most its bound, forgetting the oldest first', async () => {
  const world = github({});
  const clock = { now: 0 };
  const lookup = places({
    fetch: async (url, init) => {
      await world.fetch(url, init);
      return new Response(JSON.stringify({ private: false }), { status: 200 });
    },
    clock,
  });
  const count = APP_PLACE_LIMITS.visibilityReposMax + 1;
  for (let index = 0; index < count; index += 1) {
    await lookup.visibility(location('octocat', `repo-${index}`));
  }
  assert.equal(world.calls.length, count);
  await lookup.visibility(location('octocat', `repo-${count - 1}`));
  assert.equal(world.calls.length, count, 'the newest is still cached');
  await lookup.visibility(location('octocat', 'repo-0'));
  assert.equal(world.calls.length, count + 1, 'the oldest was forgotten');
});

function project(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-app-place-')));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  const encoder = new TextEncoder();
  const manifest = { manifestVersion: 1, id: 'heat-map', name: 'Heat map', version: '1.0.0', entry: 'index.html' };
  const zip = writeStoredZip([
    { path: 'stacki-app.json', bytes: encoder.encode(JSON.stringify(manifest)) },
    { path: 'index.html', bytes: encoder.encode('<p>hi</p>') },
  ]);
  const service = createAppService({ stackiVersion: STACKI_VERSION, fetch: async () => new Response('', { status: 500 }), now: () => 0 });
  const staged = service.stageFile(root, zip, 'heat-map.zip');
  assert.ok(staged.ok);
  assert.ok(service.commit(root, staged.value.token).ok);
  return root;
}

test('an installed app’s place: its repository for GitHub and the marketplace, none for an upload', async (context) => {
  const root = project();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const world = github({ 'octocat/heat-map': json({ private: true }), 'hubot/heat-map': json({ private: false }) });
  const index = parseMarketplaceIndex({
    version: 1,
    apps: [
      {
        id: 'heat-map',
        name: 'Heat map',
        description: 'Clicks.',
        author: 'hubot',
        icon: 'https://stacki.build/api/marketplace/icons/heat-map.png',
        categories: [],
        source: { owner: 'hubot', repository: 'heat-map', asset: 'heat-map.zip' },
        versions: [{ version: '1.0.0', tag: 'v1.0.0', sha256: 'a'.repeat(64) }],
      },
    ],
  });
  const lookup = createAppRepositoryPlaces({ fetch: world.fetch, now: () => 0, tokenFor: async () => 'token-1', marketplace: async () => index });

  assert.deepEqual(await lookup.place(root, 'heat-map'), { ok: true, value: { place: undefined } }, 'an uploaded app has no repository');
  assert.equal(world.calls.length, 0, 'and asks GitHub nothing');

  updateLockEntry(root, 'heat-map', (entry) => ({
    ...entry,
    source: { kind: 'github', owner: 'octocat', repository: 'heat-map', asset: 'heat-map.zip', tag: 'v1.0.0', account: 'octocat' },
  }));
  assert.deepEqual(await lookup.place(root, 'heat-map'), { ok: true, value: { place: { owner: 'octocat', repository: 'heat-map', visibility: 'private' } } });

  updateLockEntry(root, 'heat-map', (entry) => ({ ...entry, source: { kind: 'marketplace', id: 'heat-map', version: '1.0.0' } }));
  assert.deepEqual(await lookup.place(root, 'heat-map'), { ok: true, value: { place: { owner: 'hubot', repository: 'heat-map', visibility: 'public' } } });

  const missing = await lookup.place(root, 'not-here');
  assert.equal(missing.ok, false);
  assert.equal(CHANNEL_ACCESS['apps:repositoryVisibility']?.join(), 'panel:apps');
});
