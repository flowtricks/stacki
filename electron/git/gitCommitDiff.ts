import { COMMIT_DIFF_LIMITS } from '../../shared/ipc/gitCommitDiff';
import type { CommitDiffRequest, CommitDiffResult } from '../../shared/ipc/gitCommitDiff';
import { described } from '../../shared/properties/i18n/messageRef';
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
    // Git's own words when it gave any; our sentence, with its reference, when it said nothing.
    const detail = gitErrorDetail(error);
    if (detail) {
      return { ok: false, error: detail };
    }
    const unreadable = described('history.error.diffUnreadable');
    return { ok: false, error: unreadable.message, errorRef: unreadable.messageRef };
  }
  if (patch.length > COMMIT_DIFF_LIMITS.charactersMax) {
    const tooLarge = described('history.error.diffTooLarge');
    return { ok: false, error: tooLarge.message, errorRef: tooLarge.messageRef };
  }
  if (patch.split('\n').length > COMMIT_DIFF_LIMITS.linesMax) {
    const tooLong = described('history.error.diffTooManyLines');
    return { ok: false, error: tooLong.message, errorRef: tooLong.messageRef };
  }
  return { ok: true, value: patch };
}
