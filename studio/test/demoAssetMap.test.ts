// Goal: an asset imported from `src/` (an icon such as `src/assets/icons/check.svg`) shows
// its preview in the demo. Astro emits it as `_astro/<name>.<hash>.<ext>`, so the bake
// writes a map from each `src/` asset to its emitted URL, and the demo's asset URL layer
// reads it after uploads and before the `public/` rule.
// Method: the pure matcher and parser against known-good and known-bad input, then a
// real bake of a disposable project that imports an SVG, read back as the browser would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BAKE_RUNTIME_DIRECTORY } from '../src/features/bake/bakeProtocol';
import { ASSET_URL_LIMITS, BAKE_ASSET_URLS_FILE, matchAssetURLs, parseAssetURLs } from '../src/features/bake/bakeAssetURLs';
import { assetSiteURL, publicAssetResolver } from '../demo/assetURLs';
import { bakeFixture, makeProject, REMOVE_OPTIONS } from './demoFixture';

const BASE = '/demo/site/';
const CHECK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M2 8l4 4 8-8" stroke="currentColor" fill="none"/></svg>\n';

test('a src asset matches the same bytes, then a unique same-named file, then a rendering', () => {
  const urls = matchAssetURLs(
    [
      { path: 'src/assets/icons/check.svg', sha256: 'aaa' },
      { path: 'src/assets/photo.jpg', sha256: 'bbb' },
      { path: 'src/assets/logo.png', sha256: 'ccc' },
      { path: 'src/assets/missing.png', sha256: 'ddd' },
      { path: 'src/assets/canvas-photo.jpg', sha256: 'eee' },
      { path: 'src/assets/unused.svg', sha256: 'fff' },
    ],
    [
      { path: '_astro/check.Xg4MdlYL.svg', sha256: 'aaa' },
      { path: '_astro/photo.Ab12Cd34.jpg', sha256: 'optimised' },
      { path: '_astro/logo.Aa11Bb22.png', sha256: 'one' },
      { path: '_astro/logo.Cc33Dd44.png', sha256: 'two' },
      { path: '_astro/canvas-photo.CGnEvsiu_Z3epEC.webp', sha256: 'w1' },
      { path: '_astro/canvas-photo.CGnEvsiu_2es1y0.webp', sha256: 'w2' },
      { path: '_astro/unused.Ee55Ff66.png', sha256: 'png' },
    ],
    BASE,
  );
  assert.deepEqual(
    urls,
    {
      'src/assets/icons/check.svg': '/demo/site/_astro/check.Xg4MdlYL.svg',
      'src/assets/photo.jpg': '/demo/site/_astro/photo.Ab12Cd34.jpg',
      'src/assets/logo.png': '/demo/site/_astro/logo.Aa11Bb22.png',
      'src/assets/canvas-photo.jpg': '/demo/site/_astro/canvas-photo.CGnEvsiu_2es1y0.webp',
    },
    'A raster image falls back to any rendering of it; an SVG never takes another file',
  );
});

test('the map parser refuses what the demo must not load', () => {
  assert.deepEqual(parseAssetURLs('{"src/assets/a.svg":"/demo/site/_astro/a.1234abcd.svg"}', BASE), { 'src/assets/a.svg': '/demo/site/_astro/a.1234abcd.svg' });
  assert.throws(() => parseAssetURLs('{"public/a.svg":"/demo/site/a.svg"}', BASE), /not a src asset/);
  assert.throws(() => parseAssetURLs('{"src/pages/a.astro":"/demo/site/a"}', BASE), /not a src asset/);
  assert.throws(() => parseAssetURLs('{"src/a.svg":"https://evil.test/a.svg"}', BASE), /outside the site/);
  assert.throws(() => parseAssetURLs('{"src/a.svg":"/demo/site/../a.svg"}', BASE), /outside the site/);
  assert.throws(() => parseAssetURLs('[]', BASE));
  assert.throws(() => parseAssetURLs(' '.repeat(ASSET_URL_LIMITS.fileBytesMax + 1), BASE), /size limit/);
});

test('the demo resolves uploads first, then built src assets, then public files', () => {
  const built: Readonly<Record<string, string>> = { 'src/assets/icons/check.svg': '/demo/site/_astro/check.Xg4MdlYL.svg' };
  const uploads: Readonly<Record<string, string>> = { 'public/new.png': 'blob:x' };
  const publicURL = publicAssetResolver(BASE);
  const resolve = (file: string) => uploads[file] ?? built[file] ?? publicURL(file);
  const origin = 'https://stacki.build';
  assert.equal(assetSiteURL('/studio/api/asset?file=src%2Fassets%2Ficons%2Fcheck.svg', origin, resolve), '/demo/site/_astro/check.Xg4MdlYL.svg');
  assert.equal(assetSiteURL('/studio/api/asset?file=public%2Fnew.png', origin, resolve), 'blob:x');
  assert.equal(assetSiteURL('/studio/api/asset?file=public%2Fog.png', origin, resolve), '/demo/site/og.png');
});

test('a real bake maps an imported src/assets SVG to the file the build emitted', async () => {
  const project = await makeProject();
  const out = await mkdtemp(path.join(os.tmpdir(), 'stacki-demo-assets-'));
  try {
    await mkdir(path.join(project.root, 'src/assets/icons'), { recursive: true });
    await writeFile(path.join(project.root, 'src/assets/icons/check.svg'), CHECK);
    await writeFile(
      path.join(project.root, 'src/pages/icons.astro'),
      '---\nimport check from "../assets/icons/check.svg";\n---\n<html><head><title>Icons</title></head><body><main><img src={check.src} alt="" /></main></body></html>\n',
    );
    await bakeFixture(project.root, out);
    const urls = parseAssetURLs(await readFile(path.join(out, BAKE_RUNTIME_DIRECTORY, BAKE_ASSET_URLS_FILE), 'utf8'), BASE);
    const url = urls['src/assets/icons/check.svg'];
    assert.ok(url !== undefined, 'The SVG has a URL');
    assert.match(url, /^\/demo\/site\/_astro\/check\.[^/]+\.svg$/);
    const emitted = await readFile(path.join(out, url.slice(BASE.length)));
    assert.equal(createHash('sha256').update(emitted).digest('hex'), createHash('sha256').update(CHECK).digest('hex'), 'The URL serves the same file');
  } finally {
    await rm(out, REMOVE_OPTIONS);
    await project.stop();
  }
});
