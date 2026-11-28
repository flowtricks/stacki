// Goal: a downloaded Studio release is installed only if it matches the SHA-256 digest GitHub publishes for that asset,
// and a release GitHub publishes no digest for, or a digest that cannot be asked for, still downloads as before, so no
// update gains a step or stops working.
// Method: replace `fetch` with a stand-in for GitHub's two addresses (the release asset and the release record) and
// run the real download. No request leaves the machine.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { downloadRelease } from '../src/features/updates/catalog';

const RELEASE = JSON.stringify({
  format: 1,
  version: '1.2.3',
  files: [
    { path: 'package.json', content: '{"name":"@stacki/studio","version":"1.2.3"}' },
    { path: 'package-lock.json', content: '{}' },
    { path: 'Dockerfile', content: 'FROM node:22' },
    { path: 'scripts/build.ts', content: 'export const note = "Résumé ☂";' },
    { path: 'src/shared/release.json', content: '{"version":"1.2.3"}' },
    { path: 'vendor/stacki/LICENSE', content: 'MIT' },
  ],
});
const DIGEST = `sha256:${createHash('sha256').update(RELEASE).digest('hex')}`;
const ASSET = 'stacki-studio-1.2.3.json';

function github(context: TestContext, record: () => Response, body = RELEASE) {
  const asked: string[] = [];
  context.mock.method(globalThis, 'fetch', async (input: string) => {
    asked.push(input);
    return input.startsWith('https://api.github.com/') ? record() : new Response(body);
  });
  return asked;
}
const published = (digest: unknown) => () => Response.json({ tag_name: 'v1.2.3', assets: [{ name: ASSET, digest }] });

test('a release matching its published digest installs', async (context) => {
  const asked = github(context, published(DIGEST));
  assert.equal((await downloadRelease('1.2.3')).version, '1.2.3');
  assert.ok(asked.includes('https://api.github.com/repos/flowtricks/stacki-releases/releases/tags/v1.2.3'));
});

test('a release that differs from its published digest is refused', async (context) => {
  github(context, published(DIGEST), RELEASE.replace('MIT', 'Not MIT'));
  await assert.rejects(downloadRelease('1.2.3'), /does not match the digest/);
});

test('releases without a digest, and a digest that cannot be read, download as before', async (context) => {
  const answers: readonly (() => Response)[] = [
    published(null),
    published(undefined),
    published('sha512:abc'),
    () => Response.json({ tag_name: 'v1.2.3', assets: [] }),
    () => new Response('rate limited', { status: 403 }),
    () => new Response('not json'),
    () => {
      throw new TypeError('network down');
    },
  ];
  for (const answer of answers) {
    github(context, answer);
    assert.equal((await downloadRelease('1.2.3')).version, '1.2.3');
    context.mock.restoreAll();
  }
});
