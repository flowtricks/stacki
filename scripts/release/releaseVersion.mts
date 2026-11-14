// The versioning rule, in one place so the status and verify helpers and their tests share it.
// Releases are PATCH releases only: the next version is the last released version with its patch
// plus one (1.4.3 -> 1.4.4). The maintainer's words: "You should be releasing versions like
// 1.4.1, 1.4.2, and so on." A minor or major bump needs the maintainer to say so explicitly, and
// that is a change to this rule, not something a release agent decides.

import { assert } from '../policy/assert.mts';
import { fail, ok, type Result } from './releaseResult.mts';

export const VERSION_LIMITS = {
  /** Each component is at most six digits, so a typo cannot pass as a version. */
  componentMax: 999_999,
  /** Tags read from origin; the repository has fewer than a hundred. */
  tagCountMax: 10_000,
  tagCharsMax: 64,
} as const satisfies Record<string, number>;

export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

// No leading zeros and no prerelease or build suffix: a release tag is exactly vMAJOR.MINOR.PATCH.
const VERSION_PATTERN = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

export function parseVersion(text: string): Result<Version> {
  const match = VERSION_PATTERN.exec(text);
  if (match === null) {
    return fail('version-malformed', `"${text}" is not MAJOR.MINOR.PATCH (digits only, no leading zeros, no suffix).`);
  }
  const [, majorText, minorText, patchText] = match;
  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = Number(patchText);
  assert(Number.isSafeInteger(major), 'parseVersion: major is a safe integer');
  assert(Number.isSafeInteger(minor), 'parseVersion: minor is a safe integer');
  assert(Number.isSafeInteger(patch), 'parseVersion: patch is a safe integer');
  return ok({ major, minor, patch });
}

export function formatVersion(version: Version): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

/** The only version the next release may have: the last released one with its patch plus one. */
export function nextPatchVersion(previous: string): Result<string> {
  const parsed = parseVersion(previous);
  if (!parsed.ok) {
    return parsed;
  }
  if (parsed.value.patch >= VERSION_LIMITS.componentMax) {
    return fail('version-patch-limit', `${previous} has no next patch within the limit of ${VERSION_LIMITS.componentMax}.`);
  }
  const next = formatVersion({ ...parsed.value, patch: parsed.value.patch + 1 });
  assert(parseVersion(next).ok, 'nextPatchVersion: the result parses');
  return ok(next);
}

/** Succeeds with `next` only when it is exactly the next patch after `previous`. */
export function validatePatchBump(previous: string, next: string): Result<string> {
  const before = parseVersion(previous);
  if (!before.ok) {
    return before;
  }
  const after = parseVersion(next);
  if (!after.ok) {
    return after;
  }
  const expected = nextPatchVersion(previous);
  if (!expected.ok) {
    return expected;
  }
  const rule = `Releases are patch releases only: after ${previous} comes ${expected.value}.`;
  if (after.value.major !== before.value.major) {
    return fail('bump-major', `${previous} -> ${next} is a major bump. ${rule} Only the maintainer can change this rule.`);
  }
  if (after.value.minor !== before.value.minor) {
    return fail('bump-minor', `${previous} -> ${next} is a minor bump. ${rule} Only the maintainer can change this rule.`);
  }
  if (after.value.patch === before.value.patch) {
    return fail('bump-same', `${next} is the version already released. ${rule}`);
  }
  if (after.value.patch < before.value.patch) {
    return fail('bump-downgrade', `${next} is older than the released ${previous}. ${rule}`);
  }
  if (next !== expected.value) {
    return fail('bump-skipped', `${previous} -> ${next} skips a patch number. ${rule}`);
  }
  return ok(next);
}

/** The highest vMAJOR.MINOR.PATCH among tag names; other tags are ignored. */
export function latestReleasedVersion(tagNames: readonly string[]): Result<string> {
  if (tagNames.length > VERSION_LIMITS.tagCountMax) {
    return fail('tags-limit', `More than ${VERSION_LIMITS.tagCountMax} tags; refusing to guess the latest.`);
  }
  let latest: Version | undefined;
  for (const name of tagNames) {
    if (name.length > VERSION_LIMITS.tagCharsMax || !name.startsWith('v')) {
      continue;
    }
    const parsed = parseVersion(name.slice(1));
    if (!parsed.ok) {
      continue;
    }
    if (latest === undefined || compareVersions(parsed.value, latest) > 0) {
      latest = parsed.value;
    }
  }
  if (latest === undefined) {
    return fail('tags-none', 'No vMAJOR.MINOR.PATCH release tag found.');
  }
  return ok(formatVersion(latest));
}

function compareVersions(left: Version, right: Version): number {
  if (left.major !== right.major) {
    return left.major - right.major;
  }
  if (left.minor !== right.minor) {
    return left.minor - right.minor;
  }
  return left.patch - right.patch;
}
