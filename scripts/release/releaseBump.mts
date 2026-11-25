// The release bump, made on GitHub from the exact commit on origin, never from a working tree.
//
// Why not a local commit and push: a local push runs the pre-push gate on the working tree, which
// is the very thing that hid missing files and manifest entries from every gate before 1.4.7 (the
// tree held files HEAD did not), and it serializes a seven-minute gate in front of CI. The bump
// commit changes only the version files and the notes (prepare.mts proves that line by line), and
// promotion requires check.yml and candidate.yml green on the bump commit itself, so the gate is
// moved to CI on the exact SHA, not skipped.
//
// Steps: read the seven files at the origin SHA through the contents API; plan the edits with the
// same code as prepare.mts (planVersionFiles, planNotes); create the blobs, one tree on top of the
// origin commit's tree, and the commit; then move main to it with `force: false`, which GitHub
// accepts only as a fast-forward. If main moved meanwhile the update fails and nothing changed:
// a compare-and-swap for free.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert } from '../policy/assert.mts';
import { planNotes, planVersionFiles, PREPARE_LIMITS, type FileChange, type RepositoryFiles } from './prepare.mts';
import type { CommandRunner } from './releaseCommands.mts';
import { parseJson, parseRecord, readList, readRecord, readString } from './releaseJson.mts';
import { NOTES_LIMITS, type CommitSubject } from './releaseNotes.mts';
import { fail, ok, type Result } from './releaseResult.mts';
import { SOURCE_REPOSITORY } from './releaseStatus.mts';
import type { WriteRunner } from './releaseWrite.mts';
import { RELEASE_BUMP_PATHS, RELEASE_NOTES_FILE } from './versionManifest.mts';

export const BUMP_INPUT_PREFIX = 'stacki-release-bump-';

export interface BumpPlan {
  readonly version: string;
  readonly previous: string;
  readonly baseSha: string;
  readonly changes: readonly { readonly path: string; readonly text: string }[];
  readonly commitSubject: string;
  readonly commitMessage: string;
}

/** The repository's files at one commit, read from GitHub; writes are refused (this is a plan). */
export function remoteFiles(runner: CommandRunner, sha: string): RepositoryFiles {
  assert(/^[0-9a-f]{40}$/.test(sha), 'remoteFiles: a full SHA');
  return {
    read: (filePath) => {
      assert(RELEASE_BUMP_PATHS.includes(filePath), `remoteFiles: ${filePath} is a release bump file`);
      return runner({
        command: 'gh',
        argumentsList: ['api', '-H', 'Accept: application/vnd.github.raw', `repos/${SOURCE_REPOSITORY}/contents/${filePath}?ref=${sha}`],
        timeoutMs: 120_000,
      });
    },
    write: () => fail('remote-read-only', 'remote files are read-only; the bump is written as a GitHub commit'),
  };
}

/** Non-merge commit subjects from the previous tag to the SHA, newest first, from the compare API. */
export function parseCompareSubjects(text: string): Result<readonly CommitSubject[]> {
  const parsed = parseJson(text, 'compare');
  if (!parsed.ok) {
    return parsed;
  }
  const list = readList(parsed.value, 'compare');
  if (!list.ok) {
    return list;
  }
  const subjects: CommitSubject[] = [];
  for (const entry of list.value) {
    const record = readRecord(entry, 'compare commit');
    if (!record.ok) {
      return record;
    }
    const message = readString(record.value, 'message', 'compare commit');
    if (!message.ok) {
      return message;
    }
    const parents = record.value['parents'];
    if (typeof parents !== 'number') {
      return fail('json-field', 'compare commit: field "parents" is not a number.');
    }
    if (parents <= 1) {
      subjects.push({ subject: message.value.split('\n')[0] ?? '' });
    }
  }
  if (subjects.length > NOTES_LIMITS.commitsMax) {
    return fail('notes-too-many', `more than ${NOTES_LIMITS.commitsMax} commits since the last tag; refusing to summarize them.`);
  }
  // The compare API lists oldest first; the notes read newest first, like `git log`.
  return ok([...subjects].reverse());
}

export function planRemoteBump(input: { readonly baseSha: string; readonly previous: string; readonly version: string }, runner: CommandRunner): Result<BumpPlan> {
  assert(/^[0-9a-f]{40}$/.test(input.baseSha), 'planRemoteBump: a full SHA');
  assert(input.previous !== input.version, 'planRemoteBump: a new version');
  const files = remoteFiles(runner, input.baseSha);
  const versionChanges = planVersionFiles(files, input.version);
  if (!versionChanges.ok) {
    return versionChanges;
  }
  const compare = runner({
    command: 'gh',
    argumentsList: ['api', `repos/${SOURCE_REPOSITORY}/compare/v${input.previous}...${input.baseSha}`, '--jq', '[.commits[] | {message: .commit.message, parents: (.parents | length)}]'],
    timeoutMs: 120_000,
  });
  if (!compare.ok) {
    return compare;
  }
  const subjects = parseCompareSubjects(compare.value);
  if (!subjects.ok) {
    return subjects;
  }
  const notes = planNotes(files, input.version, subjects.value, undefined);
  if (!notes.ok) {
    return notes;
  }
  const changes: { path: string; text: string }[] = versionChanges.value.map((change: FileChange) => ({ path: change.path, text: change.text }));
  if (notes.value.text !== undefined) {
    changes.push({ path: RELEASE_NOTES_FILE, text: notes.value.text });
  }
  if (changes.length === 0) {
    return fail('already-bumped', `every version file at ${input.baseSha.slice(0, 7)} already reads ${input.version}.`);
  }
  for (const change of changes) {
    assert(RELEASE_BUMP_PATHS.includes(change.path), `planRemoteBump: ${change.path} is a release bump file`);
  }
  const commitSubject = `chore(release): version ${input.version}`;
  assert(commitSubject.length <= PREPARE_LIMITS.commitSubjectCharsMax, 'planRemoteBump: the subject fits the commit-msg limit');
  const commitMessage =
    `${commitSubject}\n\nSets every version file to ${input.version} and adds its docs/releases.md entry. Generated by ` +
    `scripts/release/releaseBump.mts from the ${subjects.value.length} commit(s) since v${input.previous} on ` +
    `${input.baseSha.slice(0, 12)}, so the same history always gives the same commit.\n`;
  return ok({ version: input.version, previous: input.previous, baseSha: input.baseSha, changes, commitSubject, commitMessage });
}

function readSha(text: string, label: string): Result<string> {
  const record = parseRecord(text, label);
  if (!record.ok) {
    return record;
  }
  const sha = readString(record.value, 'sha', label);
  if (!sha.ok) {
    return sha;
  }
  return /^[0-9a-f]{40}$/.test(sha.value) ? sha : fail('json-field', `${label}: "sha" is not a full SHA.`);
}

/** Creates the commit on GitHub and fast-forwards main to it. Returns the new commit's SHA. */
export function writeRemoteBump(plan: BumpPlan, runner: CommandRunner, writer: WriteRunner): Result<string> {
  const baseCommit = runner({ command: 'gh', argumentsList: ['api', `repos/${SOURCE_REPOSITORY}/git/commits/${plan.baseSha}`] });
  if (!baseCommit.ok) {
    return baseCommit;
  }
  const baseRecord = parseRecord(baseCommit.value, 'base commit');
  if (!baseRecord.ok) {
    return baseRecord;
  }
  const baseTree = readRecord(baseRecord.value['tree'], 'base commit tree');
  if (!baseTree.ok) {
    return baseTree;
  }
  const baseTreeSha = readString(baseTree.value, 'sha', 'base commit tree');
  if (!baseTreeSha.ok) {
    return baseTreeSha;
  }
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), BUMP_INPUT_PREFIX));
  try {
    const post = (endpoint: 'blobs' | 'trees' | 'commits', body: unknown): Result<string> => {
      const input = path.join(folder, `${endpoint}.json`);
      fs.writeFileSync(input, JSON.stringify(body));
      const answer = writer({ command: 'gh', argumentsList: ['api', '--method', 'POST', `repos/${SOURCE_REPOSITORY}/git/${endpoint}`, '--input', input], output: 'capture', timeoutMs: 300_000 });
      return answer.ok ? readSha(answer.value, endpoint) : answer;
    };
    const entries: { path: string; mode: '100644'; type: 'blob'; sha: string }[] = [];
    for (const change of plan.changes) {
      const blob = post('blobs', { content: change.text, encoding: 'utf-8' });
      if (!blob.ok) {
        return blob;
      }
      entries.push({ path: change.path, mode: '100644', type: 'blob', sha: blob.value });
    }
    const tree = post('trees', { base_tree: baseTreeSha.value, tree: entries });
    if (!tree.ok) {
      return tree;
    }
    const commit = post('commits', { message: plan.commitMessage, tree: tree.value, parents: [plan.baseSha] });
    if (!commit.ok) {
      return commit;
    }
    // Fast-forward only: GitHub refuses a non-fast-forward update when force is false.
    const moved = writer({
      command: 'gh',
      argumentsList: ['api', '--method', 'PATCH', `repos/${SOURCE_REPOSITORY}/git/refs/heads/main`, '-f', `sha=${commit.value}`, '-F', 'force=false'],
      output: 'capture',
    });
    if (!moved.ok) {
      return fail('main-moved', `main could not be fast-forwarded to the bump (${moved.error.message}); someone pushed meanwhile. Run the command again.`);
    }
    return commit;
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

/** Creates the release tag on exactly this commit. GitHub refuses a tag that already exists. */
export function writeRemoteTag(version: string, sha: string, writer: WriteRunner): Result<string> {
  assert(/^[0-9a-f]{40}$/.test(sha), 'writeRemoteTag: a full SHA');
  assert(/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version), 'writeRemoteTag: X.Y.Z');
  return writer({
    command: 'gh',
    argumentsList: ['api', '--method', 'POST', `repos/${SOURCE_REPOSITORY}/git/refs`, '-f', `ref=refs/tags/v${version}`, '-f', `sha=${sha}`],
    output: 'capture',
  });
}
