// How the app shows what happened to a file, in one place so every list agrees:
//
//   - `GitStatusBadge`: VS Code's mark at the end of a row (the Files panel, the Git panel's list of changes), a letter in
//     the colour of what happened to a file, or a dot for a folder with changes inside. Colour never carries it alone: the
//     letter or the dot is a shape, and each says in plain words what it means, in a tooltip and to a screen reader.
//   - `FileStatus` (the default export): the same fact as a word, where there is room to read one (the commit picker, a
//     saved version's files).
//
// Both are coloured by the git tokens (styles.css, `--git-*`). `data-git` on a row also colours its name there.
import type { ExplorerPath, FileGitState } from '../../shared/ipc/fileExplorer';
import { assert } from '../../shared/core/assert';
import type { MessageKey, Translator } from '../lib/i18n/localeContext';
import { useTranslate } from '../lib/i18n/useTranslate';
import TipAnchor from './TipAnchor';

export type GitMark =
  | { readonly kind: 'change'; readonly state: FileGitState; readonly from: ExplorerPath | string | undefined }
  | { readonly kind: 'contains'; readonly state: FileGitState }
  | { readonly kind: 'ignored' };

/** VS Code's letters. They are git's own marks, the same in every language. */
export const GIT_STATE_LETTERS = {
  conflicted: '!',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  added: 'A',
  untracked: 'U',
} as const satisfies Record<FileGitState, string>;

const FILE_WORDS = {
  conflicted: 'workspace.files.git.conflicted',
  modified: 'workspace.files.git.modified',
  deleted: 'workspace.files.git.deleted',
  renamed: 'workspace.files.git.renamed',
  added: 'workspace.files.git.added',
  untracked: 'workspace.files.git.untracked',
} as const satisfies Record<FileGitState, MessageKey>;

const FOLDER_WORDS = {
  conflicted: 'workspace.files.git.folder.conflicted',
  modified: 'workspace.files.git.folder.modified',
  deleted: 'workspace.files.git.folder.deleted',
  renamed: 'workspace.files.git.folder.renamed',
  added: 'workspace.files.git.folder.added',
  untracked: 'workspace.files.git.folder.untracked',
} as const satisfies Record<FileGitState, MessageKey>;

/** What a row's `data-git` says, which is what colours it. */
export function gitTone(mark: GitMark | undefined): FileGitState | 'ignored' | undefined {
  if (mark === undefined) {
    return undefined;
  }
  return mark.kind === 'ignored' ? 'ignored' : mark.state;
}

export function gitWords(mark: GitMark, translate: Translator): string {
  switch (mark.kind) {
    case 'ignored':
      return translate('workspace.files.git.ignored');
    case 'contains':
      return translate(FOLDER_WORDS[mark.state]);
    case 'change':
      if (mark.state === 'renamed' && mark.from !== undefined) {
        return translate('workspace.files.git.renamedFrom', { from: mark.from });
      }
      return translate(FILE_WORDS[mark.state]);
    default: {
      const exhaustive: never = mark;
      return exhaustive;
    }
  }
}

/** The letter or dot; nothing for an unchanged or ignored entry (an ignored one is dimmed instead). */
export function GitStatusBadge({ mark }: { readonly mark: GitMark | undefined }) {
  const translate = useTranslate();
  if (mark === undefined || mark.kind === 'ignored') {
    return undefined;
  }
  const words = gitWords(mark, translate);
  assert(words.length > 0, 'GitStatusBadge: a mark is told in words');
  return (
    <TipAnchor text={words}>
      <span className="git-badge" data-git={mark.state} aria-hidden="true">
        {mark.kind === 'change' ? GIT_STATE_LETTERS[mark.state] : <span className="git-badge-dot" />}
      </span>
    </TipAnchor>
  );
}

// What happened to a file, in a word.
//
// Git says "M". It also says "A", "D" and "R", and every one of them is
// shorthand for people who already know the shorthand — which, in an editor
// built so that nobody needs to learn git first, is nobody. A letter that
// needs a tooltip to explain it is a letter that should have been a word.
//
// The words are short enough to sit where the letter did, so nothing had to
// grow to make room for being readable.

const WORDS = {
  A: { word: 'git.file.new', why: 'git.file.new.why', inVersion: 'git.file.new.inVersion' },
  M: { word: 'git.file.changed', why: 'git.file.changed.why', inVersion: 'git.file.changed.inVersion' },
  D: { word: 'git.file.deleted', why: 'git.file.deleted.why', inVersion: 'git.file.deleted.inVersion' },
  R: { word: 'git.file.moved', why: 'git.file.moved.why', inVersion: 'git.file.moved.inVersion' },
  C: { word: 'git.file.copied', why: 'git.file.copied.why', inVersion: 'git.file.copied.inVersion' },
  U: { word: 'git.file.clashing', why: 'git.file.clashing.why', inVersion: 'git.file.clashing.inVersion' },
} as const satisfies Record<string, { readonly word: MessageKey; readonly why: MessageKey; readonly inVersion: MessageKey }>;

function isStatusLetter(status: string): status is keyof typeof WORDS {
  return Object.hasOwn(WORDS, status);
}

/**
 * The badge on a file row, or nothing at all when the file is unchanged.
 *
 * `inCommit` switches the wording from what is true right now to what a commit
 * did — "Changed" is a state the working tree is in, but a commit that touched
 * a file did the changing, and "was changed" is what it says.
 */
export default function FileStatus({ status, inCommit = false }: { readonly status?: string | undefined; readonly inCommit?: boolean }) {
  const translate = useTranslate();
  if (!status) {
    return undefined;
  }
  const known = isStatusLetter(status) ? WORDS[status] : undefined;
  // An unrecognised letter keeps the letter. Inventing a word for something
  // git meant differently would be worse than showing what git said.
  const word = known ? translate(known.word) : status;
  const why = known ? translate(inCommit ? known.inVersion : known.why) : translate('git.file.unknownWhy', { status });
  return (
    <span className={`file-status s-${status}`} title={why}>
      {word}
    </span>
  );
}
