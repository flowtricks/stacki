// Only explicitly configured packages may contribute read-only component source.
// Canonical containment permits pnpm/workspace package links without following links
// within a package or widening the editor's write boundary.
import fs from 'node:fs';
import path from 'node:path';
import { assert } from '../../shared/core/assert';
import { runSync, type SlicedWork } from './slicedWork';
import { COMPONENT_SOURCE_FILE, componentSourceRoot, parseComponentSources, type PackageComponentSource } from '../../shared/properties/componentSources';

export function readComponentSources(root: string): readonly PackageComponentSource[] {
  const file = path.join(root, COMPONENT_SOURCE_FILE);
  if (!fs.existsSync(file)) {
    return [];
  }
  if (fs.lstatSync(file).isSymbolicLink() || fs.lstatSync(path.dirname(file)).isSymbolicLink()) {
    throw new Error('Component source settings cannot be symbolic links.');
  }
  const input: unknown = JSON.parse(readUtf8(file));
  return parseComponentSources(input).sources;
}

/**
 * Every component file in the configured packages, written once for both
 * drivers (slicedWork.ts). A package can hold any number of components, so
 * there is no cap on files, folders or bytes: the queue ends when the tree does,
 * and each folder is a unit the sliced driver may yield after.
 */
export function* packageComponentFilesSliced(root: string): SlicedWork<readonly string[]> {
  const files: string[] = [];
  const queue = readComponentSources(root).map(componentSourceRoot);
  for (let index = 0; index < queue.length; index++) {
    const directory = queue[index];
    assert(directory !== undefined, 'Package scan queue entry exists');
    const absolute = packageSourcePath(root, directory);
    const entries = fs.readdirSync(absolute, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }
      if (entry.isSymbolicLink()) {
        throw new Error('Links within component packages are not supported.');
      }
      const file = directory + '/' + entry.name;
      if (entry.isDirectory()) {
        queue.push(file);
      } else if (entry.isFile() && file.endsWith('.astro')) {
        files.push(file);
      }
    }
    // Every queued folder is one found below a folder already read, so the queue ends with the tree.
    assert(queue.length >= index + 1, 'Package scan: the queue only grows by folders found');
    yield;
  }
  return files.sort();
}

export function packageComponentFiles(root: string): readonly string[] {
  return runSync(packageComponentFilesSliced(root));
}

export function readPackageSource(root: string, file: string): string {
  return readUtf8(packageSourcePath(root, file));
}

export function readPackagePreviews(root: string) {
  return packageComponentFiles(root).map((file) => {
    const importPath = packageComponentImport(root, file);
    assert(importPath !== undefined, 'Scanned package component has an import');
    return { file, importPath, source: readPackageSource(root, file) };
  });
}

export function packageSourcePath(root: string, file: string): string {
  const source = readComponentSources(root).find((entry) => file.startsWith(`node_modules/${entry.package}/`));
  if (!source || file.split('/').some((segment) => segment === '..' || segment === '.')) {
    throw new Error('Source is outside configured component packages.');
  }
  const packageRoot = fs.realpathSync(path.join(root, 'node_modules', source.package));
  const relative = file.slice(`node_modules/${source.package}/`.length);
  let current = packageRoot;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error('Links within component packages are not supported.');
    }
  }
  const actual = fs.realpathSync(current);
  assert(actual.startsWith(packageRoot + path.sep), 'Package source stays inside its package');
  assert(relative.length <= 500, 'Package source path is bounded');
  return actual;
}

export function packageComponentImport(root: string, file: string): string | undefined {
  const relative = path.isAbsolute(file) ? path.relative(root, file).split(path.sep).join('/') : file;
  const source = readComponentSources(root).find((entry) => relative.startsWith(componentSourceRoot(entry) + '/'));
  if (!source) {
    return undefined;
  }
  packageSourcePath(root, relative);
  return source.importPrefix + relative.slice(componentSourceRoot(source).length + 1);
}

// A source of any size is read whole: the platform's string length is the only ceiling.
function readUtf8(file: string): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(fs.readFileSync(file));
}
