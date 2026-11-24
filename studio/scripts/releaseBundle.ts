import { projectScripts } from './projectScripts';
import { RELEASE_DIRECTORIES, RELEASE_EXCLUDED_FILES, RELEASE_FILES } from './releaseFiles';
import { RELEASE_COMMENT_FILE, stripReleaseComments } from './releaseComments';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseRelease, releaseVersion, RELEASE_BYTES_MAX, RELEASE_FILES_MAX, type StudioRelease } from '../src/features/updates/release';
import { record } from '../src/shared/validation';

// The release file, built in memory so `release.ts` writes it and test/releaseSize.test.ts
// measures exactly the bytes that ship.

// Every Desktop and Studio already installed reads at most RELEASE_BYTES_MAX (32,000,000) bytes
// of release JSON, and that bound is fixed in their code: a larger file can never reach them.
// The release must stay a full megabyte under it, so growth is caught by the test gate one
// release early instead of by users whose update fails (1.4.18 shipped 32,255,496 bytes).
export const RELEASE_SERIALIZED_BYTES_TARGET = 31_000_000;
assertBundle(RELEASE_SERIALIZED_BYTES_TARGET < RELEASE_BYTES_MAX, 'The release target sits under the limit installed clients enforce');

/** The Studio release for the tree at `root`, as installers parse it. */
export async function buildRelease(root: string): Promise<StudioRelease> {
  const excluded: ReadonlySet<string> = new Set(RELEASE_EXCLUDED_FILES);
  const version = releaseVersion(record(JSON.parse(await readFile(path.join(root, 'src/shared/release.json'), 'utf8')))['version']);
  const files: { path: string; content: string }[] = [];
  async function collect(relative: string): Promise<void> {
    if (relative.split('/').length > 20) {
      throw new Error('Release tree is too deep');
    }
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries) {
      const file = path.posix.join(relative, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error('Release source must not contain symlinks');
      }
      if (entry.isDirectory()) {
        await collect(file);
      } else if (excluded.has(file)) {
        continue;
      } else {
        if (files.length >= RELEASE_FILES_MAX) {
          throw new Error('Release file limit exceeded');
        }
        const content = await readFile(path.join(root, file), 'utf8');
        files.push({ path: file, content: RELEASE_COMMENT_FILE.test(file) ? stripReleaseComments(file, content) : content });
      }
    }
  }
  for (const directory of RELEASE_DIRECTORIES) {
    await collect(directory);
  }
  for (const file of RELEASE_FILES) {
    files.push({ path: file, content: releaseRootFile(file, version, await readFile(path.join(root, file), 'utf8')) });
  }
  return parseRelease({
    format: 1,
    version,
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
  });
}

/** The bytes the release file holds; this, not the sum of file contents, is what clients bound. */
export function serializeRelease(release: StudioRelease): string {
  const text = JSON.stringify(release);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > RELEASE_BYTES_MAX) {
    throw new Error(`Studio release is ${bytes} bytes; installed Desktop and Studio refuse more than ${RELEASE_BYTES_MAX}`);
  }
  return text;
}

function releaseRootFile(file: string, version: string, text: string): string {
  if (file === 'package.json' || file === 'package-lock.json') {
    const value = record(JSON.parse(text));
    value['version'] = version;
    if (file === 'package.json') {
      value['scripts'] = projectScripts;
    }
    if (file === 'package-lock.json') {
      record(record(value['packages'])[''])['version'] = version;
    }
    return JSON.stringify(value, null, 2) + '\n';
  }
  if (file === '.gitignore') {
    return text.replace('vendor/stacki/\n', '');
  }
  return text;
}

function assertBundle(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}
