import { useTranslate } from '../../lib/i18n/useTranslate';
import type { MessageKey } from '../../lib/i18n/localeContext';
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
