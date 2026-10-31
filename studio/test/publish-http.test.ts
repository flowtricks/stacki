// Goal: publish jobs return promptly and reject duplicate work.
// Method: block the repository boundary and inspect HTTP progress without external services.
import { ok } from '../vendor/stacki/shared/core/result';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Publisher, type PublishState } from '../src/features/publishing/publish';
import { publishRoute } from '../src/features/publishing/publishRoutes';
import { parsePublishState } from '../src/features/publishing/publishClient';

test('publish HTTP returns a job before the commit finishes and duplicate starts share it', async () => {
  const root = await publishFixture();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let commits = 0;
  const stages: unknown[] = [];
  const publisher = new Publisher(
    root,
    {
      async commit() {
        stages.push(publisher.state);
        await gate;
        commits++;
        return ok({ sha: 'b'.repeat(40), url: 'https://example.test/commit' });
      },
      async incoming() {
        throw new Error('Unexpected sync');
      },
      async acceptBase() {},
    },
    undefined,
    async () => {
      stages.push(publisher.state);
      await gate;
    },
    async () => {
      stages.push(publisher.state);
      return {};
    },
    async () => {
      stages.push(publisher.state);
      return 'live';
    },
  );
  const { server, url } = await publishServer(publisher);
  try {
    const start = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(2000) });
    assert.equal(start.status, 202);
    const first = parsePublishState(await start.json());
    assert.equal(first.kind, 'building');
    assert.equal(commits, 0);
    const duplicate = await fetch(url, { method: 'POST' });
    for (const response of [duplicate, await fetch(url)]) {
      const current = parsePublishState(await response.json());
      assert.equal(current.kind, 'building');
      assert.equal(current.id, first.id);
    }
    release();
    let state: PublishState = first;
    for (let attempt = 0; attempt < 100 && state.kind === 'building'; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      state = parsePublishState(await (await fetch(url)).json());
    }
    assert.equal(state.kind, 'committed');
    assert.equal(state.deployment, 'live');
    assert.equal(state.id, first.id);
    assert.equal(commits, 1);
    assert.deepEqual(stages, expectedStages(first.id));
  } finally {
    release();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

async function publishFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-publish-http-'));
  for (const directory of ['src/pages', 'public', '.stacki/studio/state', 'node_modules']) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  await writeFile(path.join(root, 'src/pages/index.astro'), '<h1>Draft</h1>');
  await writeFile(
    path.join(root, '.stacki/studio/state/github-base.json'),
    JSON.stringify({ sha: 'a'.repeat(40) }),
  );
  return root;
}

async function publishServer(publisher: Publisher) {
  const server = createServer((request, response) => {
    publishRoute(publisher, request, response, request.url ?? '');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/studio/api/publish`;
  return { server, url };
}

function expectedStages(id: string | undefined) {
  return ['committing', 'cleanup', 'deploying'].map((stage) => ({
    kind: 'building',
    id,
    stage,
    deployment: 'pending',
  }));
}
