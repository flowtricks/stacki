// AGENTS.md §17: commit messages are documentation — `git blame` shows the
// commit, never the pull request. A message is a typed subject of at most 72
// characters, a blank line, and a body that says what changed and why.
//
// Messages git or our tooling writes, not people, are recognized and passed:
// merges, reverts, fixup/squash/amend commits for a later autosquash, and the
// `vX.Y.Z` release commit that scripts/release/release.ts creates.

import { POLICY_LIMITS } from './limits.mts';
import { assert } from './assert.mts';

export const COMMIT_TYPES = ['build', 'chore', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'style', 'test'] as const;

export type CommitMessageProblem =
  | { readonly kind: 'empty' }
  | { readonly kind: 'subject-format'; readonly subject: string }
  | { readonly kind: 'subject-length'; readonly length: number }
  | { readonly kind: 'separator' }
  | { readonly kind: 'body-missing' };

const SUBJECT = new RegExp(`^(?:${COMMIT_TYPES.join('|')})(?:\\([a-z0-9][a-z0-9-]*\\))?!?: \\S`);
const GENERATED = /^(?:Merge |Revert "|fixup! |squash! |amend! |v\d+\.\d+\.\d+$)/;
const MESSAGE_CHARS_MAX = 100_000;

export function commitMessageProblems(raw: string): readonly CommitMessageProblem[] {
  assert(raw.length <= MESSAGE_CHARS_MAX, 'commit message exceeds the size limit');
  const lines = messageLines(raw);
  const subject = lines[0];
  if (subject === undefined) {
    return [{ kind: 'empty' }];
  }
  if (GENERATED.test(subject)) {
    return [];
  }
  const problems: CommitMessageProblem[] = [];
  if (!SUBJECT.test(subject)) {
    problems.push({ kind: 'subject-format', subject });
  }
  const length = Array.from(subject).length;
  if (length > POLICY_LIMITS.commitSubjectCharsMax) {
    problems.push({ kind: 'subject-length', length });
  }
  if (lines.length > 1) {
    if (lines[1] !== '') {
      problems.push({ kind: 'separator' });
    }
  }
  // The body is everything after the subject; a missing separator is its own
  // finding, not a missing body.
  const body = lines.slice(1).join('\n').trim();
  if (body.length === 0) {
    problems.push({ kind: 'body-missing' });
  }
  return problems;
}

// The message as git will store it: comment lines and the verbose diff below
// the scissors line removed, trailing blank lines dropped.
function messageLines(raw: string): readonly string[] {
  const kept: string[] = [];
  for (const line of raw.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('# ------------------------ >8 ------------------------')) {
      break;
    }
    if (line.startsWith('#')) {
      continue;
    }
    kept.push(line.trimEnd());
  }
  while (kept.length > 0 && kept.at(-1) === '') {
    kept.pop();
  }
  while (kept.length > 0 && kept[0] === '') {
    kept.shift();
  }
  return kept;
}

export function describeCommitMessageProblem(problem: CommitMessageProblem): string {
  switch (problem.kind) {
    case 'empty':
      return 'The message is empty.';
    case 'subject-format':
      return `The subject "${problem.subject}" must read "type(scope): summary", with type one of ` + `${COMMIT_TYPES.join(', ')}.`;
    case 'subject-length':
      return `The subject is ${problem.length} characters; keep it to ` + `${POLICY_LIMITS.commitSubjectCharsMax} so it reads whole in git log.`;
    case 'separator':
      return 'Leave a blank line between the subject and the body.';
    case 'body-missing':
      return 'Add a body: what changed and why. A pull request description is invisible ' + 'in git blame (AGENTS.md §17).';
    default: {
      const unreachable: never = problem;
      return unreachable;
    }
  }
}
