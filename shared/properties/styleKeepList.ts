// The project's `.stacki/styles.json`: class and id names the unused-selector
// cleanup must never remove, and remote scripts the owner vouches do not add
// classes. Both are tracked project settings, shared by Desktop, Studio and the
// `check-project` command, so every tool answers "may this go?" the same way.
import { assert } from '../core/assert';
import { list, record, text } from '../core/boundary';

export const STYLE_KEEP_LIMITS = {
  /** Patterns in one keep list. A design system's state classes fit in dozens. */
  patternsMax: 1_000,
  /** Characters in one pattern: a class name with room for a wildcard. */
  patternCharsMax: 128,
  /** Remote script prefixes one project trusts. */
  trustedScriptsMax: 64,
  /** Characters in one trusted script prefix: a URL up to its path. */
  trustedScriptCharsMax: 512,
} as const satisfies Record<string, number>;

export interface StyleKeepList {
  readonly version: 1;
  /** Class or id names, `*` matching any run of characters (`is-*`). */
  readonly keep: readonly string[];
  /** URL prefixes of remote scripts that are known not to add classes. */
  readonly trustedScripts: readonly string[];
}

export const EMPTY_KEEP_LIST: StyleKeepList = { version: 1, keep: [], trustedScripts: [] };

// A pattern is a selector name as it appears unescaped in markup. Whitespace,
// quotes and commas would let one entry silently mean several names.
const PATTERN = /^[^\s"'`,{}<>]+$/;

export function parseStyleKeepList(input: unknown): StyleKeepList {
  const value = record(input);
  if (value['version'] !== 1) {
    throw new Error('Unsupported styles settings version');
  }
  const keep = value['keep'] === undefined ? [] : list(keepPattern)(value['keep']);
  if (keep.length > STYLE_KEEP_LIMITS.patternsMax) {
    throw new Error(`Keep list exceeds ${STYLE_KEEP_LIMITS.patternsMax} patterns`);
  }
  const trustedScripts = value['trustedScripts'] === undefined ? [] : list(trustedScript)(value['trustedScripts']);
  if (trustedScripts.length > STYLE_KEEP_LIMITS.trustedScriptsMax) {
    throw new Error(`Trusted scripts exceed ${STYLE_KEEP_LIMITS.trustedScriptsMax} entries`);
  }
  return { version: 1, keep, trustedScripts };
}

/** The keep list as JSON text, in the stable shape a diff reviews easily. */
export function serializeStyleKeepList(keepList: StyleKeepList): string {
  const keep = [...new Set(keepList.keep)].sort();
  const trustedScripts = [...new Set(keepList.trustedScripts)].sort();
  const source = JSON.stringify({ version: 1, keep, trustedScripts }, undefined, 2) + '\n';
  // Pair assertion: what is written must read back as the same list.
  const written: unknown = JSON.parse(source);
  const reread = parseStyleKeepList(written);
  assert(reread.keep.length === keep.length, 'serializeStyleKeepList: keep patterns round-trip');
  assert(reread.trustedScripts.length === trustedScripts.length, 'serializeStyleKeepList: trusted scripts round-trip');
  return source;
}

/** A matcher for the keep list's patterns; exact names are a set lookup. */
export function keepMatcher(keepList: StyleKeepList): (name: string) => boolean {
  const exact = new Set<string>();
  const wildcards: RegExp[] = [];
  for (const pattern of keepList.keep) {
    if (pattern.includes('*')) {
      const body = pattern
        .split('*')
        .map((part) => part.replace(/[\\^$.+?()[\]{}|/]/g, '\\$&'))
        .join('.*');
      wildcards.push(new RegExp(`^${body}$`));
    } else {
      exact.add(pattern);
    }
  }
  assert(exact.size + wildcards.length <= STYLE_KEEP_LIMITS.patternsMax, 'keepMatcher: the parser bounds patterns');
  return (name) => {
    if (exact.has(name)) {
      return true;
    }
    return wildcards.some((wildcard) => wildcard.test(name));
  };
}

function keepPattern(input: unknown): string {
  const value = text(input);
  if (value.length === 0 || value.length > STYLE_KEEP_LIMITS.patternCharsMax) {
    throw new Error(`Keep patterns must be 1 to ${STYLE_KEEP_LIMITS.patternCharsMax} characters`);
  }
  if (!PATTERN.test(value)) {
    throw new Error(`Keep pattern "${value}" contains whitespace, quotes or commas`);
  }
  if (value.replaceAll('*', '').length === 0) {
    throw new Error('A keep pattern must name more than a wildcard');
  }
  return value;
}

function trustedScript(input: unknown): string {
  const value = text(input);
  if (value.length > STYLE_KEEP_LIMITS.trustedScriptCharsMax) {
    throw new Error('Trusted script prefix is too long');
  }
  // A prefix must name a host, or "https://" alone would trust every script.
  if (!/^https:\/\/[^/\s]+\//.test(value)) {
    throw new Error('Trusted scripts must be https:// prefixes ending after a host and slash');
  }
  return value;
}
