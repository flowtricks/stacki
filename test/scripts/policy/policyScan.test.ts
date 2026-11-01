// Goal: pin the repository policy scan (scripts/policy/scan.mts), which holds
// the AGENTS.md rules that are properties of files rather than of syntax.
// Method: the scan's checks are pure functions of a path and its text, so each
// is fed in-memory files — a known-good file, then each known-bad shape — and
// the reported rule ids are compared exactly. The dependency record and the
// assertion-density counter get the same treatment with small inputs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countFile } from '../../../scripts/policy/density.mts';
import { dependencyViolations, isExempt, layoutUniquenessViolations, testMirrorViolations, normalizePath, scanFile } from '../../../scripts/policy/scan.mts';

function rules(file: string, text: string): readonly string[] {
  return scanFile(file, text).map((violation) => violation.rule);
}

test('a clean source file passes', () => {
  assert.deepEqual(rules('src/a.ts', '// Header.\nexport const a = 1;\n'), []);
});

test('a long line is not a violation', () => {
  const long = 'x'.repeat(400);
  for (const file of ['src/a.ts', 'a.json', 'a.yml', 'a.css', 'a.mjs', 'a.tsx', 'a.html']) {
    assert.deepEqual(rules(file, long), [], file);
  }
});

test('shell scripts are rejected by extension and by shebang', () => {
  assert.deepEqual(rules('tools/a.sh', 'echo hi'), ['no-shell-script']);
  assert.deepEqual(rules('tools/a.ps1', 'Write-Host hi'), ['no-shell-script']);
  assert.deepEqual(rules('tools/tool', '#!/bin/bash\necho hi'), ['no-shell-script']);
  assert.deepEqual(rules('tools/tool', '#!/usr/bin/env sh\necho hi'), ['no-shell-script']);
  // A Node entry point is TypeScript's runtime, not a shell.
  assert.deepEqual(rules('.githooks/pre-commit', '#!/usr/bin/env node\nrequire("x");'), []);
});

test('the no-check directive is rejected in code', () => {
  const directive = '// @ts-' + 'nocheck';
  assert.deepEqual(rules('src/a.ts', `${directive}\nconst a = 1;`), ['no-ts-nocheck']);
});

test('blanket lint suppressions are rejected; named ones pass', () => {
  const disable = 'eslint-' + 'disable';
  assert.deepEqual(rules('src/a.ts', `/* ${disable} */`), ['no-blanket-disable']);
  assert.deepEqual(rules('src/a.ts', `// ${disable}-next-line\nx();`), ['no-blanket-disable']);
  assert.deepEqual(rules('src/a.ts', `// ${disable}-line -- because`), ['no-blanket-disable']);
  assert.deepEqual(rules('src/a.ts', `// ${disable}-next-line no-console -- CLI\nx();`), []);
});

test('test files open with a comment', () => {
  assert.deepEqual(rules('test/helpers/a.test.ts', '// Goal: …\nimport x from "y";'), []);
  assert.deepEqual(rules('test/helpers/a.js', '#!/usr/bin/env node\n/* Goal */\nx();'), []);
  assert.deepEqual(rules('test/helpers/a.js', '\n\n// Goal\nx();'), []);
  assert.deepEqual(rules('test/shared/core/a.test.ts', 'import x from "y";'), ['test-header']);
  assert.deepEqual(rules('test/shared/core/a.test.ts', ''), ['test-header']);
  // Outside test/, no header is required.
  assert.deepEqual(rules('src/a.ts', 'import x from "y";'), []);
});

test('fixtures, corpora, and the lockfile are exempt', () => {
  assert.equal(isExempt('test/fixtures/round-trip/a.astro'), true);
  assert.equal(isExempt('test/corpus/a.md'), true);
  assert.equal(isExempt('package-lock.json'), true);
  assert.equal(isExempt('test/a.test.ts'), false);
});

test('paths are normalized to repository-relative forward slashes', () => {
  assert.equal(normalizePath('/repo', '/repo/src/a.ts'), 'src/a.ts');
  assert.equal(normalizePath('/repo', 'src/a.ts'), 'src/a.ts');
});

test('the dependency record matches package.json in both directions', () => {
  const packageText = JSON.stringify({
    dependencies: { alpha: '1' },
    devDependencies: { beta: '1', gamma: '1' },
  });
  const complete = '### `alpha`\n\n### `beta`, `gamma`\n';
  assert.deepEqual(dependencyViolations(packageText, complete), []);
  const missing = dependencyViolations(packageText, '### `alpha`\n### `beta`\n');
  assert.deepEqual(
    missing.map((violation) => violation.message),
    ["'gamma' has no justification in docs/dependencies.md (AGENTS.md §17)."],
  );
  const stale = dependencyViolations(packageText, `${complete}### \`delta\`\n`);
  assert.deepEqual(
    stale.map((violation) => violation.file),
    ['docs/dependencies.md'],
  );
  // Backticks outside a heading are prose, not a record.
  const prose = dependencyViolations(packageText, `${complete}Uses \`delta\` inside.\n`);
  assert.deepEqual(prose, []);
});

test('assertion density counts block-bodied functions and assert calls only', () => {
  const text = [
    'export function a(x: number) { assert(x > 0, "x"); assertTree(x); return x; }',
    'export const b = (x: number) => x + 1;',
    'export const c = (x: number) => { return x; };',
    'const note = "assert(this is a string)";',
    '// assert(this is a comment)',
  ].join('\n');
  assert.deepEqual(countFile('shared/a.ts', text), { functions: 2, assertions: 2 });
});

test('layout names: camelCase folders and modules, PascalCase components', () => {
  const header = '// Header.\n';
  for (const file of [
    'src/features/style/model/cssRuleView.ts',
    'src/features/style/clipPath/webflowDesigner.d.ts',
    'src/features/props/PropsPanel.tsx',
    'src/features/props/propBindings.tsx',
    'src/features/style/embedEditor.css',
    'src/features/style/components/ClassPicker.css',
    'src/main.tsx',
    'electron/content/workers/stubAstroContent.mjs',
    'electron/terminal/nodePty.d.ts',
    'electron/tsconfig.preload.json',
    'scripts/policy/commitMessage.mts',
    'scripts/move/moveSources.json',
    // Outside the layout roots the rule does not apply.
    'test/scripts/policy/policyScan.test.ts',
  ]) {
    assert.deepEqual(rules(file, header), [], file);
  }
  for (const file of [
    'src/features/style/model/css-rule-view.ts',
    'src/features/style-panel/Gap.tsx',
    'src/features/content/contentSchema.types.ts',
    'src/features/props/Props_Panel.tsx',
    'src/features/props/PropsPanel.ts',
    'electron/content/workers/stub-astro-content.mjs',
    'electron/app/main.types.ts',
    'scripts/policy/sample-check.mts',
  ]) {
    assert.deepEqual(rules(file, header), ['layout-name'], file);
  }
});

test('layout names are unique within a root, ignoring case', () => {
  const unique = ['src/ui/CodeEditor.tsx', 'src/features/style/components/CssCodeEditor.tsx'];
  assert.deepEqual(layoutUniquenessViolations(unique), []);
  const clash = ['src/ui/CodeEditor.tsx', 'src/features/style/components/codeEditor.tsx'];
  const found = layoutUniquenessViolations(clash);
  assert.deepEqual(
    found.map((violation) => [violation.file, violation.rule]),
    [['src/features/style/components/codeEditor.tsx', 'layout-unique']],
  );
  // Outside the layout roots, names may repeat (every tsconfig.json, for one).
  assert.deepEqual(layoutUniquenessViolations(['shared/a.ts', 'electron/a.ts']), []);
});

test('test/ mirrors the source: suites in their area, helpers apart', () => {
  const header = '// Header.\n';
  for (const file of [
    'test/README.md',
    'test/renderer/style/selectorWell.test.js',
    'test/electron/parse/roundtripCorpus.test.js',
    'test/shared/core/span.test.ts',
    'test/helpers/sources.js',
    'test/simulator/world.ts',
    'test/simulator/spike.bench.ts',
  ]) {
    assert.deepEqual(rules(file, header), [], file);
  }
  for (const file of ['test/sampleSuite.test.js', 'test/misc/sample.test.js', 'test/renderer/sample.test.js', 'test/renderer/style/harness.js']) {
    assert.deepEqual(rules(file, header), ['test-layout'], file);
  }
});

test('each mirror area names a source folder that exists', () => {
  const files = [
    'src/features/style/EmbedEditor.tsx',
    'src/editor/pageEdits.ts',
    'electron/parse/astroParser.ts',
    'test/renderer/style/a.test.js',
    'test/renderer/editor/b.test.js',
    'test/electron/parse/c.test.js',
  ];
  assert.deepEqual(testMirrorViolations(files), []);
  const stale = testMirrorViolations([...files, 'test/electron/gone/d.test.js']);
  assert.deepEqual(
    stale.map((violation) => [violation.file, violation.rule]),
    [['test/electron/gone/d.test.js', 'test-mirror']],
  );
});
