// Package locations and import spelling are separate: an alias must never turn an
// installed component into an editable local file with the same display name.
import { record, text } from '../core/boundary';

export const COMPONENT_SOURCE_FILE = '.stacki/component-sources.json';
export const COMPONENT_SOURCE_LIMITS = {
  sourcesMax: 16,
  filesMax: 10000,
  directoriesMax: 1000,
  sourceBytesMax: 1024 * 1024,
  sourceBytesTotalMax: 16 * 1024 * 1024,
  configBytesMax: 16384,
} as const;

export interface PackageComponentSource {
  readonly kind: 'package';
  readonly package: string;
  readonly directory: string;
  readonly importPrefix: string;
}

export interface ComponentSources {
  readonly version: 1;
  readonly sources: readonly PackageComponentSource[];
}

export type ComponentOrigin = { readonly kind: 'local' } | { readonly kind: 'package'; readonly package: string; readonly importPath: string };

export function parseComponentSources(input: unknown): ComponentSources {
  const value = record(input);
  if (value['version'] !== 1) {
    throw new Error('Unsupported component sources version.');
  }
  const sources = value['sources'];
  if (!Array.isArray(sources) || sources.length > COMPONENT_SOURCE_LIMITS.sourcesMax) {
    throw new Error('Component sources must contain at most 16 entries.');
  }
  const parsed = sources.map(parsePackageComponentSource);
  for (const [index, source] of parsed.entries()) {
    for (const previous of parsed.slice(0, index)) {
      if (source.importPrefix.startsWith(previous.importPrefix) || previous.importPrefix.startsWith(source.importPrefix)) {
        throw new Error('Component import prefixes must not overlap.');
      }
      const currentRoot = componentSourceRoot(source) + '/';
      const previousRoot = componentSourceRoot(previous) + '/';
      if (currentRoot.startsWith(previousRoot) || previousRoot.startsWith(currentRoot)) {
        throw new Error('Component source directories must not overlap.');
      }
    }
  }
  return { version: 1, sources: parsed };
}

export function parseComponentOrigin(input: unknown): ComponentOrigin {
  if (input === undefined) {
    return { kind: 'local' };
  }
  const value = record(input);
  if (value['kind'] === 'local') {
    return { kind: 'local' };
  }
  if (value['kind'] !== 'package') {
    throw new Error('Unknown component origin.');
  }
  const importPath = componentImportPath(value['importPath']);
  return { kind: 'package', package: packageName(value['package']), importPath };
}

export function componentSourceRoot(source: PackageComponentSource): string {
  return `node_modules/${source.package}/${source.directory}`;
}

export function componentImportPath(input: unknown): string {
  const value = text(input);
  if (value.length > 500 || !/^(?:@\/|@?[\w-])[\w@./-]*\.astro$/.test(value)) {
    throw new Error('Expected a bounded component import specifier.');
  }
  if (value.split('/').some((segment) => segment === '..' || segment === '.')) {
    throw new Error('Component imports cannot traverse directories.');
  }
  return value;
}

function parsePackageComponentSource(input: unknown): PackageComponentSource {
  const value = record(input);
  if (value['kind'] !== 'package') {
    throw new Error('Component sources currently support installed packages.');
  }
  const directory = text(value['directory']);
  if (directory.length > 300 || !/^[\w-]+(?:\/[\w-]+)*$/.test(directory)) {
    throw new Error('Component source directory must be relative to its package.');
  }
  const importPrefix = text(value['importPrefix']);
  componentImportPath(importPrefix + 'Component.astro');
  if (!importPrefix.endsWith('/')) {
    throw new Error('Component import prefix must end with a slash.');
  }
  return { kind: 'package', package: packageName(value['package']), directory, importPrefix };
}

function packageName(input: unknown): string {
  const value = text(input);
  if (value.length > 214 || !/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/.test(value)) {
    throw new Error('Invalid component package name.');
  }
  return value;
}
