// Goal: review publishing preserves the working branch and recovers identical submissions.
// Method: push real captured Git objects to an isolated bare remote;
// inject only the GitHub HTTP boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setToolPathHome } from '#dist/electron/lib/nodeTools.js';
import { createPublishSource } from '#dist/electron/project/publishSnapshot.js';
import { submitPublishReview } from '#dist/electron/project/publishReview.js';
import { openPublishReview } from '#dist/electron/project/publishReviewRequest.js';
import { reviewBranch } from '#dist/shared/properties/publishReview.js';

const execute = promisify(execFile);
setToolPathHome(os.homedir());
const git = async (root: string, args: readonly string[]) => (await execute('git', args, { cwd: root, timeout: 10000, maxBuffer: 1024 * 1024 })).stdout.trim();

test('review push leaves HEAD, index and base unchanged and retries the same PR', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stacki-review-'));
  const remote = await mkdtemp(path.join(os.tmpdir(), 'stacki-review-remote-'));
  try {
    await git(remote, ['init', '--bare']);
    await git(root, ['init', '--initial-branch=main']);
    await git(root, ['config', 'user.name', 'Review Test']);
    await git(root, ['config', 'user.email', 'review@example.test']);
    await writeFile(path.join(root, 'index.html'), '<h1>Published</h1>');
    await git(root, ['add', '.']);
    await git(root, ['commit', '--message', 'Initial site']);
    await git(root, ['config', `url.${remote}.insteadOf`, 'https://github.com/example/site.git']);
    await git(root, ['push', 'https://github.com/example/site.git', 'main']);
    const head = await git(root, ['rev-parse', 'HEAD']);
    const index = await git(root, ['write-tree']);
    await writeFile(path.join(root, 'index.html'), '<h1>Review me</h1>');
    const captured = await createPublishSource(root, 'github');
    assert.ok(captured.ok);
    let creations = 0;
    const pull = { state: 'open', html_url: 'https://github.com/example/site/pull/1' };
    const transport: typeof fetch = async (_input, options) => {
      if (options?.method === 'POST') {
        creations++;
        return Response.json(pull);
      }
      return Response.json(creations === 0 ? [] : [pull]);
    };
    const repository = {
      branch: 'main',
      remote: 'https://github.com/example/site.git',
      environment: { ...process.env, GH_TOKEN: 'test_credential_123456789' },
    };
    try {
      const first = await submitPublishReview(root, captured.value, repository, transport);
      assert.ok(first.ok);
      const retry = await submitPublishReview(root, captured.value, repository, transport);
      assert.deepEqual(retry, first);
      assert.equal(creations, 1);
      assert.equal(await git(root, ['rev-parse', 'HEAD']), head);
      assert.equal(await git(root, ['write-tree']), index);
      assert.equal(await git(remote, ['rev-parse', 'main']), head);
      assert.equal(await git(remote, ['show', first.value.branch + ':index.html']), '<h1>Review me</h1>');
    } finally {
      await rm(captured.value.temporary, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  }
});

test('review HTTP boundary refuses closed, malformed and excessive responses', async () => {
  const request = {
    repository: 'example/site',
    token: 'secret',
    base: 'main',
    branch: reviewBranch('a'.repeat(40), 'b'.repeat(40)),
    sha: 'c'.repeat(40),
  };
  for (const body of [
    [{ state: 'closed', html_url: 'https://github.com/example/site/pull/1' }],
    [{ state: 'open', html_url: 'javascript:alert(1)' }],
    [{ state: 'open' }],
    { unexpected: true },
    Array.from({ length: 100 }, () => ({})),
  ]) {
    const result = await openPublishReview(request, async () => Response.json(body));
    assert.equal(result.ok, false);
  }
  const interrupted = await openPublishReview(request, async () => {
    throw new Error('secret');
  });
  assert.equal(interrupted.ok, false);
  assert.equal(JSON.stringify(interrupted).includes('secret'), false);
});
