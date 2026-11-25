// Goal: in the demo, Studio's asset previews (`/studio/api/asset?file=…`, set as an
// image, video or font source) load from the baked site and never reach a server that
// is not there. Normal Studio never runs this code.
// Method: the pure mapping against public files, other files, other routes and unsafe
// paths, and the FontFace source rewrite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetSiteURL, fontSourceURLs, NO_ASSET_URL, publicAssetResolver } from '../demo/assetURLs';

const ORIGIN = 'https://stacki.build';
const resolve = publicAssetResolver('/demo/site/');

test('a public file loads from the baked site root', () => {
  assert.equal(assetSiteURL('/studio/api/asset?file=public%2Fog-image.png', ORIGIN, resolve), '/demo/site/og-image.png');
  assert.equal(assetSiteURL(`${ORIGIN}/studio/api/asset?file=public%2Fimg%2Fa%20b%23.png`, ORIGIN, resolve), '/demo/site/img/a%20b%23.png');
  assert.equal(assetSiteURL('/studio/api/asset?file=public%2Fclip.mp4#t=0.1', ORIGIN, resolve), '/demo/site/clip.mp4#t=0.1', 'The media fragment stays');
});

test('a file the build hashed, or a path that escapes, never reaches the network', () => {
  assert.equal(assetSiteURL('/studio/api/asset?file=src%2Fassets%2Fhero.png', ORIGIN, resolve), NO_ASSET_URL);
  assert.equal(assetSiteURL('/studio/api/asset?file=public%2F..%2Fsecret', ORIGIN, resolve), NO_ASSET_URL);
  assert.equal(assetSiteURL('/studio/api/asset?file=public%2F', ORIGIN, resolve), NO_ASSET_URL);
  assert.equal(assetSiteURL('/studio/api/asset', ORIGIN, resolve), NO_ASSET_URL);
  assert.equal(assetSiteURL(`/studio/api/asset?file=public%2F${'a'.repeat(1_000)}`, ORIGIN, resolve), NO_ASSET_URL);
});

test('every other URL is left alone', () => {
  assert.equal(assetSiteURL('/demo/site/og-image.png', ORIGIN, resolve), undefined);
  assert.equal(assetSiteURL('/studio/api/assets', ORIGIN, resolve), undefined);
  assert.equal(assetSiteURL('https://elsewhere.test/studio/api/asset?file=public%2Fa.png', ORIGIN, resolve), undefined);
  assert.equal(assetSiteURL('stacki-asset://local/a.png', ORIGIN, resolve), undefined);
});

test('font sources are rewritten inside url()', () => {
  assert.equal(fontSourceURLs('url("/studio/api/asset?file=public%2Ffonts%2FA.woff2")', ORIGIN, resolve), 'url("/demo/site/fonts/A.woff2")');
  assert.equal(fontSourceURLs("url('/studio/api/asset?file=src%2FA.woff2')", ORIGIN, resolve), `url('${NO_ASSET_URL}')`);
  assert.equal(fontSourceURLs('local(Inter), url(/fonts/B.woff2)', ORIGIN, resolve), 'local(Inter), url(/fonts/B.woff2)');
});

test('the resolver needs a site path', () => {
  assert.throws(() => publicAssetResolver('demo/site'), /site base/);
});
