import fs from 'node:fs';
import path from 'node:path';
import { ASTRO_FILES_MAX, diffAstroFiles, type AstroFileChange } from '../../shared/properties/astroFileChanges';
import type { Result } from '../../shared/core/result';

// A settled inventory distinguishes creation/deletion from an editor's atomic replacement.
// Initial contents establish a silent baseline; unreadable scans never imply mass deletion.
export function createAstroFileMonitor(root: string, report: (changes: readonly AstroFileChange[]) => void) {
  const initial = readAstroFiles(root);
  let previous = initial.ok ? initial.value : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  return {
    request: () => {
      if (closed || timer !== undefined) {
        return;
      }
      // One pending scan bounds work even when an agent continuously writes files.
      timer = setTimeout(() => {
        timer = undefined;
        const result = readAstroFiles(root);
        if (!result.ok) {
          console.warn(`Astro file notifications: ${result.error}`);
          return;
        }
        const changes = previous === undefined ? [] : diffAstroFiles(previous, result.value);
        previous = result.value;
        if (changes.length > 0) {
          report(changes);
        }
      }, 200);
    },
    close: () => {
      closed = true;
      clearTimeout(timer);
    },
  };
}

function readAstroFiles(root: string): Result<ReadonlySet<string>, string> {
  // Filesystem failures are expected at this boundary.
  // The diff's assertions run outside this catch.
  try {
    const directories = ['src'];
    const files = new Set<string>();
    let entriesCount = 0;
    for (let index = 0; index < directories.length; index++) {
      const directory = directories[index];
      if (directory === undefined) {
        // i18n-ignore: programmer diagnostic thrown by the file monitor; never shown to a person.
        return { ok: false, error: 'Missing scan directory' };
      }
      const absolute = path.join(root, directory);
      const entries = readAstroDirectory(absolute);
      entriesCount += entries.length;
      if (entriesCount > ASTRO_FILES_MAX) {
        // i18n-ignore: programmer diagnostic thrown by the file monitor; never shown to a person.
        return { ok: false, error: 'Project file notification scan exceeds limit' };
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.isSymbolicLink()) {
          continue;
        }
        const file = `${directory}/${entry.name}`;
        if (entry.isDirectory()) {
          directories.push(file);
        } else if (entry.isFile() && /\.astro$/i.test(file)) {
          files.add(file);
        }
      }
    }
    return { ok: true, value: files };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function readAstroDirectory(directory: string): readonly fs.Dirent[] {
  try {
    if (fs.lstatSync(directory).isSymbolicLink()) {
      return [];
    }
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}
