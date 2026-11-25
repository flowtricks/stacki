// The pure half of scripts/move/moveSources.mts: given a tree's files and texts and
// a map of moves, compute the new text of every file that names a moved file.
// Nothing here touches the disk, so test/contracts/move-sources.test.ts runs it
// on trees held in memory.
//
// Two kinds of reference are rewritten:
// - Module specifiers (import, export, import(), require, import types), found
//   with the TypeScript parser and resolved against the tree before the move.
// - Repository paths written as text (`src/…`, `#dist/electron/…`) in tests,
//   scripts, configs, docs and comments, rewritten only when they resolve to a
//   real file or a directory that moves as a whole.
// What cannot be rewritten safely — a regular expression over a moved
// directory, the bare name of a renamed file — is reported, never guessed at.

import path from 'node:path';
import ts from 'typescript';
import { assert } from '../policy/assert.mts';

export const MOVE_LIMITS = {
  /** Moves in one step: a feature folder is tens of files. */
  movesPerStepMax: 400,
  /** Syntax nodes walked in one file; ClipPath.tsx, the largest, has under 400k. */
  syntaxNodesPerFileMax: 4_000_000,
  /** Files in the tree. It holds about 900 today. */
  filesMax: 20_000,
} as const satisfies Record<string, number>;

export interface Tree {
  // Every tracked file, repository-relative with forward slashes.
  readonly files: ReadonlySet<string>;
  // The text of each file whose references may need rewriting.
  readonly texts: ReadonlyMap<string, string>;
  // Files whose repository paths are data (samples, exemption lists): their
  // imports follow a move, their path text never does.
  readonly pathData?: ReadonlySet<string>;
}

export interface StepPlan {
  // New path → new text, for every file whose text changes.
  readonly writes: ReadonlyMap<string, string>;
  // References that must be fixed by hand before the step can run.
  readonly reports: readonly string[];
}

// Whether a rewritten specifier drops its extension. TypeScript compiled by
// tsc or Vite resolves extensionless specifiers; scripts run under Node's type
// stripping, and CommonJS harnesses, need the extension they were written with.
export type ExtensionPolicy = 'keep' | 'strip';

export type SpecifierForm =
  { readonly kind: 'exact' } | { readonly kind: 'alias'; readonly extension: string } | { readonly kind: 'bare' } | { readonly kind: 'directory' };

export interface Resolution {
  readonly target: string;
  readonly form: SpecifierForm;
}

interface Specifier {
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const SCRIPT_KINDS = new Map<string, ts.ScriptKind>([
  ['.cjs', ts.ScriptKind.JS],
  ['.cts', ts.ScriptKind.TS],
  ['.js', ts.ScriptKind.JS],
  ['.jsx', ts.ScriptKind.JSX],
  ['.mjs', ts.ScriptKind.JS],
  ['.mts', ts.ScriptKind.TS],
  ['.ts', ts.ScriptKind.TS],
  ['.tsx', ts.ScriptKind.TSX],
]);
// A stale `.js` specifier names the TypeScript file it was compiled from.
const ALIASES = new Map<string, readonly string[]>([
  ['.cjs', ['.cts']],
  ['.js', ['.ts', '.tsx']],
  ['.jsx', ['.tsx']],
  ['.mjs', ['.mts']],
]);
const APPENDED = ['.ts', '.tsx', '.d.ts', '.mts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
const INDEXES = ['index.ts', 'index.tsx', 'index.js'];
// Extensions an extensionless specifier finds under tsc and Vite resolution.
const STRIPPABLE = ['.d.ts', '.ts', '.tsx', '.js', '.jsx'];
// Directories whose TypeScript is compiled by tsc or bundled by Vite.
const STRIP_ROOTS = ['src/', 'electron/', 'shared/'];
const PATH_ROOTS = 'dist|docs|electron|scripts|shared|src|test';
// A repository path written as text: a root folder at a word boundary, not
// inside a relative specifier (`../src/x` is a module specifier, not a path).
// A `#dist/` import and a `./src/` specifier in an esbuild stdin resolved from
// the repository root are repository paths with a prefix.
const PATH_TOKEN = new RegExp(`(?<![\\w./#$-])(#|\\./)?((?:${PATH_ROOTS})/[\\w./-]*)`, 'g');

export function isCodeFile(file: string): boolean {
  return SCRIPT_KINDS.has(path.posix.extname(file));
}

export function extensionPolicy(file: string): ExtensionPolicy {
  const extension = path.posix.extname(file);
  if (extension === '.ts' || extension === '.tsx') {
    return STRIP_ROOTS.some((root) => file.startsWith(root)) ? 'strip' : 'keep';
  }
  return 'keep';
}

export function planStep(tree: Tree, moves: ReadonlyMap<string, string>): StepPlan {
  assert(moves.size <= MOVE_LIMITS.movesPerStepMax, 'planStep: too many moves in one step');
  assert(tree.files.size <= MOVE_LIMITS.filesMax, 'planStep: tree exceeds the file limit');
  for (const [from, to] of moves) {
    assert(tree.files.has(from), `planStep: ${from} is not in the tree`);
    assert(!tree.files.has(to), `planStep: ${to} already exists`);
  }
  const directories = directoryIndex(tree.files);
  const writes = new Map<string, string>();
  const reports: string[] = [];
  for (const [file, text] of tree.texts) {
    let next = text;
    if (isCodeFile(file)) {
      const imports = rewriteImports(file, next, tree.files, moves);
      next = imports.text;
      reports.push(...imports.reports);
    }
    if (tree.pathData?.has(file) !== true) {
      const paths = rewritePathText({ file, text: next, files: tree.files, directories, moves });
      next = paths.text;
      reports.push(...paths.reports);
      reports.push(...renamedNameReports(file, next, moves));
    }
    if (next !== text) {
      writes.set(moves.get(file) ?? file, next);
    }
  }
  return { writes, reports };
}

// Every relative module specifier, with the offsets of its text between the
// quotes. The walk is iterative and bounded (AGENTS.md §10).
export function collectSpecifiers(file: string, text: string): readonly Specifier[] {
  const kind = SCRIPT_KINDS.get(path.posix.extname(file));
  assert(kind !== undefined, `collectSpecifiers: ${file} is not a code file`);
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind);
  const found: Specifier[] = [];
  const pending: ts.Node[] = [source];
  let visited = 0;
  while (pending.length > 0) {
    visited += 1;
    assert(visited <= MOVE_LIMITS.syntaxNodesPerFileMax, `collectSpecifiers: ${file} is too large`);
    const node = pending.pop();
    assert(node !== undefined, 'collectSpecifiers: the stack is not empty');
    const literal = specifierLiteral(node);
    if (literal !== undefined) {
      const start = literal.getStart(source) + 1;
      found.push({ start, end: literal.end - 1, value: literal.text });
    }
    ts.forEachChild(node, (child) => {
      pending.push(child);
    });
  }
  return found.sort((left, right) => left.start - right.start);
}

function specifierLiteral(node: ts.Node): ts.StringLiteralLike | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    const specifier = node.moduleSpecifier;
    return specifier !== undefined && ts.isStringLiteralLike(specifier) ? specifier : undefined;
  }
  if (ts.isCallExpression(node)) {
    return callSpecifier(node);
  }
  if (ts.isImportTypeNode(node)) {
    const argument = node.argument;
    if (ts.isLiteralTypeNode(argument) && ts.isStringLiteralLike(argument.literal)) {
      return argument.literal;
    }
    return undefined;
  }
  if (ts.isExternalModuleReference(node)) {
    return ts.isStringLiteralLike(node.expression) ? node.expression : undefined;
  }
  return undefined;
}

// import('…'), require('…') and require.resolve('…').
function callSpecifier(node: ts.CallExpression): ts.StringLiteralLike | undefined {
  const first = node.arguments[0];
  if (first === undefined || !ts.isStringLiteralLike(first)) {
    return undefined;
  }
  const callee = node.expression;
  if (callee.kind === ts.SyntaxKind.ImportKeyword) {
    return first;
  }
  if (ts.isIdentifier(callee)) {
    return callee.text === 'require' ? first : undefined;
  }
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    const isResolve = callee.expression.text === 'require' && callee.name.text === 'resolve';
    return isResolve ? first : undefined;
  }
  return undefined;
}

export function resolveSpecifier(files: ReadonlySet<string>, importer: string, specifier: string): Resolution | undefined {
  assert(specifier.startsWith('.'), 'resolveSpecifier: only relative specifiers resolve');
  const base = path.posix.join(path.posix.dirname(importer), specifier);
  return resolvePath(files, base);
}

// A repository path as written, without a leading `./`: the file itself, a
// stale `.js` name for its source, the name without an extension, or a folder
// with an index file.
export function resolvePath(files: ReadonlySet<string>, base: string): Resolution | undefined {
  if (files.has(base)) {
    return { target: base, form: { kind: 'exact' } };
  }
  const extension = path.posix.extname(base);
  for (const alias of ALIASES.get(extension) ?? []) {
    const candidate = base.slice(0, base.length - extension.length) + alias;
    if (files.has(candidate)) {
      return { target: candidate, form: { kind: 'alias', extension } };
    }
  }
  for (const appended of APPENDED) {
    if (files.has(base + appended)) {
      return { target: base + appended, form: { kind: 'bare' } };
    }
  }
  for (const index of INDEXES) {
    if (files.has(`${base}/${index}`)) {
      return { target: `${base}/${index}`, form: { kind: 'directory' } };
    }
  }
  return undefined;
}

export function formatSpecifier(importer: string, resolution: Resolution, policy: ExtensionPolicy): string {
  const relative = path.posix.relative(path.posix.dirname(importer), resolution.target);
  const written = writtenPath(relative, resolution.form, policy);
  return written.startsWith('.') ? written : `./${written}`;
}

function writtenPath(target: string, form: SpecifierForm, policy: ExtensionPolicy): string {
  switch (form.kind) {
    case 'directory':
      return path.posix.dirname(target);
    case 'bare':
      return stripExtension(target);
    case 'exact':
      return policy === 'strip' ? stripExtension(target) : target;
    case 'alias': {
      if (policy === 'strip') {
        return stripExtension(target);
      }
      return stripExtension(target) + form.extension;
    }
    default: {
      const exhaustive: never = form;
      return exhaustive;
    }
  }
}

export function stripExtension(file: string): string {
  const extension = STRIPPABLE.find((candidate) => file.endsWith(candidate));
  return extension === undefined ? file : file.slice(0, file.length - extension.length);
}

interface RewriteResult {
  readonly text: string;
  readonly reports: readonly string[];
}

export function rewriteImports(file: string, text: string, files: ReadonlySet<string>, moves: ReadonlyMap<string, string>): RewriteResult {
  const importer = moves.get(file) ?? file;
  const policy = extensionPolicy(importer);
  const edits: Edit[] = [];
  const reports: string[] = [];
  for (const specifier of collectSpecifiers(file, text)) {
    if (!specifier.value.startsWith('.')) {
      continue;
    }
    const resolution = resolveSpecifier(files, file, specifier.value);
    if (resolution === undefined) {
      // A test's `../dist/…` names build output, which is not in the tree.
      if (policy === 'strip') {
        reports.push(`${file}: '${specifier.value}' resolves to no file`);
      }
      continue;
    }
    const target = moves.get(resolution.target) ?? resolution.target;
    const moved = importer !== file || target !== resolution.target;
    if (!moved && !hasStrippableExtension(specifier.value, policy)) {
      continue;
    }
    const next = formatSpecifier(importer, { target, form: resolution.form }, policy);
    if (next !== specifier.value) {
      edits.push({ start: specifier.start, end: specifier.end, text: next });
    }
  }
  return { text: applyEdits(text, edits), reports };
}

function hasStrippableExtension(specifier: string, policy: ExtensionPolicy): boolean {
  if (policy === 'keep') {
    return false;
  }
  return stripExtension(specifier) !== specifier;
}

export function applyEdits(text: string, edits: readonly Edit[]): string {
  const ordered = [...edits].sort((left, right) => left.start - right.start);
  const pieces: string[] = [];
  let cursor = 0;
  for (const edit of ordered) {
    assert(edit.start >= cursor, 'applyEdits: edits overlap');
    assert(edit.end >= edit.start, 'applyEdits: an edit ends before it starts');
    pieces.push(text.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  pieces.push(text.slice(cursor));
  return pieces.join('');
}

// Every directory that holds a file, mapped to all the files beneath it.
export function directoryIndex(files: ReadonlySet<string>): ReadonlyMap<string, string[]> {
  const index = new Map<string, string[]>();
  for (const file of files) {
    let directory = path.posix.dirname(file);
    while (directory !== '.') {
      const list = index.get(directory) ?? [];
      list.push(file);
      index.set(directory, list);
      directory = path.posix.dirname(directory);
    }
  }
  return index;
}

interface PathTextInput {
  readonly file: string;
  readonly text: string;
  readonly files: ReadonlySet<string>;
  readonly directories: ReadonlyMap<string, readonly string[]>;
  readonly moves: ReadonlyMap<string, string>;
}

export function rewritePathText(input: PathTextInput): RewriteResult {
  const edits: Edit[] = [];
  const reports: string[] = [];
  for (const match of input.text.matchAll(PATH_TOKEN)) {
    const written = match[2];
    assert(written !== undefined, 'rewritePathText: a match has its path group');
    const token = written.replace(/\.+$/, '');
    const start = match.index + (match[1] ?? '').length;
    const mapped = mapPathToken(token, input);
    if (mapped.kind === 'mapped') {
      edits.push({ start, end: start + token.length, text: mapped.text });
    } else if (mapped.kind === 'report') {
      reports.push(`${input.file}:${lineOf(input.text, start)}: ${mapped.message}`);
    }
  }
  reports.push(...regexReports(input));
  return { text: applyEdits(input.text, edits), reports };
}

type TokenMapping = { readonly kind: 'same' } | { readonly kind: 'mapped'; readonly text: string } | { readonly kind: 'report'; readonly message: string };

function mapPathToken(token: string, input: PathTextInput): TokenMapping {
  if (token.startsWith('dist/')) {
    return mapDistToken(token, input);
  }
  const trimmed = token.endsWith('/') ? token.slice(0, -1) : token;
  const directory = input.directories.get(trimmed);
  // A root (`test/`) names the whole tree, which no step moves.
  if (directory !== undefined && trimmed.includes('/')) {
    const target = movedDirectory(trimmed, directory, input.moves);
    if (target.kind !== 'mapped') {
      return target;
    }
    return { kind: 'mapped', text: token.endsWith('/') ? `${target.text}/` : target.text };
  }
  if (directory !== undefined) {
    return SAME;
  }
  const resolution = resolvePath(input.files, trimmed);
  if (resolution === undefined) {
    return { kind: 'same' };
  }
  const target = input.moves.get(resolution.target);
  if (target === undefined) {
    return SAME;
  }
  switch (resolution.form.kind) {
    case 'bare':
      return { kind: 'mapped', text: stripExtension(target) };
    case 'directory':
      return { kind: 'mapped', text: path.posix.dirname(target) };
    case 'exact':
      return { kind: 'mapped', text: target };
    case 'alias':
      // A `.js` name for a TypeScript file can mean the build output
      // (dist-relative or in a script); keep the extension it was written with.
      return { kind: 'mapped', text: stripExtension(target) + resolution.form.extension };
    default: {
      const exhaustive: never = resolution.form;
      return exhaustive;
    }
  }
}

const SAME: TokenMapping = { kind: 'same' };

// A folder maps to a folder only when every file in it moves and they land
// together, each at the same depth below one new folder (names may change).
function movedDirectory(directory: string, files: readonly string[], moves: ReadonlyMap<string, string>): TokenMapping {
  const moved = files.filter((file) => moves.has(file));
  if (moved.length === 0) {
    return SAME;
  }
  const targets = new Set<string>();
  for (const file of files) {
    const target = moves.get(file);
    if (target === undefined) {
      return { kind: 'report', message: `${directory}/ moves only in part` };
    }
    const depth = file.slice(directory.length + 1).split('/').length;
    let parent = target;
    for (let level = 0; level < depth; level += 1) {
      parent = path.posix.dirname(parent);
    }
    targets.add(parent);
  }
  if (targets.size !== 1) {
    return { kind: 'report', message: `${directory}/ splits across ${[...targets].join(', ')}` };
  }
  const [target] = targets;
  assert(target !== undefined, 'movedDirectory: one target folder');
  return { kind: 'mapped', text: target };
}

// Build output mirrors its source: dist/electron/x.js is electron/x.ts, and a
// copied runtime asset (dist/electron/content/x.mjs) is the asset itself.
function mapDistToken(token: string, input: PathTextInput): TokenMapping {
  const match = /^dist\/((?:electron|shared|scripts)\/[\w./-]+?)(\.js|\.mjs|\.d\.ts)?$/.exec(token);
  if (match === null) {
    return SAME;
  }
  const stem = match[1];
  assert(stem !== undefined, 'mapDistToken: a match has its stem');
  const emitted = match[2] ?? '';
  const candidates = [`${stem}.ts`, `${stem}.mts`, `${stem}.mjs`, `${stem}.tsx`];
  const source = candidates.find((candidate) => input.files.has(candidate));
  if (source === undefined) {
    return SAME;
  }
  const target = input.moves.get(source);
  if (target === undefined) {
    return SAME;
  }
  const targetStem = target.replace(/\.(?:ts|mts|mjs|tsx)$/, '');
  return { kind: 'mapped', text: `dist/${targetStem}${emitted}` };
}

// A regular expression over a moved file's folder (`/\/src\/panels\//`) is
// matched against paths at run time; no rewrite can know what it meant.
function regexReports(input: PathTextInput): readonly string[] {
  if (!isCodeFile(input.file)) {
    return [];
  }
  const folders = new Set<string>();
  for (const from of input.moves.keys()) {
    const folder = path.posix.dirname(from);
    // A root alone (`src`) is every path's prefix, not a folder that moves.
    if (folder.includes('/')) {
      folders.add(folder.replaceAll('/', '\\/'));
    }
  }
  const reports: string[] = [];
  for (const folder of folders) {
    const at = input.text.indexOf(folder);
    if (at >= 0) {
      const line = lineOf(input.text, at);
      reports.push(`${input.file}:${line}: a regular expression names moved folder ${folder}`);
    }
  }
  return reports;
}

// A renamed file named without its folder (`see tool-prefs.ts`) is a reader's
// pointer this tool cannot place; report it for a hand edit.
function renamedNameReports(file: string, text: string, moves: ReadonlyMap<string, string>): readonly string[] {
  const reports: string[] = [];
  for (const [from, to] of moves) {
    const name = path.posix.basename(from);
    if (name === path.posix.basename(to)) {
      continue;
    }
    const pattern = new RegExp(`(?<![\\w./-])${escapeRegExp(name)}(?![\\w-])`);
    const found = pattern.exec(text);
    if (found !== null) {
      reports.push(`${file}:${lineOf(text, found.index)}: names renamed file ${name}`);
    }
  }
  return reports;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}
