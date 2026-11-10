// The one-time cleanup of the component photographs an earlier version kept.
//
// Version 1.0.22's insert palette stored JPEGs of components in userData/component-shots/<project
// key>/, one folder per project, with nothing that ever removed a project's folder. The palette now
// shows live frames, so the folder is dead weight. It is removed on startup; once it is gone the
// check is one failed directory read, so "once" needs no marker. Only the names that version wrote
// are deleted, at most so many, and a folder that holds anything else is left and logged.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { assert } from '../../shared/core/assert';

export const LEGACY_SHOT_LIMITS = {
  /** Project folders looked into. The old version never pruned them, so a long-used install may have many. */
  projectsMax: 2000,
  /** Files looked at in one project folder: 500 photographs, the meta file and stray temporaries, with room. */
  filesPerProjectMax: 2000,
} as const satisfies Record<string, number>;

export const LEGACY_SHOTS_DIRECTORY = 'component-shots';

// What the old store wrote: a photograph per component, the meta file, and the meta's temporary before its rename.
const LEGACY_FILE = /^(?:[0-9a-f]{16}\.jpg|meta\.json|meta\.json\.\d+\.tmp)$/;
const PROJECT_KEY = /^[0-9a-f]{8,64}$/;

export interface LegacyShotsCleanup {
  readonly filesRemoved: number;
  readonly foldersRemoved: number;
  /** Folders left because they held something the old version did not write, or more than the bound. */
  readonly foldersKept: number;
}

/** Removes userData/component-shots. Undefined when there was nothing to remove. */
export async function removeLegacyComponentShots(userDataPath: string): Promise<LegacyShotsCleanup | undefined> {
  assert(path.isAbsolute(userDataPath), 'userData is an absolute path');
  const root = path.join(userDataPath, LEGACY_SHOTS_DIRECTORY);
  let projects: readonly string[];
  try {
    projects = await fs.readdir(root);
  } catch {
    return undefined;
  }
  let filesRemoved = 0;
  let foldersRemoved = 0;
  let foldersKept = 0;
  for (const name of projects.slice(0, LEGACY_SHOT_LIMITS.projectsMax)) {
    const folder = path.join(root, name);
    if (!PROJECT_KEY.test(name)) {
      foldersKept += 1;
      continue;
    }
    const removed = await removeLegacyProject(folder);
    filesRemoved += removed.files;
    if (removed.empty) {
      foldersRemoved += 1;
    } else {
      foldersKept += 1;
    }
  }
  foldersKept += Math.max(0, projects.length - LEGACY_SHOT_LIMITS.projectsMax);
  if (foldersKept === 0) {
    await fs.rmdir(root).catch(() => undefined);
  }
  assert(foldersRemoved + foldersKept === projects.length, 'Every project folder is counted once');
  return { filesRemoved, foldersRemoved, foldersKept };
}

async function removeLegacyProject(folder: string): Promise<{ readonly files: number; readonly empty: boolean }> {
  let names: readonly string[];
  try {
    names = await fs.readdir(folder);
  } catch {
    // A file where a folder was expected is not the old store's; it stays.
    return { files: 0, empty: false };
  }
  let files = 0;
  for (const name of names.slice(0, LEGACY_SHOT_LIMITS.filesPerProjectMax)) {
    if (LEGACY_FILE.test(name)) {
      await fs.rm(path.join(folder, name), { force: true });
      files += 1;
    }
  }
  const empty = files === names.length;
  if (empty) {
    await fs.rmdir(folder).catch(() => undefined);
  }
  assert(files <= names.length, 'Only listed files are removed');
  return { files, empty };
}
