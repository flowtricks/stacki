#!/usr/bin/env node
// Moves source files and rewrites every reference to them, one reviewed step
// at a time (docs/codebase.md, "Directory map"). A step is a list of moves in
// scripts/move/moveSources.json; the rewriting is
// scripts/move/moveSourcesPlan.mts. The manifest is empty between moves: write
// a step, run it, commit, and clear it (the commit records its table).
//
//   node scripts/move/moveSources.mts --step <name> [--dry-run] [--accept-reports]
//   node scripts/move/moveSources.mts --normalize-only [--dry-run]
//   node scripts/move/moveSources.mts --verify
//
// A step refuses to start on a dirty tree, a missing source, an existing
// target, or a name the layout forbids, and it refuses to write while any
// reference needs a hand edit (unless --accept-reports says each was read).
// --verify checks the renderer, main and shared sources: every relative
// specifier resolves and carries no extension, every renderer file is reached
// from src/main.tsx, and no moved file's old path survives in the tree.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assert } from '../policy/assert.mts';
import { runChild } from '../policy/child.mts';
import { POLICY_LIMITS } from '../policy/limits.mts';
import {
  collectSpecifiers,
  directoryIndex,
  extensionPolicy,
  isCodeFile,
  MOVE_LIMITS,
  planStep,
  resolveSpecifier,
  stripExtension,
  type Tree,
} from './moveSourcesPlan.mts';

interface Move {
  readonly from: string;
  readonly to: string;
}

interface Step {
  readonly step: string;
  readonly moves: readonly Move[];
}

type Command =
  | { readonly kind: 'step'; readonly name: string; readonly write: WriteMode }
  | { readonly kind: 'normalize'; readonly write: WriteMode }
  | { readonly kind: 'verify' };

type WriteMode = 'dry-run' | 'write' | 'write-accepting-reports';

const MANIFEST = 'scripts/move/moveSources.json';
// Files whose old paths are history, not references: the restructure leaves
// them as written.
const HISTORICAL = new Set([
  '.git-blame-ignore-revs',
  '.ripwire_notes',
  'docs/editor-core-tracker.md',
  'docs/stacki-editor-core-plan.md',
  'package-lock.json',
  MANIFEST,
]);
// Files that hold repository paths as data — the tool, its test, and the
// source-path rules' samples and exemptions: their imports follow a move,
// their path text does not.
const PATH_DATA = new Set([
  'scripts/move/moveSources.mts',
  'scripts/move/moveSourcesPlan.mts',
  'test/scripts/gate/sourcePaths.test.js',
  'test/scripts/move/moveSources.test.ts',
]);
const UNTOUCHED_PREFIXES = ['docs/archive/', 'test/fixtures/', 'test/corpus/'];

export function parseManifest(input: unknown): readonly Step[] {
  assert(typeof input === 'object', 'moveSources.json: expected an object');
  assert(input !== null, 'moveSources.json: expected an object, not null');
  const steps: unknown = Reflect.get(input, 'steps');
  assert(Array.isArray(steps), 'moveSources.json: steps must be an array');
  return steps.map((entry: unknown, index): Step => {
    assert(typeof entry === 'object', `steps[${index}]: expected an object`);
    assert(entry !== null, `steps[${index}]: expected an object, not null`);
    const name: unknown = Reflect.get(entry, 'step');
    const moves: unknown = Reflect.get(entry, 'moves');
    assert(typeof name === 'string', `steps[${index}].step: expected a string`);
    assert(Array.isArray(moves), `steps[${index}].moves: expected an array`);
    assert(moves.length <= MOVE_LIMITS.movesPerStepMax, `steps[${index}]: too many moves`);
    return { step: name, moves: moves.map((move: unknown) => parseMove(move, name)) };
  });
}

function parseMove(input: unknown, step: string): Move {
  assert(Array.isArray(input), `${step}: a move is a [from, to] pair`);
  assert(input.length === 2, `${step}: a move is a [from, to] pair`);
  const from: unknown = input[0];
  const to: unknown = input[1];
  assert(typeof from === 'string', `${step}: from must be a string`);
  assert(typeof to === 'string', `${step}: to must be a string`);
  return { from, to };
}

// AGENTS.md naming, as the layout check will hold it: folders are camelCase;
// TypeScript modules camelCase, components PascalCase; tests carry a suffix.
const FOLDER = /^[a-z][A-Za-z0-9]*$/;
const MODULE = /^[a-z][A-Za-z0-9]*(?:\.(?:test|bench|entry|d))?\.(?:ts|mts|js|mjs|json|css)$/;
const COMPONENT = /^[A-Z][A-Za-z0-9]*\.(?:tsx|css)$/;
const COMPONENT_MODULE = /^[a-z][A-Za-z0-9]*\.tsx$/;
const EXEMPT_NAMES = /^(?:tsconfig[\w.]*\.json|README\.md)$/;

export function nameProblem(target: string): string | undefined {
  const parts = target.split('/');
  const name = parts.pop();
  assert(name !== undefined, 'nameProblem: a path has a name');
  const folder = parts.slice(1).find((part) => !FOLDER.test(part));
  if (folder !== undefined) {
    return `${target}: folder '${folder}' is not camelCase`;
  }
  if (EXEMPT_NAMES.test(name) || MODULE.test(name)) {
    return undefined;
  }
  if (COMPONENT.test(name) || COMPONENT_MODULE.test(name)) {
    return undefined;
  }
  return `${target}: '${name}' is neither a camelCase module nor a PascalCase component`;
}

function preflight(root: string, files: ReadonlySet<string>, moves: readonly Move[]): string[] {
  const problems: string[] = [];
  const targets = new Set<string>();
  for (const move of moves) {
    if (!files.has(move.from)) {
      problems.push(`${move.from}: not a tracked file`);
    }
    if (files.has(move.to) || fs.existsSync(path.join(root, move.to))) {
      problems.push(`${move.to}: already exists`);
    }
    const folded = move.to.toLowerCase();
    if (targets.has(folded)) {
      problems.push(`${move.to}: two moves land on one name`);
    }
    targets.add(folded);
    const problem = nameProblem(move.to);
    if (problem !== undefined) {
      problems.push(problem);
    }
  }
  problems.push(...collisionProblems(files, moves));
  return problems;
}

// A moved file's name must stay unique within its root, so a test or a lint
// glob that names a file by its name finds one file.
function collisionProblems(files: ReadonlySet<string>, moves: readonly Move[]): string[] {
  const leaving = new Set(moves.map((move) => move.from));
  const names = new Map<string, string>();
  for (const file of files) {
    if (!leaving.has(file)) {
      names.set(nameKey(file), file);
    }
  }
  const problems: string[] = [];
  for (const move of moves) {
    const clash = names.get(nameKey(move.to));
    if (clash !== undefined) {
      problems.push(`${move.to}: its name is already taken by ${clash}`);
    }
  }
  return problems;
}

function nameKey(file: string): string {
  const root = file.startsWith('src/') ? 'src' : file.split('/')[0];
  return `${root ?? ''}:${path.posix.basename(file).toLowerCase()}`;
}

function trackedFiles(root: string): ReadonlySet<string> {
  const listing = runChild('git', ['ls-files', '-z'], { cwd: root });
  assert(listing.status === 0, `git ls-files failed: ${listing.stderr}`);
  const files = listing.stdout.split('\0').filter((file) => file.length > 0);
  assert(files.length <= MOVE_LIMITS.filesMax, 'moveSources: tree exceeds the file limit');
  return new Set(files);
}

function isRewritable(file: string): boolean {
  if (HISTORICAL.has(file)) {
    return false;
  }
  return !UNTOUCHED_PREFIXES.some((prefix) => file.startsWith(prefix));
}

function readTree(root: string): Tree {
  const files = trackedFiles(root);
  const texts = new Map<string, string>();
  for (const file of files) {
    if (!isRewritable(file)) {
      continue;
    }
    const absolute = path.join(root, file);
    const stat = fs.statSync(absolute, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isFile() || stat.size > POLICY_LIMITS.fileBytesMax) {
      continue;
    }
    const bytes = fs.readFileSync(absolute);
    if (bytes.includes(0)) {
      continue;
    }
    texts.set(file, bytes.toString('utf8'));
  }
  return { files, texts, pathData: PATH_DATA };
}

function runStep(root: string, steps: readonly Step[], name: string, write: WriteMode): number {
  const step = steps.find((candidate) => candidate.step === name);
  if (step === undefined) {
    console.error(`moveSources: no step named '${name}' in ${MANIFEST}`);
    return 1;
  }
  const tree = readTree(root);
  const problems = preflight(root, tree.files, step.moves);
  if (write !== 'dry-run' && !isClean(root)) {
    problems.push('the working tree has changes: commit or stash them first');
  }
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    return 1;
  }
  const moves = new Map(step.moves.map((move) => [move.from, move.to]));
  const plan = planStep(tree, moves);
  return finish(root, { moves, writes: plan.writes, reports: plan.reports, write });
}

interface Outcome {
  readonly moves: ReadonlyMap<string, string>;
  readonly writes: ReadonlyMap<string, string>;
  readonly reports: readonly string[];
  readonly write: WriteMode;
}

function finish(root: string, outcome: Outcome): number {
  for (const [from, to] of outcome.moves) {
    console.log(`move  ${from} → ${to}`);
  }
  console.log(`${outcome.writes.size} file(s) rewritten.`);
  if (outcome.reports.length > 0) {
    console.error(`\nReferences to fix by hand:\n${outcome.reports.join('\n')}`);
  }
  if (outcome.write === 'dry-run') {
    return outcome.reports.length > 0 ? 1 : 0;
  }
  if (outcome.reports.length > 0 && outcome.write !== 'write-accepting-reports') {
    console.error('\nNothing written. Fix the references, or pass --accept-reports.');
    return 1;
  }
  applyMoves(root, outcome.moves);
  for (const [file, text] of outcome.writes) {
    fs.writeFileSync(path.join(root, file), text);
  }
  formatFiles(root, [...outcome.writes.keys()]);
  return 0;
}

function applyMoves(root: string, moves: ReadonlyMap<string, string>): void {
  for (const [from, to] of moves) {
    fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
    const moved = runChild('git', ['mv', from, to], { cwd: root });
    assert(moved.status === 0, `git mv ${from} ${to}: ${moved.stderr}`);
  }
}

// Longer specifiers can push a line past 100 columns; Prettier rewraps it.
function formatFiles(root: string, files: readonly string[]): void {
  if (files.length === 0) {
    return;
  }
  const prettier = path.join(root, 'node_modules', '.bin', 'prettier');
  const formatted = runChild(prettier, ['--write', '--ignore-unknown', ...files], { cwd: root });
  assert(formatted.status === 0, `prettier failed: ${formatted.stderr}`);
}

function isClean(root: string): boolean {
  const status = runChild('git', ['status', '--porcelain'], { cwd: root });
  assert(status.status === 0, `git status failed: ${status.stderr}`);
  return status.stdout.trim().length === 0;
}

function runNormalize(root: string, write: WriteMode): number {
  const tree = readTree(root);
  if (write !== 'dry-run' && !isClean(root)) {
    console.error('moveSources: the working tree has changes: commit or stash them first');
    return 1;
  }
  const plan = planStep(tree, new Map());
  return finish(root, { moves: new Map(), writes: plan.writes, reports: plan.reports, write });
}

function runVerify(root: string, steps: readonly Step[]): number {
  const tree = readTree(root);
  const problems = [...specifierProblems(tree), ...unreachedProblems(tree), ...stalePathProblems(tree, steps)];
  if (problems.length === 0) {
    console.log('moveSources --verify: clean.');
    return 0;
  }
  console.error(problems.join('\n'));
  console.error(`\nmoveSources --verify: ${problems.length} problem(s).`);
  return 1;
}

function specifierProblems(tree: Tree): string[] {
  const problems: string[] = [];
  for (const [file, text] of tree.texts) {
    if (!isCodeFile(file) || extensionPolicy(file) !== 'strip') {
      continue;
    }
    for (const specifier of collectSpecifiers(file, text)) {
      if (!specifier.value.startsWith('.')) {
        continue;
      }
      const resolution = resolveSpecifier(tree.files, file, specifier.value);
      if (resolution === undefined) {
        problems.push(`${file}: '${specifier.value}' resolves to no file`);
      } else if (stripExtension(specifier.value) !== specifier.value) {
        problems.push(`${file}: '${specifier.value}' carries an extension`);
      }
    }
  }
  return problems;
}

// Every renderer file is reached from the entry; a file nothing reaches is dead.
function unreachedProblems(tree: Tree): string[] {
  const reached = new Set<string>(['src/main.tsx']);
  const pending = ['src/main.tsx'];
  while (pending.length > 0) {
    assert(reached.size <= MOVE_LIMITS.filesMax, 'unreachedProblems: file limit exceeded');
    const file = pending.pop();
    assert(file !== undefined, 'unreachedProblems: the stack is not empty');
    const text = tree.texts.get(file);
    if (text === undefined || !isCodeFile(file)) {
      continue;
    }
    for (const specifier of collectSpecifiers(file, text)) {
      if (!specifier.value.startsWith('.')) {
        continue;
      }
      const target = resolveSpecifier(tree.files, file, specifier.value)?.target;
      if (target !== undefined && !reached.has(target)) {
        reached.add(target);
        pending.push(target);
      }
    }
  }
  return [...tree.files]
    .filter((file) => file.startsWith('src/') && !file.endsWith('.d.ts'))
    .filter((file) => !reached.has(file))
    .map((file) => `${file}: not reached from src/main.tsx`);
}

// An applied step's old paths must not survive as text anywhere rewritable.
const STALE_PATH_TOKEN = /(?<![\w./#$-])#?((?:dist\/)?(?:src|electron|shared|scripts|test)\/[\w./-]+)/g;
function stalePathProblems(tree: Tree, steps: readonly Step[]): string[] {
  const stale = new Map<string, string>();
  for (const step of steps) {
    for (const move of step.moves) {
      if (!tree.files.has(move.from) && tree.files.has(move.to)) {
        stale.set(stripExtension(move.from), move.to);
      }
    }
  }
  if (stale.size === 0) {
    return [];
  }
  const directories = directoryIndex(tree.files);
  const problems: string[] = [];
  for (const [file, text] of tree.texts) {
    if (PATH_DATA.has(file)) {
      continue;
    }
    for (const match of text.matchAll(STALE_PATH_TOKEN)) {
      const written = stripExtension((match[1] ?? '').replace(/\.+$/, ''));
      const bare = written.startsWith('dist/') ? written.slice('dist/'.length) : written;
      if (stale.has(bare) && !directories.has(bare)) {
        problems.push(`${file}: still names ${bare} (now ${stale.get(bare) ?? ''})`);
      }
    }
  }
  return problems;
}

function parseCommand(argumentsList: readonly string[]): Command | undefined {
  const write: WriteMode = argumentsList.includes('--dry-run') ? 'dry-run' : argumentsList.includes('--accept-reports') ? 'write-accepting-reports' : 'write';
  if (argumentsList.includes('--verify')) {
    return { kind: 'verify' };
  }
  if (argumentsList.includes('--normalize-only')) {
    return { kind: 'normalize', write };
  }
  const flag = argumentsList.indexOf('--step');
  const name = flag >= 0 ? argumentsList[flag + 1] : undefined;
  return name === undefined ? undefined : { kind: 'step', name, write };
}

function main(argumentsList: readonly string[]): number {
  const root = path.resolve(import.meta.dirname, '..', '..');
  const command = parseCommand(argumentsList);
  if (command === undefined) {
    console.error('usage: moveSources --step <name> [--dry-run] | --normalize-only | --verify');
    return 2;
  }
  const manifestText = fs.readFileSync(path.join(root, MANIFEST), 'utf8');
  const manifest: unknown = JSON.parse(manifestText);
  const steps = parseManifest(manifest);
  switch (command.kind) {
    case 'step':
      return runStep(root, steps, command.name, command.write);
    case 'normalize':
      return runNormalize(root, command.write);
    case 'verify':
      return runVerify(root, steps);
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
