// Goal: tests name repository files in the one spelling the layout tool
// (scripts/move/moveSources.mts) can follow when a file moves — a whole
// repository path in one string, repoPath('src/editor/pageEdits.ts') — so a
// move can never leave a test reading the wrong file or stubbing nothing.
// Method: read every test file and reject each spelling the tool cannot see:
// `'..'` path pieces and `../src/` relative paths (they break when the test
// moves), a regular expression over a source folder (it stops matching when
// the folder moves, silently), and a stale `.js` name for a TypeScript file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const ROOTS = 'src|dist|electron|shared|scripts|test';
const RULES = [
  {
    pattern: new RegExp(`'\\.\\.'\\s*,\\s*'(?:${ROOTS})'`),
    message: "path pieces after '..': write repoPath('src/…')",
  },
  {
    pattern: /['"`](?:\.\.\/)+dist\//,
    message: 'build output relative to the test: write #dist/…',
  },
  {
    // A relative module specifier is followed by the tool; the same path in a
    // string (an esbuild stdin, a file read) is not.
    pattern: new RegExp(`['"\`](?:\\.\\./)+(?:${ROOTS}|node_modules)/`),
    unless: /^\s*(?:import\b|export\b.*\bfrom\b|\}\s*from\b|.*\brequire\(\s*['"])/,
    message: "a path relative to the test: write repoPath('src/…')",
  },
  {
    // Package imports do not add extensions: `#dist/electron/x` finds nothing.
    pattern: /#dist\/[\w./-]+(?<!\.js|\.mjs|\.json)['"]/,
    message: 'a #dist import names its file with the extension: #dist/…/x.js',
  },
  {
    // A test's own folder is not where the fixtures are once the test moves.
    pattern: /__dirname,\s*'(?:corpus|fixtures|helpers)'/,
    message: "a test folder from __dirname: write repoPath('test/corpus') and the like",
  },
  {
    pattern: /import\.meta\.dirname,\s*'\.\./,
    message: 'the repository root from import.meta.dirname: use the working directory',
  },
  {
    pattern: /__dirname,\s*'\.\./,
    message: 'the repository root from __dirname: use ROOT or repoPath',
  },
  {
    pattern: /\\\/(?:src|electron|shared)\\\//,
    message: 'a regular expression over a source folder: stub by file (stubSources)',
  },
];
const STALE_NAME = new RegExp(`(?<![\\w./#$-])(?:#|\\./)?((?:${ROOTS})/[\\w./-]+)\\.(js|jsx)\\b`, 'g');
// Files that hold these spellings as data (the move tool's test, the lint
// rules' cases, and this test), and the helper that is the one place the root
// is found from __dirname.
const EXEMPT = new Set([
  'test/scripts/eslintPlugin/eslintPlugin.test.ts',
  'test/scripts/move/moveSources.test.ts',
  'test/helpers/sources.js',
  'test/scripts/gate/sourcePaths.test.js',
]);

function testFiles() {
  // Local checks run before staging, so new tests must follow the same rules
  // as committed tests. Deleted files have no source left to inspect.
  const listing = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', 'test'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 4_000_000,
    timeout: 30_000,
  });
  const files = [...new Set(listing.split('\0'))];
  assert.ok(files.length <= 20_000, 'test source path scan exceeds its file limit');
  return files
    .filter((file) => /\.(?:[cm]?js|ts)$/.test(file))
    .filter((file) => !file.startsWith('test/fixtures/') && !file.startsWith('test/corpus/'))
    .filter((file) => !EXEMPT.has(file))
    .filter((file) => fs.existsSync(repoPath(file)));
}

test('tests name repository files by one whole path', () => {
  const problems = [];
  for (const file of testFiles()) {
    const lines = fs.readFileSync(repoPath(file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const rule of RULES) {
        if (rule.pattern.test(line) && !rule.unless?.test(line)) {
          problems.push(`${file}:${index + 1}: ${rule.message}`);
        }
      }
      for (const match of line.matchAll(STALE_NAME)) {
        const stem = match[1];
        const written = `${stem}.${match[2]}`;
        const typed = [`${stem}.ts`, `${stem}.tsx`].find((name) => fs.existsSync(repoPath(name)));
        if (!fs.existsSync(repoPath(written)) && typed !== undefined) {
          problems.push(`${file}:${index + 1}: ${written} is ${typed}`);
        }
      }
    });
  }
  assert.deepEqual(problems, []);
});

test('the rules catch each spelling they name', () => {
  const samples = [
    "path.join(__dirname, '..', 'src', 'Sample.tsx')",
    "require('../dist/electron/main.js')",
    "path.join(__dirname, '../src/Sample.tsx')",
    "'../node_modules/.stacki-test/sample.bundle.js'",
    "require('#dist/electron/sample')",
    "path.join(__dirname, 'corpus')",
    'build.onLoad({ filter: /\\/src\\/panels\\/[^/]+$/ })',
  ];
  for (const sample of samples) {
    const caught = RULES.some((rule) => rule.pattern.test(sample) && !rule.unless?.test(sample));
    assert.ok(caught, `no rule catches ${sample}`);
  }
  const allowed = ["repoPath('src/Sample.tsx')", "import { a } from '../../scripts/policy/scan.mts';"];
  for (const sample of allowed) {
    const caught = RULES.some((rule) => rule.pattern.test(sample) && !rule.unless?.test(sample));
    assert.ok(!caught, `a rule rejects ${sample}`);
  }
  // Samples name no real file, so the move tool never rewrites them.
  const stale = [..."load('src/sample.js')".matchAll(STALE_NAME)].map((match) => match[1]);
  assert.deepEqual(stale, ['src/sample']);
});
