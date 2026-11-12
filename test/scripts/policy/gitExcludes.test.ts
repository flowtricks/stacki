// Goal: files a clone hides from git for itself (.git/info/exclude, the global excludes
// file) are named to ESLint, so a contributor's local notes folder cannot fail the gate
// (issue #78), while a clean checkout is checked exactly as before.
// Method: build a throwaway git repository for each case, with its own excludes and a
// private global git config so the machine running the test cannot leak in. The listing
// is checked for what it must name and, as the negative space, for what it must not: a
// tracked file, a path only .gitignore hides, and a directory that is not a repository.
// The ESLint case runs the real ESLint with a config that wires the helpers the way
// eslint.config.mjs does, and the wiring itself is pinned in the real config's text.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { eslintIgnoresFor, localExcludedPaths } from '../../../scripts/policy/gitExcludes.mts';

// The runner starts every suite at the repository root.
const REPOSITORY = process.cwd();

function git(root: string, ...argumentsList: readonly string[]): void {
  const result = spawnSync('git', argumentsList, { cwd: root, encoding: 'utf8', env: process.env });
  assert.equal(result.status, 0, `git ${argumentsList.join(' ')}: ${result.stderr}`);
}

function write(root: string, file: string, text: string): void {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
}

// Runs `body` with git's global and system configuration replaced, then restores it.
function withPrivateGitConfig(globalConfig: string, body: () => void): void {
  const saved = { global: process.env['GIT_CONFIG_GLOBAL'], system: process.env['GIT_CONFIG_NOSYSTEM'], xdg: process.env['XDG_CONFIG_HOME'] };
  process.env['GIT_CONFIG_GLOBAL'] = globalConfig;
  process.env['GIT_CONFIG_NOSYSTEM'] = '1';
  process.env['XDG_CONFIG_HOME'] = path.dirname(globalConfig);
  try {
    body();
  } finally {
    for (const [name, value] of [
      ['GIT_CONFIG_GLOBAL', saved.global],
      ['GIT_CONFIG_NOSYSTEM', saved.system],
      ['XDG_CONFIG_HOME', saved.xdg],
    ] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

function repository(): { readonly root: string; readonly home: string } {
  const home = mkdtempSync(path.join(tmpdir(), 'stacki-excludes-home-'));
  const root = mkdtempSync(path.join(tmpdir(), 'stacki-excludes-repo-'));
  writeFileSync(path.join(home, 'gitconfig'), '');
  git(root, 'init', '--quiet');
  return { root, home };
}

test('paths only a local exclude list hides are listed; tracked and .gitignore-only paths are not', () => {
  const { root, home } = repository();
  try {
    write(root, '.gitignore', 'built/\n');
    write(root, 'built/output.ts', 'export {};\n');
    write(root, 'src/kept.ts', 'export {};\n');
    write(root, 'notes/todo.ts', 'export   const a=1\n');
    write(root, 'notes/deep/more.json', '{"a":1}\n');
    write(root, 'scratch.json', '{"a":1}\n');
    write(root, 'tracked/inside.ts', 'export {};\n');
    write(root, '.git/info/exclude', 'notes/\nscratch.json\ntracked/\n');
    git(root, 'add', '.gitignore', 'src');
    git(root, 'add', '--force', 'tracked/inside.ts');
    withPrivateGitConfig(path.join(home, 'gitconfig'), () => {
      assert.deepEqual([...localExcludedPaths(root)].sort(), ['notes/', 'scratch.json']);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('the global excludes file counts, wherever git is told to find it', () => {
  const { root, home } = repository();
  try {
    write(home, 'globalIgnore', 'private-notes/\n');
    write(home, 'gitconfig', `[core]\n\texcludesFile = ${path.join(home, 'globalIgnore').replaceAll('\\', '/')}\n`);
    write(root, 'private-notes/a.ts', 'export {};\n');
    write(root, 'src/b.ts', 'export {};\n');
    withPrivateGitConfig(path.join(home, 'gitconfig'), () => {
      assert.deepEqual(localExcludedPaths(root), ['private-notes/']);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('a repository with no local excludes lists nothing, and neither does a folder that is not a repository', () => {
  const { root, home } = repository();
  const plain = mkdtempSync(path.join(tmpdir(), 'stacki-excludes-plain-'));
  try {
    write(root, 'src/a.ts', 'export {};\n');
    write(plain, 'notes/a.ts', 'export {};\n');
    withPrivateGitConfig(path.join(home, 'gitconfig'), () => {
      assert.deepEqual(localExcludedPaths(root), []);
      assert.deepEqual(localExcludedPaths(plain), []);
    });
  } finally {
    for (const folder of [root, home, plain]) {
      rmSync(folder, { recursive: true, force: true });
    }
  }
});

test('eslintIgnoresFor turns a folder into a glob and escapes glob characters in names', () => {
  assert.deepEqual(eslintIgnoresFor(['notes/', 'a/b/', 'scratch.ts']), ['notes/**', 'a/b/**', 'scratch.ts']);
  assert.deepEqual(eslintIgnoresFor(['odd[1].ts', 'x(y)/', '!bang.ts', 'a{b}.ts']), ['odd\\[1\\].ts', 'x\\(y\\)/**', '\\!bang.ts', 'a\\{b\\}.ts']);
  assert.deepEqual(eslintIgnoresFor([]), []);
});

test('ESLint skips a local notes folder and still lints everything else', () => {
  const { root, home } = repository();
  try {
    const helpers = pathToFileUrl(path.join(REPOSITORY, 'scripts', 'policy', 'gitExcludes.mts'));
    write(
      root,
      'eslint.config.mjs',
      `import { eslintIgnoresFor, localExcludedPaths } from '${helpers}';\n` +
        `export default [{ ignores: [...eslintIgnoresFor(localExcludedPaths(import.meta.dirname))] }, { files: ['**/*.js'], rules: { 'no-undef': 'error' } }];\n`,
    );
    write(root, 'src/ok.js', 'export const a = 1;\n');
    write(root, 'notes/bad.js', 'export const b = missingName;\n');
    write(root, '.git/info/exclude', 'notes/\n');
    const eslint = path.join(REPOSITORY, 'node_modules', 'eslint', 'bin', 'eslint.js');
    const run = (): ReturnType<typeof spawnSync> =>
      spawnSync(process.execPath, [eslint, '--max-warnings', '0', '.'], { cwd: root, encoding: 'utf8', env: process.env });
    withPrivateGitConfig(path.join(home, 'gitconfig'), () => {
      const clean = run();
      assert.equal(clean.status, 0, String(clean.stdout) + String(clean.stderr));
      // The negative space: a file git does not hide is still held to the rules.
      write(root, 'src/bad.js', 'export const c = missingName;\n');
      const dirty = run();
      assert.equal(dirty.status, 1);
      // ESLint prints the platform's separator: `\` on Windows.
      assert.match(String(dirty.stdout), /src[\\/]bad\.js/);
      assert.doesNotMatch(String(dirty.stdout), /notes/);
      // Without the exclude, the notes folder fails like any other: only the exclude changed the verdict.
      rmSync(path.join(root, 'src/bad.js'));
      write(root, '.git/info/exclude', '');
      const unhidden = run();
      assert.equal(unhidden.status, 1);
      assert.match(String(unhidden.stdout), /notes\/bad\.js/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('the real ESLint config, the format runner and the gate all read the local excludes', () => {
  const config = readFileSync(path.join(REPOSITORY, 'eslint.config.mjs'), 'utf8');
  assert.match(config, /eslintIgnoresFor\(localExcludedPaths\(import\.meta\.dirname\)\)/);
  const gate = readFileSync(path.join(REPOSITORY, 'scripts', 'gate', 'runTests.ts'), 'utf8');
  assert.match(gate, /scripts', 'policy', 'formatTree\.mts'/);
  assert.doesNotMatch(gate, /prettier\.cjs/);
  const local = readFileSync(path.join(REPOSITORY, 'scripts', 'policy', 'checkLocal.mts'), 'utf8');
  assert.match(local, /formatTree\.mts/);
  assert.doesNotMatch(local, /prettier\.cjs/);
});

function pathToFileUrl(file: string): string {
  return new URL(`file://${file.startsWith('/') ? '' : '/'}${file.replaceAll('\\', '/')}`).href;
}
