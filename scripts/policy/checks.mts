// The checks every gate runs, in one place: the git hooks and every agent
// harness call these functions, so a human commit and an agent edit are held
// to the same rules by the same code (docs/enforcement.md).
//
// Three scopes, from fastest to fullest:
// - checkFiles: files an edit just touched. Prettier, the policy scan, ESLint.
// - checkChanged: everything that differs from HEAD, plus the type checker.
// - The full gate, `npm test`, is not here: it builds and runs every test.

import fs from 'node:fs';
import path from 'node:path';
import { assert } from './assert.mts';
import { runChild, type ChildResult } from './child.mts';
import { checkStudio, studioAffected } from './studioChecks.mts';
import { POLICY_LIMITS } from './limits.mts';
import { formatViolations, isExempt, normalizePath, scanPaths } from './scan.mts';

export type CheckOutcome = { readonly kind: 'pass' } | { readonly kind: 'fail'; readonly report: string };

// How Prettier treats the files: rewrite them in place (an agent's own edit,
// where formatting is deterministic and a round trip is waste), or only check
// them (a commit, where the author decides what is staged).
export type FormatMode = 'write' | 'check';

const LINTED_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']);
// Each build target has its own module and library settings. The broad root
// program alone cannot catch an import that fails the Electron build.
const TYPE_PROJECTS = [
  'tsconfig.json',
  'scripts/tsconfig.json',
  'scripts/tsconfig.build.json',
  'shared/tsconfig.json',
  'electron/tsconfig.json',
  'electron/tsconfig.morph.json',
  'electron/tsconfig.preload.json',
] as const;

export function repositoryRoot(): string {
  return path.resolve(import.meta.dirname, '..', '..');
}

export function checkFiles(root: string, candidates: readonly string[], options: { readonly format: FormatMode }): CheckOutcome {
  const files = relevantFiles(root, candidates);
  const sections: string[] = [];
  // Batches bound each child's command line and memory; every file is checked.
  const batchSize = POLICY_LIMITS.filesPerCheckMax;
  for (let start = 0; start < files.length; start += batchSize) {
    sections.push(...checkBatch(root, files.slice(start, start + batchSize), options.format));
  }
  if (studioAffected(candidates.map((file) => normalizePath(root, file)))) {
    const studio = checkStudio(root, options.format);
    if (studio.status !== 0) {
      sections.push(section('Studio', studio.stdout + studio.stderr));
    }
  }
  return outcome(sections);
}

function checkBatch(root: string, files: readonly string[], format: FormatMode): string[] {
  assert(files.length > 0, 'checkBatch: a batch has files');
  assert(files.length <= POLICY_LIMITS.filesPerCheckMax, 'checkBatch: batch exceeds the limit');
  const sections: string[] = [];
  const formatted = runPrettier(root, files, format);
  if (formatted.status !== 0) {
    sections.push(section('Prettier', formatted.stdout + formatted.stderr));
  }
  const violations = scanPaths(root, files);
  if (violations.length > 0) {
    sections.push(section('Policy scan', formatViolations(violations)));
  }
  const linted = files.filter((file) => LINTED_EXTENSIONS.has(path.extname(file)));
  if (linted.length > 0) {
    const lint = runEslint(root, linted);
    if (lint.status !== 0) {
      sections.push(section('ESLint', lint.stdout + lint.stderr));
    }
  }
  return sections;
}

export function checkChanged(root: string): CheckOutcome {
  const files = changedFiles(root);
  const fileOutcome = checkFiles(root, files, { format: 'check' });
  const sections = fileOutcome.kind === 'fail' ? [fileOutcome.report] : [];
  // Config edits and deleted modules can break compilation without leaving a
  // changed TypeScript file. Incremental checks make unconditional coverage cheap.
  const types = runTypeCheck(root);
  if (types.status !== 0) {
    sections.push(section('TypeScript', types.stdout + types.stderr));
  }
  const paths = runSourcePathCheck(root);
  if (paths.status !== 0) {
    sections.push(section('Test source paths', paths.stdout + paths.stderr));
  }
  return outcome(sections);
}

// Files that differ from HEAD — staged, unstaged, or new and not ignored —
// that still exist. A deletion needs no check of its own.
export function changedFiles(root: string): readonly string[] {
  const tracked = git(root, ['diff', '--name-only', '-z', 'HEAD']);
  const untracked = git(root, ['ls-files', '-z', '--others', '--exclude-standard']);
  const names = new Set([...splitNul(tracked), ...splitNul(untracked)]);
  return [...names].filter((file) => fs.existsSync(path.join(root, file))).sort();
}

export function stagedFiles(root: string): readonly string[] {
  const staged = git(root, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']);
  return splitNul(staged);
}

export function runTypeCheck(root: string): ChildResult {
  const compiler = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  const cache = path.join(root, 'node_modules', '.cache', 'tsc');
  for (const project of TYPE_PROJECTS) {
    const cacheName = project.replaceAll('/', '-').replace('.json', '.tsbuildinfo');
    const result = runChild(process.execPath, [compiler, '--project', project, '--noEmit', '--incremental', '--tsBuildInfoFile', path.join(cache, cacheName)], {
      cwd: root,
    });
    if (result.status !== 0) {
      return result;
    }
  }
  return { status: 0, stdout: '', stderr: '' };
}

export function runSourcePathCheck(root: string): ChildResult {
  return runChild(process.execPath, ['test/scripts/gate/sourcePaths.test.js'], { cwd: root });
}

export function runEslint(root: string, files: readonly string[]): ChildResult {
  assert(files.length <= POLICY_LIMITS.filesPerCheckMax, 'runEslint: file limit exceeded');
  const eslint = path.join(root, 'node_modules', 'eslint', 'bin', 'eslint.js');
  // No --cache: ESLint keys a cached result on the linted file and the config only, but the type-aware rules also read the types of every file it
  // imports. A changed dependency therefore left a stale "unsafe argument" verdict that no re-run could clear.
  const argumentsList = [eslint, '--no-cache', '--max-warnings', '0', '--no-warn-ignored', ...files];
  return runChild(process.execPath, argumentsList, { cwd: root });
}

function runPrettier(root: string, files: readonly string[], mode: FormatMode): ChildResult {
  assert(files.length <= POLICY_LIMITS.filesPerCheckMax, 'runPrettier: file limit exceeded');
  const prettier = path.join(root, 'node_modules', 'prettier', 'bin', 'prettier.cjs');
  const action = mode === 'write' ? '--write' : '--check';
  const argumentsList = [prettier, action, '--ignore-unknown', '--log-level', 'warn', ...files];
  return runChild(process.execPath, argumentsList, { cwd: root });
}

// Normalized, existing, and not exempt. Bounded by the scan's file limit: a
// change larger than the repository limit is a mistake to stop at.
function relevantFiles(root: string, candidates: readonly string[]): readonly string[] {
  assert(candidates.length <= POLICY_LIMITS.scanFilesMax, 'relevantFiles: file limit exceeded');
  const files = candidates
    .map((file) => normalizePath(root, file))
    .filter((file) => !file.startsWith('..'))
    .filter((file) => !isExempt(file))
    .filter((file) => fs.existsSync(path.join(root, file)));
  return [...new Set(files)];
}

function git(root: string, argumentsList: readonly string[]): string {
  const result = runChild('git', argumentsList, { cwd: root });
  assert(result.status === 0, `git ${argumentsList.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function splitNul(text: string): readonly string[] {
  return text.split('\0').filter((entry) => entry.length > 0);
}

function section(title: string, body: string): string {
  return `── ${title} ──\n${body.trim()}`;
}

function outcome(sections: readonly string[]): CheckOutcome {
  if (sections.length === 0) {
    return { kind: 'pass' };
  }
  return { kind: 'fail', report: sections.join('\n\n') };
}
