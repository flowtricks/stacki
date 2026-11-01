// Goal: electron/lib/installedPackages.ts tells installed code from the user's
// own: a path is installed when any whole segment is `node_modules`, in POSIX
// or Windows spelling, at any depth and in any case, and never because a
// segment merely contains the word. The package naming it shares with the
// injected-routes reader is pinned in test/electron/preview/injectedRoutes.test.js.
// Method: a table of paths and the answer each must get; the function is pure.
const test = require('node:test');
const assert = require('node:assert/strict');
const { isInstalledFile, packageOf } = require('#dist/electron/lib/installedPackages.js');

test('a node_modules segment anywhere makes a file installed', () => {
  const installed = [
    '/site/node_modules/pkg/Card.astro',
    '/site/node_modules/.pnpm/@scope+engine@file+..+engine/node_modules/@scope/engine/Hero.astro',
    '/repo/packages/web/node_modules/pkg/index.ts',
    'C:\\site\\node_modules\\@scope\\cards\\Page.astro',
    '/site/Node_Modules/pkg/Card.astro', // macOS and Windows ignore case.
  ];
  for (const file of installed) {
    assert.equal(isInstalledFile(file), true, file);
  }
});

test('a segment that only contains the word is the user’s own', () => {
  const own = [
    '/site/src/components/Card.astro',
    '/site/src/node_modules.astro',
    '/site/src/my_node_modules/Card.astro',
    '/site/node_modules_backup/Card.astro',
    'C:\\site\\src\\Card.astro',
  ];
  for (const file of own) {
    assert.equal(isInstalledFile(file), false, file);
  }
});

test('the package named is the innermost one, pnpm layout included', () => {
  const pnpm = '/site/node_modules/.pnpm/@scope+engine@file+..+engine/node_modules/@scope/engine/Hero.astro';
  assert.equal(packageOf(pnpm), '@scope/engine');
  assert.equal(packageOf('/site/src/Card.astro'), undefined);
});
