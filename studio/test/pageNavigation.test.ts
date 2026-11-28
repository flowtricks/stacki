// Goal: on a site with `trailingSlash: 'always'`, a canvas opened on a slashless page
// route reaches the page instead of Astro's 404. Method: call the redirect decision
// with the requests a canvas, a fetch, a write and tooling make, for each setting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slashRedirect } from '../src/server/pageNavigation';
import { samePage } from '../src/features/preview/previewHandshake';

const visit = (pathname: string, search = '') => ({ method: 'GET', pathname, search, fetchMode: 'navigate' });

test('a page navigation missing the slash on an always-slash site is sent to the spelling Astro serves', () => {
  assert.equal(slashRedirect(visit('/about'), 'always'), '/about/');
  assert.equal(slashRedirect(visit('/work/acme', '?x=1'), 'always'), '/work/acme/?x=1');
  assert.equal(slashRedirect({ ...visit('/about'), method: 'HEAD' }, 'always'), '/about/');
});
test('served paths, files, Studio and tooling paths, and other settings are left alone', () => {
  for (const pathname of [
    '/',
    '/about/',
    '/feed.xml',
    '/llms.txt',
    '/studio',
    '/studio/api/project',
    '/__avb/preview',
    '/__studio-entry',
    '/@vite/client',
    '/_astro/x',
  ]) {
    assert.equal(slashRedirect(visit(pathname), 'always'), undefined, pathname);
  }
  assert.equal(slashRedirect(visit('/about'), 'ignore'), undefined);
  assert.equal(slashRedirect(visit('/about'), 'never'), undefined);
});
test('fetches and writes are never redirected', () => {
  assert.equal(slashRedirect({ ...visit('/about'), fetchMode: 'cors' }, 'always'), undefined);
  assert.equal(slashRedirect({ ...visit('/about'), fetchMode: undefined }, 'always'), undefined);
  assert.equal(slashRedirect({ ...visit('/about'), method: 'POST' }, 'always'), undefined);
});
test('a request path that is not a site path is a programmer error', () => {
  assert.throws(() => slashRedirect(visit('about'), 'always'), /A request path is a site path/);
});
test('the canvas takes the page it asked for at /about when the frame reports /about/', () => {
  assert.equal(samePage('/about/', '/about'), true);
  assert.equal(samePage('/about', '/about'), true);
  assert.equal(samePage('/', '/'), true);
  assert.equal(samePage('/work/acme/?x=1', '/work/acme?x=1'), true);
  assert.equal(samePage('/about/', '/contact'), false);
  assert.equal(samePage('/about/?x=1', '/about?x=2'), false);
});
