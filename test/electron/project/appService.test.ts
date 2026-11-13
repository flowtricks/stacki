// Goal: installing, serving, updating and removing Stacki apps behaves as
// docs/apps.md says. An uploaded zip is staged and installed once confirmed;
// files land in .stacki/apps/<id>/ with a lockfile recording the SHA-256; the
// stacki-app: protocol serves those files only, under the sandboxing policy,
// and nothing outside the app's folder. A GitHub app installs a release asset
// (the latest, or a chosen tag) after its size and digest check out; a private
// repository is read with the signed-in account's token, which goes to GitHub's
// API only and never follows a redirect to storage; an update check records a
// newer release as available, and Update installs only the bytes that were
// checked. The chooser lists the account's repositories and a repository's releases;
// the ones carrying the `stacki-app` topic are marked, found by a repository search
// over the account and its organizations whose query stays within GitHub's limit.
// Method: temporary projects on a real disk, and a fake GitHub (a fetch that
// answers the release API and serves assets through one redirect) whose
// releases, digests and bytes each case changes; every request is recorded.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeStoredZip } from '#dist/shared/properties/appBundle.js';
import { createAppService } from '#dist/electron/project/appService.js';
import { rateLimitReset, stackiAppSearchQuery } from '#dist/electron/project/appGitHub.js';
import { readAppsLock } from '#dist/electron/project/appStore.js';
import { serveAppRequest } from '#dist/electron/handlers/appsHandlers.js';
// The running Stacki these tests stand in for: new enough for every fixture bundle.
const STACKI_VERSION = '1.1.0';

const encoder = new TextEncoder();

function project(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-apps-')));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  return root;
}

function appZip(version: string, extra: Readonly<Record<string, string>> = {}): Uint8Array {
  const manifest = { manifestVersion: 1, id: 'heat-map', name: 'Heat map', version, entry: 'index.html' };
  const files = { 'stacki-app.json': JSON.stringify(manifest), 'index.html': `<p>v${version}</p>`, ...extra };
  return writeStoredZip(Object.entries(files).map(([filePath, text]) => ({ path: filePath, bytes: encoder.encode(text) })));
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

interface Release {
  tag: string;
  bytes: Uint8Array;
  digest: string | undefined;
  served?: Uint8Array;
}

interface Call {
  readonly url: string;
  readonly authorization: string | undefined;
}

// GitHub as the service sees it: release JSON, and an asset that redirects once to storage.
function fakeGitHub(release: { current: Release }) {
  const calls: Call[] = [];
  const asset = (entry: Release) => ({
    name: 'heat-map.zip',
    size: entry.bytes.byteLength,
    url: 'https://api.github.com/repos/octocat/heat-map/releases/assets/7',
    ...(entry.digest === undefined ? {} : { digest: entry.digest }),
  });
  const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, authorization: new Headers(init.headers).get('authorization') ?? undefined });
    const { current } = release;
    if (
      url === 'https://api.github.com/repos/octocat/heat-map/releases/latest' ||
      url === `https://api.github.com/repos/octocat/heat-map/releases/tags/${current.tag}`
    ) {
      return Response.json({ tag_name: current.tag, assets: [asset(current)] });
    }
    if (url.startsWith('https://api.github.com/repos/octocat/heat-map/releases?')) {
      return Response.json([
        {
          tag_name: current.tag,
          name: 'Latest',
          published_at: '2026-11-01T00:00:00Z',
          prerelease: false,
          draft: false,
          assets: [{ name: 'heat-map.zip', size: 10 }],
        },
        { tag_name: 'v0-draft', name: 'Draft', published_at: '2026-11-02T00:00:00Z', prerelease: false, draft: true, assets: [] },
      ]);
    }
    if (url.startsWith('https://api.github.com/user/repos?')) {
      return Response.json([
        { owner: { login: 'octocat', type: 'User' }, name: 'heat-map', private: true, pushed_at: '2026-11-01T00:00:00Z' },
        { owner: { login: 'acme', type: 'Organization' }, name: 'notes', private: false, pushed_at: '2026-10-01T00:00:00Z', topics: ['stacki-app'] },
        { owner: { login: 'acme', type: 'Organization' }, name: 'website', private: false, pushed_at: '2026-09-01T00:00:00Z', topics: ['astro'] },
      ]);
    }
    if (url.startsWith('https://api.github.com/search/repositories?')) {
      // The tagged repositories the search sees, including one outside the listing.
      return Response.json({
        items: [
          { owner: { login: 'octocat' }, name: 'heat-map', private: true, pushed_at: '2026-11-01T00:00:00Z' },
          { owner: { login: 'acme' }, name: 'charts', private: true, pushed_at: '2026-08-01T00:00:00Z' },
        ],
      });
    }
    if (url === 'https://api.github.com/repos/octocat/heat-map/releases/assets/7') {
      return new Response(undefined, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/asset' } });
    }
    if (url === 'https://release-assets.githubusercontent.com/asset') {
      return new Response(new Uint8Array(current.served ?? current.bytes));
    }
    return new Response('not found', { status: 404 });
  };
  return { fetcher, calls };
}

test('an uploaded app installs once confirmed, and serves its files sandboxed', () => {
  const root = project();
  const service = createAppService({
    stackiVersion: STACKI_VERSION,
    fetch: async () => new Response('', { status: 500 }),
    now: () => Date.parse('2026-11-10T00:00:00Z'),
  });
  const zip = appZip('1.0.0', { 'app.js': 'stacki.selection.get()' });
  const staged = service.stageFile(root, zip, '/Users/me/Downloads/heat-map.zip');
  assert.ok(staged.ok);
  assert.equal(staged.value.manifest.id, 'heat-map');
  assert.equal(staged.value.sha256, sha256(zip));
  assert.deepEqual(staged.value.source, { kind: 'file', fileName: 'heat-map.zip' });
  assert.equal(fs.existsSync(path.join(root, '.stacki/apps/heat-map')), false, 'staging writes nothing');

  const installed = service.commit(root, staged.value.token);
  assert.ok(installed.ok);
  assert.equal(service.commit(root, staged.value.token).ok, false, 'a token installs once');
  assert.equal(readAppsLock(root).apps[0]?.sha256, sha256(zip));
  assert.equal(fs.readFileSync(path.join(root, '.stacki/apps/heat-map/app.js'), 'utf8'), 'stacki.selection.get()');

  const page = serveAppRequest('stacki-app://heat-map/index.html', root);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') ?? '', /^sandbox allow-scripts/);
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(serveAppRequest('stacki-app://heat-map/stacki-sdk.js', root).status, 200);
  assert.equal(serveAppRequest('stacki-app://heat-map/missing.js', root).status, 404);
  assert.equal(serveAppRequest('stacki-app://heat-map/..%2Fapps.json', root).status, 404);
  assert.equal(serveAppRequest('stacki-app://other/index.html', root).status, 404);
  assert.equal(serveAppRequest('stacki-app://heat-map/index.html', undefined).status, 404);
  // A link planted by hand inside the folder does not reach outside it.
  fs.writeFileSync(path.join(root, 'secret.txt'), 'secret');
  fs.symlinkSync(path.join(root, 'secret.txt'), path.join(root, '.stacki/apps/heat-map/leak.txt'));
  assert.equal(serveAppRequest('stacki-app://heat-map/leak.txt', root).status, 404);

  const removed = service.uninstall(root, 'heat-map');
  assert.ok(removed.ok);
  assert.deepEqual(removed.value, []);
  assert.equal(fs.existsSync(path.join(root, '.stacki/apps/heat-map')), false);
});

test('a bad upload is refused with its reason and installs nothing', () => {
  const root = project();
  const service = createAppService({ stackiVersion: STACKI_VERSION, fetch: async () => new Response(''), now: () => 0 });
  const staged = service.stageFile(root, encoder.encode('not a zip'), 'x.zip');
  assert.equal(staged.ok, false);
  assert.match(staged.ok ? '' : staged.message, /not a zip/);
  const traversal = writeStoredZip([{ path: '../../evil.js', bytes: encoder.encode('x') }]);
  assert.equal(service.stageFile(root, traversal, 'evil.zip').ok, false);
  assert.equal(fs.existsSync(path.join(root, '.stacki/apps')), false);
});

test('a staged upload expires', () => {
  const root = project();
  let now = 0;
  const service = createAppService({ stackiVersion: STACKI_VERSION, fetch: async () => new Response(''), now: () => now });
  const staged = service.stageFile(root, appZip('1.0.0'), 'a.zip');
  assert.ok(staged.ok);
  now = 11 * 60_000;
  assert.equal(service.commit(root, staged.value.token).ok, false);
});

test('GitHub: install, find an update, Update installs only the checked bytes', async () => {
  const root = project();
  const first = appZip('1.0.0');
  const initial: Release = { tag: 'v1.0.0', bytes: first, digest: `sha256:${sha256(first)}` };
  const release = { current: initial };
  const github = fakeGitHub(release);
  let now = 0;
  const service = createAppService({ stackiVersion: STACKI_VERSION, fetch: github.fetcher, now: () => now });
  const source = { kind: 'github' as const, owner: 'octocat', repository: 'heat-map', asset: 'heat-map.zip' };

  const staged = await service.stageGitHub(root, source, undefined);
  assert.ok(staged.ok, staged.ok ? '' : staged.message);
  assert.deepEqual(staged.value.source, { ...source, tag: 'v1.0.0' });
  assert.ok(service.commit(root, staged.value.token).ok);
  assert.ok(
    github.calls.every((call) => call.authorization === undefined),
    'a public repository is read without credentials',
  );

  const same = await service.checkUpdates(root, true);
  assert.deepEqual(same.ok ? same.value : same.message, [{ kind: 'current', id: 'heat-map' }]);

  // A newer release is found and waits for Update; the installed version stays.
  const second = appZip('1.1.0');
  release.current = { tag: 'v1.1.0', bytes: second, digest: `sha256:${sha256(second)}` };
  const found = await service.checkUpdates(root, true);
  assert.deepEqual(found.ok ? found.value : found.message, [{ kind: 'available', id: 'heat-map', version: '1.1.0' }]);
  assert.equal(readAppsLock(root).apps[0]?.version, '1.0.0');
  assert.deepEqual(readAppsLock(root).apps[0]?.update, { version: '1.1.0', tag: 'v1.1.0', sha256: sha256(second), additions: [] });

  // Automatic checks are spaced out; a forced one is not.
  now += 60_000;
  const skipped = await service.checkUpdates(root, false);
  assert.deepEqual(skipped.ok ? skipped.value : skipped.message, []);

  // Update refuses bytes that changed since the check.
  const swapped = appZip('1.1.0', { 'extra.js': 'x' });
  release.current = { tag: 'v1.1.0', bytes: swapped, digest: undefined };
  const changed = await service.applyUpdate(root, 'heat-map');
  assert.match(changed.ok ? '' : changed.message, /changed since it was checked/);

  release.current = { tag: 'v1.1.0', bytes: second, digest: `sha256:${sha256(second)}` };
  const updated = await service.applyUpdate(root, 'heat-map');
  assert.ok(updated.ok, updated.ok ? '' : updated.message);
  assert.equal(updated.value.manifest.version, '1.1.0');
  assert.equal(updated.value.lock.update, undefined);
});

// A bundle whose manifest says `"stacki": ">=<minimum>"`.
function appZipNeeding(version: string, minimum: string): Uint8Array {
  const manifest = { manifestVersion: 1, id: 'heat-map', name: 'Heat map', version, entry: 'index.html', stacki: `>=${minimum}` };
  return appZip(version, { 'stacki-app.json': JSON.stringify(manifest) });
}

test('an app that needs a newer Stacki is refused on upload, install and update; a new enough Stacki takes it', async () => {
  const root = project();
  const needs = appZipNeeding('1.0.0', '1.1.0');
  const old = createAppService({ stackiVersion: '1.0.24', fetch: async () => new Response(''), now: () => 0 });
  const refused = old.stageFile(root, needs, 'heat-map.zip');
  assert.equal(refused.ok, false);
  assert.equal(refused.ok ? '' : refused.message, 'Heat map 1.0.0: Needs Stacki 1.1.0 or later. Update Stacki.');
  assert.equal(fs.existsSync(path.join(root, '.stacki/apps')), false);

  // The exact minimum is enough, and a host that cannot say its version is not judged.
  const exact = createAppService({ stackiVersion: '1.1.0', fetch: async () => new Response(''), now: () => 0 });
  assert.ok(exact.stageFile(root, needs, 'heat-map.zip').ok);
  const unknown = createAppService({ stackiVersion: 'unknown', fetch: async () => new Response(''), now: () => 0 });
  assert.ok(unknown.stageFile(root, needs, 'heat-map.zip').ok);

  // An update a GitHub check finds is reported, not offered, on a Stacki too old for it; the installed version stays.
  const first = appZip('1.0.0');
  const initial: Release = { tag: 'v1.0.0', bytes: first, digest: `sha256:${sha256(first)}` };
  const release = { current: initial };
  const github = fakeGitHub(release);
  const service = createAppService({ stackiVersion: '1.0.24', fetch: github.fetcher, now: () => 0 });
  const source = { kind: 'github' as const, owner: 'octocat', repository: 'heat-map', asset: 'heat-map.zip' };
  const staged = await service.stageGitHub(root, source, undefined);
  assert.ok(staged.ok, staged.ok ? '' : staged.message);
  assert.ok(service.commit(root, staged.value.token).ok);
  const second = appZipNeeding('1.1.0', '1.1.0');
  release.current = { tag: 'v1.1.0', bytes: second, digest: `sha256:${sha256(second)}` };
  const checked = await service.checkUpdates(root, true);
  assert.deepEqual(checked.ok ? checked.value : checked.message, [
    {
      kind: 'failed',
      id: 'heat-map',
      message: 'Heat map 1.1.0: Needs Stacki 1.1.0 or later. Update Stacki.',
      messageRef: { key: 'apps.error.versionTooOld', params: { name: 'Heat map', version: '1.1.0', minimum: '1.1.0' } },
    },
  ]);
  assert.equal(readAppsLock(root).apps[0]?.version, '1.0.0');
  assert.equal(readAppsLock(root).apps[0]?.update, undefined);
});

test('GitHub: a private repository is read with the account token, which never follows a redirect', async () => {
  const root = project();
  const initial: Release = { tag: 'v2.0.0', bytes: appZip('2.0.0'), digest: undefined };
  const github = fakeGitHub({ current: initial });
  const tokens: string[] = [];
  const service = createAppService({
    stackiVersion: STACKI_VERSION,
    fetch: github.fetcher,
    now: () => 0,
    tokenFor: async (account: string) => {
      tokens.push(account);
      return 'gho_test_token';
    },
  });
  const repositories = await service.repositories('octocat');
  assert.deepEqual(repositories.ok ? repositories.value : repositories.message, [
    { owner: 'octocat', name: 'heat-map', private: true, updatedAt: '2026-11-01T00:00:00Z', stackiApp: true, organization: false },
    { owner: 'acme', name: 'notes', private: false, updatedAt: '2026-10-01T00:00:00Z', stackiApp: true, organization: true },
    { owner: 'acme', name: 'website', private: false, updatedAt: '2026-09-01T00:00:00Z', stackiApp: false, organization: true },
    { owner: 'acme', name: 'charts', private: true, updatedAt: '2026-08-01T00:00:00Z', stackiApp: true, organization: false },
  ]);
  const search = github.calls.find((call) => call.url.startsWith('https://api.github.com/search/repositories?'));
  assert.ok(search !== undefined, 'the tagged repositories come from a search');
  const searched = new URL(search.url).searchParams;
  assert.equal(searched.get('q'), 'topic:stacki-app user:octocat org:acme');
  assert.equal(searched.get('sort'), 'updated');
  const releases = await service.releases('octocat', 'heat-map', 'octocat');
  assert.deepEqual(releases.ok ? releases.value.map((entry) => entry.tag) : releases.message, ['v2.0.0'], 'drafts are left out');
  const source = { kind: 'github' as const, owner: 'octocat', repository: 'heat-map', asset: 'heat-map.zip', account: 'octocat' };
  const staged = await service.stageGitHub(root, source, 'v2.0.0');
  assert.ok(staged.ok, staged.ok ? '' : staged.message);
  assert.deepEqual(staged.value.source, { ...source, tag: 'v2.0.0' });
  for (const call of github.calls) {
    const api = call.url.startsWith('https://api.github.com/');
    assert.equal(call.authorization, api ? 'Bearer gho_test_token' : undefined, call.url);
  }
  assert.ok(tokens.every((account) => account === 'octocat'));
  const unsigned = createAppService({ stackiVersion: STACKI_VERSION, fetch: github.fetcher, now: () => 0 });
  const refused = await unsigned.repositories('octocat');
  assert.match(refused.ok ? '' : refused.message, /Sign in with GitHub/);
});

test('GitHub: a digest mismatch, an oversized asset and a foreign redirect are refused', async () => {
  const root = project();
  const bytes = appZip('1.0.0');
  const initial: Release = { tag: 'v1.0.0', bytes, digest: `sha256:${'0'.repeat(64)}` };
  const release = { current: initial };
  const github = fakeGitHub(release);
  const service = createAppService({ stackiVersion: STACKI_VERSION, fetch: github.fetcher, now: () => 0 });
  const source = { kind: 'github' as const, owner: 'octocat', repository: 'heat-map', asset: 'heat-map.zip' };
  const mismatch = await service.stageGitHub(root, source, undefined);
  assert.match(mismatch.ok ? '' : mismatch.message, /digest/);

  release.current = { tag: 'v1.0.0', bytes, digest: undefined, served: new Uint8Array(bytes.byteLength + 10) };
  const longer = await service.stageGitHub(root, source, undefined);
  assert.match(longer.ok ? '' : longer.message, /larger than|bytes/);

  const foreign = createAppService({
    stackiVersion: STACKI_VERSION,
    fetch: async (url: string, init: RequestInit) => {
      if (url.includes('/releases/latest')) {
        return github.fetcher(url, init);
      }
      return new Response(undefined, { status: 302, headers: { location: 'https://evil.example.com/x' } });
    },
    now: () => 0,
  });
  release.current = { tag: 'v1.0.0', bytes, digest: undefined };
  const redirected = await foreign.stageGitHub(root, source, undefined);
  assert.match(redirected.ok ? '' : redirected.message, /not GitHub/);

  const missing = await service.stageGitHub(root, { ...source, asset: 'other.zip' }, undefined);
  assert.match(missing.ok ? '' : missing.message, /no asset named other.zip/);
  assert.equal(fs.existsSync(path.join(root, '.stacki/apps')), false);
});

test('GitHub: the tagged-repository query names the topic, the account and its organizations, within GitHub’s limit', () => {
  assert.equal(stackiAppSearchQuery([{ login: 'octocat', kind: 'user' }]), 'topic:stacki-app user:octocat');
  assert.equal(
    stackiAppSearchQuery([
      { login: 'octocat', kind: 'user' },
      { login: 'acme', kind: 'organization' },
      { login: 'ACME', kind: 'organization' },
      { login: 'globex', kind: 'organization' },
    ]),
    'topic:stacki-app user:octocat org:acme org:globex',
    'an owner named twice, in any case, is named once',
  );
  // Thirty 39-character organizations cannot all fit in 256 characters: the query stops at the limit.
  const many = Array.from({ length: 30 }, (_, index) => ({ login: `${String(index).padStart(2, '0')}${'o'.repeat(37)}`, kind: 'organization' as const }));
  const query = stackiAppSearchQuery([{ login: 'octocat', kind: 'user' }, ...many]);
  assert.ok(query.length <= 256, `${query.length}`);
  assert.ok(query.startsWith('topic:stacki-app user:octocat org:00'), query);
  assert.throws(() => stackiAppSearchQuery([]), /names at least one owner/);
});

test('GitHub: a refused search still marks the repositories by their own topics', async () => {
  const fetcher = async (url: string): Promise<Response> => {
    if (url.startsWith('https://api.github.com/user/repos?')) {
      return Response.json([
        { owner: { login: 'octocat', type: 'User' }, name: 'heat-map', private: false, pushed_at: '2026-11-01T00:00:00Z', topics: ['stacki-app'] },
        { owner: { login: 'octocat', type: 'User' }, name: 'website', private: false, pushed_at: '2026-10-01T00:00:00Z' },
      ]);
    }
    return new Response('rate limited', { status: 403 });
  };
  const service = createAppService({ stackiVersion: STACKI_VERSION, fetch: fetcher, now: () => 0, tokenFor: async () => 'gho_test_token' });
  const repositories = await service.repositories('octocat');
  assert.deepEqual(repositories.ok ? repositories.value.map((entry) => [entry.name, entry.stackiApp]) : repositories.message, [
    ['heat-map', true],
    ['website', false],
  ]);
});

test('GitHub: the rate limit is told from a plain refusal, with its reset time', async () => {
  const headers = (entries: Record<string, string>) => new Headers(entries);
  assert.deepEqual(rateLimitReset({ status: 403, headers: headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1789052400' }) }), {
    resetAtMs: 1_789_052_400_000,
  });
  assert.deepEqual(rateLimitReset({ status: 429, headers: headers({ 'retry-after': '120' }) }, 1_000), { resetAtMs: 121_000 });
  assert.deepEqual(rateLimitReset({ status: 429, headers: headers({}) }), { resetAtMs: undefined });
  assert.equal(rateLimitReset({ status: 403, headers: headers({ 'x-ratelimit-remaining': '12' }) }), undefined, 'a 403 with requests left is no access');
  assert.equal(rateLimitReset({ status: 403, headers: headers({}) }), undefined);
  assert.equal(rateLimitReset({ status: 502, headers: headers({}) }), undefined);

  const limited = createAppService({
    stackiVersion: STACKI_VERSION,
    fetch: async () => new Response('limited', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1789052400' } }),
    now: () => 0,
    tokenFor: async () => 'gho_test_token',
  });
  const answer = await limited.repositories('octocat');
  assert.equal(answer.ok ? '' : answer.message, `GitHub is limiting requests until ${new Date(1_789_052_400_000).toISOString()}.`);
});
