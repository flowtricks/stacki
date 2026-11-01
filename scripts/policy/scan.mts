#!/usr/bin/env node
// The repository policy scan: the AGENTS.md rules that are properties of files
// and of the repository rather than of syntax, so ESLint cannot hold them.
//
//   node scripts/policy/scan.mts                 every tracked and new file
//   node scripts/policy/scan.mts --files a b     just these files (hooks)
//
// File checks run in both modes: shell scripts, test headers,
// the no-check directive, layout names. Repository checks run only in full
// mode: the dependency record, one lockfile, the CLAUDE.md import, unique
// layout names, and assertion density in shared/.
// Output is one line per violation, `path:line  rule  message`; exit 1 on any.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assert } from './assert.mts';
import { runChild } from './child.mts';
import { POLICY_LIMITS } from './limits.mts';
import { sharedAssertionDensity } from './density.mts';

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly message: string;
}

const CODE_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']);
const SHELL_EXTENSIONS = new Set(['.bash', '.bat', '.cmd', '.fish', '.ps1', '.sh', '.zsh']);
const SHELL_SHEBANG = /^#!.*\b(?:ba|z|fi|k|da)?sh\b/;
// Byte-exact inputs: round-trip fixtures and corpora are tested as written.
const EXEMPT_PREFIXES = ['test/fixtures/', 'test/corpus/', 'node_modules/', 'dist/', 'release/', 'studio/'];
const EXEMPT_FILES = new Set(['package-lock.json']);
const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];
// A suppression with no rule list switches every rule off, including the one
// that asks for a reason, so ESLint cannot see it; the scan can. Spelled with
// a character class so this file does not match itself.
const BLANKET_DISABLE = /(?:\/\/|\/\*)\s*eslint-disabl[e](?:-next-line|-line)?\s*(?:\*\/|--|$)/;
// Spelled in two pieces so this file does not match itself.
const NO_CHECK_DIRECTIVE = '@ts-' + 'nocheck';

// The layout's naming rule (docs/codebase.md, "Directory map"): under these
// roots folders are camelCase, TypeScript modules camelCase and components
// PascalCase, so a name says what a file holds and a root spells names one
// way. Each phase of the layout restructure adds its root here.
const LAYOUT_ROOTS = ['src/', 'electron/', 'shared/', 'scripts/', 'test/'];
const LAYOUT_FOLDER = /^[a-z][A-Za-z0-9]*$/;
const LAYOUT_NAMES = [
  /^[a-z][A-Za-z0-9]*(?:\.d)?\.ts$/, // A module, or a declaration file.
  /^[a-z][A-Za-z0-9]*(?:\.(?:test|bench|entry))?\.(?:js|ts)$/, // A suite, a bench, a helper.
  /^README\.md$/, // A folder's guide.
  /^[a-z][A-Za-z0-9]*\.m[jt]s$/, // A module Node runs as written (a worker, a script).
  /^[a-z][A-Za-z0-9]*\.json$/, // Data a script reads (the move manifest).
  /^tsconfig(?:\.[a-z]+)?\.json$/, // A TypeScript project: the compiler's own name.
  /^[A-Za-z][A-Za-z0-9]*\.tsx$/, // A component, or a module that renders JSX.
  /^[A-Za-z][A-Za-z0-9]*\.css$/, // A component's stylesheet, or a shared one.
];

export function scanFile(file: string, text: string): readonly Violation[] {
  assert(!path.isAbsolute(file), 'scanFile: paths are repository-relative');
  assert(!file.includes('\\'), 'scanFile: paths use forward slashes');
  const extension = path.extname(file);
  const lines = text.split('\n');
  const found: Violation[] = [];
  if (SHELL_EXTENSIONS.has(extension) || SHELL_SHEBANG.test(lines[0] ?? '')) {
    const message = 'Scripts are TypeScript, not shell (AGENTS.md §17).';
    found.push({ file, line: 1, rule: 'no-shell-script', message });
  }
  found.push(...layoutNameViolations(file));
  found.push(...testPlacementViolations(file));
  if (CODE_EXTENSIONS.has(extension)) {
    const index = lines.findIndex((line) => line.includes(NO_CHECK_DIRECTIVE));
    if (index >= 0) {
      const message = 'Type checking cannot be switched off for a file.';
      found.push({ file, line: index + 1, rule: 'no-ts-nocheck', message });
    }
    const blanket = lines.findIndex((line) => BLANKET_DISABLE.test(line));
    if (blanket >= 0) {
      const message = 'Name the rules a suppression covers, and say why after ` -- `.';
      found.push({ file, line: blanket + 1, rule: 'no-blanket-disable', message });
    }
    if (file.startsWith('test/')) {
      found.push(...testHeaderViolations(file, lines));
    }
  }
  return found;
}

export function layoutNameViolations(file: string): readonly Violation[] {
  const root = LAYOUT_ROOTS.find((prefix) => file.startsWith(prefix));
  if (root === undefined) {
    return [];
  }
  const parts = file.slice(root.length).split('/');
  const name = parts.pop();
  assert(name !== undefined, 'layoutNameViolations: a path has a name');
  const found: Violation[] = [];
  const folder = parts.find((part) => !LAYOUT_FOLDER.test(part));
  if (folder !== undefined) {
    const message = `Folder '${folder}' is not camelCase (docs/codebase.md, "Directory map").`;
    found.push({ file, line: 1, rule: 'layout-name', message });
  }
  if (!LAYOUT_NAMES.some((pattern) => pattern.test(name))) {
    const message = `'${name}' is neither a camelCase module nor a PascalCase component: no hyphens, ` + 'underscores or extra dots.';
    found.push({ file, line: 1, rule: 'layout-name', message });
  }
  return found;
}

// test/ mirrors the source (docs/codebase.md): suites for a source folder sit
// in test/<root>/<area>/, and only suites do; helpers have their own folder.
const TEST_FOLDERS = new Set(['corpus', 'electron', 'fixtures', 'helpers', 'integration', 'renderer', 'scripts', 'shared', 'simulator']);
const TEST_MIRRORS = new Set(['electron', 'renderer', 'scripts', 'shared']);
const SUITE = /\.test\.(?:js|ts)$/;

export function testPlacementViolations(file: string): readonly Violation[] {
  const parts = file.split('/');
  if (parts[0] !== 'test') {
    return [];
  }
  const top = parts[1];
  assert(top !== undefined, 'testPlacementViolations: a test path has a part below test/');
  if (parts.length === 2) {
    return top === 'README.md' ? [] : [placement(file, 'test/ holds folders and its README only.')];
  }
  if (!TEST_FOLDERS.has(top)) {
    const known = [...TEST_FOLDERS].join(', ');
    return [placement(file, `test/${top}/ is not a test folder (${known}).`)];
  }
  if (!TEST_MIRRORS.has(top) || !CODE_EXTENSIONS.has(path.posix.extname(file))) {
    return [];
  }
  if (parts.length < 4) {
    return [placement(file, `A suite sits in the area it tests: test/${top}/<area>/.`)];
  }
  if (!SUITE.test(file)) {
    return [placement(file, 'A mirror folder holds suites only (*.test.*); helpers go in test/helpers/.')];
  }
  return [];
}

function placement(file: string, message: string): Violation {
  return { file, line: 1, rule: 'test-layout', message };
}

// Each mirror area names a source folder that exists: test/electron/parse/ is
// the suites of electron/parse/, test/renderer/style/ of src/features/style/.
export function testMirrorViolations(files: readonly string[]): readonly Violation[] {
  const folders = new Set(files.map((file) => path.posix.dirname(file)).flatMap(ancestors));
  const found: Violation[] = [];
  const reported = new Set<string>();
  for (const file of files) {
    const [first, mirror, area] = file.split('/');
    if (first !== 'test' || mirror === undefined || area === undefined || !TEST_MIRRORS.has(mirror)) {
      continue;
    }
    if (file.split('/').length < 4 || reported.has(`${mirror}/${area}`)) {
      continue;
    }
    const sources = mirror === 'renderer' ? [`src/${area}`, `src/features/${area}`] : [`${mirror}/${area}`];
    if (!sources.some((source) => folders.has(source))) {
      reported.add(`${mirror}/${area}`);
      const message = `test/${mirror}/${area}/ mirrors no source folder (${sources.join(' or ')}).`;
      found.push({ file, line: 1, rule: 'test-mirror', message });
    }
  }
  return found;
}

function ancestors(folder: string): readonly string[] {
  const parts = folder.split('/');
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
}

// Names are unique within a layout root, ignoring case, so a file named in a
// test, a lint list or a conversation is one file.
export function layoutUniquenessViolations(files: readonly string[]): readonly Violation[] {
  const found: Violation[] = [];
  for (const root of LAYOUT_ROOTS) {
    const seen = new Map<string, string>();
    const named = files.filter((candidate) => candidate.startsWith(root) && !isExempt(candidate));
    for (const file of named) {
      const name = path.posix.basename(file).toLowerCase();
      const first = seen.get(name);
      if (first === undefined) {
        seen.set(name, file);
      } else {
        const message = `Its name is taken by ${first}; names are unique within ${root}.`;
        found.push({ file, line: 1, rule: 'layout-unique', message });
      }
    }
  }
  return found;
}

// AGENTS.md §13: every test file opens with a comment describing its goal and
// methodology. The scan can hold the opening comment; review holds its content.
function testHeaderViolations(file: string, lines: readonly string[]): readonly Violation[] {
  const firstIndex = lines.findIndex((line, index) => {
    if (line.trim().length === 0) {
      return false;
    }
    return !(index === 0 && line.startsWith('#!'));
  });
  const first = firstIndex < 0 ? '' : (lines[firstIndex] ?? '').trimStart();
  if (first.startsWith('//') || first.startsWith('/*')) {
    return [];
  }
  const message = 'A test file opens with a comment on its goal and methodology (§13).';
  return [{ file, line: Math.max(1, firstIndex + 1), rule: 'test-header', message }];
}

// AGENTS.md §17: every dependency has a written justification. The record and
// package.json must name the same set, so neither can drift from the other.
export function dependencyViolations(packageText: string, recordText: string): readonly Violation[] {
  const declared = declaredDependencies(packageText);
  const recorded = recordedDependencies(recordText);
  const found: Violation[] = [];
  for (const name of declared) {
    if (!recorded.has(name)) {
      const message = `'${name}' has no justification in docs/dependencies.md (AGENTS.md §17).`;
      found.push({ file: 'package.json', line: 1, rule: 'dependency-record', message });
    }
  }
  for (const name of recorded) {
    if (!declared.has(name)) {
      const message = `'${name}' is recorded but not declared in package.json.`;
      found.push({ file: 'docs/dependencies.md', line: 1, rule: 'dependency-record', message });
    }
  }
  return found;
}

function declaredDependencies(packageText: string): ReadonlySet<string> {
  const input: unknown = JSON.parse(packageText);
  assert(typeof input === 'object', 'package.json: expected an object');
  assert(input !== null, 'package.json: expected an object, not null');
  const names = new Set<string>();
  for (const field of ['dependencies', 'devDependencies'] as const) {
    const block: unknown = Reflect.get(input, field);
    if (block === undefined) {
      continue;
    }
    assert(typeof block === 'object', `package.json.${field}: expected an object`);
    assert(block !== null, `package.json.${field}: expected an object, not null`);
    for (const name of Object.keys(block)) {
      names.add(name);
    }
  }
  return names;
}

// Names are the backticked words on `### ` headings; one heading may justify a
// family of packages that share a purpose.
function recordedDependencies(recordText: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const line of recordText.split('\n')) {
    if (!line.startsWith('### ')) {
      continue;
    }
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      const name = match[1];
      assert(name !== undefined, 'recordedDependencies: a match has its group');
      names.add(name);
    }
  }
  return names;
}

export function repositoryViolations(root: string, files: readonly string[]): readonly Violation[] {
  const present = new Set(files);
  const found: Violation[] = [];
  const lockfiles = LOCKFILES.filter((name) => present.has(name));
  if (lockfiles.length !== 1) {
    const listed = lockfiles.join(', ');
    const message = `Expected exactly one lockfile (package-lock.json); found: ${listed}.`;
    found.push({ file: 'package.json', line: 1, rule: 'one-lockfile', message });
  }
  const packageText = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  const recordText = readIfPresent(path.join(root, 'docs', 'dependencies.md'));
  found.push(...dependencyViolations(packageText, recordText));
  const claude = readIfPresent(path.join(root, 'CLAUDE.md'));
  if (!claude.split('\n').some((line) => line.trim() === '@AGENTS.md')) {
    const message = 'CLAUDE.md must import the standards with a line reading `@AGENTS.md`.';
    found.push({ file: 'CLAUDE.md', line: 1, rule: 'agent-instructions', message });
  }
  found.push(...layoutUniquenessViolations(files));
  found.push(...testMirrorViolations(files));
  const density = sharedAssertionDensity(root, files);
  if (density.perFunction < POLICY_LIMITS.sharedAssertionsPerFunctionMin) {
    const measured = density.perFunction.toFixed(2);
    const message = `shared/ averages ${measured} assertions per function; the floor is ` + `${POLICY_LIMITS.sharedAssertionsPerFunctionMin} (AGENTS.md §9).`;
    found.push({ file: 'shared', line: 1, rule: 'assertion-density', message });
  }
  return found;
}

function readIfPresent(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

// Tracked files plus new files not yet added, minus ignored ones: an agent's
// new file is checked before anyone stages it.
export function repositoryFiles(root: string): readonly string[] {
  const listing = runChild('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--deduplicate'], { cwd: root });
  assert(listing.status === 0, `git ls-files failed: ${listing.stderr}`);
  const files = listing.stdout.split('\0').filter((file) => file.length > 0);
  assert(files.length <= POLICY_LIMITS.scanFilesMax, 'scan: repository exceeds the file limit');
  // A file deleted in the working tree is still listed until the index learns.
  return files.filter((file) => fs.existsSync(path.join(root, file)));
}

export function isExempt(file: string): boolean {
  if (EXEMPT_FILES.has(file)) {
    return true;
  }
  return EXEMPT_PREFIXES.some((prefix) => file.startsWith(prefix));
}

export function scanPaths(root: string, files: readonly string[]): readonly Violation[] {
  assert(files.length <= POLICY_LIMITS.scanFilesMax, 'scanPaths: file limit exceeded');
  const found: Violation[] = [];
  for (const file of files) {
    if (isExempt(file)) {
      continue;
    }
    const absolute = path.join(root, file);
    const stat = fs.statSync(absolute, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isFile()) {
      continue;
    }
    if (stat.size > POLICY_LIMITS.fileBytesMax) {
      const message = `${stat.size} bytes exceeds the scan limit; review it by hand or exempt it.`;
      found.push({ file, line: 1, rule: 'file-size', message });
      continue;
    }
    found.push(...scanFile(file, fs.readFileSync(absolute, 'utf8')));
  }
  return found;
}

export function formatViolations(violations: readonly Violation[]): string {
  const shown = violations.slice(0, POLICY_LIMITS.violationsPrintedMax);
  const lines = shown.map((entry) => `${entry.file}:${entry.line}  ${entry.rule}  ${entry.message}`);
  const hidden = violations.length - shown.length;
  if (hidden > 0) {
    lines.push(`… and ${hidden} more.`);
  }
  return lines.join('\n');
}

// Repository-relative, forward-slashed: the form git and the checks use.
export function normalizePath(root: string, file: string): string {
  const relative = path.isAbsolute(file) ? path.relative(root, file) : file;
  return relative.split(path.sep).join('/');
}

function main(argumentsList: readonly string[]): number {
  const root = path.resolve(import.meta.dirname, '..', '..');
  const filesFlag = argumentsList.indexOf('--files');
  const violations: Violation[] = [];
  if (filesFlag >= 0) {
    const files = argumentsList.slice(filesFlag + 1).map((file) => normalizePath(root, file));
    violations.push(...scanPaths(root, files));
  } else {
    const files = repositoryFiles(root);
    violations.push(...scanPaths(root, files));
    violations.push(...repositoryViolations(root, files));
  }
  if (violations.length === 0) {
    return 0;
  }
  console.error(formatViolations(violations));
  console.error(`\npolicy scan: ${violations.length} violation(s).`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
