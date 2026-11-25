// Goal: a link followed in the canvas's interact mode opens the project page it landed on,
// whether the frame serves pages at the site root (a dev server) or under a base (the
// static demo serves /about as /demo/site/about/).
// Method: call canvasRoute with the frame's URL and the route it was opened on, for both
// hosts, and check the destinations that must not be rewritten: paths outside the base,
// a base that merely shares a prefix, and a frame URL that does not end in its route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canvasRoute } from '../src/features/preview/canvasRoute';

const DEV = 'http://localhost:4321';
const DEMO = 'https://stacki.build';

test('a dev server at the site root keeps the destination as it is', () => {
  assert.equal(canvasRoute('/about', `${DEV}/#avb-design`, '/'), '/about');
  assert.equal(canvasRoute('/', `${DEV}/about/#avb-design`, '/about'), '/');
  assert.equal(canvasRoute('/blog/post/', `${DEV}/about#avb-design`, '/about'), '/blog/post');
});

test('the static demo strips its base, from the home page and from a nested page', () => {
  assert.equal(canvasRoute('/demo/site/about', `${DEMO}/demo/site/#avb-design`, '/'), '/about');
  assert.equal(canvasRoute('/demo/site', `${DEMO}/demo/site/about/#avb-design`, '/about'), '/');
  assert.equal(canvasRoute('/demo/site/blog/post/', `${DEMO}/demo/site/about/#avb-design`, '/about'), '/blog/post');
});

test('paths outside the base, or a frame URL that does not end in its route, are left alone', () => {
  assert.equal(canvasRoute('/elsewhere', `${DEMO}/demo/site/#avb-design`, '/'), '/elsewhere');
  assert.equal(canvasRoute('/demo/sites/about', `${DEMO}/demo/site/#avb-design`, '/'), '/demo/sites/about');
  assert.equal(canvasRoute('/contact', `${DEMO}/demo/site/about/#avb-design`, '/pricing'), '/contact');
  assert.equal(canvasRoute('/contact', undefined, '/'), '/contact');
  assert.equal(canvasRoute('/contact', 'not a url', '/'), '/contact');
});

test('a destination or route that is not a site path is a programmer error', () => {
  assert.throws(() => canvasRoute('about', `${DEV}/`, '/'), /Assertion failed: A canvas destination is a site path/);
  assert.throws(() => canvasRoute('/about', `${DEV}/`, 'about'), /Assertion failed: A preview route is a site path/);
});
