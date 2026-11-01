// The style selectors panel's way to the main process: check the project,
// remove selectors, undo or redo a removal, and edit the keep list. Every
// answer is parsed before the panel sees it.
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
): Promise<Result<SelectorRemoval, string>> {
  const input = parseIpcPayload('style:removeSelectors', { projectPath, ids, files });
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
    return { keepList: EMPTY_KEEP_LIST, source: undefined };
  }
  const input: unknown = JSON.parse(stored.source);
  return { keepList: parseStyleKeepList(input), source: stored.source };
}

/** Add or remove names, against the file as it was read; a concurrent edit is refused. */
export async function updateKeepList(
  projectPath: string,
  stored: StoredKeepList,
  change: { readonly add: readonly string[]; readonly remove: readonly string[] },
): Promise<StoredKeepList> {
  const removed = new Set(change.remove);
  const keep = [...stored.keepList.keep.filter((pattern) => !removed.has(pattern)), ...change.add];
  const keepList = parseStyleKeepList({ ...stored.keepList, keep });
  const source = serializeStyleKeepList(keepList);
  const saved = await writeMetadata(projectPath, stored.source === undefined ? { kind: 'styles', source } : { kind: 'styles', source, base: stored.source });
  return { keepList, source: saved.source ?? source };
}
