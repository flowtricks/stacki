// The style selectors panel's way to the main process: check the project,
// remove selectors, undo or redo a removal, and edit the keep list (names and
// locked stylesheets). Every
// answer is parsed before the panel sees it.
import { assert } from '../../../shared/core/assert';
import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';
import type { Result } from '../../../shared/core/result';
import {
  parseSelectorRemovalResult,
  parseSelectorReportResult,
  type SelectorFileChange,
  type SelectorFileDigest,
  type SelectorRemoval,
  type SelectorReport,
} from '../../../shared/properties/selectorUsage';
import { EMPTY_KEEP_LIST, parseStyleKeepList, serializeStyleKeepList, type StyleKeepList } from '../../../shared/properties/styleKeepList';
import { readMetadata, writeMetadata } from '../../ipc/projectMetadataBridge';
import type { KeepListChange } from './lockChanges';
import { createPanelCache } from '../../lib/usePanelData';

/** The last full report per project: the panel opens on it, then refreshes. */
export const selectorReportCache = createPanelCache<SelectorReport>();

// How long after a project opens its first full check starts: after the dev
// server and the page have had the machine to themselves.
const PREWARM_DELAY_MS = 4_000;

/** Run the full check in the background so the panel opens on a finished report. */
export function prewarmSelectorReport(projectPath: string): () => void {
  let active = true;
  const timer = setTimeout(() => {
    readSelectorReport(projectPath).then(
      (result) => {
        if (active && result.ok) {
          selectorReportCache.set(projectPath, result.value);
        }
      },
      // Best effort: the panel runs its own check and reports any failure.
      () => undefined,
    );
  }, PREWARM_DELAY_MS);
  return () => {
    active = false;
    clearTimeout(timer);
  };
}

/** `cached` answers at once from earlier package searches; `search` is the full check. */
export async function readSelectorReport(projectPath: string, packages: 'cached' | 'search' = 'search'): Promise<Result<SelectorReport, string>> {
  const input = parseIpcPayload('style:selectorUsage', { projectPath, packages });
  const answer: unknown = await window.avb.selectorUsage(input);
  // A malformed answer is a failed read the panel reports, never a crash.
  let result;
  try {
    result = parseSelectorReportResult(answer);
  } catch (error: unknown) {
    return { ok: false, error: `The style check returned an unreadable answer: ${error instanceof Error ? error.message : String(error)}` };
  }
  return result.ok ? result : { ok: false, error: result.error.message };
}

export async function removeSelectors(
  projectPath: string,
  ids: readonly string[],
  files: readonly SelectorFileDigest[],
  reach: 'cleanup' | 'chosen' = 'cleanup',
): Promise<Result<SelectorRemoval, string>> {
  const input = parseIpcPayload('style:removeSelectors', { projectPath, ids, files, reach });
  const result = parseSelectorRemovalResult(await window.avb.removeSelectors(input));
  return result.ok ? result : { ok: false, error: result.error.message };
}

export async function restoreSelectors(projectPath: string, changes: readonly SelectorFileChange[], to: 'before' | 'after'): Promise<void> {
  const input = parseIpcPayload('style:restoreSelectors', { projectPath, changes, to });
  const result = parseSelectorRemovalResult(await window.avb.restoreSelectors(input));
  if (!result.ok) {
    throw new Error(result.error.message);
  }
}

/** The keep list and the bytes it was read from, for a witnessed write. */
export interface StoredKeepList {
  readonly keepList: StyleKeepList;
  readonly source: string | undefined;
}

export async function readKeepList(projectPath: string): Promise<StoredKeepList> {
  const stored = await readMetadata(projectPath, 'styles');
  if (stored.source === undefined) {
    return keep(projectPath, { keepList: EMPTY_KEEP_LIST, source: undefined });
  }
  const input: unknown = JSON.parse(stored.source);
  return keep(projectPath, { keepList: parseStyleKeepList(input), source: stored.source });
}

/**
 * The keep list last read or written per project. The panel opens on it: reading
 * it on every mount drew the stylesheet lock controls a frame or more after the
 * rows, on every open of the panel.
 */
export const keepListCache = createPanelCache<StoredKeepList>();

/** Reads the keep list ahead of the panel's first open (panelPrefetch.ts). */
export async function prewarmKeepList(projectPath: string): Promise<void> {
  assert(projectPath.length > 0, 'prewarmKeepList: a project is open');
  if (keepListCache.get(projectPath) === undefined) {
    await readKeepList(projectPath);
  }
}

function keep(projectPath: string, stored: StoredKeepList): StoredKeepList {
  keepListCache.set(projectPath, stored);
  return stored;
}

/** The keep list with `change` applied; the parser re-checks every bound. */
export function changedKeepList(keepList: StyleKeepList, change: KeepListChange): StyleKeepList {
  const removed = new Set(change.remove);
  const unlocked = new Set(change.unlock);
  const keep = [...keepList.keep.filter((pattern) => !removed.has(pattern)), ...change.add];
  const lockedStylesheets = [...keepList.lockedStylesheets.filter((entry) => !unlocked.has(entry)), ...change.lock];
  const next = parseStyleKeepList({ version: 1, keep, lockedStylesheets });
  // Postconditions: what was asked to go is gone, whatever else was there stays.
  assert(
    change.unlock.every((entry) => !next.lockedStylesheets.includes(entry) || change.lock.includes(entry)),
    'changedKeepList: unlocked paths are gone',
  );
  assert(
    keepList.lockedStylesheets.every((entry) => unlocked.has(entry) || next.lockedStylesheets.includes(entry)),
    'changedKeepList: other locks are kept',
  );
  return next;
}

/** Change names or locks against the file as it was read; a concurrent edit is refused. */
export async function updateKeepList(projectPath: string, stored: StoredKeepList, change: KeepListChange): Promise<StoredKeepList> {
  const keepList = changedKeepList(stored.keepList, change);
  const source = serializeStyleKeepList(keepList);
  const saved = await writeMetadata(projectPath, stored.source === undefined ? { kind: 'styles', source } : { kind: 'styles', source, base: stored.source });
  return keep(projectPath, { keepList, source: saved.source ?? source });
}

/**
 * Undo or redo a keep-list change: write `source` back only while the file
 * still holds `expected`, so an edit made since is refused, never lost.
 */
export async function replaceKeepList(projectPath: string, expected: string, source: string): Promise<StoredKeepList> {
  const current = await readKeepList(projectPath);
  const onDisk = current.source ?? serializeStyleKeepList(EMPTY_KEEP_LIST);
  if (onDisk !== expected) {
    throw new Error('.stacki/styles.json changed since; the lock change was not undone.');
  }
  const parsed: unknown = JSON.parse(source);
  const keepList = parseStyleKeepList(parsed);
  const saved = await writeMetadata(projectPath, current.source === undefined ? { kind: 'styles', source } : { kind: 'styles', source, base: current.source });
  return keep(projectPath, { keepList, source: saved.source ?? source });
}
