// Goal: the shared pieces Settings is drawn with hold on their own: a scroll
// area fades only the edges with more content past them, so a row is never cut
// against the chrome; and the shared switch keeps its track colour on hover.
// Method: bundle the pure edge model with esbuild and call it with every
// position, including invalid input that must fail its assertion, then read the
// switch's stylesheet for the hover rule that outweighs the base button hover.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/settings-chrome.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  entryPoints: [repoPath('src/ui/useScrollEdges.ts')],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['react'],
  logLevel: 'silent',
});
const model = require(output);

test('a scroll area fades only the edges with more content past them', () => {
  const edges = (scrollTop, scrollHeight, clientHeight) => model.scrollEdges({ scrollTop, scrollHeight, clientHeight });
  assert.deepEqual(edges(0, 300, 300), { top: 'flush', bottom: 'flush' }, 'content that fits never fades');
  assert.deepEqual(edges(0, 900, 300), { top: 'flush', bottom: 'fade' }, 'at rest at the top only the bottom fades');
  assert.deepEqual(edges(300, 900, 300), { top: 'fade', bottom: 'fade' });
  assert.deepEqual(edges(600, 900, 300), { top: 'fade', bottom: 'flush' }, 'at the end only the top fades');
  assert.deepEqual(edges(599.5, 900, 300), { top: 'fade', bottom: 'flush' }, 'sub-pixel rounding is not more content');
  assert.deepEqual(edges(-40, 900, 300), { top: 'flush', bottom: 'fade' }, 'elastic overscroll above the top');
  assert.deepEqual(edges(700, 900, 300), { top: 'fade', bottom: 'flush' }, 'elastic overscroll past the end');
  assert.throws(() => edges(Number.NaN, 900, 300), /Assertion failed: scrollEdges: scrollTop is finite/);
  assert.throws(() => edges(0, -1, 300), /scrollHeight is not negative/);
  assert.throws(() => edges(0, 900, -1), /clientHeight is not negative/);
});

test('the shared switch keeps its track colour on hover', () => {
  const css = fs.readFileSync(repoPath('src/ui/switch.css'), 'utf8');
  // The base `button:hover:not(:disabled):where(...)` (styles.css) is (0,2,1); this must outweigh it.
  const hover = /button\.ui-switch:hover:not\(:disabled\)\s*\{([^}]*)\}/.exec(css);
  assert.ok(hover, 'the switch has a hover rule written to outweigh the base button hover');
  assert.match(hover[1], /background:\s*var\(--ui-switch-track\)/, 'hover keeps the state colour');
  assert.match(hover[1], /filter:\s*brightness\(1\.\d+\)/, 'and brightens slightly');
  // The base controls live in their shared sheet, which styles.css imports (and the app UI kit builds from).
  const base = fs.readFileSync(repoPath('src/ui/controls.css'), 'utf8');
  assert.match(base, /button:hover:not\(:disabled\):where\(/, 'the base rule this fights is still the one described');
  for (const file of ['src/app/settings/Settings.tsx', 'src/app/settings/CmsSourceSettings.tsx', 'src/app/settings/RoleCard.tsx']) {
    assert.doesNotMatch(fs.readFileSync(repoPath(file), 'utf8'), /role="switch"/, `${file} uses the shared Switch`);
  }
});
