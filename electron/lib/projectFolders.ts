// Reads `.stacki/folders.json` from disk for the scanners that run beside the
// project: Desktop's main process and Studio's server, which vendors this file.
// Synchronous and small on purpose: the scanners that ask are synchronous, and
// the file is bounded (PROJECT_FOLDER_LIMITS.fileCharsMax) before it is read.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assert } from '../../shared/core/assert';
import {
  PROJECT_FOLDERS_FILE,
  PROJECT_FOLDER_LIMITS,
  configOf,
  foldersFor,
  readProjectFoldersSource,
  type ProjectFolderKind,
  type ProjectFoldersRead,
} from '../../shared/properties/projectFolders';

/** What the project's folder settings say now. A file that is a link, too large or unreadable is invalid, never followed. */
export function readProjectFolders(projectPath: string): ProjectFoldersRead {
  assert(projectPath.length > 0, 'readProjectFolders: the project is named');
  const file = path.join(projectPath, PROJECT_FOLDERS_FILE);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error: unknown) {
    if (isMissing(error)) {
      return { kind: 'absent' };
    }
    return { kind: 'invalid', message: error instanceof Error ? error.message : String(error) };
  }
  if (stat.isSymbolicLink()) {
    return { kind: 'invalid', message: 'Folder settings cannot be a symbolic link' };
  }
  if (!stat.isFile()) {
    return { kind: 'invalid', message: 'Folder settings must be a file' };
  }
  // Characters are at most bytes, so a file over the character bound in bytes may still fit; four
  // bytes per character is UTF-8's widest. The text parser applies the exact bound after this.
  if (stat.size > PROJECT_FOLDER_LIMITS.fileCharsMax * 4) {
    return { kind: 'invalid', message: `Folder settings exceed ${PROJECT_FOLDER_LIMITS.fileCharsMax} characters` };
  }
  let source: string;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (error: unknown) {
    if (isMissing(error)) {
      return { kind: 'absent' };
    }
    return { kind: 'invalid', message: error instanceof Error ? error.message : String(error) };
  }
  return readProjectFoldersSource(source);
}

/** The folders `kind` reads in this project: the configured ones, else the defaults (also when the file is invalid). */
export function projectFoldersFor(projectPath: string, kind: ProjectFolderKind): readonly string[] {
  return foldersFor(kind, configOf(readProjectFolders(projectPath)));
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}
