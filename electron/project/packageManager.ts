// Which package manager a project uses. Kept apart from projectFiles so Studio's
// publishing services can share it without the project scan.

import * as fs from 'fs';
import * as path from 'path';
import { readJson, parseRecord } from '../lib/mainHelpers';
import {
  parsePackageManagerField,
  type PackageManager,
} from '../../shared/properties/packageManager';

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

// The packageManager field in package.json names it outright; otherwise the
// lockfile shows which one last installed; else npm.
export function detectPackageManager(directory: string): PackageManager {
  const declared = declaredPackageManager(directory);
  if (declared !== undefined) {
    return declared;
  }
  if (fs.existsSync(path.join(directory, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (fs.existsSync(path.join(directory, 'yarn.lock'))) {
    return 'yarn';
  }
  if (
    fs.existsSync(path.join(directory, 'bun.lockb')) ||
    fs.existsSync(path.join(directory, 'bun.lock'))
  ) {
    return 'bun';
  }
  return 'npm';
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
