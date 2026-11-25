// Goal: Save names the first empty required publish field instead of surfacing the parser's vague message,
// and the parser still rejects the same data when it is reached some other way.
// Method: one case per field and provider, the all-filled case, the order when several are empty, then the
// parser's own error on an empty identifier as the negative space (the two channels stay separate).
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_PUBLISH_CONFIG, parsePublishConfig } from '#dist/shared/properties/publishConfig.js';
import { findMissingPublishField } from '#dist/shared/properties/publishMissing.js';

const pages = { provider: 'cloudflare', accountId: 'account', project: 'site', branch: 'main', directory: 'dist' } as const;
const worker = { provider: 'cloudflare-workers', accountId: 'account', project: 'site' } as const;
const vercel = { provider: 'vercel', organizationId: 'team', projectId: 'project' } as const;

function missing(hosting: (typeof DEFAULT_PUBLISH_CONFIG)['hosting'], buildScript = 'build') {
  const result = findMissingPublishField({ hosting, buildScript });
  return result.ok ? undefined : result.error.field;
}

test('every filled configuration is accepted', () => {
  for (const hosting of [DEFAULT_PUBLISH_CONFIG.hosting, pages, worker, vercel]) {
    assert.deepEqual(findMissingPublishField({ hosting, buildScript: 'build' }), { ok: true, value: undefined });
  }
});

test('an empty Cloudflare account is named first, for Pages and Workers', () => {
  assert.equal(missing({ ...pages, accountId: '' }), 'cloudflareAccount');
  assert.equal(missing({ ...worker, accountId: '' }), 'cloudflareAccount');
  assert.equal(missing({ ...worker, accountId: '', project: '' }), 'cloudflareAccount');
  assert.equal(missing({ ...pages, accountId: '  ' }), 'cloudflareAccount');
});

test('an empty hosting project is named once the account is chosen', () => {
  assert.equal(missing({ ...pages, project: '' }), 'hostingProject');
  assert.equal(missing({ ...worker, project: '' }), 'hostingProject');
  assert.equal(missing({ ...vercel, projectId: '' }), 'hostingProject');
  assert.equal(missing({ ...vercel, projectId: '', organizationId: '' }), 'hostingProject');
});

test('an empty Vercel organization or team is named', () => {
  assert.equal(missing({ ...vercel, organizationId: '' }), 'vercelOrganization');
});

test('an empty build script is named after the hosting fields', () => {
  assert.equal(missing(DEFAULT_PUBLISH_CONFIG.hosting, ''), 'buildScript');
  assert.equal(missing({ ...worker, project: '' }, ''), 'hostingProject');
});

test('no hosting needs no hosting field', () => {
  assert.equal(missing({ provider: 'none' }), undefined);
});

test('the parser still throws on an empty identifier it is handed', () => {
  assert.throws(() => parsePublishConfig({ ...DEFAULT_PUBLISH_CONFIG, hosting: { ...worker, project: '' } }), /nonempty names/);
});
