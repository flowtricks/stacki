// Every file a release bump rewrites, in one typed list, with the code that reads and writes the
// version in each. The list is derived from the 1.4.2 and 1.4.3 bump commits
// (`git show --stat 8f8eaa0f ad828169`): the same six version files plus the release notes, every
// time. releaseStatus.mts builds its "only version files changed" rule from this list too, so the
// files a bump may touch and the files a bump does touch cannot drift apart.
//
// Writes are textual, not JSON.stringify: each file keeps its exact formatting and key order, and
// only the version string changes. A write is then read back as JSON and compared field by field
// (prepare.mts), so a pattern that matched the wrong line fails loudly instead of shipping.

import { assert } from '../policy/assert.mts';
import { parseRecord, readRecord, readString } from './releaseJson.mts';
import { fail, ok, type Result } from './releaseResult.mts';
import { parseVersion } from './releaseVersion.mts';

/** How the version is stored in a file: which JSON fields hold it. */
export type VersionFileKind = 'package-json' | 'package-lock' | 'release-json';

export interface VersionFile {
  readonly path: string;
  readonly kind: VersionFileKind;
}

export const VERSION_FILES = [
  { path: 'package.json', kind: 'package-json' },
  { path: 'package-lock.json', kind: 'package-lock' },
  { path: 'packages/create-stacki/package.json', kind: 'package-json' },
  { path: 'studio/package.json', kind: 'package-json' },
  { path: 'studio/package-lock.json', kind: 'package-lock' },
  { path: 'studio/src/shared/release.json', kind: 'release-json' },
] as const satisfies readonly VersionFile[];

export const RELEASE_NOTES_FILE = 'docs/releases.md';

/** Every path a release bump commit may contain, and nothing else. */
export const RELEASE_BUMP_PATHS: readonly string[] = [...VERSION_FILES.map((file) => file.path), RELEASE_NOTES_FILE];

export const MANIFEST_LIMITS = {
  /** The largest version file is a lockfile of a few megabytes. */
  fileCharsMax: 16 * 1024 * 1024,
} as const satisfies Record<string, number>;

// The top-level "version" of a JSON file Prettier or npm wrote: exactly two spaces of indent.
const TOP_LEVEL_VERSION = /^( {2}"version": ")([^"\n]*)(",?)$/m;
// A lockfile's root package is written by npm as `"packages": { "": {` at these indents.
const LOCK_ROOT_PACKAGE = '\n  "packages": {\n    "": {\n';
const LOCK_ROOT_VERSION = /^( {6}"version": ")([^"\n]*)(",?)$/m;

/** Each version a file holds, by field, as JSON reads it. A lockfile holds two. */
export function readVersions(file: VersionFile, text: string): Result<readonly string[]> {
  if (text.length > MANIFEST_LIMITS.fileCharsMax) {
    return fail('manifest-too-large', `${file.path}: larger than ${MANIFEST_LIMITS.fileCharsMax} characters.`);
  }
  const record = parseRecord(text, file.path);
  if (!record.ok) {
    return record;
  }
  const root = readString(record.value, 'version', file.path);
  if (!root.ok) {
    return root;
  }
  switch (file.kind) {
    case 'package-json':
    case 'release-json':
      return ok([root.value]);
    case 'package-lock': {
      const packages = readRecord(record.value['packages'], `${file.path} packages`);
      if (!packages.ok) {
        return packages;
      }
      const rootPackage = readRecord(packages.value[''], `${file.path} packages[""]`);
      if (!rootPackage.ok) {
        return rootPackage;
      }
      const packageVersion = readString(rootPackage.value, 'version', `${file.path} packages[""]`);
      return packageVersion.ok ? ok([root.value, packageVersion.value]) : packageVersion;
    }
    default: {
      const exhaustive: never = file.kind;
      return exhaustive;
    }
  }
}

/**
 * The file's text with every version field set to `version`, every other byte unchanged. A
 * pattern that finds no field is a failure value: the file's layout is not what npm writes.
 */
export function writeVersion(file: VersionFile, text: string, version: string): Result<string> {
  assert(parseVersion(version).ok, 'writeVersion: the version is MAJOR.MINOR.PATCH');
  const rootReplaced = replaceFirst(text, TOP_LEVEL_VERSION, version);
  if (rootReplaced === undefined) {
    return fail('manifest-layout', `${file.path}: no top-level "version" line at two spaces of indent.`);
  }
  switch (file.kind) {
    case 'package-json':
    case 'release-json':
      return ok(rootReplaced);
    case 'package-lock': {
      const start = rootReplaced.indexOf(LOCK_ROOT_PACKAGE);
      if (start < 0) {
        return fail('manifest-layout', `${file.path}: no "packages" root entry in npm's layout.`);
      }
      const head = rootReplaced.slice(0, start + LOCK_ROOT_PACKAGE.length);
      const rest = rootReplaced.slice(start + LOCK_ROOT_PACKAGE.length);
      // The root package's own fields come before its first nested object closes.
      const end = rest.indexOf('\n    }');
      const block = end < 0 ? rest : rest.slice(0, end);
      const replaced = replaceFirst(block, LOCK_ROOT_VERSION, version);
      if (replaced === undefined) {
        return fail('manifest-layout', `${file.path}: the root package has no "version" line.`);
      }
      return ok(head + replaced + (end < 0 ? '' : rest.slice(end)));
    }
    default: {
      const exhaustive: never = file.kind;
      return exhaustive;
    }
  }
}

function replaceFirst(text: string, pattern: RegExp, version: string): string | undefined {
  assert(!pattern.global, 'replaceFirst: a non-global pattern replaces one line');
  if (!pattern.test(text)) {
    return undefined;
  }
  return text.replace(pattern, (_line, before: string, _old: string, after: string) => `${before}${version}${after}`);
}
