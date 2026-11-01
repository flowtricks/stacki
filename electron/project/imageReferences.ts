import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { toDigest } from '../../shared/core/brand';
import { LIMITS } from '../../shared/core/limits';
import { readSource } from '../lib/mainLimits';
import { isPathWithin } from '../lib/platform';
export type ImageAliases = readonly (readonly [string, readonly string[]])[];

export interface ImageReferenceEdit {
  readonly file: string;
  readonly before: string;
  readonly after: string;
}
const TEXT_FILE = /\.(astro|[cm]?[jt]sx?|mdx?|css|scss|sass|less|html|json|ya?ml|toml)$/i;
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'studio', 'vendor']);
const TOTAL_BYTES_MAX = 64 * 1024 * 1024;

export function planImageReferences(projectPath: string, from: string, to: string, aliases: ImageAliases) {
  if (aliases.length > 100 || aliases.reduce((count, [, targets]) => count + targets.length, 0) > 1000) {
    throw new Error('Too many path aliases for image conversion.');
  }
  const files = sourceFiles(projectPath);
  const edits: ImageReferenceEdit[] = [];
  let bytes = 0;
  for (const file of files) {
    bytes += fs.statSync(file).size;
    if (bytes > TOTAL_BYTES_MAX) {
      throw new Error('Project text exceeds the 64 MB conversion limit.');
    }
    const before = readSource(file);
    const after = rewriteImageReferences(before, file, projectPath, from, to, aliases);
    if (before !== after) {
      edits.push({ file, before, after });
    }
    if (edits.length > LIMITS.documentActorsMax) {
      throw new Error('Too many files reference this image; convert a smaller project.');
    }
  }
  return edits;
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
function sourceFiles(projectPath: string): readonly string[] {
  const pending = [projectPath];
  const files: string[] = [];
  let visited = 0;
  for (let index = 0; index < pending.length; index++) {
    const directory = pending[index];
    if (directory === undefined) {
      throw new Error('Missing scan directory.');
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (++visited > LIMITS.scanEntriesMax) {
        throw new Error('Project scan exceeds 10,000 entries.');
      }
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
  }
  return files;
}
