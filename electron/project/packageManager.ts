// Which package manager a project uses. Kept apart from projectFiles so Studio's
// publishing services can share it without the project scan.

import * as fs from 'fs';
import * as path from 'path';
import { readJson, parseRecord } from '../lib/mainHelpers';
import {
  parsePackageManagerField,
  type PackageManager,
} from '../../shared/properties/packageManager';

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
