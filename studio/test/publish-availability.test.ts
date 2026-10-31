// Goal: Studio reports actual draft and deployed revisions without mutating either destination.
// Method: hash real files against Git, serve the real HTTP route, and control external responses.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, chmod, symlink, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { PublishStatusSource } from '../src/features/publishing/publishStatusSource';
import { availabilityRoutes } from '../src/features/publishing/availabilityRoutes';
import {
  parsePublishedStatusFiles,
  readDeployedStatusRevision,
} from '../src/features/publishing/publishStatusRemote';
import { parsePublishAvailability } from '../vendor/stacki/shared/properties/publishState';
import { ok } from '../vendor/stacki/shared/core/result';

const revision = 'a'.repeat(40);
const otherRevision = 'b'.repeat(40);
const file = 'src/pages/index.astro';
const source = '<h1>Hello</h1>';

test('source comparison follows edits, undo, additions, modes, and explicit deletions', async (t) => {
  const fixture = await sourceFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const status = new PublishStatusSource(fixture.root);
  const remote = parsePublishedStatusFiles({ truncated: false, tree: [fixture.entry] });
  assert.equal(await status.differs(remote), false);
  await writeFile(path.join(fixture.root, file), '<h1>Draft</h1>');
  assert.equal(await status.differs(remote), true);
  await writeFile(path.join(fixture.root, file), source);
  assert.equal(await status.differs(remote), false);
  const executable = new Map([[file, { sha: fixture.entry.sha, mode: '100755' }]]);
  assert.equal(await status.differs(executable), true, 'Remote executable changes are detected');
  // Windows chmod cannot change executable bits; exercise real mode changes on POSIX.
  if (process.platform !== 'win32') {
    await chmod(path.join(fixture.root, file), 0o755);
    assert.equal(await status.differs(remote), true);
    assert.equal(await status.differs(executable), false);
    await chmod(path.join(fixture.root, file), 0o644);
  }
  await writeFile(path.join(fixture.root, 'public/new.txt'), 'new');
  assert.equal(await status.differs(remote), true);
  await rm(path.join(fixture.root, 'public/new.txt'));
  const assetTree = new Map([...remote, ['public/old.png', { sha: revision, mode: '100644' }]]);
  assert.equal(await status.differs(assetTree), false, 'Missing files are not implicit deletions');
  await mkdir(path.join(fixture.root, '.stacki/studio/state'), { recursive: true });
  await writeFile(
    path.join(fixture.root, '.stacki/studio/state/asset-state.json'),
    JSON.stringify({
      deleted: ['public/old.png'],
      directories: [],
      removedDirectories: [],
    }),
  );
  assert.equal(await status.differs(assetTree), true);
  assert.equal(await status.differs(remote), false, 'Already-published deletions are current');
});

test('source checks reject symlinks and never allocate snapshot files', async (t) => {
  const fixture = await sourceFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const before = await readdir(fixture.root);
  const status = new PublishStatusSource(fixture.root);
  await status.differs(new Map());
  assert.deepEqual(await readdir(fixture.root), before);
  await symlink(path.join(fixture.root, file), path.join(fixture.root, 'public/link'));
  await assert.rejects(status.differs(new Map()), /symbolic links/);
});

test('remote parsers reject partial trees, bad revisions, traversal, modes, and duplicates', () => {
  const entry = { path: file, sha: revision, mode: '100644', type: 'blob' };
  assert.equal(parsePublishedStatusFiles({ truncated: false, tree: [entry] }).size, 1);
  for (const input of [
    {},
    { truncated: true, tree: [entry] },
    { truncated: false, tree: new Array(100_001) },
    ...[{ sha: 'invalid' }, { path: '../secret' }, { path: '/absolute' }, { mode: 'bad' }].map(
      (change) => ({ truncated: false, tree: [{ ...entry, ...change }] }),
    ),
    { truncated: false, tree: [entry, entry] },
  ]) {
    assert.throws(() => parsePublishedStatusFiles(input));
  }
});

for (const scenario of [
  { draft: source, deployed: revision, github: 'current', hosting: 'current', commits: 0 },
  {
    draft: '<h1>Draft</h1>',
    deployed: revision,
    github: 'pending',
    hosting: 'pending',
    commits: 1,
  },
  { draft: source, deployed: otherRevision, github: 'current', hosting: 'pending', commits: 0 },
  { draft: source, deployed: 'invalid', github: 'current', hosting: 'unknown', commits: 0 },
]) {
  test(`HTTP status: ${scenario.github}/${scenario.hosting}/${scenario.deployed}`, async (t) => {
    const fixture = await sourceFixture();
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    await writeFile(path.join(fixture.root, file), scenario.draft);
    let connections = 0;
    const route = availabilityRoutes(
      fixture.root,
      {
        async historyConnection() {
          connections++;
          return ok({ repository: 'example/site', branch: 'main', token: 'private-test-token' });
        },
      },
      {
        endpoint: 'https://site.test/__studio-deployment',
        transport: async (input, options) => {
          const url = String(input);
          assert.equal(options?.redirect, 'error');
          if (url.startsWith('https://site.test/')) {
            assert.equal(options.headers, undefined, 'GitHub credentials never go to the site');
            return Response.json({ sha: scenario.deployed });
          }
          assert.equal(
            new Headers(options?.headers).get('Authorization'),
            'Bearer private-test-token',
          );
          return Response.json(
            url.includes('/git/ref/')
              ? { object: { sha: revision } }
              : { truncated: false, tree: [fixture.entry] },
          );
        },
      },
    );
    const server = createServer((request, response) => {
      void route(request, response, '/studio/api/publish/availability');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/studio/api/publish/availability`;
    const replies = await Promise.all([fetch(url), fetch(url)]);
    for (const response of replies) {
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.text();
      assert.ok(!body.includes('private-test-token'));
      const value = parsePublishAvailability(JSON.parse(body));
      assert.equal(value.github, scenario.github);
      assert.equal(value.hosting, scenario.hosting);
      assert.equal(value.githubPush?.commits, scenario.commits);
      assert.equal(value.githubPush?.repositoryUrl, 'https://github.com/example/site');
    }
    assert.equal(connections, 1, 'Concurrent readers share one bounded inspection');
    assert.equal((await fetch(url, { method: 'POST' })).status, 405);
    assert.equal(connections, 1, 'POST must never publish or request credentials');
  });
}

test('deployment checks reject redirects, HTML, oversized JSON, and invalid revisions', async () => {
  for (const response of [
    new Response('', { status: 302 }),
    new Response('<html>'),
    Response.json({ sha: 'bad' }),
    Response.json({ sha: revision, extra: 'x'.repeat(1000) }),
  ]) {
    await assert.rejects(
      readDeployedStatusRevision('https://site.test/status', async () => response),
    );
  }
  await assert.rejects(readDeployedStatusRevision('http://site.test/status'));
});

async function sourceFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-publish-status-'));
  await mkdir(path.join(root, 'src/pages'), { recursive: true });
  await mkdir(path.join(root, 'public'));
  await writeFile(path.join(root, file), source, { mode: 0o644 });
  const { stdout } = await promisify(execFile)('git', ['hash-object', path.join(root, file)]);
  return { root, entry: { path: file, sha: stdout.trim(), mode: '100644', type: 'blob' } };
}
