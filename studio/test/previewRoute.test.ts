// Goal: in preview mode the page switcher and the preview drive each other without
// echoing. A path the preview frame reports names a project page, under the static
// demo's base too, and a template's entry names the template; the switcher loads a
// route only when the preview is somewhere else, and waits while a template's entry
// is still unknown.
// Method: call the pure rules in previewRoute.ts with literal frame paths, openings
// at the site root (a dev server) and under the demo's base, and the project's files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewBase, previewFrameRoute, previewLandedPage, previewNeedsRoute, previewUnderBase } from '../src/features/preview/previewRoute';
import { routeFor } from '../src/features/project/projectClient';

const FILES = ['src/pages/index.astro', 'src/pages/studio.astro', 'src/pages/docs/[...slug].astro', 'src/pages/404.astro'];
const DEV = { url: 'http://localhost:4321/studio#avb-preview', route: '/studio' };
const DEMO = { url: 'http://localhost:8787/demo/site/studio/#avb-preview', route: '/studio' };

test('a reported path names the route, at the site root and under the demo base', () => {
  assert.equal(previewFrameRoute('/docs/intro?tab=1', DEV), '/docs/intro');
  assert.equal(previewFrameRoute('/demo/site/docs/intro/', DEMO), '/docs/intro');
  assert.equal(previewFrameRoute('/demo/site/', DEMO), '/');
  assert.equal(previewBase(DEMO), '/demo/site');
  assert.equal(previewBase(DEV), '');
  assert.throws(() => previewFrameRoute('docs', DEV), /reports a site path/);
});

test('the route names a page, or a template showing that entry', () => {
  assert.deepEqual(previewLandedPage(FILES, '/studio', routeFor), { file: 'src/pages/studio.astro', entry: undefined });
  assert.deepEqual(previewLandedPage(FILES, '/docs/intro', routeFor), { file: 'src/pages/docs/[...slug].astro', entry: '/docs/intro' });
  assert.deepEqual(previewLandedPage(FILES, '/', routeFor), { file: 'src/pages/index.astro', entry: undefined });
  assert.equal(previewLandedPage(['src/pages/index.astro'], '/download', routeFor), undefined, 'a route no page serves keeps the switcher as it was');
});

test('the switcher loads a route only where the preview is not', () => {
  assert.equal(previewNeedsRoute(undefined, '/studio'), true, 'entering preview loads the page');
  assert.equal(previewNeedsRoute('/studio', '/docs/intro'), true, 'a page picked in the switcher loads');
  assert.equal(previewNeedsRoute('/docs/intro', '/docs/intro/'), false, 'the preview opened the page itself');
  assert.equal(previewNeedsRoute('/studio', undefined), false, "a template's entry is not known yet");
  assert.throws(() => previewNeedsRoute('/studio', 'docs'), /asks for a site path/);
});

test('a page that slipped off the demo copy goes back under the base, at its folder', () => {
  assert.equal(previewUnderBase('/studio', '/demo/site'), '/demo/site/studio/');
  assert.equal(previewUnderBase('/docs/install/', '/demo/site'), '/demo/site/docs/install/');
  assert.equal(previewUnderBase('/', '/demo/site'), '/demo/site/');
  assert.equal(previewUnderBase('/demo/site/docs/', '/demo/site'), '/demo/site/docs/', 'already under the base');
  assert.equal(previewUnderBase('/robots.txt', '/demo/site'), '/demo/site/robots.txt');
  assert.throws(() => previewUnderBase('/studio', '/demo/site/'), /no trailing slash/);
});
