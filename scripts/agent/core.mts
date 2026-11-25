// The policy every agent harness enforces, as pure functions of the tool call
// the agent is about to make. Harness adapters (hook.mts for Claude Code and
// Codex, .pi/extensions/stacki-policy for Pi) only translate their protocol to
// these calls and back, so the three agents are held to one rule set.
//
// Two decisions are made before a tool runs:
// - commandVerdict: a shell command that would switch a gate off.
// - pathVerdict: an edit to the files that define the gates themselves.
// Checks after an edit, and before the agent stops, live in policy/checks.mts.

import path from 'node:path';
import { assert } from '../policy/assert.mts';
import { normalizePath } from '../policy/scan.mts';

export type Verdict =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string }
  // A human decides: the harness asks where it can, and refuses where it
  // cannot, telling the agent to ask its human.
  | { readonly kind: 'ask'; readonly reason: string };

const ALLOW: Verdict = { kind: 'allow' };
const COMMAND_CHARS_MAX = 200_000;
const SEGMENTS_MAX = 1_000;
const TOKENS_MAX = 20_000;

// The files that define the gates. Weakening one weakens every gate at once,
// so an agent changes them only with a human's say-so (docs/enforcement.md).
const POLICY_PATTERNS: readonly RegExp[] = [
  /^AGENTS\.md$/,
  /^CLAUDE\.md$/,
  /^eslint\.config\.mjs$/,
  /^\.prettierrc\.json$/,
  /^\.prettierignore$/,
  /(?:^|\/)tsconfig[^/]*\.json$/,
  /^scripts\/(?:eslintPlugin|policy|agent)\//,
  /^\.githooks\//,
  /^\.claude\/settings\.json$/,
  /^\.codex\//,
  /^\.pi\//,
  /^\.github\/workflows\//,
  // In any folder of shared/, so the protection follows the file when it moves.
  /^shared\/(?:[^/]+\/)?limits\.ts$/,
  /^docs\/enforcement\.md$/,
];

const POLICY_EDIT_REASON =
  'This file defines the repository gates (docs/enforcement.md). Changing it changes ' +
  'what every agent and every commit is held to, so a human approves it first.';

export function pathVerdict(file: string): Verdict {
  assert(!file.includes('\\'), 'pathVerdict: paths use forward slashes');
  assert(!file.startsWith('/'), 'pathVerdict: paths are repository-relative');
  if (file.startsWith('.git/')) {
    return { kind: 'deny', reason: 'The .git directory is git’s own state; use git commands.' };
  }
  if (POLICY_PATTERNS.some((pattern) => pattern.test(file))) {
    return { kind: 'ask', reason: `${file}: ${POLICY_EDIT_REASON}` };
  }
  return ALLOW;
}

// Git subcommands that run hooks, and so accept --no-verify.
const HOOKED_SUBCOMMANDS = new Set(['am', 'commit', 'merge', 'push', 'rebase', 'revert']);
const HOOK_SETTINGS = /^core\.hookspath\b/i;
const BYPASS_REASON =
  'This would skip the repository hooks, which hold the same checks as CI. Fix the ' +
  'finding instead; if a hook itself is wrong, ask your human to change it.';

export function commandVerdict(command: string, root: string): Verdict {
  assert(command.length <= COMMAND_CHARS_MAX, 'commandVerdict: command exceeds the size limit');
  assert(path.isAbsolute(root), 'commandVerdict: the root is absolute');
  if (/\.git\/hooks\b/.test(command)) {
    return { kind: 'deny', reason: `Writing git's own hook directory. ${BYPASS_REASON}` };
  }
  for (const segment of commandSegments(command)) {
    const verdict = gitSegmentVerdict(tokenize(segment));
    if (verdict.kind !== 'allow') {
      return verdict;
    }
  }
  return shellWriteVerdict(withRootAsDot(command, root), root);
}

// A checkout path is data, not shell syntax: `/Users/Lilian's Home/stacki` has an
// apostrophe that opens a quote nothing closes and a space that splits the path,
// so the words after it no longer read as paths inside the repository and a gate
// file write looked harmless (issue #78). Every spelling a shell accepts for the
// root is rewritten to `.` before the command is split, so `tee <root>/.claude/…`
// is read as `tee ./.claude/…` however the root was quoted or escaped.
const ROOT_SPELLINGS_MAX = 8;

function withRootAsDot(command: string, root: string): string {
  const forward = root.split(path.sep).join('/');
  assert(forward.length > 1, 'withRootAsDot: the root is not the filesystem root');
  const spellings = new Set<string>([root, forward]);
  for (const text of [root, forward]) {
    spellings.add(text.replace(/[^\w/.:@%+=,-]/g, (character) => `\\${character}`)); // Backslash-escaped, unquoted.
    spellings.add(text.replace(/'/g, "'\\''")); // Inside single quotes.
    spellings.add(text.replace(/["\\$`]/g, (character) => `\\${character}`)); // Inside double quotes.
  }
  assert(spellings.size <= ROOT_SPELLINGS_MAX, 'withRootAsDot: spelling limit exceeded');
  let result = command;
  // Longest first: a short spelling must not eat the front of a longer one.
  for (const spelling of [...spellings].sort((first, second) => second.length - first.length)) {
    let from = 0;
    for (let guard = 0; guard < COMMAND_CHARS_MAX; guard += 1) {
      const index = result.indexOf(spelling, from);
      if (index < 0) {
        break;
      }
      const end = index + spelling.length;
      // Only a whole path: `<root>-other/x` is a different directory.
      if (end === result.length || /[/\s'"`;&|)<>]/.test(result.charAt(end))) {
        result = `${result.slice(0, index)}.${result.slice(end)}`;
        from = index + 1;
      } else {
        from = end;
      }
    }
  }
  // `'<root>'/.claude/x` closed its quote before the slash: `'.'/.claude/x` is `./.claude/x`.
  return result.replace(/(["'])\.\1\//g, './');
}

// A shell command can write a file as surely as an edit tool can. When one
// command both names a gate file and contains a way to write — a redirect, an
// in-place editor, a file-moving command, or an interpreter running a script
// — a human decides, as for an edit. Reading a gate file is always fine, also
// in a command line that writes elsewhere: `sed -i … a.ts && tsc -p
// tsconfig.json` edits a.ts and only reads the config. The check is a
// heuristic by nature (a shell is Turing-complete); CI remains the gate that
// cannot be talked around.
const SHELL_WRITE = new RegExp(
  [
    '(?:^|[^>&0-9])>>?(?![&>])',
    '\\btee\\b',
    '\\b(?:sed|perl)\\b[^|;&\\n]*\\s-i',
    '\\b(?:mv|cp|rm|ln|install|truncate|touch|chmod)(?:\\s|$)',
    '\\b(?:python3?|ruby|deno|bun)\\b',
    '\\bnode\\s+(?:-e|--eval|-p|--print)\\b',
    '\\bgit\\s+(?:checkout|restore|apply|am)\\b',
  ].join('|'),
);
// Globs count: `rm tsconfig*.json` names every config at once.
const PATH_LIKE = /[\w@.:~\\/*?-]+/g;

const CHANGE_DIRECTORY = /^(?:cd|pushd)\s+(['"]?)([^'"\s]+)\1$/;
// A `cd` inside one command: `(cd scripts && rm agent/core.mts)`.
const INNER_CHANGE_DIRECTORY = /\b(?:cd|pushd)\s+(['"]?)([^'"\s;&|()]+)\1/g;

function shellWriteVerdict(command: string, root: string): Verdict {
  const prefix = `${root.split(path.sep).join('/')}/`;
  // `cd scripts/agent && sed -i … core.mts` names core.mts relative to the
  // directory an earlier command moved to, so later paths are read from it too.
  let directory = '';
  for (const unit of writeUnits(command)) {
    const change = CHANGE_DIRECTORY.exec(unit);
    if (change !== null) {
      directory = changedDirectory(directory, change[2] ?? '', prefix);
      continue;
    }
    if (!SHELL_WRITE.test(unit)) {
      continue;
    }
    const inner = [...unit.matchAll(INNER_CHANGE_DIRECTORY)].map((match) => changedDirectory(directory, match[2] ?? '', prefix));
    const file = gateFileNamed(unit, prefix, [directory, ...inner]);
    if (file !== undefined) {
      return { kind: 'ask', reason: `This command may write ${file}. ${POLICY_EDIT_REASON}` };
    }
  }
  return ALLOW;
}

// The repository-relative directory after `cd target`. A directory outside
// the repository reads as the root, so paths there are still checked as written.
function changedDirectory(directory: string, target: string, prefix: string): string {
  assert(!directory.startsWith('/'), 'changedDirectory: the directory is repository-relative');
  const relative = repositoryRelative(target, prefix);
  if (relative.startsWith('/')) {
    return '';
  }
  const changed = path.posix.normalize(path.posix.join(directory, relative));
  assert(!changed.startsWith('/'), 'changedDirectory: the result is repository-relative');
  return changed;
}

// The first gate file a command names, read both as written and from each
// directory the command line moved to.
function gateFileNamed(unit: string, prefix: string, directories: readonly string[]): string | undefined {
  assert(prefix.endsWith('/'), 'gateFileNamed: the root prefix ends with a slash');
  assert(directories.length > 0, 'gateFileNamed: the current directory is included');
  for (const match of unit.matchAll(PATH_LIKE)) {
    const file = repositoryRelative(match[0], prefix);
    const moved = directories.map((directory) => path.posix.normalize(path.posix.join(directory, file)));
    for (const candidate of [file, ...moved]) {
      if (POLICY_PATTERNS.some((pattern) => pattern.test(candidate))) {
        return candidate;
      }
    }
  }
  return undefined;
}

function repositoryRelative(word: string, prefix: string): string {
  const candidate = word.split('\\').join('/').replace(/^\.\//, '');
  return candidate.startsWith(prefix) ? candidate.slice(prefix.length) : candidate;
}

// Splits a command line into the commands a write could apply to: at `;`,
// `&&`, `||` and newlines outside quotes, parentheses, and backticks. A
// pipeline stays whole, since `ls tsconfig*.json | xargs rm` removes what its
// first stage names; so does a subshell or a substitution, for the same
// reason. A heredoc body stays with the command that reads it and is not
// parsed, since a script's apostrophes are not shell quotes.
export function writeUnits(command: string): readonly string[] {
  assert(command.length <= COMMAND_CHARS_MAX, 'writeUnits: command exceeds the size limit');
  const units: string[] = [];
  let start = 0;
  let depth = 0;
  let backtick = 0; // 1 inside a `…` substitution, which does not nest.
  let delimiters: string[] = [];
  for (let index = 0; index < command.length; index += 1) {
    const character = command.charAt(index);
    if (character === '"' || character === "'") {
      index = quoteEnd(command, index);
    } else if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth = Math.max(0, depth - 1);
    } else if (character === '`') {
      backtick = 1 - backtick;
    } else if (command.startsWith('<<', index)) {
      const heredoc = heredocStart(command, index);
      if (heredoc !== undefined) {
        delimiters.push(heredoc.delimiter);
        index = heredoc.end - 1;
      }
    } else if (character === '\n' && delimiters.length > 0) {
      index = heredocBodyEnd(command, index + 1, delimiters) - 1;
      delimiters = [];
    } else if (depth + backtick === 0) {
      const length = separatorLength(command, index);
      if (length > 0) {
        units.push(command.slice(start, index));
        assert(units.length <= SEGMENTS_MAX, 'writeUnits: unit limit exceeded');
        index += length - 1;
        start = index + 1;
      }
    }
  }
  units.push(command.slice(start));
  return units.map((unit) => unit.trim()).filter((unit) => unit.length > 0);
}

function separatorLength(command: string, index: number): number {
  const character = command.charAt(index);
  if (character === ';' || character === '\n') {
    return 1;
  }
  if (command.startsWith('&&', index) || command.startsWith('||', index)) {
    return 2;
  }
  return 0;
}

// The index of the quote that closes the one at `index`, or the last index
// when it never closes.
function quoteEnd(command: string, index: number): number {
  const quote = command.charAt(index);
  assert(quote === '"' || quote === "'", 'quoteEnd: starts at a quote');
  for (let position = index + 1; position < command.length; position += 1) {
    const character = command.charAt(position);
    if (character === quote) {
      return position;
    }
    if (character === '\\' && quote === '"') {
      position += 1;
    }
  }
  return command.length - 1;
}

// `<<EOF`, `<<-EOF`, `<< 'EOF'`, `<<"EOF"`; not the here-string `<<<`.
const HEREDOC_START = /<<-?[ \t]*(['"]?)([A-Za-z_][\w-]*)\1/y;

function heredocStart(command: string, index: number): { readonly delimiter: string; readonly end: number } | undefined {
  assert(command.startsWith('<<', index), 'heredocStart: starts at <<');
  if (command.startsWith('<<<', index)) {
    return undefined;
  }
  HEREDOC_START.lastIndex = index;
  const match = HEREDOC_START.exec(command);
  if (match === null) {
    return undefined;
  }
  const delimiter = match[2] ?? '';
  assert(delimiter.length > 0, 'heredocStart: the delimiter is a word');
  return { delimiter, end: index + match[0].length };
}

// The index just past the line that ends the last of the pending heredocs, or
// the end of the command when one never ends. `<<-` allows leading tabs, so
// a terminator line is compared trimmed.
function heredocBodyEnd(command: string, start: number, delimiters: readonly string[]): number {
  assert(delimiters.length > 0, 'heredocBodyEnd: a heredoc is pending');
  let position = start;
  let end = command.length;
  for (const delimiter of delimiters) {
    end = command.length;
    for (let line = 0; line < COMMAND_CHARS_MAX && position < command.length; line += 1) {
      const newline = command.indexOf('\n', position);
      const lineEnd = newline < 0 ? command.length : newline;
      const text = command.slice(position, lineEnd);
      position = lineEnd + 1;
      if (text.trim() === delimiter) {
        end = lineEnd;
        break;
      }
    }
  }
  assert(end <= command.length, 'heredocBodyEnd: the end is within the command');
  return end;
}

function gitSegmentVerdict(tokens: readonly string[]): Verdict {
  const gitIndex = tokens.findIndex((token) => token === 'git' || token.endsWith('/git'));
  if (gitIndex < 0) {
    return ALLOW;
  }
  const rest = tokens.slice(gitIndex + 1);
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    assert(token !== undefined, 'gitSegmentVerdict: index within tokens');
    // `git -c core.hooksPath=/dev/null commit …`
    if (token === '-c' || token.startsWith('--config-env')) {
      const setting = rest[index + 1] ?? '';
      if (HOOK_SETTINGS.test(setting)) {
        return { kind: 'deny', reason: `Overriding core.hooksPath. ${BYPASS_REASON}` };
      }
    }
  }
  const subcommandIndex = subcommandPosition(rest);
  const subcommand = rest[subcommandIndex];
  const arguments_ = rest.slice(subcommandIndex + 1);
  if (subcommand === 'config') {
    return configVerdict(arguments_);
  }
  if (subcommand === undefined || !HOOKED_SUBCOMMANDS.has(subcommand)) {
    return ALLOW;
  }
  if (arguments_.includes('--no-verify')) {
    return { kind: 'deny', reason: `\`git ${subcommand} --no-verify\`. ${BYPASS_REASON}` };
  }
  // `-n` is --no-verify only for commit; a cluster such as `-anm` includes it.
  if (subcommand === 'commit') {
    if (arguments_.some(isNoVerifyCluster)) {
      return { kind: 'deny', reason: `\`git commit -n\`. ${BYPASS_REASON}` };
    }
  }
  return ALLOW;
}

// Global options before the subcommand that take the next word as their
// value: `git -C ../repo commit` runs commit, not a command named ../repo.
const GLOBAL_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--config-env', '--exec-path', '--git-dir', '--namespace', '--super-prefix', '--work-tree']);

function subcommandPosition(rest: readonly string[]): number {
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    assert(token !== undefined, 'subcommandPosition: index within tokens');
    if (GLOBAL_OPTIONS_WITH_VALUE.has(token)) {
      index += 1;
      continue;
    }
    if (!token.startsWith('-')) {
      return index;
    }
  }
  return rest.length;
}

// `git config core.hooksPath` reads the setting; with a value, `--unset`, or
// `--replace-all` it changes it.
function configVerdict(arguments_: readonly string[]): Verdict {
  const keyIndex = arguments_.findIndex((token) => HOOK_SETTINGS.test(token));
  if (keyIndex < 0) {
    return ALLOW;
  }
  if (arguments_.some((token) => token === '--get' || token === '--get-all')) {
    return ALLOW;
  }
  const unsets = arguments_.some((token) => token.startsWith('--unset'));
  const hasValue = keyIndex < arguments_.length - 1;
  if (unsets || hasValue) {
    return { kind: 'deny', reason: `Changing core.hooksPath. ${BYPASS_REASON}` };
  }
  return ALLOW;
}

// A short-option cluster that includes n: `-n`, `-an`, `-nm`. A cluster stops
// at the first option that takes a value (m, F, c, C, t, S, u), since the rest
// of the token is that value (`-mnote` is a message).
function isNoVerifyCluster(token: string): boolean {
  if (!/^-[A-Za-z]+$/.test(token)) {
    return false;
  }
  for (const letter of token.slice(1)) {
    if (letter === 'n') {
      return true;
    }
    if ('mFcCtSu'.includes(letter)) {
      return false;
    }
  }
  return false;
}

// Splits a shell command line at the operators that start a new command:
// `;`, `&&`, `||`, `|`, `&`, newlines, and subshell parentheses. Quotes are
// honored so `git commit -m "a; b"` stays one command.
export function commandSegments(command: string): readonly string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const character = command.charAt(index);
    if (quote !== undefined) {
      current += character;
      if (character === quote) {
        quote = undefined;
      } else if (character === '\\' && quote === '"') {
        index += 1;
        current += command.charAt(index);
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (';&|\n()`'.includes(character)) {
      segments.push(current);
      current = '';
      assert(segments.length <= SEGMENTS_MAX, 'commandSegments: segment limit exceeded');
      continue;
    }
    current += character;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}

// Words of one simple command, with quotes removed: `-m "a b"` → `-m`, `a b`.
export function tokenize(segment: string): readonly string[] {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment.charAt(index);
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        tokens.push(current);
        assert(tokens.length <= TOKENS_MAX, 'tokenize: token limit exceeded');
      }
      current = '';
      started = false;
      continue;
    }
    current += character;
    started = true;
  }
  if (started) {
    tokens.push(current);
  }
  return tokens;
}

// The files a Codex `apply_patch` touches, read from its patch headers.
// Every string in the tool input is searched, so the check does not depend on
// which field the harness puts the patch in.
export function patchPaths(input: unknown): readonly string[] {
  const found = new Set<string>();
  for (const text of stringsWithin(input)) {
    for (const match of text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
      found.add((match[1] ?? '').trim());
    }
    for (const match of text.matchAll(/^\*\*\* Move to: (.+)$/gm)) {
      found.add((match[1] ?? '').trim());
    }
  }
  return [...found].filter((file) => file.length > 0);
}

const STRINGS_NODES_MAX = 10_000;

function stringsWithin(input: unknown): readonly string[] {
  const strings: string[] = [];
  const pending: unknown[] = [input];
  let visited = 0;
  while (pending.length > 0) {
    visited += 1;
    assert(visited <= STRINGS_NODES_MAX, 'stringsWithin: payload exceeds the node limit');
    const value = pending.pop();
    if (typeof value === 'string') {
      strings.push(value);
    } else if (Array.isArray(value)) {
      const items: readonly unknown[] = value;
      pending.push(...items);
    } else if (typeof value === 'object' && value !== null) {
      const items: readonly unknown[] = Object.values(value);
      pending.push(...items);
    }
  }
  return strings;
}

// A path a tool names, relative to the repository with forward slashes, or
// absent when it lies outside the repository (not this repository's business).
export function repositoryPath(root: string, base: string, file: string): string | undefined {
  assert(path.isAbsolute(root), 'repositoryPath: the root is absolute');
  const relative = normalizePath(root, path.resolve(base, file));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative;
}
