// Goal: src/lib/packageManifest.ts says a package.json depends on a package only when it lists
// it, as a dependency or a dev dependency, and says no for anything it cannot read.
// Method: package.json texts with the package in each list, in neither, under another name, and
// texts that are not a manifest: malformed, empty, a version that is not a string, oversized.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { hasDependency, PACKAGE_MANIFEST_CHARS_MAX } = load('src/lib/packageManifest.ts');

test('a package listed as a dependency or a dev dependency is found', () => {
  assert.equal(hasDependency('{"dependencies":{"@sanity/astro":"^3"}}', '@sanity/astro'), true);
  assert.equal(hasDependency('{"devDependencies":{"@sanity/astro":"^3"}}', '@sanity/astro'), true);
  assert.equal(hasDependency('{"dependencies":{"sanity":"^6","@sanity/client":"^8"}}', 'sanity'), true);
});

test('a package not listed, or a manifest that cannot be read, depends on nothing', () => {
  assert.equal(hasDependency('{"dependencies":{}}', '@sanity/astro'), false);
  assert.equal(hasDependency('{"dependencies":{"@sanity/client":"^8"}}', 'sanity'), false);
  assert.equal(hasDependency('{"peerDependencies":{"sanity":"^6"}}', 'sanity'), false);
  assert.equal(hasDependency('{"dependencies":{"sanity":6}}', 'sanity'), false);
  assert.equal(hasDependency('not json', '@sanity/astro'), false);
  assert.equal(hasDependency('', '@sanity/astro'), false);
  assert.equal(hasDependency('[]', '@sanity/astro'), false);
  const oversized = `{"dependencies":{"sanity":"^6"},"x":"${'a'.repeat(PACKAGE_MANIFEST_CHARS_MAX)}"}`;
  assert.equal(hasDependency(oversized, 'sanity'), false);
});
