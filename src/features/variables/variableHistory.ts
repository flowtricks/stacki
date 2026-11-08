import type { Result } from '../../../shared/core/result';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { variableEdit } from '../../ipc/variableEditBridge';

// One undoable variable edit, as the app's history records it.
export interface VariableUndo {
  readonly label: string;
  readonly coalesceKey?: string | undefined;
  readonly undo: () => Promise<void>;
  readonly redo: () => Promise<void>;
}

type FileTexts = Readonly<Record<string, string>>;
interface HistoryOptions {
  readonly projectPath: string;
  readonly refresh: () => Promise<void>;
  readonly report: (message: string) => void;
  readonly record?: ((command: VariableUndo) => void) | undefined;
}

export function createVariableHistory(options: HistoryOptions) {
  return async (
    files: string | undefined | readonly string[],
    label: string,
    // Edits sharing a key collapse into one undo step; undefined keeps each its own.
    coalesceKey: string | undefined,
    run: () => Promise<boolean | void>,
  ): Promise<boolean> => {
    const paths = [...new Set(typeof files === 'string' ? [files] : (files ?? []))];
    assert(paths.length <= LIMITS.scanEntriesMax, 'Variable undo: file limit exceeded');
    const before = await readTexts(options.projectPath, paths);
    if (!before.ok) {
      options.report(before.error);
      return false;
    }
    if ((await run()) === false) {
      return false;
    }
    if (!paths.length) {
      return true;
    }
    const after = await readTexts(options.projectPath, paths);
    if (!after.ok) {
      options.report(after.error);
      return false;
    }
    const changed = paths.filter((path) => before.value[path] !== after.value[path]);
    if (!changed.length) {
      return true;
    }
    const previous = selectTexts(before.value, changed);
    const next = selectTexts(after.value, changed);
    options.record?.({
      label,
      coalesceKey,
      undo: () => restoreTexts(options, previous),
      redo: () => restoreTexts(options, next),
    });
    return true;
  };
}

async function readTexts(projectPath: string, files: readonly string[]): Promise<Result<FileTexts, string>> {
  assert(files.length <= LIMITS.scanEntriesMax, 'Variable undo: read limit exceeded');
  const texts: Record<string, string> = {};
  // Reading sequentially bounds outstanding disk requests even for project-wide edits.
  for (const file of files) {
    const result = await variableEdit('readStyleFile', `${projectPath}/${file}`);
    if (!result.ok) {
      return result;
    }
    assert(result.css !== undefined, 'Variable undo: successful file read requires text');
    texts[file] = result.css;
  }
  return { ok: true, value: texts };
}
function selectTexts(texts: FileTexts, paths: readonly string[]): FileTexts {
  assert(paths.length <= LIMITS.scanEntriesMax, 'Variable undo: selection limit exceeded');
  return Object.fromEntries(
    paths.map((path) => {
      const value = texts[path];
      assert(value !== undefined, 'Variable undo: missing file snapshot');
      return [path, value];
    }),
  );
}
async function restoreTexts(options: HistoryOptions, texts: FileTexts): Promise<void> {
  const entries = Object.entries(texts);
  assert(entries.length <= LIMITS.scanEntriesMax, 'Variable undo: restore limit exceeded');
  for (const [file, css] of entries) {
    const result = await variableEdit('writeStyleFile', {
      filePath: `${options.projectPath}/${file}`,
      css,
      // An Astro file may be the open page, whose model must hear of the restore.
      announce: true,
    });
    if (!result.ok) {
      options.report(result.error || 'Could not restore that stylesheet.');
      break;
    }
  }
  await options.refresh();
}
