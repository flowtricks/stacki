// Goal: submitting a review never advances the live baseline, cleans assets, or deploys.
// Method: capture real temporary draft files and make forbidden lifecycle calls fail loudly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Publisher } from '../src/features/publishing/publish';
import { DEFAULT_PUBLISH_CONFIG } from '../vendor/stacki/shared/properties/publishConfig';
import { reviewBranch } from '../vendor/stacki/shared/properties/publishReview';
import { ok } from '../vendor/stacki/shared/core/result';
import { parsePublishState } from '../src/features/publishing/publishClient';

test('review outcome preserves draft baseline and excludes deployment side effects', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-review-'));
  try {
    for (const directory of ['src/pages', '.stacki', '.stacki/studio/state']) {
      await mkdir(path.join(root, directory), { recursive: true });
    }
    await writeFile(path.join(root, 'src/pages/index.astro'), '<h1>Draft</h1>');
    const baseline = JSON.stringify({ sha: 'a'.repeat(40) });
    await writeFile(path.join(root, '.stacki/studio/state/github-base.json'), baseline);
    await writeFile(
      path.join(root, '.stacki/publish.json'),
      JSON.stringify({
        ...DEFAULT_PUBLISH_CONFIG,
        githubWorkflow: { kind: 'pull-request' },
      }),
    );
    const forbidden = async (): Promise<never> => {
      throw new Error('Review performed a publish side effect');
    };
    let submitted = 0;
    const publisher = new Publisher(
      root,
      {
        commit: forbidden,
        incoming: forbidden,
        acceptBase: forbidden,
        async review(source, parent) {
          assert.equal(parent, 'a'.repeat(40));
          assert.ok(source.files.some((file) => file.path === 'src/pages/index.astro'));
          submitted++;
          return ok({
            sha: 'b'.repeat(40),
            branch: reviewBranch(parent, source.tree),
            url: 'https://github.com/example/site/pull/1',
          });
        },
      },
      undefined,
      forbidden,
      forbidden,
      forbidden,
    );
    const result = await publisher.publish('all');
    assert.equal(result.kind, 'review-open');
    assert.deepEqual(parsePublishState(result), result);
    assert.equal(submitted, 1);
    assert.equal(
      await readFile(path.join(root, '.stacki/studio/state/github-base.json'), 'utf8'),
      baseline,
    );
    assert.equal((await publisher.publish('hosting')).kind, 'failed');
    assert.equal(submitted, 1);
    await writeFile(path.join(root, '.stacki/studio/state/github-base.json'), '{"sha":"invalid"}');
    const failed = await publisher.publish('github');
    assert.equal(failed.kind, 'failed');
    assert.equal(submitted, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
