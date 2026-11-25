// Goal: a site's own links work in the demo's interact mode. A link written from the
// site root moves under the bake's base to the folder its page is served at, a link
// already inside the base is left alone, and files keep their names.
// Method: the pure rule the frame applies before it checks that the target exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bakedLinkPath } from '../src/features/bake/bakeLinks';

const ROOT = '/demo/site/';

test('a root link moves under the base, at its page folder', () => {
  assert.equal(bakedLinkPath('/about', ROOT), '/demo/site/about/');
  assert.equal(bakedLinkPath('/about/', ROOT), '/demo/site/about/');
  assert.equal(bakedLinkPath('/docs/getting-started', ROOT), '/demo/site/docs/getting-started/');
  assert.equal(bakedLinkPath('/', ROOT), '/demo/site/');
});

test('a link already inside the base and a file link keep their paths', () => {
  assert.equal(bakedLinkPath('/demo/site/features/', ROOT), '/demo/site/features/');
  assert.equal(bakedLinkPath('/og-image.png', ROOT), '/demo/site/og-image.png');
});

test('the base must be a folder path', () => {
  assert.throws(() => bakedLinkPath('/about', 'demo/site'), /folder path/);
});
