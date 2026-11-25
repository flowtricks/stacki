import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { toDigest } from '../../shared/core/brand';
import { assert } from '../../shared/core/assert';
import { readSource } from '../lib/mainLimits';
import { runSliced, runSync, type SlicedWork } from '../lib/slicedWork';
import { isPathWithin } from '../lib/platform';
export type ImageAliases = readonly (readonly [string, readonly string[]])[];

export interface ImageReferenceEdit {
  readonly file: string;
  readonly before: string;
  readonly after: string;
}
const TEXT_FILE = /\.(astro|[cm]?[jt]sx?|mdx?|css|scss|sass|less|html|json|ya?ml|toml)$/i;
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'studio', 'vendor']);

// No size limit (owner requirement): a project of any number of files, of any
// size, is scanned in full and every file that references the image is edited.
// The scan is one generator so it runs two ways from one body: sliced, for the
// converter that shares the main thread with the window, and synchronously, for
// callers that already block.
function* imageReferenceWork(projectPath: string, from: string, to: string, aliases: ImageAliases): SlicedWork<readonly ImageReferenceEdit[]> {
  const edits: ImageReferenceEdit[] = [];
  const files = yield* sourceFilesWork(projectPath);
  for (const file of files) {
    const before = readSource(file);
    const after = rewriteImageReferences(before, file, projectPath, from, to, aliases);
    if (before !== after) {
      edits.push({ file, before, after });
    }
    yield;
  }
  assert(edits.length <= files.length, 'Every edited file was scanned');
  return edits;
}

/** The edits that point every reference to `from` at `to`, computed in one go. */
export function planImageReferences(projectPath: string, from: string, to: string, aliases: ImageAliases): readonly ImageReferenceEdit[] {
  return runSync(imageReferenceWork(projectPath, from, to, aliases));
}

/** The same edits, returning to the event loop between files and folders. */
export function planImageReferencesSliced(projectPath: string, from: string, to: string, aliases: ImageAliases): Promise<readonly ImageReferenceEdit[]> {
  return runSliced(imageReferenceWork(projectPath, from, to, aliases));
}

export function rewriteImageReferences(source: string, file: string, projectPath: string, from: string, to: string, aliases: ImageAliases = []): string {
  const relative = (target: string) => path.relative(path.dirname(file), target).split(path.sep).join('/');
  const pairs: Array<readonly [string, string]> = [[relative(from), relative(to)]];
  if (!relative(from).startsWith('.')) {
    pairs.push([`./${relative(from)}`, `./${relative(to)}`]);
  }
  const publicRoot = path.join(projectPath, 'public');
  if (isPathWithin(publicRoot, from)) {
    pairs.push(['/' + path.relative(publicRoot, from).split(path.sep).join('/'), '/' + path.relative(publicRoot, to).split(path.sep).join('/')]);
  }
  for (const [prefix, targets] of aliases) {
    for (const target of targets) {
      const root = path.resolve(projectPath, target);
      if (isPathWithin(root, from)) {
        pairs.push([prefix + path.relative(root, from).split(path.sep).join('/'), prefix + path.relative(root, to).split(path.sep).join('/')]);
      }
    }
  }
  let result = source;
  for (const [before, after] of pairs) {
    for (const encode of [(value: string) => value, encodedPath]) {
      const escaped = encode(before).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Boundaries exclude longer filenames, remote URLs and embedded identifiers.
      const pattern = new RegExp('(^|[\\s"\'`(=])' + escaped + '(?=[\\s"\'`)<>?#,;\\]}]|$)', 'gm');
      result = result.replace(pattern, (_match, prefix: string) => prefix + encode(after));
    }
  }
  return result;
}

export function imageReferenceDigest(source: string) {
  return toDigest(createHash('sha256').update(source).digest('hex'));
}
function encodedPath(value: string): string {
  return value
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}
// Links are not followed (a Dirent for a link is neither a directory nor a file),
// so the walk cannot cycle: it ends within the number of folders it discovers.
function* sourceFilesWork(projectPath: string): SlicedWork<readonly string[]> {
  const pending = [projectPath];
  const files: string[] = [];
  for (let index = 0; index < pending.length; index++) {
    const directory = pending[index];
    assert(directory !== undefined, 'The scan stays inside its queue');
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || SKIP.has(entry.name)) {
        continue;
      }
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(file);
      } else if (entry.isFile() && TEXT_FILE.test(entry.name)) {
        files.push(file);
      }
    }
    yield;
  }
  return files;
}
