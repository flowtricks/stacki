#!/usr/bin/env node
// Usage:
//
//   node --experimental-strip-types scripts/release/prepare.mts [--version=X.Y.Z] [--allow-minor]
//        [--notes=TEXT | --notes-file=PATH] [--expected-sha=SHA] [--dry-run]
//
// Prepares a release deterministically: computes the version (the next patch after the last tag on
// origin, unless one is named), writes it into every file in versionManifest.mts, reads each file
// back to prove it, adds the docs/releases.md entry generated from the commits since the last tag
// (releaseNotes.mts), and makes the one commit `chore(release): version X.Y.Z`. It never pushes
// and never tags; releaseGo.mts does that, and only after this has succeeded.
//
// It refuses, before writing anything: a tracked change in the working tree, a branch other than
// main (or, in the workflow, a HEAD other than the SHA its preflight approved), a tag for the
// version that already exists, a version that breaks the bump rule, and code that check.yml has
// not proved (releaseStatus.mts, `assessCode`). Running it twice changes nothing the second time.
// `--dry-run` prints the whole plan, every changed field and the full notes entry, and writes
// nothing. Exit status: 0 prepared or planned, 1 refused, 2 the facts could not be read.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assert } from '../policy/assert.mts';
import { flowtricksEnvironment, systemCommandRunner, type CommandRunner } from './releaseCommands.mts';
import { insertNotesEntry, NOTES_LIMITS, parseNotesOverride, renderNotesEntry, type CommitSubject } from './releaseNotes.mts';
import { fail, ok, type Result } from './releaseResult.mts';
import { assessCode, gatherFacts, parseTagNames } from './releaseStatus.mts';
import { latestReleasedVersion, nextPatchVersion, validateBump, type BumpPolicy } from './releaseVersion.mts';
import { systemWriteRunner, type WriteRunner } from './releaseWrite.mts';
import { RELEASE_NOTES_FILE, readVersions, VERSION_FILES, writeVersion, type VersionFile } from './versionManifest.mts';

export const PREPARE_LIMITS = {
  commitSubjectCharsMax: 72,
} as const satisfies Record<string, number>;

/** The repository's files, by repository-relative path, so tests can use an in-memory tree. */
export interface RepositoryFiles {
  readonly read: (filePath: string) => Result<string>;
  readonly write: (filePath: string, text: string) => Result<void>;
}

export interface PrepareOptions {
  readonly version: string | undefined;
  readonly bumpPolicy: BumpPolicy;
  readonly notesOverride: string | undefined;
  // The workflow checks out its preflight SHA detached; locally the branch must be main.
  readonly expectedSha: string | undefined;
}

export interface FileChange {
  readonly path: string;
  readonly before: readonly string[];
  readonly text: string;
}

export interface PreparePlan {
  readonly version: string;
  readonly previous: string;
  readonly baseSha: string;
  readonly commitCount: number;
  readonly versionChanges: readonly FileChange[];
  readonly notesEntry: string;
  // The new releases.md text, or undefined when the entry is already there.
  readonly notesText: string | undefined;
  readonly commitSubject: string;
  readonly commitBody: string;
}

export type PrepareOutcome =
  | { readonly kind: 'committed'; readonly plan: PreparePlan; readonly commitSha: string }
  | { readonly kind: 'already-prepared'; readonly plan: PreparePlan; readonly commitSha: string };

export function systemRepositoryFiles(root: string): RepositoryFiles {
  const resolve = (filePath: string): string => {
    const resolved = path.resolve(root, filePath);
    assert(resolved.startsWith(path.resolve(root) + path.sep), `repository file ${filePath} stays inside the repository`);
    return resolved;
  };
  return {
    read: (filePath) => {
      try {
        return ok(fs.readFileSync(resolve(filePath), 'utf8'));
      } catch (error: unknown) {
        return fail('file-read', `${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    write: (filePath, text) => {
      try {
        fs.writeFileSync(resolve(filePath), text);
        return ok(undefined);
      } catch (error: unknown) {
        return fail('file-write', `${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

function gitText(runner: CommandRunner, argumentsList: readonly string[]): Result<string> {
  const result = runner({ command: 'git', argumentsList });
  return result.ok ? ok(result.value.trim()) : result;
}

/** Everything the commit will hold, decided and checked before a byte is written. */
export function planRelease(options: PrepareOptions, runner: CommandRunner, files: RepositoryFiles): Result<PreparePlan> {
  const head = gitText(runner, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!head.ok) {
    return head;
  }
  assert(/^[0-9a-f]{40}$/.test(head.value), 'planRelease: HEAD is a full SHA');
  const position = checkPosition(options, runner, head.value);
  if (!position.ok) {
    return position;
  }
  const tags = runner({ command: 'git', argumentsList: ['ls-remote', '--tags', 'origin', 'refs/tags/v*'] });
  if (!tags.ok) {
    return tags;
  }
  const tagNames = parseTagNames(tags.value);
  const previous = latestReleasedVersion(tagNames);
  if (!previous.ok) {
    return previous;
  }
  const version = chooseVersion(options, previous.value, tagNames, runner);
  if (!version.ok) {
    return version;
  }
  const facts = gatherFacts(head.value, runner);
  if (!facts.ok) {
    return facts;
  }
  const code = assessCode(facts.value);
  if (!code.ready) {
    return fail('not-green', code.text);
  }
  const versionChanges = planVersionFiles(files, version.value);
  if (!versionChanges.ok) {
    return versionChanges;
  }
  const subjects = readSubjects(runner, previous.value);
  if (!subjects.ok) {
    return subjects;
  }
  const notes = planNotes(files, version.value, subjects.value, options.notesOverride);
  if (!notes.ok) {
    return notes;
  }
  const commitSubject = `chore(release): version ${version.value}`;
  assert(commitSubject.length <= PREPARE_LIMITS.commitSubjectCharsMax, 'planRelease: the subject fits the commit-msg limit');
  const commitBody =
    `Sets every version file to ${version.value} and adds its docs/releases.md entry. Generated by ` +
    `scripts/release/prepare.mts from the ${subjects.value.length} commit(s) since v${previous.value}, so the ` +
    'same history always gives the same commit.';
  return ok({
    version: version.value,
    previous: previous.value,
    baseSha: head.value,
    commitCount: subjects.value.length,
    versionChanges: versionChanges.value,
    notesEntry: notes.value.entry,
    notesText: notes.value.text,
    commitSubject,
    commitBody,
  });
}

function checkPosition(options: PrepareOptions, runner: CommandRunner, headSha: string): Result<void> {
  if (options.expectedSha === undefined) {
    const branch = gitText(runner, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!branch.ok) {
      return branch;
    }
    if (branch.value !== 'main') {
      return fail('wrong-branch', `on ${branch.value}; a release is prepared on main.`);
    }
  } else if (options.expectedSha !== headSha) {
    return fail('wrong-commit', `HEAD is ${headSha.slice(0, 7)}, but the preflight approved ${options.expectedSha.slice(0, 7)}.`);
  }
  // Untrimmed: the first column of a porcelain line is a space for an unstaged change.
  const status = runner({ command: 'git', argumentsList: ['status', '--porcelain'] });
  if (!status.ok) {
    return status;
  }
  const tracked = status.value.split('\n').filter((line) => line.length > 0 && !line.startsWith('??'));
  if (tracked.length > 0) {
    return fail('dirty-tree', `uncommitted changes to tracked files (${tracked.map((line) => line.slice(3)).join(', ')}); commit or wait for them first.`);
  }
  return ok(undefined);
}

function chooseVersion(options: PrepareOptions, previous: string, tagNames: readonly string[], runner: CommandRunner): Result<string> {
  const target = options.version ?? (() => {
    const next = nextPatchVersion(previous);
    return next.ok ? next.value : undefined;
  })();
  if (target === undefined) {
    return fail('version-none', `no next version after ${previous}.`);
  }
  const bump = validateBump(previous, target, options.bumpPolicy);
  if (!bump.ok) {
    return bump;
  }
  if (tagNames.includes(`v${target}`)) {
    return fail('tag-exists', `tag v${target} already exists on origin. Never move it: release the next patch.`);
  }
  // A local tag that never reached origin is a leftover from a failed push; it must not be reused.
  const local = runner({ command: 'git', argumentsList: ['rev-parse', '--verify', '--quiet', `refs/tags/v${target}`] });
  if (local.ok) {
    return fail('tag-exists-locally', `tag v${target} exists locally but not on origin; delete it (git tag -d v${target}) after checking why the push failed.`);
  }
  return ok(target);
}

export function planVersionFiles(files: RepositoryFiles, version: string): Result<readonly FileChange[]> {
  const changes: FileChange[] = [];
  for (const file of VERSION_FILES) {
    const change = planVersionFile(files, file, version);
    if (!change.ok) {
      return change;
    }
    if (change.value !== undefined) {
      changes.push(change.value);
    }
  }
  return ok(changes);
}

function planVersionFile(files: RepositoryFiles, file: VersionFile, version: string): Result<FileChange | undefined> {
  const before = files.read(file.path);
  if (!before.ok) {
    return before;
  }
  const beforeVersions = readVersions(file, before.value);
  if (!beforeVersions.ok) {
    return beforeVersions;
  }
  if (beforeVersions.value.every((value) => value === version)) {
    return ok(undefined);
  }
  const text = writeVersion(file, before.value, version);
  if (!text.ok) {
    return text;
  }
  // Postconditions in memory, before any write: JSON reads the new version in every field, and
  // the only lines that differ are version lines.
  const afterVersions = readVersions(file, text.value);
  if (!afterVersions.ok) {
    return afterVersions;
  }
  if (!afterVersions.value.every((value) => value === version)) {
    return fail('manifest-readback', `${file.path}: after the edit JSON reads ${afterVersions.value.join(', ')}, not ${version}.`);
  }
  const changedLines = differingLines(before.value, text.value);
  if (changedLines === undefined || changedLines.some((line) => !line.includes('"version": "'))) {
    return fail('manifest-readback', `${file.path}: the edit changed more than its version lines.`);
  }
  return ok({ path: file.path, before: beforeVersions.value, text: text.value });
}

// The lines of `after` that differ from `before`, or undefined when the line count changed.
function differingLines(before: string, after: string): readonly string[] | undefined {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  if (beforeLines.length !== afterLines.length) {
    return undefined;
  }
  return afterLines.filter((line, index) => line !== beforeLines[index]);
}

function readSubjects(runner: CommandRunner, previous: string): Result<readonly CommitSubject[]> {
  const log = runner({
    command: 'git',
    argumentsList: ['log', '--no-merges', `--max-count=${NOTES_LIMITS.commitsMax + 1}`, '--format=%s', `v${previous}..HEAD`],
  });
  if (!log.ok) {
    return log;
  }
  const subjects = log.value
    .split('\n')
    .filter((line) => line.length > 0)
    .map((subject) => ({ subject }));
  if (subjects.length > NOTES_LIMITS.commitsMax) {
    return fail('notes-too-many', `more than ${NOTES_LIMITS.commitsMax} commits since v${previous}; refusing to summarize them.`);
  }
  return ok(subjects);
}

export function planNotes(
  files: RepositoryFiles,
  version: string,
  subjects: readonly CommitSubject[],
  overrideText: string | undefined,
): Result<{ readonly entry: string; readonly text: string | undefined }> {
  const override = parseNotesOverride(overrideText ?? '');
  if (!override.ok) {
    return override;
  }
  const entry = renderNotesEntry({ version, subjectsNewestFirst: subjects, override: override.value });
  const releases = files.read(RELEASE_NOTES_FILE);
  if (!releases.ok) {
    return releases;
  }
  const insertion = insertNotesEntry(releases.value, version, entry);
  if (!insertion.ok) {
    return insertion;
  }
  return ok({ entry, text: insertion.value.kind === 'inserted' ? insertion.value.text : undefined });
}

/** The paths the commit will contain, in manifest order. */
export function changedPaths(plan: PreparePlan): readonly string[] {
  return [...plan.versionChanges.map((change) => change.path), ...(plan.notesText === undefined ? [] : [RELEASE_NOTES_FILE])];
}

/** Writes the plan, proves every file on disk, and makes the one commit. */
export function executePlan(plan: PreparePlan, runner: CommandRunner, writer: WriteRunner, files: RepositoryFiles): Result<PrepareOutcome> {
  const paths = changedPaths(plan);
  if (paths.length === 0) {
    return ok({ kind: 'already-prepared', plan, commitSha: plan.baseSha });
  }
  const written = writeAndReadBack(plan, files);
  if (!written.ok) {
    return written;
  }
  const add = writer({ command: 'git', argumentsList: ['add', '--', ...paths], output: 'capture' });
  if (!add.ok) {
    return add;
  }
  const commit = writer({ command: 'git', argumentsList: ['commit', '-m', plan.commitSubject, '-m', plan.commitBody], output: 'capture' });
  if (!commit.ok) {
    return commit;
  }
  return verifyCommit(plan, paths, runner);
}

function writeAndReadBack(plan: PreparePlan, files: RepositoryFiles): Result<void> {
  for (const change of plan.versionChanges) {
    const write = files.write(change.path, change.text);
    if (!write.ok) {
      return write;
    }
  }
  if (plan.notesText !== undefined) {
    const write = files.write(RELEASE_NOTES_FILE, plan.notesText);
    if (!write.ok) {
      return write;
    }
  }
  // Read back from disk, not from memory: this is the pair of the in-memory check in the plan.
  for (const file of VERSION_FILES) {
    const text = files.read(file.path);
    if (!text.ok) {
      return text;
    }
    const versions = readVersions(file, text.value);
    if (!versions.ok) {
      return versions;
    }
    if (!versions.value.every((value) => value === plan.version)) {
      return fail('manifest-readback', `${file.path} reads ${versions.value.join(', ')} after the write, not ${plan.version}.`);
    }
  }
  if (plan.notesText !== undefined) {
    const notes = files.read(RELEASE_NOTES_FILE);
    if (!notes.ok) {
      return notes;
    }
    if (notes.value !== plan.notesText) {
      return fail('manifest-readback', `${RELEASE_NOTES_FILE} does not hold the planned entry after the write.`);
    }
  }
  return ok(undefined);
}

function verifyCommit(plan: PreparePlan, paths: readonly string[], runner: CommandRunner): Result<PrepareOutcome> {
  const sha = gitText(runner, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!sha.ok) {
    return sha;
  }
  const parent = gitText(runner, ['rev-parse', '--verify', 'HEAD~1^{commit}']);
  if (!parent.ok) {
    return parent;
  }
  if (parent.value !== plan.baseSha) {
    return fail('commit-parent', `the bump commit's parent is ${parent.value.slice(0, 7)}, not ${plan.baseSha.slice(0, 7)}.`);
  }
  const committed = gitText(runner, ['show', '--name-only', '--format=', 'HEAD']);
  if (!committed.ok) {
    return committed;
  }
  const committedPaths = committed.value.split('\n').filter((line) => line.length > 0);
  const same = committedPaths.length === paths.length && paths.every((candidate) => committedPaths.includes(candidate));
  if (!same) {
    return fail('commit-paths', `the bump commit holds ${committedPaths.join(', ')}, expected exactly ${paths.join(', ')}.`);
  }
  for (const file of VERSION_FILES) {
    const text = gitText(runner, ['show', `HEAD:${file.path}`]);
    if (!text.ok) {
      return text;
    }
    const versions = readVersions(file, text.value);
    if (!versions.ok) {
      return versions;
    }
    if (!versions.value.every((value) => value === plan.version)) {
      return fail('commit-readback', `the bump commit's ${file.path} reads ${versions.value.join(', ')}, not ${plan.version}.`);
    }
  }
  return ok({ kind: 'committed', plan, commitSha: sha.value });
}

export function renderPlan(plan: PreparePlan): string {
  const lines = [`Release preparation for ${plan.version} (last released ${plan.previous}) from ${plan.baseSha.slice(0, 7)}, ${plan.commitCount} commit(s)`];
  for (const file of VERSION_FILES) {
    const change = plan.versionChanges.find((candidate) => candidate.path === file.path);
    lines.push(`  ${file.path.padEnd(38)}${change === undefined ? `already ${plan.version}` : `${change.before.join(', ')} -> ${plan.version}`}`);
  }
  lines.push(`  ${RELEASE_NOTES_FILE.padEnd(38)}${plan.notesText === undefined ? `entry for ${plan.version} already present (kept as written)` : 'new entry below'}`);
  if (plan.notesText !== undefined) {
    lines.push('--- docs/releases.md entry ---', plan.notesEntry.trimEnd());
  }
  if (changedPaths(plan).length === 0) {
    lines.push('--- nothing to commit: every file already holds this version ---');
  } else {
    lines.push('--- commit ---', plan.commitSubject, '', plan.commitBody);
  }
  return lines.join('\n');
}

export interface PrepareArguments {
  readonly options: PrepareOptions;
  readonly mode: 'dry-run' | 'write';
}

export function parsePrepareArguments(argumentsList: readonly string[], readNotesFile: (filePath: string) => Result<string>): Result<PrepareArguments> {
  let version: string | undefined;
  let bumpPolicy: BumpPolicy = 'patch-only';
  let notesOverride: string | undefined;
  let expectedSha: string | undefined;
  let mode: PrepareArguments['mode'] = 'write';
  for (const argument of argumentsList) {
    if (argument.startsWith('--version=')) {
      const value = argument.slice('--version='.length).trim();
      version = value.length === 0 ? undefined : value;
    } else if (argument === '--allow-minor') {
      bumpPolicy = 'minor-or-major';
    } else if (argument.startsWith('--notes=')) {
      notesOverride = argument.slice('--notes='.length);
    } else if (argument.startsWith('--notes-file=')) {
      const notes = readNotesFile(argument.slice('--notes-file='.length));
      if (!notes.ok) {
        return notes;
      }
      notesOverride = notes.value;
    } else if (argument.startsWith('--expected-sha=')) {
      expectedSha = argument.slice('--expected-sha='.length);
      if (!/^[0-9a-f]{40}$/.test(expectedSha)) {
        return fail('usage', '--expected-sha takes a full 40-character SHA.');
      }
    } else if (argument === '--dry-run') {
      mode = 'dry-run';
    } else {
      return fail('usage', `unknown argument ${argument}`);
    }
  }
  return ok({ options: { version, bumpPolicy, notesOverride, expectedSha }, mode });
}

function main(argumentsList: readonly string[]): number {
  const root = process.cwd();
  const files = systemRepositoryFiles(root);
  const parsed = parsePrepareArguments(argumentsList, (filePath) => files.read(filePath));
  if (!parsed.ok) {
    console.error(parsed.error.message);
    return 2;
  }
  const bootstrap = systemCommandRunner(process.env);
  const environment = flowtricksEnvironment(process.env, bootstrap);
  const runner = systemCommandRunner(environment);
  const plan = planRelease(parsed.value.options, runner, files);
  if (!plan.ok) {
    console.log(`REFUSED (${plan.error.code}): ${plan.error.message}`);
    return plan.error.code.startsWith('command-') || plan.error.code.startsWith('json-') ? 2 : 1;
  }
  console.log(renderPlan(plan.value));
  if (parsed.value.mode === 'dry-run') {
    console.log('DRY RUN: nothing was written or committed.');
    return 0;
  }
  const outcome = executePlan(plan.value, runner, systemWriteRunner(environment), files);
  if (!outcome.ok) {
    console.log(`FAILED (${outcome.error.code}): ${outcome.error.message}`);
    return 1;
  }
  console.log(outcome.value.kind === 'committed' ? `PREPARED: ${outcome.value.commitSha}` : `ALREADY PREPARED: ${outcome.value.commitSha}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
