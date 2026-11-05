// The pure checks behind `npm run check:linux` (linuxPreflight.ts). Each takes
// values the caller read from git or disk and returns findings; none touches
// the filesystem, so the suite can feed them hostile inputs directly.
//
// Why these checks: the Linux release job fails on things a macOS working copy
// hides. The filesystem there is case-insensitive, so an import that differs
// from the file only in case works locally and fails in CI. Git hooks and
// shebang lines run under a different `env`. And the Electron probes run in a
// hidden window on a slower runner whose animation frames arrive late, so a
// probe that measures after a fixed sleep can catch a popup still opening.
import assert = require('node:assert/strict');
import path = require('node:path');

export const PREFLIGHT_LIMITS = {
  /** Tracked files in the repository. About 2,700 today. */
  trackedFilesMax: 50_000,
  /** Bytes of one source file the scans read; larger files are generated. */
  sourceBytesMax: 4 * 1024 * 1024,
  /** Relative specifiers in one file. */
  specifiersPerFileMax: 2_000,
  /** Interactions in one probe that the settle scan examines. */
  interactionsPerFileMax: 500,
  /** Bytes of a file's head read for its shebang. */
  shebangBytesMax: 256,
} as const satisfies Record<string, number>;

export interface Finding {
  readonly file: string;
  /** 1-based; 0 when the finding is about the whole file. */
  readonly line: number;
  readonly message: string;
}

// ── Case-exact resolution ───────────────────────────────────────────────────

/** The tracked files as Linux sees them: exact paths, and the same folded to
 * lower case, which is what a case-insensitive macOS volume matches. */
export interface TrackedTree {
  readonly exact: ReadonlySet<string>;
  readonly folded: ReadonlyMap<string, readonly string[]>;
}

export function trackedTree(files: readonly string[]): TrackedTree {
  assert.ok(files.length <= PREFLIGHT_LIMITS.trackedFilesMax, 'trackedTree: tracked file count exceeds limit');
  const exact = new Set<string>();
  const folded = new Map<string, string[]>();
  const add = (entry: string): void => {
    if (exact.has(entry)) {
      return;
    }
    exact.add(entry);
    const key = entry.toLowerCase();
    const entries = folded.get(key);
    if (entries === undefined) {
      folded.set(key, [entry]);
    } else {
      entries.push(entry);
    }
  };
  for (const file of files) {
    assert.ok(file.length > 0, 'trackedTree: a tracked path is empty');
    assert.ok(!file.startsWith('/'), `trackedTree: ${file} is not repository-relative`);
    // Directories count too: a specifier may name a folder with an index.
    const parts = file.split('/');
    for (let depth = 1; depth <= parts.length; depth += 1) {
      add(parts.slice(0, depth).join('/'));
    }
  }
  assert.ok(exact.size >= files.length, 'trackedTree: every tracked file is in the tree');
  return { exact, folded };
}

/** Tracked paths that differ only in case. A macOS checkout holds one of them. */
export function caseCollisions(tree: TrackedTree): readonly Finding[] {
  const findings: Finding[] = [];
  for (const entries of tree.folded.values()) {
    if (entries.length > 1) {
      const message = `${entries.join(' and ')} differ only in case; a macOS checkout keeps one of them. Rename one with \`git mv\`.`;
      findings.push({ file: entries[0] ?? '', line: 0, message });
    }
  }
  return findings;
}

export interface Specifier {
  readonly specifier: string;
  readonly line: number;
}

// `from '…'`, `import '…'`, `import('…')`, `require('…')`, `@import '…'` and
// `@import url('…')`, for specifiers that start with ./ or ../ only: bare
// package names resolve inside node_modules, which npm writes per platform.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|@import\s+(?:url\(\s*)?)(['"])(\.{1,2}\/[^'"\n]*)\1/g;

export function relativeSpecifiers(text: string): readonly Specifier[] {
  assert.ok(text.length <= PREFLIGHT_LIMITS.sourceBytesMax, 'relativeSpecifiers: source exceeds limit');
  const found: Specifier[] = [];
  for (const match of text.matchAll(SPECIFIER)) {
    const specifier = match[2];
    assert.ok(specifier !== undefined, 'relativeSpecifiers: the pattern captures the specifier');
    assert.ok(found.length < PREFLIGHT_LIMITS.specifiersPerFileMax, 'relativeSpecifiers: specifier count exceeds limit');
    found.push({ specifier, line: lineAt(text, match.index) });
  }
  return found;
}

export type Resolution = { readonly kind: 'exact' } | { readonly kind: 'case'; readonly actual: string } | { readonly kind: 'missing' };

// What TypeScript, Node and Vite append to an extensionless specifier; none adds .css.
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'] as const;
// TypeScript's ESM style names the emitted file: `./a.js` is `./a.ts` on disk.
const EMITTED: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

/** How `specifier`, written in `importer`, resolves among the tracked files. */
export function resolveSpecifier(tree: TrackedTree, importer: string, specifier: string): Resolution {
  assert.ok(specifier.startsWith('./') || specifier.startsWith('../'), `resolveSpecifier: ${specifier} is not relative`);
  // Vite's suffixes (`?raw`, `?inline`) and fragments are not part of the path.
  const bare = specifier.replace(/[?#].*$/, '');
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), bare));
  if (base.startsWith('../') || base === '..') {
    return { kind: 'missing' };
  }
  const candidates = candidatePaths(base);
  if (candidates.some((candidate) => tree.exact.has(candidate))) {
    return { kind: 'exact' };
  }
  for (const candidate of candidates) {
    const actual = tree.folded.get(candidate.toLowerCase());
    if (actual !== undefined && actual[0] !== undefined) {
      return { kind: 'case', actual: actual[0] };
    }
  }
  return { kind: 'missing' };
}

function candidatePaths(base: string): readonly string[] {
  const candidates = [base];
  for (const extension of EXTENSIONS) {
    candidates.push(`${base}${extension}`, `${base}/index${extension}`);
  }
  const extension = path.posix.extname(base);
  for (const emitted of EMITTED[extension] ?? []) {
    candidates.push(`${base.slice(0, -extension.length)}${emitted}`);
  }
  return candidates;
}

/** Specifiers that resolve on macOS only because its filesystem ignores case.
 * A specifier that resolves to nothing tracked is not reported: probes build
 * code in template strings, and generated files are not tracked. */
export function caseMismatches(tree: TrackedTree, file: string, text: string): readonly Finding[] {
  const findings: Finding[] = [];
  for (const { specifier, line } of relativeSpecifiers(text)) {
    const resolution = resolveSpecifier(tree, file, specifier);
    if (resolution.kind === 'case') {
      const message = `'${specifier}' matches ${resolution.actual} only ignoring case; Linux cannot find it. Write the path as the file is named.`;
      findings.push({ file, line, message });
    }
  }
  return findings;
}

// Paths in configuration text: package.json scripts and build settings, and
// workflow steps. Globs, URLs and build output are skipped: CI creates dist/
// and release/, and node_modules belongs to npm.
const CONFIG_PATH = /(?<![\w./:$-])(?:\.\/)?((?:[\w@.-]+\/)+[\w@.-]+)/g;
const GENERATED_ROOTS = ['dist/', 'release/', 'node_modules/', 'squashfs-root/'] as const;

export function configPathMismatches(tree: TrackedTree, file: string, text: string): readonly Finding[] {
  assert.ok(text.length <= PREFLIGHT_LIMITS.sourceBytesMax, 'configPathMismatches: config exceeds limit');
  const findings: Finding[] = [];
  for (const match of text.matchAll(CONFIG_PATH)) {
    const reference = match[1];
    assert.ok(reference !== undefined, 'configPathMismatches: the pattern captures the path');
    if (GENERATED_ROOTS.some((root) => reference.startsWith(root))) {
      continue;
    }
    if (tree.exact.has(reference)) {
      continue;
    }
    const actual = tree.folded.get(reference.toLowerCase());
    if (actual !== undefined) {
      const message = `'${reference}' names ${actual.join(', ')} only ignoring case; the Linux build cannot find it.`;
      findings.push({ file, line: lineAt(text, match.index), message });
    }
  }
  return findings;
}

// ── Executable bits and shebangs ────────────────────────────────────────────

export interface TrackedEntry {
  readonly file: string;
  /** Git's mode: 100644 for a plain file, 100755 for an executable one. */
  readonly mode: string;
  /** The file's first bytes, read as latin1 (at most shebangBytesMax). */
  readonly head: string;
}

// Interpreters a Linux runner has at these paths. Paths under Homebrew or
// the local prefix are macOS habits.
const PORTABLE_INTERPRETERS = new Set(['/bin/sh', '/bin/bash', '/usr/bin/env']);
const ELF_MAGIC = '\x7fELF';

/** Shebang and mode problems. `executed` lists the files something runs
 * directly (git hooks, `./path` steps), which need the executable bit. */
export function shebangFindings(entries: readonly TrackedEntry[], executed: ReadonlySet<string>): readonly Finding[] {
  const findings: Finding[] = [];
  for (const entry of entries) {
    assert.ok(entry.head.length <= PREFLIGHT_LIMITS.shebangBytesMax, `shebangFindings: ${entry.file} head exceeds limit`);
    const executable = entry.mode === '100755';
    const shebang = entry.head.startsWith('#!');
    if (executed.has(entry.file)) {
      if (!executable) {
        const message = `runs directly but is not executable in git (mode ${entry.mode}); Linux refuses it. Run \`git update-index --chmod=+x ${entry.file}\`.`;
        findings.push({ file: entry.file, line: 1, message });
      }
    }
    if (shebang) {
      findings.push(...interpreterFindings(entry.file, entry.head));
    } else if (executable) {
      if (!entry.head.startsWith(ELF_MAGIC)) {
        const message = `is executable but has no #! line; Linux runs it with the wrong interpreter. Add a shebang or \`git update-index --chmod=-x ${entry.file}\`.`;
        findings.push({ file: entry.file, line: 1, message });
      }
    }
  }
  return findings;
}

function interpreterFindings(file: string, head: string): readonly Finding[] {
  const newline = head.indexOf('\n');
  // A head with no newline is a one-line file or a line longer than the head.
  const line = newline === -1 ? head : head.slice(0, newline);
  if (line.endsWith('\r')) {
    return [{ file, line: 1, message: 'the #! line ends in CRLF; Linux looks for an interpreter named "node\\r". Save it with LF endings.' }];
  }
  const words = line.slice(2).trim().split(/\s+/);
  const interpreter = words[0] ?? '';
  if (!PORTABLE_INTERPRETERS.has(interpreter)) {
    return [{ file, line: 1, message: `#!${interpreter} does not exist on Linux runners; use #!/usr/bin/env <program>.` }];
  }
  if (interpreter === '/usr/bin/env') {
    if (words.length > 2) {
      if (words[1] !== '-S') {
        const message = `#!${line.slice(2).trim()}: Linux passes "${words.slice(1).join(' ')}" to env as one program name. Use #!/usr/bin/env -S ….`;
        return [{ file, line: 1, message }];
      }
    }
  }
  return [];
}

/** `./path` commands in workflow steps that name tracked files. */
export function directlyExecutedPaths(tree: TrackedTree, workflowText: string): readonly string[] {
  const found = new Set<string>();
  for (const match of workflowText.matchAll(/(?<![\w./-])\.\/((?:[\w.-]+\/)*[\w.-]+)/g)) {
    const reference = match[1];
    if (reference !== undefined && tree.exact.has(reference)) {
      found.add(reference);
    }
  }
  return [...found].sort();
}

// ── Probes that measure before the motion settles ───────────────────────────

// What opens or changes UI in a probe, what reads its layout, what waits a
// fixed time, and what waits for the motion itself.
const INTERACTION = /\.click\(\)|sendInputEvent\(|dispatchEvent\(/g;
const LAYOUT_READ = /getBoundingClientRect|getComputedStyle|offset(?:Width|Height|Left|Top)\b|client(?:Width|Height)\b/;
const FIXED_SLEEP = /setTimeout\(\s*\w+\s*,\s*\d+\s*\)|\bsleep\(\s*\d+\s*\)|\bdelay\(\s*\d+\s*\)/;
const SETTLE = /getAnimations|\.finished\b|transitionend|animationend|popup-phase|\bwaitFor\w*\(|\buntil\w*\(|\bsettle\w*\(/;

/** Interactions followed by a layout read after a fixed sleep, with nothing
 * that waits for the transition between them and the next interaction. On a
 * hidden window on the Linux runner, animation frames arrive late, so a popup
 * can still be in its opening phase when the sleep ends. */
export function unsettledMeasurements(file: string, text: string): readonly Finding[] {
  assert.ok(text.length <= PREFLIGHT_LIMITS.sourceBytesMax, 'unsettledMeasurements: source exceeds limit');
  const code = withoutCommentLines(text);
  assert.equal(code.length, text.length, 'unsettledMeasurements: blanking comments keeps every offset');
  const starts = [...code.matchAll(INTERACTION)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
  assert.ok(starts.length <= PREFLIGHT_LIMITS.interactionsPerFileMax, `unsettledMeasurements: ${file} has too many interactions`);
  const findings: Finding[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const current = starts[index];
    assert.ok(current !== undefined, 'unsettledMeasurements: the index is inside the list');
    const segment = code.slice(current.end, starts[index + 1]?.start ?? code.length);
    if (LAYOUT_READ.test(segment)) {
      if (FIXED_SLEEP.test(segment)) {
        if (!SETTLE.test(segment)) {
          const message =
            'measures layout after a fixed sleep without waiting for the motion to finish; a slow Linux runner can still be opening it. ' +
            "Wait for the popup to leave data-popup-phase='opening' and for element.getAnimations() to finish, within a bound.";
          findings.push({ file, line: lineAt(text, current.start), message });
        }
      }
    }
  }
  return findings;
}

/** Comment lines replaced by spaces of the same length, so prose about a
 * settle ("until it reports :hover") does not count as one. */
function withoutCommentLines(text: string): string {
  return text.replace(/^([ \t]*)(\/\/|\*|\/\*)[^\n]*/gm, (line) => ' '.repeat(line.length));
}

// ── Files only a working copy has ───────────────────────────────────────────

/** Tracked text that names a git-ignored file. A clean CI checkout lacks it,
 * which is how propModelParity failed 1.0.4 on every platform. */
export function ignoredReferences(ignored: readonly string[], file: string, text: string): readonly Finding[] {
  assert.ok(text.length <= PREFLIGHT_LIMITS.sourceBytesMax, 'ignoredReferences: source exceeds limit');
  const findings: Finding[] = [];
  for (const target of ignored) {
    assert.ok(target.startsWith('test/'), `ignoredReferences: ${target} is outside test/`);
    // Suites name fixtures from the repository root or from test/.
    const index = Math.max(text.indexOf(target), text.indexOf(target.slice('test/'.length)));
    if (index !== -1) {
      const message = `names ${target}, which .gitignore excludes; a clean CI checkout does not have it. Commit it or stop reading it.`;
      findings.push({ file, line: lineAt(text, index), message });
    }
  }
  return findings;
}

// ── electron-builder's Linux settings ───────────────────────────────────────

// The freedesktop main categories; a .desktop file needs one of them.
const DESKTOP_CATEGORIES = new Set([
  'AudioVideo',
  'Audio',
  'Video',
  'Development',
  'Education',
  'Game',
  'Graphics',
  'Network',
  'Office',
  'Science',
  'Settings',
  'System',
  'Utility',
]);
// The targets the release workflow installs and smoke-tests.
const LINUX_TARGETS_REQUIRED = ['AppImage', 'deb'] as const;
const ICON_SIDE_PX_MIN = 256;
const PNG_SIGNATURE = '89504e470d0a1a0a';

/** Problems in package.json `build.linux`. `iconHeader` is the icon's first
 * 24 bytes, or undefined when the icon is not tracked. */
export function linuxBuildFindings(build: unknown, tree: TrackedTree, iconHeader: Buffer | undefined): readonly Finding[] {
  const file = 'package.json';
  const linux = record(record(build)?.['linux']);
  if (linux === undefined) {
    return [{ file, line: 0, message: 'build.linux is missing; electron-builder --linux has nothing to package.' }];
  }
  const findings: Finding[] = [];
  const add = (message: string): void => {
    findings.push({ file, line: 0, message: `build.linux: ${message}` });
  };
  const category = linux['category'];
  if (typeof category !== 'string' || !DESKTOP_CATEGORIES.has(category)) {
    add(`category ${JSON.stringify(category)} is not a freedesktop main category; the .desktop file is rejected by menus.`);
  }
  const executableName = linux['executableName'];
  if (typeof executableName !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(executableName)) {
    add(`executableName ${JSON.stringify(executableName)} must be lower case without spaces; the deb links it into /usr/bin.`);
  }
  const executableArguments = linux['executableArgs'];
  if (Array.isArray(executableArguments) && executableArguments.includes('--no-sandbox')) {
    add('executableArgs disables the Chromium sandbox; the AppImage step fails on --no-sandbox in its .desktop file.');
  }
  const targets = Array.isArray(linux['target']) ? linux['target'].map((target: unknown) => record(target)?.['target']) : [];
  for (const required of LINUX_TARGETS_REQUIRED) {
    if (!targets.includes(required)) {
      add(`target lacks ${required}; the release workflow installs and smoke-tests it.`);
    }
  }
  findings.push(...iconFindings(linux['icon'], tree, iconHeader).map((message) => ({ file, line: 0, message: `build.linux: ${message}` })));
  return findings;
}

function iconFindings(icon: unknown, tree: TrackedTree, header: Buffer | undefined): readonly string[] {
  if (typeof icon !== 'string') {
    return ['icon is not set; the deb and AppImage ship without one.'];
  }
  if (!tree.exact.has(icon)) {
    const actual = tree.folded.get(icon.toLowerCase());
    return [actual === undefined ? `icon ${icon} is not tracked; CI will not have it.` : `icon ${icon} matches ${actual.join(', ')} only ignoring case.`];
  }
  if (header === undefined || header.length < 24 || header.subarray(0, 8).toString('hex') !== PNG_SIGNATURE) {
    return [`icon ${icon} is not a PNG; electron-builder needs one for Linux.`];
  }
  const widthPx = header.readUInt32BE(16);
  const heightPx = header.readUInt32BE(20);
  if (widthPx < ICON_SIDE_PX_MIN || heightPx < ICON_SIDE_PX_MIN) {
    return [`icon ${icon} is ${widthPx}×${heightPx}; Linux needs at least ${ICON_SIDE_PX_MIN}×${ICON_SIDE_PX_MIN}.`];
  }
  return [];
}

// ── Shared ──────────────────────────────────────────────────────────────────

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(value));
}

/** The 1-based line of a character offset. */
export function lineAt(text: string, offset: number): number {
  assert.ok(offset >= 0, 'lineAt: an offset is not negative');
  assert.ok(offset <= text.length, 'lineAt: the offset is inside the text');
  let line = 1;
  for (let index = text.indexOf('\n'); index !== -1 && index < offset; index = text.indexOf('\n', index + 1)) {
    line += 1;
  }
  return line;
}
