// Goal: managed Studio exposes the published origin without provider credentials.
// Method: verify exact destination matching and reject unsafe endpoint origins.
import assert from 'node:assert/strict';
import test from 'node:test';
import { managedSiteURL } from '../src/features/publishing/siteRoutes';

const hosting = {
  provider: 'cloudflare-workers',
  accountId: 'a'.repeat(32),
  project: 'site',
} as const;

test('managed publishing links to the public origin and omits the deployment probe path', () => {
  const endpoint = 'https://example.com/__studio-deployment';
  assert.equal(managedSiteURL(hosting, hosting, endpoint), 'https://example.com');
  assert.equal(managedSiteURL({ provider: 'none' }, undefined, endpoint), 'https://example.com');
  assert.equal(managedSiteURL({ ...hosting, project: 'other' }, hosting, endpoint), undefined);
  assert.equal(managedSiteURL({ ...hosting, accountId: 'b'.repeat(32) }, hosting, endpoint), undefined);
  assert.equal(managedSiteURL(hosting, undefined, endpoint), undefined);
  assert.equal(managedSiteURL(hosting, hosting, undefined), undefined);
});

test('published site endpoints cannot create executable or credential-bearing links', () => {
  for (const endpoint of [
    'javascript:alert(1)',
    'http://example.com/status',
    'https://user:secret@example.com/status',
    'https://example.com:8443/status',
    'file:///tmp/site',
  ]) {
    assert.throws(() => managedSiteURL(hosting, hosting, endpoint));
  }
});
