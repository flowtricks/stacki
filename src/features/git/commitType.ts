// Optional Conventional Commits types for the Git panel's commit message.
//
// The default is no type: the message is committed exactly as typed, as it was
// before this existed. A type is only ever added because the person picked one,
// so a project that never uses the convention never sees a prefix appear.
//
// The subject is built here, in one pure function, so the preview the panel
// shows and the subject git receives cannot drift apart.
// See https://www.conventionalcommits.org/en/v1.0.0/.

import { assert } from '../../../shared/core/assert';
import { err, ok, type Result } from '../../../shared/core/result';

// The spec's common types, plus `content` and `style` read as a site editor
// means them. `content` is not in the spec's list at all, and the spec's
// `style` means code formatting; on a website most commits are copy, images
// and data, or a visual change, so those two words say what happened in the
// words a site editor would use. The spec allows any noun as a type.
export const COMMIT_TYPES = ['feat', 'fix', 'content', 'style', 'refactor', 'perf', 'docs', 'chore', 'build', 'ci', 'test', 'revert'] as const;
export type CommitTypeName = (typeof COMMIT_TYPES)[number];

/** One plain-English line per type, shown in the picker's rows. */
export const COMMIT_TYPE_DESCRIPTIONS = {
  feat: 'a new feature',
  fix: 'a bug fix',
  content: 'copy, images or data',
  style: 'visual or CSS change',
  refactor: 'restructure without changing behaviour',
  perf: 'faster or lighter',
  docs: 'documentation only',
  chore: 'upkeep, nothing visible changes',
  build: 'build setup or dependencies',
  ci: 'automation and checks',
  test: 'tests only',
  revert: 'undo an earlier commit',
} as const satisfies Record<CommitTypeName, string>;

// A scope names one area (`nav`, `footer`); anything longer is a sentence and
// belongs in the message.
export const COMMIT_SCOPE_LENGTH_MAX = 32;

declare const commitScopeBrand: unique symbol;
/** A scope that has passed `parseCommitScope`: non-empty, bounded, and free of the characters the subject syntax uses. */
export type CommitScope = string & { readonly [commitScopeBrand]: 'CommitScope' };

/** What the person chose: nothing, or a type with an optional scope and a breaking mark. */
export type CommitConvention =
  { readonly kind: 'none' } | { readonly kind: 'typed'; readonly type: CommitTypeName; readonly scope: CommitScope | undefined; readonly breaking: boolean };

export const COMMIT_CONVENTION_NONE: CommitConvention = { kind: 'none' };

// Whitespace, parentheses and a colon would each end the scope early or make
// the subject unparseable as `type(scope)!: message`.
const SCOPE_FORBIDDEN = /[\s():]/;

/**
 * The typed scope, checked where it is typed. Empty means no scope, which is
 * fine; anything git tooling would misread is refused with a reason to show.
 */
export function parseCommitScope(raw: string): Result<CommitScope | undefined, string> {
  const scope = raw.trim();
  if (scope.length === 0) {
    return ok(undefined);
  }
  if (scope.length > COMMIT_SCOPE_LENGTH_MAX) {
    return err(`A scope is at most ${COMMIT_SCOPE_LENGTH_MAX} characters.`);
  }
  if (SCOPE_FORBIDDEN.test(scope)) {
    return err('A scope has no spaces, parentheses or colons.');
  }
  assert(isCommitScope(scope), 'Commit scope: a checked scope satisfies the scope rules');
  return ok(scope);
}

/** The type name, or undefined for anything that is not one: storage and menus hand over plain strings. */
export function parseCommitTypeName(raw: unknown): CommitTypeName | undefined {
  if (typeof raw === 'string') {
    return COMMIT_TYPES.find((type) => type === raw);
  }
  return undefined;
}

/**
 * The subject git receives.
 *
 * With no type the trimmed message is used unchanged, so a prefix the person
 * typed themselves (`feat: x`) is left alone. With a type, a known type prefix
 * already at the front is replaced rather than stacked: `fix: x` with `feat`
 * picked becomes `feat: x`, not `feat: fix: x`. An empty message takes the
 * fallback, which then gets the chosen type like any other message.
 */
export function buildCommitSubject(message: string, convention: CommitConvention, fallback: string): string {
  assert(fallback.trim().length > 0, 'Commit subject: the fallback message is non-empty');
  assert(!fallback.includes('\n'), 'Commit subject: the fallback message is one line');
  const typed = message.trim();
  switch (convention.kind) {
    case 'none': {
      const subject = typed || fallback;
      assert(subject.length > 0, 'Commit subject: an untyped subject is non-empty');
      return subject;
    }
    case 'typed': {
      if (convention.scope !== undefined) {
        // Paired with parseCommitScope: a scope that skipped the parser is a programmer error.
        assert(parseCommitScope(convention.scope).ok, 'Commit subject: the scope was parsed');
      }
      const body = stripCommitTypePrefix(typed) || fallback;
      const scope = convention.scope === undefined ? '' : `(${convention.scope})`;
      const subject = `${convention.type}${scope}${convention.breaking ? '!' : ''}: ${body}`;
      assert(subject.startsWith(convention.type), 'Commit subject: a typed subject leads with its type');
      assert(stripCommitTypePrefix(subject) === body, 'Commit subject: the prefix is written once');
      return subject;
    }
    default: {
      const exhaustive: never = convention;
      return exhaustive;
    }
  }
}

// Only the known type names count as a prefix, so a message that merely opens
// with a word and a colon ("Note: header spacing") is never cut short.
const TYPE_PREFIX = new RegExp(`^(?:${COMMIT_TYPES.join('|')})(?:\\([^()\\s:]*\\))?!?:\\s*`, 'i');

/** The message without a leading `type(scope)!:` prefix of a known type. */
export function stripCommitTypePrefix(message: string): string {
  return message.replace(TYPE_PREFIX, '').trim();
}

// A predicate rather than a cast: the brand is earned by the same checks the parser makes.
function isCommitScope(scope: string): scope is CommitScope {
  if (scope.length === 0) {
    return false;
  }
  if (scope.length <= COMMIT_SCOPE_LENGTH_MAX) {
    return !SCOPE_FORBIDDEN.test(scope);
  }
  return false;
}
