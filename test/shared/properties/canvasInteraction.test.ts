// Goal: frame modes and navigation remain bounded, validated messages.
// Method: accept both modes and local paths; reject foreign types and unsafe path shapes.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isCanvasSitePage,
  parseCanvasInteraction,
  parseCanvasLeaving,
  parseCanvasNavigation,
  parseCanvasSitePages,
} from '#dist/shared/properties/canvasInteraction.js';

test('canvas modes reject malformed messages', () => {
  for (const mode of ['select', 'interact']) {
    assert.equal(parseCanvasInteraction({ type: 'avb:interaction', mode }), mode);
  }
  for (const value of [
    undefined,
    true,
    {},
    { type: 'avb:interaction', mode: true },
    { type: 'other', mode: 'select' },
    { type: 'avb:interaction', mode: 'preview' },
  ]) {
    assert.equal(parseCanvasInteraction(value), undefined);
  }
});

test('navigation allows local routes and rejects malformed or oversized paths', () => {
  for (const path of ['/', '/campuses', '/about/?query=value#heading']) {
    assert.equal(parseCanvasNavigation({ type: 'avb:navigated', path }), path);
  }
  for (const path of [undefined, 3, '', 'https://evil.test', '//evil.test', '/\\evil.test', '/with space', '/\nunsafe', '/' + 'a'.repeat(4000)]) {
    assert.equal(parseCanvasNavigation({ type: 'avb:navigated', path }), undefined);
  }
});

test('leaving is the one message shape and nothing else', () => {
  assert.equal(parseCanvasLeaving({ type: 'avb:leaving' }), true);
  for (const value of [undefined, 'avb:leaving', {}, { type: 'avb:navigated', path: '/' }, { type: 'avb:Leaving' }]) {
    assert.equal(parseCanvasLeaving(value), false);
  }
});

test('site pages: the host list parses, and only bounded site paths pass', () => {
  assert.deepEqual(parseCanvasSitePages({ type: 'avb:site-pages', base: '', routes: ['/', '/about'] }), { base: '', routes: ['/', '/about'] });
  assert.deepEqual(parseCanvasSitePages({ type: 'avb:site-pages', base: '/demo/site', routes: [] }), { base: '/demo/site', routes: [] });
  for (const value of [
    { type: 'avb:site-pages', base: 'demo', routes: [] },
    { type: 'avb:site-pages', base: '', routes: ['about'] },
    { type: 'avb:site-pages', base: '', routes: ['//evil.test'] },
    { type: 'avb:site-pages', base: '', routes: [3] },
    { type: 'avb:site-pages', base: '', routes: '/about' },
    { type: 'avb:site-pages', base: '', routes: Array.from({ length: 10_001 }, () => '/') },
    { type: 'avb:site-pages', routes: [] },
    { type: 'other', base: '', routes: [] },
  ]) {
    assert.equal(parseCanvasSitePages(value), undefined);
  }
});

test('site pages: routes match with their parameters, under the base, slashes aside', () => {
  const pages = { base: '/demo/site', routes: ['/', '/about', '/blog/[slug]', '/docs/[...path]', '/post-[id]'] };
  for (const path of [
    '/demo/site/',
    '/demo/site',
    '/demo/site/about/',
    '/about',
    '/demo/site/blog/hello',
    '/demo/site/docs/',
    '/demo/site/docs/a/b',
    '/post-7',
  ]) {
    assert.equal(isCanvasSitePage(path, pages), true, path);
  }
  for (const path of ['/download/mac', '/demo/site/download/mac', '/blog/a/b', '/blog', '/about/team', '/demo/sites/about', '/rss.xml']) {
    assert.equal(isCanvasSitePage(path, pages), false, path);
  }
  assert.equal(isCanvasSitePage('/anything/at/all', { base: '', routes: ['/[...slug]'] }), true, 'a catch-all page takes every path');
});
