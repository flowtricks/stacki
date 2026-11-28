// Where a project's packages are installed. A package manager does not always install into the project's own
// folder: in a workspace npm, pnpm, Yarn and Bun hoist packages to the workspace's root. These answers walk up
// from the project to there and no further, so nothing installed outside the project's workspace is ever used.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assert } from '../../shared/core/assert';
import { parseRecord, readJson } from './mainHelpers';

/** Folder levels above a project looked at for its workspace. Real workspaces nest a few. */
const INSTALL_FOLDERS_MAX = 16;

/**
 * The folders whose `node_modules` an install for this project fills, nearest first: the project, and, when it is
 * part of a workspace, every folder up to the workspace's root. Without a workspace it ends at the nearest folder
 * that has a package.json, where npm installs. It never passes the repository's own folder, and never reaches the
 * home folder or above it: an `astro` that happens to be installed up there belongs to something else.
 */
export function installFolders(projectPath: string, homePath: string = os.homedir()): readonly string[] {
  const chain: string[] = [];
  let nearestPackage: number | undefined;
  let directory = path.resolve(projectPath);
  while (chain.length < INSTALL_FOLDERS_MAX) {
    if (chain.length > 0 && isSameOrAbove(directory, homePath)) {
      break;
    }
    chain.push(directory);
    if (isWorkspaceRoot(directory)) {
      return chain;
    }
    if (nearestPackage === undefined && fs.existsSync(path.join(directory, 'package.json'))) {
      nearestPackage = chain.length;
    }
    const parent = path.dirname(directory);
    if (parent === directory || isRepositoryRoot(directory)) {
      break;
    }
    directory = parent;
  }
  assert(chain.length > 0, 'installFolders: the project itself');
  return chain.slice(0, nearestPackage ?? 1);
}

/** The package.json of the astro this project runs: its own copy, or the one its workspace installed. */
export function astroManifestPath(projectPath: string, homePath: string = os.homedir()): string | undefined {
  const manifestIn = (directory: string): string => path.join(directory, 'node_modules', 'astro', 'package.json');
  const own = manifestIn(projectPath);
  if (fs.existsSync(own)) {
    return own;
  }
  return installFolders(projectPath, homePath)
    .slice(1)
    .map(manifestIn)
    .find((candidate) => fs.existsSync(candidate));
}

/** Whether the packages for this project were installed by Yarn Plug'n'Play, which leaves no node_modules to run from. */
export function usesYarnPlugAndPlay(projectPath: string, homePath: string = os.homedir()): boolean {
  return installFolders(projectPath, homePath).some((directory) => fs.existsSync(path.join(directory, '.pnp.cjs')));
}

function isSameOrAbove(directory: string, homePath: string): boolean {
  const relative = path.relative(directory, path.resolve(homePath));
  if (relative === '') {
    return true;
  }
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isWorkspaceRoot(directory: string): boolean {
  if (fs.existsSync(path.join(directory, 'pnpm-workspace.yaml'))) {
    return true;
  }
  try {
    return parseRecord(readJson(path.join(directory, 'package.json')))['workspaces'] !== undefined;
  } catch {
    return false; // No package.json, or one that is not JSON.
  }
}

// A checkout's top folder holds `.git`: a folder, or in a linked worktree a file. A submodule has a file too, and is
// not the top: its workspace may well be the repository around it.
function isRepositoryRoot(directory: string): boolean {
  const marker = path.join(directory, '.git');
  try {
    if (fs.statSync(marker).isDirectory()) {
      return true;
    }
    return !/[\\/]modules[\\/]/.test(fs.readFileSync(marker, 'utf8'));
  } catch {
    return false;
  }
}
