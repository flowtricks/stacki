// What git will accept as a branch name, applied where the name is typed
// rather than after it has been sent.
//
// `git checkout -b` refuses a name it doesn't like, which arrives here as a
// failed action and a red message — the name is gone, and what was wrong with
// it is written in git's words ("fatal: 'my branch' is not a valid branch
// name"). Since the rules are fixed and short, the field can keep to them
// instead: the characters git refuses are never typed, and the few problems
// that are about the shape of the whole name are said before Enter does
// anything.
//
// Capitals are deliberately left alone. Git takes them — `Feature/Login` is a
// perfectly good branch — so a field that stripped them would be inventing a
// rule rather than enforcing one. What capitals DO cause is a collision on
// macOS and Windows, where `feature` and `Feature` are the same file in
// .git/refs, and that is caught below as the clash it actually is.

// Characters git refuses in a ref: ASCII control codes, space, and the seven
// it reserves for its own syntax (~ ^ : ? * [ and a backslash). See
// `git help check-ref-format`.
const FORBIDDEN = /[\x00-\x1f\x7f ~^:?*[\\]/g;

/**
 * The typed text as a branch name can hold it.
 *
 * Spaces become `-` rather than vanishing: a space is what somebody means as a
 * separator, and dropping it silently joins two words into one.
 */
export function sanitizeBranchName(text) {
  return String(text ?? '')
    .replace(/\s+/g, '-')
    .replace(FORBIDDEN, '')
    .replace(/@\{/g, '') // `@{` is git's reflog syntax, not part of a name
    .replace(/\.{2,}/g, '.') // `..` is a range between two refs
    .replace(/\/{2,}/g, '/') // an empty path component
    .replace(/^[-./]+/, ''); // a name can't open with a dash, a dot or a slash
}

/**
 * What's wrong with this name, or null when nothing is — for the shape of the
 * whole name, which is the part typing can't prevent character by character.
 * An empty field is not an error; there is simply nothing to create yet.
 *
 * `existing` is the branches the project already has.
 */
export function branchNameError(name, existing = []) {
  const n = String(name ?? '').trim();
  if (!n) return null;
  if (n === '@') return '“@” is git’s own name for the current branch.';
  if (n.endsWith('/')) return 'A name can’t end with “/”.';
  if (n.endsWith('.')) return 'A name can’t end with “.”.';
  if (n.split('/').some((part) => part.endsWith('.lock'))) return '“.lock” is reserved by git.';
  const clash = existing.find((b) => String(b).toLowerCase() === n.toLowerCase());
  if (clash === n) return `${n} already exists.`;
  if (clash) {
    // Not pedantry: on macOS and Windows these are one file in .git/refs, so
    // git refuses the second one — with a message about a file, not a branch.
    return `${clash} already exists, and names differing only in case are the same branch here.`;
  }
  return null;
}

/** Whether this name can be created as it stands. */
export function isValidBranchName(name, existing = []) {
  const n = String(name ?? '').trim();
  return !!n && !branchNameError(n, existing);
}
