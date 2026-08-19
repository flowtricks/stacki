import React from 'react';

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
  A: { word: 'New', why: 'This file is new — it isn’t in the last saved version' },
  M: { word: 'Changed', why: 'This file has changes that aren’t saved yet' },
  D: { word: 'Deleted', why: 'This file has been deleted' },
  R: { word: 'Moved', why: 'This file has been moved or renamed' },
  C: { word: 'Copied', why: 'This file was copied from another one' },
  U: { word: 'Clashing', why: 'Two branches changed this file and it needs sorting out' },
};

/**
 * The badge on a file row, or nothing at all when the file is unchanged.
 *
 * `inCommit` switches the wording from what is true right now to what a commit
 * did — "Changed" is a state the working tree is in, but a commit that touched
 * a file did the changing, and "was changed" is what it says.
 */
export default function FileStatus({ status, inCommit = false }) {
  if (!status) return null;
  const known = WORDS[status];
  // An unrecognised letter keeps the letter. Inventing a word for something
  // git meant differently would be worse than showing what git said.
  const word = known ? known.word : status;
  const why = known
    ? inCommit
      ? `${known.word} in this version`
      : known.why
    : `git calls this “${status}”`;
  return (
    <span className={`file-status s-${status}`} title={why}>
      {word}
    </span>
  );
}
