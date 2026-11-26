// How one package of a workspace names a file of another it depends on: through the other's `exports`, or by its path
// when it declares none. A relative path across packages is never suggested.
import { toRecord } from '../../../shared/core/record';
import { CODE_INTEL_LIMITS } from '../../../shared/ipc/codeIntel';
import { readText } from './fileCache';
import { folderOf, relativeSpecifier, within } from './paths';

export interface PackageManifest {
  readonly name: string | undefined;
  readonly exports: unknown;
  readonly dependencies: readonly string[];
}

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;
const DEPENDENCIES_MAX = 500;
const EXPORTS_MAX = 500;

export function packageManifest(folder: string): PackageManifest | undefined {
  const text = readText(`${folder}/package.json`, CODE_INTEL_LIMITS.styleFileBytesMax);
  if (text === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A package.json being edited says nothing yet.
    return undefined;
  }
  const manifest = toRecord(parsed);
  if (manifest === undefined) {
    return undefined;
  }
  const name = manifest['name'];
  return {
    name: typeof name === 'string' ? name : undefined,
    exports: manifest['exports'],
    dependencies: DEPENDENCY_FIELDS.flatMap((field) => Object.keys(toRecord(manifest[field]) ?? {})).slice(0, DEPENDENCIES_MAX),
  };
}

/** The specifier a package depending on `owner` writes for `file`; undefined when `owner` does not export it. */
export function exportedSpecifier(owner: PackageManifest, folder: string, file: string): string | undefined {
  if (owner.name === undefined || !within(folder, file)) {
    return undefined;
  }
  const relative = relativeSpecifier(folder, file);
  if (owner.exports === undefined) {
    return `${owner.name}/${relative.slice(2)}`;
  }
  const entries = toRecord(owner.exports);
  for (const [key, value] of Object.entries(entries ?? {}).slice(0, EXPORTS_MAX)) {
    const target = exportTarget(value);
    if (target === undefined || !key.startsWith('.')) {
      continue;
    }
    const star = target.indexOf('*');
    if (star === -1) {
      if (target === relative) {
        return `${owner.name}${key.slice(1)}`;
      }
      continue;
    }
    const head = target.slice(0, star);
    const tail = target.slice(star + 1);
    if (relative.startsWith(head) && relative.endsWith(tail) && relative.length >= head.length + tail.length) {
      return `${owner.name}${key.slice(1).replace('*', relative.slice(head.length, relative.length - tail.length))}`;
    }
  }
  return undefined;
}

// A target may be a string or a set of conditions, one of which names the file.
function exportTarget(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  const conditions = toRecord(value);
  const chosen = conditions?.['astro'] ?? conditions?.['import'] ?? conditions?.['default'];
  return typeof chosen === 'string' ? chosen : undefined;
}

/** The folder of the package that owns `file`, at or below `root`. */
export function owningPackage(file: string, root: string, isPackage: (folder: string) => boolean): string | undefined {
  let folder = folderOf(file);
  for (let depth = 0; depth < CODE_INTEL_LIMITS.indexDepthMax && within(root, folder); depth++) {
    if (isPackage(folder)) {
      return folder;
    }
    folder = folderOf(folder);
  }
  return undefined;
}
