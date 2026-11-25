// Goal: the whole-repository Prettier run sees the files git sees, so a local notes folder
// (.git/info/exclude) cannot fail it (issue #78), and checks every other file as before.
// Method: batchFiles is checked on its bounds. The runner itself runs against a throwaway
// git repository that borrows this repository's Prettier: an unformatted file in an excluded
// folder passes, then (negative space) an unformatted tracked file, an untracked file nobody
// ignored, and the same folder once its exclude is removed all fail, while a file the
// repository's own .gitignore hides stays hidden as it always was.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { batchFiles, formatTree } from '../../../scripts/policy/formatTree.mts';

// The runner starts every suite at the repository root.
const REPOSITORY = process.cwd();
const UNFORMATTED = 'export   const a=1\n';

test('batchFiles bounds each batch by count and by characters and loses no file', () => {
  const many = Array.from({ length: 1_000 }, (_, index) => `src/file${index}.ts`);
  const batches = batchFiles(many);
  assert.deepEqual(batches.flat(), many);
  for (const batch of batches) {
    assert.ok(batch.length <= 400, 'at most 400 files');
  }
  const long = Array.from({ length: 10 }, (_, index) => `${'d/'.repeat(3_000)}${index}.ts`);
  for (const batch of batchFiles(long)) {
    assert.ok(batch.join(' ').length <= 20_000 + (long[0] ?? '').length, 'a batch stays near the character bound');
  }
  assert.deepEqual(batchFiles([]), []);
});

function fixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'stacki-format-tree-'));
  const run = (...argumentsList: readonly string[]): void => {
    const result = spawnSync('git', argumentsList, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  run('init', '--quiet');
  mkdirSync(path.join(root, 'node_modules'));
  symlinkSync(path.join(REPOSITORY, 'node_modules', 'prettier'), path.join(root, 'node_modules', 'prettier'), 'junction');
  writeFileSync(path.join(root, '.gitignore'), 'node_modules/\nbuilt/\n');
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src', 'ok.ts'), 'export const a = 1;\n');
  run('add', '.gitignore', 'src');
  return root;
}

function put(root: string, file: string, text: string): void {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
}

function quietFormat(root: string): number {
  // Prettier reports its findings on the streams; the status is what the gate reads.
  const write = process.stderr.write.bind(process.stderr);
  const out = process.stdout.write.bind(process.stdout);
  process.stderr.write = (): boolean => true;
  process.stdout.write = (): boolean => true;
  try {
    return formatTree(root, ['--check', '--log-level', 'warn']);
  } finally {
    process.stderr.write = write;
    process.stdout.write = out;
  }
}

test('an unformatted file in a locally excluded folder does not fail the format check', () => {
  const root = fixture();
  try {
    put(root, '.git/info/exclude', 'notes/\n');
    put(root, 'notes/scratch.ts', UNFORMATTED);
    put(root, 'notes/data.json', '{"a":   1}\n');
    put(root, 'built/generated.ts', UNFORMATTED);
    assert.equal(quietFormat(root), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every file git counts is still checked: tracked, new, and a formerly excluded folder', () => {
  const root = fixture();
  try {
    put(root, '.git/info/exclude', 'notes/\n');
    put(root, 'notes/scratch.ts', UNFORMATTED);
    assert.equal(quietFormat(root), 0);
    put(root, 'src/ok.ts', UNFORMATTED);
    assert.equal(quietFormat(root), 1, 'a tracked file that needs formatting fails');
    put(root, 'src/ok.ts', 'export const a = 1;\n');
    put(root, 'src/new.ts', UNFORMATTED);
    assert.equal(quietFormat(root), 1, 'a new file nobody ignored fails');
    rmSync(path.join(root, 'src', 'new.ts'));
    put(root, '.git/info/exclude', '');
    assert.equal(quietFormat(root), 1, 'without the exclude the notes folder is checked like any other');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
