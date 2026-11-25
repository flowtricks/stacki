// The boot snapshot file in main: read once, synchronously, before the window exists; updated from the renderer's
// saves; written rarely (debounced) and atomically. The contract and its bounds are shared/properties/bootSnapshot.ts.
//
// Why synchronous reads here: the file is at most BOOT_LIMITS.fileBytesMax, read once before the window is
// created, and the first frame cannot be real without it. A larger or damaged file is ignored, never half-used.
//
// Never written: the project. This module writes `boot-snapshot.json` in the app's own data folder and nothing else.
import * as fs from 'fs';
import * as path from 'path';
import {
  BOOT_LIMITS,
  BOOT_SNAPSHOT_VERSION,
  parseBootFileText,
  parseBootSnapshot,
  serializeBootSnapshot,
  withSnapshot,
  type BootFile,
  type BootSnapshot,
} from '../../shared/properties/bootSnapshot';
import { createCoalescedSaver, type SaveClock } from '../../shared/core/debouncedSaver';

/** A snapshot changes as a person works; one write a second after they pause, and never less often than every ten during a stream. */
const SAVE_TIMING = { delayMs: 1_000, waitMsMax: 10_000 } as const;

export const BOOT_FILE = 'boot-snapshot.json';

/** What the renderer's first render receives: the project it opens (if any) and the snapshots of recent projects. */
export interface BootPayload {
  readonly version: typeof BOOT_SNAPSHOT_VERSION;
  readonly pendingProject?: string;
  readonly snapshots: readonly BootSnapshot[];
}

export interface BootStore {
  readonly payload: (pendingProject: string | undefined) => BootPayload;
  /** Takes a snapshot's JSON text from the renderer; false when it is not a valid snapshot (dropped, never half-applied). */
  readonly save: (text: string) => boolean;
  readonly flush: () => void;
}

export function emptyBootFile(): BootFile {
  return { version: BOOT_SNAPSHOT_VERSION, projects: [] };
}

export function readBootFile(directory: string): BootFile {
  const file = path.join(directory, BOOT_FILE);
  try {
    if (fs.statSync(file).size > BOOT_LIMITS.fileBytesMax) {
      return emptyBootFile();
    }
    const parsed = parseBootFileText(fs.readFileSync(file, 'utf8'));
    return parsed.ok ? parsed.value : emptyBootFile();
  } catch {
    return emptyBootFile();
  }
}

/** The file's text with the oldest projects dropped until it fits, so a write never exceeds the bound a read enforces. */
function fittingText(file: BootFile): string {
  let projects = file.projects;
  for (let attempt = 0; attempt <= BOOT_LIMITS.projectsMax; attempt += 1) {
    const text = JSON.stringify({ version: BOOT_SNAPSHOT_VERSION, projects });
    if (text.length <= BOOT_LIMITS.fileBytesMax) {
      return text;
    }
    projects = projects.slice(0, -1);
  }
  return JSON.stringify(emptyBootFile());
}

function writeBootFile(directory: string, file: BootFile): boolean {
  const target = path.join(directory, BOOT_FILE);
  const temporary = `${target}.tmp`;
  try {
    fs.writeFileSync(temporary, fittingText(file), 'utf8');
    fs.renameSync(temporary, target);
    return true;
  } catch {
    return false;
  }
}

export function createBootStore<Timer>(directory: string, clock: SaveClock<Timer>, projectExists: (projectPath: string) => boolean): BootStore {
  let file = readBootFile(directory);
  const saver = createCoalescedSaver(clock, SAVE_TIMING, () => {
    writeBootFile(directory, file);
  });
  return {
    payload(pendingProject) {
      // A snapshot of a project that is gone from disk is not shown: its pages would be a list of files that do not exist.
      const snapshots = file.projects.filter((entry) => projectExists(entry.projectPath));
      return pendingProject === undefined ? { version: BOOT_SNAPSHOT_VERSION, snapshots } : { version: BOOT_SNAPSHOT_VERSION, pendingProject, snapshots };
    },
    save(text) {
      if (text.length > BOOT_LIMITS.snapshotBytesMax) {
        return false;
      }
      let input: unknown;
      try {
        input = JSON.parse(text);
      } catch {
        return false;
      }
      const parsed = parseBootSnapshot(input);
      if (!parsed.ok) {
        return false;
      }
      const serialized = serializeBootSnapshot(parsed.value);
      if (serialized === undefined) {
        return false;
      }
      file = withSnapshot(file, parsed.value);
      saver.schedule();
      return true;
    },
    flush() {
      saver.flush();
    },
  };
}
