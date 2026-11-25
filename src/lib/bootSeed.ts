// What the first render knows before anything is asked: the project the window opens and the last session's
// snapshot of it, read from `window.stackiBoot` (the preload fills it synchronously from main, which read the file
// before the window existed). Absent in Studio and in tests: no seed, and everything opens as it always did.
//
// The seed is untrusted like any boundary value: it stays `unknown` until parsed here, and a snapshot that does not
// parse is dropped whole.
import { parseBootSnapshot, type BootSnapshot } from '../../shared/properties/bootSnapshot';

export interface BootBridge {
  readonly seed: unknown;
  readonly save: (text: string) => void;
  readonly firstFrame: () => void;
}

declare global {
  interface Window {
    stackiBoot?: BootBridge;
  }
}

export interface BootSeed {
  /** The project the window opens at start, when one is owed (a reload, a project picked from the menu). */
  readonly project?: { readonly path: string; readonly name: string };
  readonly snapshots: readonly BootSnapshot[];
}

const SNAPSHOTS_MAX = 8;

/** The seed in `input`: a pending project and the snapshots that parse. Pure, so a test can drive any shape. */
export function parseBootSeed(input: unknown): BootSeed {
  if (typeof input !== 'object' || input === null) {
    return { snapshots: [] };
  }
  const pending: unknown = Reflect.get(input, 'pendingProject');
  const listed: unknown = Reflect.get(input, 'snapshots');
  const snapshots: BootSnapshot[] = [];
  if (Array.isArray(listed)) {
    // Array.isArray narrows to any[]; each entry is bound as unknown before it is parsed.
    for (const entry of listed.slice(0, SNAPSHOTS_MAX)) {
      const candidate: unknown = entry;
      const parsed = parseBootSnapshot(candidate);
      if (parsed.ok) {
        snapshots.push(parsed.value);
      }
    }
  }
  if (typeof pending === 'string' && pending.length > 0 && pending.length <= 4096) {
    return { project: { path: pending, name: pending.split(/[\\/]/).filter(Boolean).pop() ?? pending }, snapshots };
  }
  return { snapshots };
}

let seed: BootSeed | undefined;

/** The seed of this page load, parsed once. */
export function bootSeed(): BootSeed {
  seed ??= parseBootSeed(typeof window === 'undefined' ? undefined : window.stackiBoot?.seed);
  return seed;
}

/** The snapshot of `projectPath` from the last session, if one was kept. */
export function bootSnapshotFor(projectPath: string): BootSnapshot | undefined {
  return bootSeed().snapshots.find((entry) => entry.projectPath === projectPath);
}

/** Tells main the real shell has painted, which shows the window. A no-op without the boot bridge. */
export function reportFirstFrame(): void {
  window.stackiBoot?.firstFrame();
}

/** Sends a snapshot for main to keep. A no-op without the boot bridge. */
export function saveBootSnapshot(snapshot: BootSnapshot): void {
  window.stackiBoot?.save(JSON.stringify(snapshot));
}
