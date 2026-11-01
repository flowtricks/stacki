import { COMMIT_DIFF_LIMITS } from '../../shared/ipc/gitCommitDiff';
import type { CommitDiffRequest, CommitDiffResult } from '../../shared/ipc/gitCommitDiff';
import { gitErrorDetail } from './git';
import type { Git } from './git';

export async function readCommitDiff(git: Git, request: CommitDiffRequest): Promise<CommitDiffResult> {
  // Literal paths prevent filenames containing Git pathspec syntax from selecting
  // unrelated files. Disable external diff/textconv programs for read-only inspection.
  const argumentsList = [
    '-c',
    'diff.suppressBlankEmpty=false',
    '--literal-pathspecs',
    'show',
    '--format=',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--no-notes',
    '--no-relative',
    '--root',
    '--diff-merges=first-parent',
    '--find-renames',
    '--diff-algorithm=myers',
    '--unified=3',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '--output-indicator-new=+',
    '--output-indicator-old=-',
    '--output-indicator-context= ',
    '--end-of-options',
    request.commit,
    '--',
    request.path,
    ...(request.from === undefined ? [] : [request.from]),
  ];
  let patch: string;
  try {
    ({ stdout: patch } = await git(request.projectPath, argumentsList));
  } catch (error: unknown) {
    return { ok: false, error: gitErrorDetail(error) || 'Could not read this commit’s diff.' };
  }
  if (patch.length > COMMIT_DIFF_LIMITS.charactersMax) {
    return { ok: false, error: 'This file’s diff is too large to display.' };
  }
  if (patch.split('\n').length > COMMIT_DIFF_LIMITS.linesMax) {
    return { ok: false, error: 'This file’s diff has too many lines to display.' };
  }
  return { ok: true, value: patch };
}
