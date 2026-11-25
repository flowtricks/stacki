// Which package manager a project uses. Kept apart from projectFiles so Studio's
// publishing services can share it without the project scan.

import * as fs from 'fs';
import * as path from 'path';
import { readJson, parseRecord } from '../lib/mainHelpers';
import { parsePackageManagerField, type PackageManager } from '../../shared/properties/packageManager';

// By default `pnpm` blocks dependency build scripts and, since v11, exits with an error when it
// does, though everything else is installed. Keep them blocked; just don't fail the install.
export const PNPM_TOLERATE_IGNORED_BUILDS = '--config.strict-dep-builds=false';

// Installs a project's dependencies with its own manager.
export function installArguments(manager: PackageManager): readonly string[] {
  switch (manager) {
    case 'npm':
      return ['install', '--no-audit', '--no-fund'];
    case 'pnpm':
      return ['install', PNPM_TOLERATE_IGNORED_BUILDS];
    case 'yarn':
    case 'bun':
      return ['install'];
    default: {
      const exhaustive: never = manager;
      return exhaustive;
    }
  }
}

// The packageManager field in package.json names it outright; otherwise the lockfile shows
// which one last installed; else npm. A package inside a workspace keeps neither (the root
// owns the lockfile and the field), so each parent folder is asked in turn, nearest first.
export function detectPackageManager(directory: string): PackageManager {
  for (const folder of ancestorsOf(directory)) {
    const found = managerIn(folder);
    if (found !== undefined) {
      return found;
    }
  }
  return 'npm';
}

/** The folder itself, then each parent up to the filesystem root. A monorepo package keeps its lockfile, node_modules and `astro` dependency in the workspace root. */
export function ancestorsOf(directory: string): readonly string[] {
  let current = path.resolve(directory);
  const chain = [current];
  let parent = path.dirname(current);
  // Each step moves one folder up and stops where `dirname` stops changing: the root.
  while (parent !== current) {
    current = parent;
    chain.push(current);
    parent = path.dirname(current);
  }
  return chain;
}

// What one folder says: its package.json's field, then its lockfiles.
function managerIn(directory: string): PackageManager | undefined {
  const declared = declaredPackageManager(directory);
  if (declared !== undefined) {
    return declared;
  }
  const has = (file: string): boolean => fs.existsSync(path.join(directory, file));
  if (has('pnpm-lock.yaml') || has('pnpm-workspace.yaml')) {
    return 'pnpm';
  }
  if (has('yarn.lock')) {
    return 'yarn';
  }
  if (has('bun.lockb') || has('bun.lock')) {
    return 'bun';
  }
  if (has('package-lock.json') || has('npm-shrinkwrap.json')) {
    return 'npm';
  }
  return undefined;
}

function declaredPackageManager(directory: string): PackageManager | undefined {
  const manifest = path.join(directory, 'package.json');
  if (!fs.existsSync(manifest)) {
    return undefined;
  }
  try {
    return parsePackageManagerField(parseRecord(readJson(manifest))['packageManager']);
  } catch {
    // An unreadable package.json falls back to the lockfile; the install reports it.
    return undefined;
  }
}
