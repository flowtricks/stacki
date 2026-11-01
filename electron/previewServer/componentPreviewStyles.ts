// Import stylesheet entry points so layered imports keep their authored cascade.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assert } from '../../shared/core/assert';

export function componentPreviewStylesModule(projectDirectory: string): string {
  const sources = componentPreviewStyleSources(projectDirectory);
  const entries = componentPreviewStylePaths(sources);
  assert(entries.length <= Object.keys(sources).length, 'Preview styles must belong to the project');
  assert(new Set(entries).size === entries.length, 'Preview style entries must be unique');
  return entries.map((file) => `import ${JSON.stringify(file)};`).join('\n');
}

export function componentPreviewStylePaths(sources: Readonly<Record<string, string>>): readonly string[] {
  const paths = Object.keys(sources);
  if (paths.length > 1024) {
    throw new Error('Preview stylesheet count exceeds limit');
  }
  const imported = new Set<string>();
  let sourceChars = 0;
  for (const file of paths) {
    const source = sources[file];
    if (typeof source !== 'string') {
      throw new Error('Preview stylesheet: expected source text');
    }
    sourceChars += source.length;
    if (sourceChars > 10 * 1024 * 1024) {
      throw new Error('Preview stylesheets exceed source limit');
    }
    // Consume comments and strings as whole tokens so examples inside them cannot
    // remove a real entry point. Import tokens capture their own quoted paths.
    const imports = new RegExp(
      String.raw`\/\*[\s\S]*?\*\/|"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|` +
        String.raw`@(?:import|use|forward)\s*(?:["']([^"']+)["']|` +
        String.raw`url\(\s*(?:["']([^"']+)["']|([^)\s]+))\s*\))`,
      'gi',
    );
    for (const match of source.matchAll(imports)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (specifier === undefined) {
        continue;
      }
      const target = new URL(specifier.replace(/^[@~]\//, '/src/'), new URL(file, 'https://preview'));
      if (target.origin !== 'https://preview') {
        continue;
      }
      const pathname = target.pathname;
      const extension = /\.(css|scss)$/.test(pathname) ? '' : '.scss';
      const candidates = [pathname, pathname + extension, pathname.replace(/([^/]+)$/, '_$1') + extension];
      for (const candidate of candidates) {
        if (Object.hasOwn(sources, candidate)) {
          imported.add(candidate);
        }
      }
    }
  }
  const entries = paths.filter((file) => !imported.has(file));
  if (paths.length > 0 && entries.length === 0) {
    throw new Error('Preview stylesheets have no entry point');
  }
  return entries;
}

function componentPreviewStyleSources(projectDirectory: string): Readonly<Record<string, string>> {
  const root = path.join(projectDirectory, 'src/styles');
  if (!fs.existsSync(root)) {
    return {};
  }
  // Bound the directory queue and total bytes before allocating stylesheet contents.
  const directories = [root];
  const sources: Record<string, string> = {};
  let entriesCount = 0;
  let sourceBytes = 0;
  for (let index = 0; index < directories.length; index++) {
    const directory = directories[index];
    assert(directory !== undefined, 'Preview style directory must exist in the queue');
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    entriesCount += entries.length;
    assert(entriesCount <= 4096, 'Preview stylesheet directory entries exceed limit');
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        assert(directories.length < 128, 'Preview stylesheet directories exceed limit');
        directories.push(file);
      } else if (entry.isFile() && /\.(css|scss)$/.test(entry.name)) {
        sourceBytes += fs.statSync(file).size;
        assert(sourceBytes <= 10 * 1024 * 1024, 'Preview stylesheets exceed source limit');
        assert(Object.keys(sources).length < 1024, 'Preview stylesheet count exceeds limit');
        const key = '/' + path.relative(projectDirectory, file).split(path.sep).join('/');
        sources[key] = fs.readFileSync(file, 'utf8');
      }
    }
  }
  return sources;
}
