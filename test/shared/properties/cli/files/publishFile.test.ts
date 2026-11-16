// Goal: the publish registry accepts `.stacki/publish.json` as the app writes it, for every hosting provider, and refuses what the parser rejects.
// Method: round trip realistic documents through the canonical writer, the registry check and the app parser (refusalOfSource); then known-bad
// shapes: unknown key, wrong type, bad identifier, token-looking account, URL that is not an origin, out-of-bounds hooks, missing required.
// Also pins that no key of the file is credential-shaped.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PUBLISH_FILE } from '#dist/shared/properties/cli/files/publishFile.js';
import { refusalOfSource, serializeDocument } from '#dist/shared/properties/cli/stackiFiles.js';
import { checkValue } from '#dist/shared/properties/cli/stackiSchema.js';
import { PUBLISH_LIMITS } from '#dist/shared/properties/publishConfig.js';

const schema = { kind: 'object', fields: PUBLISH_FILE.fields } as const;
const base = { version: 1, defaultTarget: 'all', githubAccount: 'flowtricks', buildScript: 'build', beforePublish: ['lint'], afterPublish: [] };
const pages = { provider: 'cloudflare', accountId: 'a1b2c3', project: 'my-site', branch: 'main', directory: 'dist' };
const good: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['no hosting', { ...base, hosting: { provider: 'none' } }],
  [
    'cloudflare pages',
    { ...base, hosting: pages, githubWorkflow: { kind: 'pull-request' }, publishedSite: { hosting: pages, source: 'manual', url: 'https://example.com' } },
  ],
  ['cloudflare workers', { ...base, hosting: { provider: 'cloudflare-workers', accountId: 'a1', project: 'site' } }],
  ['vercel', { ...base, hosting: { provider: 'vercel', organizationId: 'team_1', projectId: 'prj_1' } }],
];
for (const [name, document] of good) {
  test(`a ${name} document passes the registry and the parser`, () => {
    assert.equal(checkValue(schema, document, 'publish'), undefined);
    const text = serializeDocument(PUBLISH_FILE, document);
    assert.equal(refusalOfSource(PUBLISH_FILE, text), undefined);
    assert.deepEqual(JSON.parse(text), document);
  });
}

test('the empty document passes the registry and the parser', () => {
  assert.equal(checkValue(schema, PUBLISH_FILE.empty, 'publish'), undefined);
  assert.equal(refusalOfSource(PUBLISH_FILE, serializeDocument(PUBLISH_FILE, { ...PUBLISH_FILE.empty })), undefined);
});

test('no key of the file is credential-shaped', () => {
  assert.deepEqual(
    Object.keys(PUBLISH_FILE.fields).filter((key) => /token|secret|password|credential|apikey/i.test(key)),
    [],
  );
});

const hosting = { provider: 'none' };
const bad: ReadonlyArray<readonly [string, unknown]> = [
  ['an unknown key', { ...base, hosting, token: 'x' }],
  ['an unknown hosting key', { ...base, hosting: { ...pages, apiToken: 'x' } }],
  ['a wrong type', { ...base, hosting, buildScript: 3 }],
  ['an unknown target', { ...base, hosting, defaultTarget: 'everywhere' }],
  ['an unknown provider', { ...base, hosting: { provider: 'netlify' } }],
  ['a build script that is a command', { ...base, hosting, buildScript: 'npm run build && rm -rf /' }],
  ['a token as the GitHub account', { ...base, hosting, githubAccount: 'ghp_' + 'x'.repeat(36) }],
  ['an email as the GitHub account', { ...base, hosting, githubAccount: 'me@example.com' }],
  ['too many hooks', { ...base, hosting, beforePublish: Array.from({ length: PUBLISH_LIMITS.hooksMax + 1 }, (_, index) => `s${index}`) }],
  ['a directory that leaves the project', { ...base, hosting: { ...pages, directory: '../dist' } }],
  ['a missing hosting key', { ...base, hosting: { provider: 'vercel', organizationId: 'team_1' } }],
  ['a site URL with a path', { ...base, hosting: pages, publishedSite: { hosting: pages, source: 'manual', url: 'https://example.com/a' } }],
  ['a site URL over http', { ...base, hosting: pages, publishedSite: { hosting: pages, source: 'manual', url: 'http://example.com' } }],
  ['a site with no hosting', { ...base, hosting: pages, publishedSite: { source: 'manual', url: 'https://example.com' } }],
  ['a missing version', { ...base, version: undefined, hosting }],
  ['a missing build script', { version: 1, githubAccount: '', hosting, beforePublish: [], afterPublish: [] }],
];
for (const [name, document] of bad) {
  test(`the registry refuses ${name}`, () => {
    assert.notEqual(checkValue(schema, document, 'publish'), undefined);
  });
}
