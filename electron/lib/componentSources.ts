// Only explicitly configured packages may contribute read-only component source.
// Canonical containment permits pnpm/workspace package links without following links
// within a package or widening the editor's write boundary.
import fs from 'node:fs';
import path from 'node:path';
import { assert } from '../../shared/core/assert';
import {
  COMPONENT_SOURCE_FILE,
  COMPONENT_SOURCE_LIMITS,
  componentSourceRoot,
  parseComponentSources,
  type PackageComponentSource,
} from '../../shared/properties/componentSources';

export function readComponentSources(root: string): readonly PackageComponentSource[] {
  const file = path.join(root, COMPONENT_SOURCE_FILE);
  if (!fs.existsSync(file)) {
    return [];
  }
  if (fs.lstatSync(file).isSymbolicLink() || fs.lstatSync(path.dirname(file)).isSymbolicLink()) {
    throw new Error('Component source settings cannot be symbolic links.');
  }
  const input: unknown = JSON.parse(readBounded(file, COMPONENT_SOURCE_LIMITS.configBytesMax));
  return parseComponentSources(input).sources;
}

export function packageComponentFiles(root: string): readonly string[] {
  const files: string[] = [];
  let sizeBytes = 0;
  const queue = readComponentSources(root).map(componentSourceRoot);
  for (let index = 0; index < queue.length; index++) {
    if (queue.length > COMPONENT_SOURCE_LIMITS.directoriesMax) {
      throw new Error('Package component directory limit exceeded.');
    }
    const directory = queue[index];
    assert(directory !== undefined, 'Package scan queue entry exists');
    const absolute = packageSourcePath(root, directory);
    const entries = fs.readdirSync(absolute, { withFileTypes: true });
    if (entries.length > COMPONENT_SOURCE_LIMITS.filesMax) {
      throw new Error('Package component directory is too large.');
    }
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
        sizeBytes += fs.statSync(path.join(absolute, entry.name)).size;
        if (sizeBytes > COMPONENT_SOURCE_LIMITS.sourceBytesTotalMax) {
          throw new Error('Package component sources exceed the 16 MiB scan limit.');
        }
        files.push(file);
      }
      if (files.length > COMPONENT_SOURCE_LIMITS.filesMax) {
        throw new Error('Package component file limit exceeded.');
      }
    }
  }
  assert(files.length <= COMPONENT_SOURCE_LIMITS.filesMax, 'Package scan is bounded');
  return files.sort();
}

export function readPackageSource(root: string, file: string): string {
  return readBounded(packageSourcePath(root, file), COMPONENT_SOURCE_LIMITS.sourceBytesMax);
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

function readBounded(file: string, maximum: number): string {
  if (fs.statSync(file).size > maximum) {
    throw new Error('Component source exceeds its byte limit.');
  }
  const bytes = fs.readFileSync(file);
  if (bytes.length > maximum) {
    throw new Error('Component source exceeds its byte limit.');
  }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
}
