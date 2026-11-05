// Goal: the pure parts of `npm run check:linux` report each way the Linux
// release job has failed, and stay quiet on the code that is correct.
// Methodology: feed each check a small tracked tree, file text or manifest
// built here, the valid shape first and then each invalid one, including the
// v1.0.11 sourceMenu probe (measure after fixed sleeps) beside its fix (wait
// for the popup phase and its animations). The Electron half, the probes run
// under slow motion, is exercised by running `npm run check:linux` itself.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  caseCollisions,
  caseMismatches,
  configPathMismatches,
  directlyExecutedPaths,
  ignoredReferences,
  lineAt,
  linuxBuildFindings,
  relativeSpecifiers,
  resolveSpecifier,
  shebangFindings,
  trackedTree,
  unsettledMeasurements,
} from '#dist/scripts/release/linuxPreflightChecks.js';
import { parseOptions } from '#dist/scripts/release/linuxPreflight.js';
import { frameDelayPreload, parseSlowMotion } from '#dist/scripts/release/linuxSlowMotion.js';

const tree = trackedTree([
  'src/ui/Popup.tsx',
  'src/ui/popup.css',
  'src/ui/index.ts',
  'electron/main.ts',
  'scripts/release/afterPack.ts',
  'resources/icon.png',
  '.githooks/pre-push',
]);

test('a tracked tree holds files and their folders, exact and folded', () => {
  assert.ok(tree.exact.has('src/ui/Popup.tsx'));
  assert.ok(tree.exact.has('src/ui'));
  assert.ok(!tree.exact.has('src/ui/popup.tsx'));
  assert.deepEqual(tree.folded.get('src/ui/popup.tsx'), ['src/ui/Popup.tsx']);
  assert.deepEqual(caseCollisions(tree), []);
  assert.throws(() => trackedTree(['/absolute/path']), /not repository-relative/);
  assert.throws(() => trackedTree(['']), /empty/);
});

test('paths that differ only in case collide', () => {
  const findings = caseCollisions(trackedTree(['src/Button.tsx', 'src/button.tsx']));
  assert.equal(findings.length, 1);
  assert.match(findings[0]?.message ?? '', /src\/Button\.tsx and src\/button\.tsx differ only in case/);
});

test('relative specifiers are found in every import form, bare packages are not', () => {
  const text = [
    "import Popup from './Popup';",
    "export * from '../core/limits';",
    "import './popup.css';",
    "const lazy = import('./lazy');",
    "const legacy = require('./legacy.js');",
    "import fs = require('node:fs');",
    "import React from 'react';",
    "@import './tokens.css';",
    "@import url('./fonts.css');",
  ].join('\n');
  assert.deepEqual(
    relativeSpecifiers(text).map(({ specifier, line }) => `${line}:${specifier}`),
    ['1:./Popup', '2:../core/limits', '3:./popup.css', '4:./lazy', '5:./legacy.js', '8:./tokens.css', '9:./fonts.css'],
  );
  assert.deepEqual(relativeSpecifiers("import x from 'pkg/./sub';"), []);
});

test('a specifier resolves exactly, only ignoring case, or not at all', () => {
  const importer = 'src/ui/Select.tsx';
  assert.deepEqual(resolveSpecifier(tree, importer, './Popup'), { kind: 'exact' });
  assert.deepEqual(resolveSpecifier(tree, importer, './popup.css?inline'), { kind: 'exact' });
  // TypeScript's ESM style names the emitted .js for a .ts source.
  assert.deepEqual(resolveSpecifier(tree, 'electron/app.ts', './main.js'), { kind: 'exact' });
  assert.deepEqual(resolveSpecifier(tree, 'src/app.ts', './ui'), { kind: 'exact' });
  // The macOS-only case: the file is Popup.tsx, the import says popup.
  assert.deepEqual(resolveSpecifier(tree, importer, './popup'), { kind: 'case', actual: 'src/ui/Popup.tsx' });
  assert.deepEqual(resolveSpecifier(tree, importer, './POPUP.css'), { kind: 'case', actual: 'src/ui/popup.css' });
  assert.deepEqual(resolveSpecifier(tree, importer, './Missing'), { kind: 'missing' });
  assert.deepEqual(resolveSpecifier(tree, 'a.ts', '../outside'), { kind: 'missing' });
  assert.throws(() => resolveSpecifier(tree, importer, 'react'), /not relative/);
});

test('case mismatches are reported with their line; unresolved specifiers are not', () => {
  const text = "import Popup from './Popup';\nimport Other from './popup';\nimport Gone from './Gone';";
  const findings = caseMismatches(tree, 'src/ui/Select.tsx', text);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.line, 2);
  assert.match(findings[0]?.message ?? '', /'\.\/popup' matches src\/ui\/Popup\.tsx only ignoring case/);
});

test('config paths must match case; build output, URLs and unknown paths are skipped', () => {
  const good = '"afterPack": "./dist/scripts/release/afterPack.js", "icon": "resources/icon.png", "homepage": "https://github.com/Resources/icon.png"';
  assert.deepEqual(configPathMismatches(tree, 'package.json', good), []);
  const bad = '{\n  "icon": "resources/Icon.png",\n  "run": "node Scripts/release/afterPack.ts"\n}';
  const findings = configPathMismatches(tree, 'package.json', bad);
  assert.deepEqual(
    findings.map((finding) => finding.line),
    [2, 3],
  );
  assert.match(findings[0]?.message ?? '', /'resources\/Icon\.png' names resources\/icon\.png only ignoring case/);
  assert.deepEqual(configPathMismatches(tree, 'release.yml', 'run: node not/tracked/anywhere.js'), []);
});

test('shebangs and executable bits are portable to Linux', () => {
  const none = new Set<string>();
  const findingsFor = (file: string, mode: string, head: string, executed: ReadonlySet<string> = none): readonly string[] =>
    shebangFindings([{ file, mode, head }], executed).map((finding) => finding.message);
  // Valid shapes.
  assert.deepEqual(findingsFor('a.mts', '100644', '#!/usr/bin/env node\nimport x;'), []);
  assert.deepEqual(findingsFor('b.sh', '100755', '#!/bin/sh\necho'), []);
  assert.deepEqual(findingsFor('c', '100755', '#!/usr/bin/env -S node --no-warnings\n'), []);
  assert.deepEqual(findingsFor('d.node', '100755', '\x7fELF\x02\x01'), []);
  assert.deepEqual(findingsFor('e.ts', '100644', 'export {}'), []);
  // Each invalid shape.
  assert.match(findingsFor('f', '100755', '#!/usr/bin/env node\r\nrun()')[0] ?? '', /CRLF/);
  assert.match(findingsFor('g', '100755', '#!/usr/bin/env node --no-warnings\n')[0] ?? '', /as one program name/);
  assert.match(findingsFor('h', '100755', '#!/opt/homebrew/bin/node\n')[0] ?? '', /does not exist on Linux runners/);
  assert.match(findingsFor('i.ts', '100755', 'export {}')[0] ?? '', /executable but has no #! line/);
  assert.match(findingsFor('.githooks/pre-push', '100644', '#!/usr/bin/env node\n', new Set(['.githooks/pre-push']))[0] ?? '', /not executable in git/);
  assert.throws(() => shebangFindings([{ file: 'j', mode: '100644', head: 'x'.repeat(257) }], none), /head exceeds limit/);
});

test('workflow steps that run ./paths name the tracked files they run', () => {
  const workflow = 'run: |\n  ./.githooks/pre-push\n  "$appimage" --appimage-extract\n  ./release/Stacki.AppImage\n  node ./scripts/missing.js';
  assert.deepEqual(directlyExecutedPaths(tree, workflow), ['.githooks/pre-push']);
});

// The v1.0.11 failure: the probe clicked, slept 8 × 30 ms and measured; on the
// Linux runner the popup was still opening (scale 0.985), so 8px read 9.98px.
const SOURCE_MENU_UNFIXED = `
  await js("document.querySelector('.u-select-link').click(); true");
  const lefts = [];
  for (let i = 0; i < 8; i += 1) {
    await new Promise((r) => setTimeout(r, 30));
    lefts.push(await js("document.querySelector('.u-select-list').getBoundingClientRect().left"));
  }
  const out = await js("document.querySelector('.u-select-list').getBoundingClientRect()");
`;
const SOURCE_MENU_FIXED = SOURCE_MENU_UNFIXED.replace(
  'const out =',
  `const settled = await js(\`(async () => {
     const phased = document.querySelector('[data-popup-phase]');
     await Promise.all(phased.getAnimations().map((a) => a.finished));
   })()\`);
   const out =`,
);

test('a probe that measures after a fixed sleep is flagged; one that waits for the motion is not', () => {
  const findings = unsettledMeasurements('sourceMenu.test.js', SOURCE_MENU_UNFIXED);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.line, 2);
  assert.match(findings[0]?.message ?? '', /without waiting for the motion to finish/);
  assert.deepEqual(unsettledMeasurements('sourceMenu.test.js', SOURCE_MENU_FIXED), []);
  // A bounded poll on the condition is a wait too.
  assert.deepEqual(unsettledMeasurements('a.js', "x.click(); await sleep(50); await waitForPopup('open'); el.getBoundingClientRect();"), []);
  // No read, or no sleep, is nothing to flag.
  assert.deepEqual(unsettledMeasurements('b.js', 'x.click(); await sleep(50); done();'), []);
  assert.deepEqual(unsettledMeasurements('c.js', 'x.click(); el.getBoundingClientRect();'), []);
  // Prose about waiting is not a wait.
  const commented = "x.click();\n// We wait until it settles, getAnimations() style.\nawait sleep(50);\nel.getBoundingClientRect();";
  assert.equal(unsettledMeasurements('d.js', commented).length, 1);
  // Each interaction is judged up to the next one.
  const two = "a.click(); await sleep(50); el.getBoundingClientRect();\nb.click(); await waitForPopup('open'); el.getBoundingClientRect();";
  assert.deepEqual(
    unsettledMeasurements('e.js', two).map((finding) => finding.line),
    [1],
  );
});

test('tracked tests that name git-ignored files are reported', () => {
  const ignored = ['test/fixtures/large/bytes-100.astro'];
  assert.deepEqual(ignoredReferences(ignored, 'test/a.test.js', "read('fixtures/editor-core/a.astro')"), []);
  const fromRoot = ignoredReferences(ignored, 'test/snapshot.json', '{\n "test/fixtures/large/bytes-100.astro": 1 }');
  assert.equal(fromRoot[0]?.line, 2);
  assert.match(fromRoot[0]?.message ?? '', /\.gitignore excludes/);
  assert.equal(ignoredReferences(ignored, 'test/b.test.js', "join(ROOT, 'fixtures/large/bytes-100.astro')").length, 1);
  assert.throws(() => ignoredReferences(['dist/x.js'], 'test/c.test.js', ''), /outside test\//);
});

const PNG_1080 = Buffer.from('89504e470d0a1a0a0000000d49484452000004380000043808060000', 'hex');
const LINUX = {
  category: 'Development',
  icon: 'resources/icon.png',
  executableName: 'stacki',
  executableArgs: ['--enable-sandbox'],
  target: [{ target: 'AppImage' }, { target: 'deb' }],
};

test('electron-builder Linux settings are checked field by field', () => {
  assert.deepEqual(linuxBuildFindings({ linux: LINUX }, tree, PNG_1080), []);
  const messagesFor = (linux: unknown, header: Buffer | undefined = PNG_1080): string =>
    linuxBuildFindings({ linux }, tree, header)
      .map((finding) => finding.message)
      .join('\n');
  assert.match(messagesFor(undefined), /build\.linux is missing/);
  assert.match(messagesFor({ ...LINUX, category: 'IDE' }), /not a freedesktop main category/);
  assert.match(messagesFor({ ...LINUX, executableName: 'Stacki App' }), /lower case without spaces/);
  assert.match(messagesFor({ ...LINUX, executableArgs: ['--no-sandbox'] }), /disables the Chromium sandbox/);
  assert.match(messagesFor({ ...LINUX, target: [{ target: 'AppImage' }] }), /target lacks deb/);
  assert.match(messagesFor({ ...LINUX, icon: undefined }), /icon is not set/);
  assert.match(messagesFor({ ...LINUX, icon: 'resources/Icon.png' }), /only ignoring case/);
  assert.match(messagesFor({ ...LINUX, icon: 'resources/gone.png' }), /not tracked/);
  assert.match(messagesFor(LINUX, Buffer.from('GIF89a')), /not a PNG/);
  const small = Buffer.from(PNG_1080);
  small.writeUInt32BE(128, 16);
  assert.match(messagesFor(LINUX, small), /128×1080; Linux needs at least 256×256/);
});

test('the slow-motion profile is parsed at its boundary', () => {
  assert.deepEqual(parseSlowMotion('{"frameDelayMs":200,"animationRate":0.25}'), { frameDelayMs: 200, animationRate: 0.25 });
  assert.throws(() => parseSlowMotion('null'), /expected an object/);
  assert.throws(() => parseSlowMotion('{"frameDelayMs":1.5,"animationRate":1}'), /frameDelayMs: expected an integer/);
  assert.throws(() => parseSlowMotion('{"frameDelayMs":-1,"animationRate":1}'), /at least 0/);
  assert.throws(() => parseSlowMotion('{"frameDelayMs":2001,"animationRate":1}'), /frameDelayMs: exceeds limit/);
  assert.throws(() => parseSlowMotion('{"frameDelayMs":0,"animationRate":0}'), /below limit/);
  assert.throws(() => parseSlowMotion('{"frameDelayMs":0,"animationRate":2}'), /at most 1/);
  assert.throws(() => parseSlowMotion('{"frameDelayMs":0}'), /animationRate: expected a number/);
  const preload = frameDelayPreload(200);
  assert.match(preload, /executeInMainWorld\(\{ func: slow, args: \[200\] \}\)/);
  assert.throws(() => frameDelayPreload(-1), /not negative/);
});

test('command-line options are bounded', () => {
  assert.deepEqual(parseOptions([]), { staticOnly: false, repeat: 1, jobs: 2, only: undefined });
  assert.deepEqual(parseOptions(['--static', '--repeat=3', '--jobs=1', '--only=style/']), { staticOnly: true, repeat: 3, jobs: 1, only: 'style/' });
  assert.throws(() => parseOptions(['--repeat=6']), /from 1 to 5/);
  assert.throws(() => parseOptions(['--jobs=0']), /from 1 to 4/);
  assert.throws(() => parseOptions(['--only=']), /Unknown argument/);
  assert.throws(() => parseOptions(['--docker']), /Unknown argument/);
});

test('line numbers are 1-based and offsets are bounded', () => {
  assert.equal(lineAt('a\nb\nc', 0), 1);
  assert.equal(lineAt('a\nb\nc', 2), 2);
  assert.equal(lineAt('a\nb\nc', 5), 3);
  assert.throws(() => lineAt('a', 2), /inside the text/);
  assert.throws(() => lineAt('a', -1), /not negative/);
});
