// The one writer of `.stacki/component-canvas.json` for an open canvas. What the canvas shows is the file as last read
// or written with every edit not yet on disk applied to it, and a save writes exactly that. So an edit is never a copy
// of the whole file taken earlier: it is a change, applied to whatever the file holds when it is written. Saves run one
// at a time; where the file changed meanwhile (a moved asset, a renamed variable, an agent, a git pull), the save
// reads it again and applies the same changes to the new text, so neither side's settings are lost.
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { EMPTY_CANVAS_FILE, parseComponentCanvasSource, serializeComponentCanvas, type ComponentCanvasFile } from '../../../shared/properties/componentCanvas';

/** One edit of the settings: built from the values it sets, so it applies to any later state of the file. */
export type CanvasChange = (file: ComponentCanvasFile) => ComponentCanvasFile;

export interface CanvasSettingsIo {
  /** The file's text now; undefined when there is none. */
  readonly read: () => Promise<string | undefined>;
  /** Writes `source` where the file still holds `base`, and refuses otherwise. Resolves with what was written. */
  readonly write: (source: string, base: string | undefined) => Promise<string>;
}

export interface CanvasSettingsStore {
  /** Applies a change and returns the settings as they are now. Throws, keeping nothing, when it cannot be applied. */
  readonly change: (change: CanvasChange) => ComponentCanvasFile;
  /** Writes every change made so far. */
  readonly save: () => Promise<ComponentCanvasFile>;
  /** Reads the file again, for a change made outside the canvas, keeping the changes not yet written. */
  readonly reread: () => Promise<ComponentCanvasFile>;
}

// How many times a save reads a file that keeps changing under it before it gives up and says so.
const SAVE_ATTEMPTS_MAX = 4;

export function canvasSettingsStore(io: CanvasSettingsIo, stored: string | undefined): CanvasSettingsStore {
  let base = stored;
  let pending: readonly CanvasChange[] = [];
  let current = parsed(stored);
  let queue: Promise<unknown> = Promise.resolve();
  const replay = (from: ComponentCanvasFile, changes: readonly CanvasChange[]): ComponentCanvasFile => changes.reduce((file, change) => change(file), from);
  // One read or write at a time, in the order asked; a failure is the caller's, and the next still runs.
  const inTurn = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
  };
  const rebase = (source: string | undefined): void => {
    const next = replay(parsed(source), pending);
    base = source;
    current = next;
  };
  const write = async (): Promise<ComponentCanvasFile> => {
    for (let attempt = 1; attempt <= SAVE_ATTEMPTS_MAX; attempt++) {
      const count = pending.length;
      const source = serializeComponentCanvas(current);
      // No file yet and nothing to put in one: nothing is written.
      if (source === base || (base === undefined && source === serializeComponentCanvas(EMPTY_CANVAS_FILE))) {
        pending = pending.slice(count);
        return current;
      }
      try {
        const saved = await io.write(source, base);
        base = saved;
        // Changes made while this write ran stay pending, applied over what it wrote.
        pending = pending.slice(count);
        current = replay(parsed(saved), pending);
        return current;
      } catch (error: unknown) {
        const found = await io.read();
        if (found === base || attempt === SAVE_ATTEMPTS_MAX) {
          throw error;
        }
        rebase(found);
      }
    }
    assert(false, 'A save returns or throws within its attempts');
    return current;
  };
  return {
    change: (change) => {
      assert(pending.length < LIMITS.treeNodesMax, 'Unsaved canvas changes are bounded');
      const next = change(current);
      pending = [...pending, change];
      current = next;
      return next;
    },
    save: () => inTurn(write),
    reread: () =>
      inTurn(async () => {
        rebase(await io.read());
        return current;
      }),
  };
}

// A file the parser refuses is never written over: the error reaches the person instead.
function parsed(source: string | undefined): ComponentCanvasFile {
  if (source === undefined) {
    return EMPTY_CANVAS_FILE;
  }
  const result = parseComponentCanvasSource(source);
  if (!result.ok) {
    throw new Error(`.stacki/component-canvas.json: ${result.error.message}`);
  }
  return result.value;
}
