// Route the hosted package through its own compiler and strict lint rules.
// Direct Node invocations also work on Windows without spawning npm.cmd.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { runChild, type ChildResult } from './child.mts';

const STUDIO_SUITES_PER_BATCH = 20;
const STUDIO_BATCHES_MAX = 50;

export function studioAffected(files: readonly string[]): boolean {
  return files.some((file) => /^(studio|src|shared|electron)\//.test(file));
}

export function checkStudio(root: string, format: 'write' | 'check'): ChildResult {
  return runChild(process.execPath, [fileURLToPath(import.meta.url), `--${format}`], {
    cwd: root,
  });
}

function verifyStudio(root: string): number {
  const cwd = path.join(root, 'studio');
  const dependency = (file: string): string => path.join(cwd, 'node_modules', file);
  const tsx = dependency('tsx/dist/cli.mjs');
  const compiler = dependency('typescript/bin/tsc');
  const commands: readonly (readonly string[])[] = [
    [tsx, 'scripts/assemble.ts'],
    [compiler, '--noEmit'],
    [compiler, '-p', 'tsconfig.worker.json'],
    [dependency('eslint/bin/eslint.js'), '--max-warnings', '0', '.'],
    [dependency('prettier/bin/prettier.cjs'), process.argv.includes('--write') ? '--write' : '--check', '.'],
  ];
  const suites = fs
    .readdirSync(path.join(cwd, 'test'))
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => `test/${name}`);
  // The suites run in batches, each its own child under the child time limit: in one
  // run, GitHub's Windows runner took over five minutes for them all (1.1.0). A bound
  // on the batch count keeps a runaway suite list from becoming an unbounded loop.
  const batches: (readonly string[])[] = [];
  for (let start = 0; start < suites.length; start += STUDIO_SUITES_PER_BATCH) {
    // --test-force-exit: a suite that leaves a handle open (a server, a child's pipe) would
    // otherwise hold the batch until the child time limit, as on GitHub's Windows runner in 1.1.1.
    batches.push([tsx, '--test', '--test-force-exit', ...suites.slice(start, start + STUDIO_SUITES_PER_BATCH)]);
  }
  assert(batches.length <= STUDIO_BATCHES_MAX, 'verifyStudio: too many Studio test batches');
  const full = process.argv.includes('--full') ? [...batches, [tsx, 'scripts/build.ts']] : [];
  for (const argumentsList of [...commands, ...full]) {
    const result = runChild(process.execPath, argumentsList, { cwd });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.status !== 0) {
      // Name the command, so a timed-out batch says which suites it held.
      process.stderr.write(`studio verify: failed running ${argumentsList.slice(1).join(' ')}\n`);
      return 1;
    }
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = verifyStudio(path.resolve(import.meta.dirname, '../..'));
}
