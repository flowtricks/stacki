// Goal: opening a component from inside another component remembers WHICH copy
// of it was opened, so the canvas outlines that copy and not every copy.
//
// The bug: NavLink is rendered once per item by the header's loop. Opening it
// from the open header (itself opened from the layout) kept the outermost
// instance as the focus, dropped the copy, and the selected `li` was outlined
// on 'Home' and on 'Example Components' alike.
//
// Method: the real componentEntry, bundled with esbuild, called with a
// one-deep stack (nested) and with an empty stack (not nested), for the first,
// second and third copy. The overlay and runtime wiring is checked as source,
// because they are React modules the node runner does not mount.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const buildDirectory = repoPath('node_modules/.stacki-test/opened-instance');
fs.mkdirSync(buildDirectory, { recursive: true });
const bundle = path.join(buildDirectory, 'opened-instance.bundle.js');
esbuild.buildSync({
  stdin: { contents: "export { componentEntry } from './src/app/model/pageGestures';", resolveDir: ROOT, loader: 'ts' },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});
const { componentEntry } = require(bundle);

const navLink = { name: 'NavLink', path: '/p/src/components/NavLink.astro' };
const header = { kind: 'component', name: 'Header', path: '/p/Header.astro', focusPath: '0.1', focusOcc: 0, focusWhole: false, hostKey: '0.1' };

test('a component opened inside another records the copy that was opened', () => {
  for (const occurrence of [0, 1, 2]) {
    const entry = componentEntry([header], [], navLink, { path: 'src/Header.astro|0.0.0', occurrence });
    assert.equal(entry.hostOcc, occurrence);
    assert.equal(entry.focusPath, '0.1', 'the outermost instance stays the focus');
  }
});

test('a component opened from the page needs no recorded copy: the focus is already one copy', () => {
  const entry = componentEntry([], [], navLink, { path: '0.4', occurrence: 2 });
  assert.equal(entry.hostOcc, undefined);
  assert.equal(entry.focusOcc, 2);
});

test('the opened copy reaches the overlay as the selection copy, and a stale one falls back to the first', () => {
  const runtime = fs.readFileSync(repoPath('src/features/preview/previewRuntime.ts'), 'utf8');
  const overlays = fs.readFileSync(repoPath('src/features/preview/PreviewOverlays.tsx'), 'utf8');
  assert.match(runtime, /selOcc: selectedOccurrence \?\? props\.openedOcc/);
  assert.match(overlays, /copiesToDraw\(all, props\.selOcc\)/);
  assert.match(overlays, /copiesToDraw\(all, outline\.occ\)/);
});
